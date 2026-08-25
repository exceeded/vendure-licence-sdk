/**
 * SQL dialect adapter — lets every HULO plugin run its (historically
 * MySQL-flavoured) raw SQL unchanged on PostgreSQL.
 *
 * The plugins own a closed corpus of hand-written queries, all funnelled
 * through `TransactionalConnection.rawConnection.query()`. Rather than
 * fork 200+ call sites per dialect, `createDbAdapter()` wraps the
 * connection and `translateSql()` rewrites each statement on the fly for
 * Postgres. On MySQL/MariaDB everything passes through byte-identical,
 * so existing installs see zero behavioural change.
 *
 * The translator intentionally supports only the constructs the plugins
 * use — it is not a general SQL transpiler. Every construct it handles
 * is covered by unit tests, and the per-plugin corpus tests assert that
 * no untranslated MySQL-ism survives.
 */

export type SqlDialect = 'mysql' | 'postgres';

/** Resolve the dialect from a TypeORM DataSource / connection options. */
export function dialectOf(conn: { options?: { type?: string } }): SqlDialect {
    const t = String(conn?.options?.type || '').toLowerCase();
    return t === 'postgres' || t === 'cockroachdb' ? 'postgres' : 'mysql';
}

export interface TranslateOptions {
    /**
     * Conflict target for `INSERT … ON DUPLICATE KEY UPDATE` statements —
     * the column list of the table's PRIMARY KEY / unique constraint,
     * e.g. `['channelId']`. Required (on Postgres) for statements that
     * use ON DUPLICATE KEY UPDATE; ignored everywhere else.
     */
    conflictColumns?: string[];
    /**
     * The call site reads `result.insertId` (MySQL OkPacket). On Postgres
     * the adapter appends `RETURNING id` and returns `{ insertId }`.
     */
    needInsertId?: boolean;
    /**
     * The call site reads `result.affectedRows`. On Postgres the adapter
     * appends `RETURNING 1` and returns `{ affectedRows }`.
     */
    needAffected?: boolean;
}

/** `?` placeholders → `$1…$n` (Postgres). Skips quoted strings. */
function numberPlaceholders(sql: string): string {
    let n = 0;
    let out = '';
    let inSingle = false;
    let inDouble = false;
    for (let i = 0; i < sql.length; i++) {
        const ch = sql[i];
        if (ch === "'" && !inDouble) {
            // '' escapes a quote inside a string literal
            if (inSingle && sql[i + 1] === "'") { out += "''"; i++; continue; }
            inSingle = !inSingle;
        } else if (ch === '"' && !inSingle) {
            inDouble = !inDouble;
        } else if (ch === '?' && !inSingle && !inDouble) {
            out += `$${++n}`;
            continue;
        }
        out += ch;
    }
    return out;
}

/** Map MySQL column types in DDL to their Postgres equivalents. */
function translateDdlTypes(sql: string): string {
    return sql
        .replace(/\b(INT|BIGINT|INTEGER)\s+AUTO_INCREMENT\s+PRIMARY\s+KEY/gi, 'BIGSERIAL PRIMARY KEY')
        .replace(/\bAUTO_INCREMENT\b/gi, '') // safety net if pattern above missed
        .replace(/\bTINYINT(\(\d+\))?\b/gi, 'SMALLINT')
        .replace(/\bDATETIME(\(\d+\))?\b/gi, 'TIMESTAMP')
        .replace(/\b(MEDIUMTEXT|LONGTEXT)\b/gi, 'TEXT')
        .replace(/\bDOUBLE\b/gi, 'DOUBLE PRECISION')
        // Postgres has no ON UPDATE auto-touch; callers set updatedAt explicitly.
        .replace(/\s+ON\s+UPDATE\s+CURRENT_TIMESTAMP(\(\d*\))?/gi, '')
        // Inline ENUM('a','b') columns → VARCHAR (the app validates values).
        .replace(/\bENUM\s*\((?:\s*'[^']*'\s*,?)+\)/gi, 'VARCHAR(32)');
}

/**
 * Postgres has no inline `INDEX idx_name (cols)` inside CREATE TABLE —
 * lift them out into trailing `CREATE INDEX IF NOT EXISTS` statements.
 * (The adapter splits multi-statement strings before executing.)
 */
function extractInlineIndexes(sql: string): string {
    const m = sql.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+([A-Za-z0-9_"]+)/i);
    if (!m) return sql;
    const table = m[1].replace(/"/g, '');
    const indexes: string[] = [];
    // The INDEX/KEY keyword must start a table-element (after a comma or
    // newline) — otherwise column names ending in "Key" get eaten.
    let out = sql.replace(/(,|\n)\s*(UNIQUE\s+)?(?:INDEX|KEY)\s+([A-Za-z0-9_]+)\s*\(([^)]+)\)/g,
        (_all, _lead, unique, name, cols) => {
            indexes.push(
                `CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${name} ON ${table} (${cols})`,
            );
            return '';
        });
    if (!indexes.length) return sql;
    return out + ';\n' + indexes.join(';\n');
}

/** `a=VALUES(a), b=VALUES(b)` → `a=EXCLUDED.a, b=EXCLUDED.b` */
function translateUpsert(sql: string, conflictColumns?: string[]): string {
    return sql.replace(/ON\s+DUPLICATE\s+KEY\s+UPDATE\s+([\s\S]+)$/i, (_all, assignments: string) => {
        if (!conflictColumns?.length) {
            throw new Error(
                'translateSql: ON DUPLICATE KEY UPDATE needs conflictColumns on Postgres — pass { conflictColumns: [...] }',
            );
        }
        const converted = assignments.replace(/VALUES\s*\(\s*([A-Za-z0-9_"]+)\s*\)/gi, 'EXCLUDED.$1');
        return `ON CONFLICT (${conflictColumns.join(', ')}) DO UPDATE SET ${converted}`;
    });
}

/** Translate one MySQL-flavoured statement to Postgres. */
export function translateSql(sql: string, dialect: SqlDialect, opts?: TranslateOptions): string {
    if (dialect !== 'postgres') return sql;
    let out = sql;

    // Identifier quoting: backticks → double quotes.
    out = out.replace(/`([^`]*)`/g, '"$1"');

    // INSERT IGNORE → ON CONFLICT DO NOTHING (appended before any trailing ;)
    if (/INSERT\s+IGNORE\s+INTO/i.test(out)) {
        out = out.replace(/INSERT\s+IGNORE\s+INTO/i, 'INSERT INTO');
        out = out.replace(/;?\s*$/, ' ON CONFLICT DO NOTHING');
    }

    // ON DUPLICATE KEY UPDATE → ON CONFLICT … DO UPDATE SET …
    if (/ON\s+DUPLICATE\s+KEY\s+UPDATE/i.test(out)) {
        out = translateUpsert(out, opts?.conflictColumns);
    }

    // NOW(3) / NOW(6) fractional-seconds precision → plain NOW().
    out = out.replace(/\bNOW\s*\(\s*\d+\s*\)/gi, 'NOW()');

    // Date arithmetic. Every plugin use is DATE_SUB/DATE_ADD(<expr>, INTERVAL <n|?> <unit>).
    const UNIT_MAP: Record<string, string> = {
        SECOND: 'secs', MINUTE: 'mins', HOUR: 'hours', DAY: 'days', WEEK: 'weeks', MONTH: 'months', YEAR: 'years',
    };
    out = out.replace(
        /DATE_(SUB|ADD)\s*\(\s*([^,()]+(?:\([^()]*\))?)\s*,\s*INTERVAL\s+(\?|\d+)\s+(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)\s*\)/gi,
        (_all, op, base, amount, unit) => {
            const sign = /SUB/i.test(op) ? '-' : '+';
            const fn = UNIT_MAP[unit.toUpperCase()];
            return `(${base.trim()} ${sign} make_interval(${fn} => ${amount === '?' ? '?' : Number(amount)}))`;
        },
    );

    // Expression matcher tolerating string literals and parens nested three
    // deep — enough for compositions like STRING_AGG((url)::text, '|' …).
    const ATOM = "[^(),']|'(?:[^']|'')*'";
    const D1 = `(?:${ATOM}|,)`;
    const P1 = `\\((?:${D1})*\\)`;
    const D2 = `(?:${ATOM}|,|${P1})`;
    const P2 = `\\((?:${D2})*\\)`;
    const EXPR = `(?:${ATOM}|${P2})+?`; // no bare top-level commas: they separate args

    // GROUP_CONCAT — full form first: GROUP_CONCAT(expr ORDER BY o [ASC|DESC] SEPARATOR 'sep')
    out = out.replace(
        new RegExp(
            `GROUP_CONCAT\\s*\\(\\s*(${EXPR})\\s+ORDER\\s+BY\\s+([A-Za-z0-9_."]+(?:\\s+(?:ASC|DESC))?)\\s+SEPARATOR\\s+('(?:[^']|'')*')\\s*\\)`,
            'gi',
        ),
        'STRING_AGG(($1)::text, $3 ORDER BY $2)',
    );
    out = out.replace(
        new RegExp(`GROUP_CONCAT\\s*\\(\\s*DISTINCT\\s+(${EXPR})\\s*\\)`, 'gi'),
        "STRING_AGG(DISTINCT ($1)::text, ',')",
    );
    out = out.replace(
        new RegExp(`GROUP_CONCAT\\s*\\(\\s*(${EXPR})\\s*\\)`, 'gi'),
        "STRING_AGG(($1)::text, ',')",
    );

    // SUBSTRING_INDEX(a, 'd', ±1) → split_part(a, 'd', ±1). All plugin uses
    // are n = 1 or -1, where the two functions agree (PG ≥14 for negative n).
    // Innermost-first so nested SUBSTRING_INDEX(SUBSTRING_INDEX(…)) resolves.
    const SUBIDX = new RegExp(
        `SUBSTRING_INDEX\\s*\\(\\s*(${EXPR})\\s*,\\s*('(?:[^']|'')*')\\s*,\\s*(-?1)\\s*\\)`,
        'gi',
    );
    for (let guard = 0; guard < 5 && /SUBSTRING_INDEX/i.test(out); guard++) {
        const before = out;
        out = out.replace(SUBIDX, 'split_part($1, $2, $3)');
        if (out === before) break;
    }

    // IF(cond, a, b) → CASE WHEN cond THEN a ELSE b END (simple 3-arg form).
    out = out.replace(
        /\bIF\s*\(\s*([^,()]+(?:\([^()]*\))?[^,()]*)\s*,\s*('(?:[^']|'')*'|[^,()]+)\s*,\s*('(?:[^']|'')*'|[^,()]+)\s*\)/gi,
        'CASE WHEN $1 THEN $2 ELSE $3 END',
    );

    // CAST(x AS UNSIGNED/SIGNED) → BIGINT.
    out = out.replace(/\bAS\s+UNSIGNED\b/gi, 'AS BIGINT').replace(/\bAS\s+SIGNED\b/gi, 'AS BIGINT');

    // TIMESTAMPDIFF(SECOND, a, b) → EXTRACT(EPOCH FROM (b - a))::int
    out = out.replace(
        /TIMESTAMPDIFF\s*\(\s*SECOND\s*,\s*([A-Za-z0-9_."]+(?:\([^()]*\))?)\s*,\s*([A-Za-z0-9_."]+(?:\([^()]*\))?)\s*\)/gi,
        '(EXTRACT(EPOCH FROM ($2 - $1)))::int',
    );

    // Aggregates: node-postgres returns COUNT/SUM as strings (int8/numeric).
    // The plugins do arithmetic on them, so cast to native JS-safe types.
    out = out.replace(/\bCOUNT\s*\(\s*(\*|DISTINCT\s+[A-Za-z0-9_."]+|[A-Za-z0-9_."]+)\s*\)/gi, 'COUNT($1)::int');
    out = out.replace(/\bSUM\s*\(\s*([^()]+(?:\([^()]*\))?)\s*\)/gi, 'SUM($1)::float8');
    // Guard against double-casting when a query already casts.
    out = out.replace(/::int::int/g, '::int').replace(/::float8::float8/g, '::float8');

    // MySQL allows alias-qualified columns in UPDATE … SET (SET ac.x = …);
    // Postgres requires them unqualified. Strip the alias inside the SET list.
    out = out.replace(
        /(UPDATE\s+"?[A-Za-z0-9_]+"?\s+([A-Za-z][A-Za-z0-9_]*)\s+SET\s+)([\s\S]*?)(\s+WHERE\s|$)/i,
        (_all, head, alias, setList, tail) =>
            head + setList.replace(new RegExp(`\\b${alias}\\.`, 'g'), '') + tail,
    );

    // MySQL's DELETE … ORDER BY … LIMIT n has no direct Postgres form —
    // emulate with a ctid subselect (arbitrary-order DELETE … LIMIT too).
    out = out.replace(
        /DELETE\s+FROM\s+("?[A-Za-z0-9_]+"?)\s+ORDER\s+BY\s+("?[A-Za-z0-9_]+"?(?:\s+(?:ASC|DESC))?)\s+LIMIT\s+(\?|\d+)/gi,
        'DELETE FROM $1 WHERE ctid IN (SELECT ctid FROM $1 ORDER BY $2 LIMIT $3)',
    );

    // DDL type mapping + inline index extraction.
    if (/CREATE\s+TABLE/i.test(out)) {
        out = translateDdlTypes(out);
        out = extractInlineIndexes(out);
    }
    if (/ALTER\s+TABLE/i.test(out)) {
        out = translateDdlTypes(out);
        // ALTER TABLE t ADD INDEX name (cols) has no Postgres form.
        out = out.replace(
            /ALTER\s+TABLE\s+("?[A-Za-z0-9_]+"?)\s+ADD\s+(UNIQUE\s+)?INDEX\s+(IF\s+NOT\s+EXISTS\s+)?([A-Za-z0-9_]+)\s*\(([^)]+)\)/gi,
            (_all, table, unique, _ifne, name, cols) =>
                `CREATE ${unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS ${name} ON ${table} (${cols})`,
        );
    }

    // Placeholders last, so every ? added/kept above gets numbered.
    out = numberPlaceholders(out);
    return out;
}

export interface DbAdapter {
    dialect: SqlDialect;
    query(sql: string, params?: any[], opts?: TranslateOptions): Promise<any>;
}

/**
 * Postgres folds unquoted identifiers to lowercase, so `SELECT sessionId`
 * comes back as `row.sessionid` — but every plugin reads camelCase keys.
 * We restore them by harvesting the camelCase identifiers from the query
 * itself (plus every column name seen in translated DDL) and renaming the
 * lowercase row keys back. The corpus uses consistent spellings, so the
 * lower→camel mapping is unambiguous.
 */
const IDENTIFIER_MAP = new Map<string, string>(); // lower → original

function harvestIdentifiers(sql: string): void {
    for (const m of sql.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
        const tok = m[0];
        if (/[A-Z]/.test(tok) && /[a-z]/.test(tok)) {
            IDENTIFIER_MAP.set(tok.toLowerCase(), tok);
        }
    }
}

function restoreRowKeys(rows: any): any {
    if (!Array.isArray(rows)) return rows;
    return rows.map(row => {
        if (!row || typeof row !== 'object') return row;
        let changed = false;
        const out: any = {};
        for (const k of Object.keys(row)) {
            const camel = IDENTIFIER_MAP.get(k);
            if (camel && camel !== k && !(camel in row)) {
                out[camel] = row[k];
                changed = true;
            } else {
                out[k] = row[k];
            }
        }
        return changed ? out : row;
    });
}

/**
 * Wrap a TypeORM DataSource (`connection.rawConnection`) in a
 * dialect-translating `query()`. Multi-statement strings produced by the
 * translator (inline-index extraction) are split and run sequentially on
 * Postgres; the result of the FIRST statement is returned.
 */
const ADAPTER_CACHE = new WeakMap<object, DbAdapter>();

/** Memoized `createDbAdapter` — safe to call inline at every query site. */
export function adapterFor(rawConnection: {
    options?: { type?: string };
    query(sql: string, params?: any[]): Promise<any>;
}): DbAdapter {
    let a = ADAPTER_CACHE.get(rawConnection);
    if (!a) {
        a = createDbAdapter(rawConnection);
        ADAPTER_CACHE.set(rawConnection, a);
    }
    return a;
}

export function createDbAdapter(rawConnection: {
    options?: { type?: string };
    query(sql: string, params?: any[]): Promise<any>;
}): DbAdapter {
    const dialect = dialectOf(rawConnection);
    return {
        dialect,
        async query(sql: string, params?: any[], opts?: TranslateOptions): Promise<any> {
            if (dialect !== 'postgres') {
                return rawConnection.query(sql, params);
            }
            harvestIdentifiers(sql);
            let translated = translateSql(sql, dialect, opts);
            if (/;\s*CREATE (UNIQUE )?INDEX/i.test(translated)) {
                const parts = translated.split(/;\s*(?=CREATE (?:UNIQUE )?INDEX)/i);
                const first = await rawConnection.query(parts[0], params);
                for (const extra of parts.slice(1)) {
                    await rawConnection.query(extra.replace(/;\s*$/, ''));
                }
                return first;
            }
            if (opts?.needInsertId || opts?.needAffected) {
                if (!/RETURNING/i.test(translated)) {
                    translated = translated.replace(/;?\s*$/, opts.needInsertId ? ' RETURNING id' : ' RETURNING 1');
                }
                const rows = await rawConnection.query(translated, params);
                return {
                    insertId: rows?.[0]?.id,
                    affectedRows: Array.isArray(rows) ? rows.length : 0,
                };
            }
            return restoreRowKeys(await rawConnection.query(translated, params));
        },
    };
}

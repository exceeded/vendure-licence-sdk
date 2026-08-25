import { describe, expect, it } from 'vitest';
import { translateSql, dialectOf } from '../src/sql-dialect';

const pg = (sql: string, opts?: any) => translateSql(sql, 'postgres', opts);

describe('dialectOf', () => {
    it('maps types', () => {
        expect(dialectOf({ options: { type: 'postgres' } })).toBe('postgres');
        expect(dialectOf({ options: { type: 'mariadb' } })).toBe('mysql');
        expect(dialectOf({ options: { type: 'mysql' } })).toBe('mysql');
        expect(dialectOf({} as any)).toBe('mysql');
    });
});

describe('mysql passthrough', () => {
    it('returns sql byte-identical on mysql', () => {
        const sql = "SELECT `a` FROM `order` WHERE x = ? AND createdAt > DATE_SUB(NOW(), INTERVAL ? DAY)";
        expect(translateSql(sql, 'mysql')).toBe(sql);
    });
});

describe('postgres translation', () => {
    it('backticks → double quotes', () => {
        expect(pg('SELECT `a` FROM `order`')).toBe('SELECT "a" FROM "order"');
    });

    it('? → $n, skipping string literals', () => {
        expect(pg("SELECT * FROM t WHERE a = ? AND b = 'x?y' AND c = ?"))
            .toBe("SELECT * FROM t WHERE a = $1 AND b = 'x?y' AND c = $2");
    });

    it('DATE_SUB with placeholder', () => {
        expect(pg('WHERE createdAt > DATE_SUB(NOW(), INTERVAL ? DAY)'))
            .toBe('WHERE createdAt > (NOW() - make_interval(days => $1))');
    });

    it('DATE_SUB with literal + hours', () => {
        expect(pg('WHERE t > DATE_SUB(NOW(), INTERVAL 24 HOUR)'))
            .toBe('WHERE t > (NOW() - make_interval(hours => 24))');
    });

    it('DATE_ADD', () => {
        expect(pg('SELECT DATE_ADD(NOW(), INTERVAL 7 DAY)'))
            .toBe('SELECT (NOW() + make_interval(days => 7))');
    });

    it('INSERT IGNORE → ON CONFLICT DO NOTHING', () => {
        expect(pg('INSERT IGNORE INTO t (a) VALUES (?)'))
            .toBe('INSERT INTO t (a) VALUES ($1) ON CONFLICT DO NOTHING');
    });

    it('ON DUPLICATE KEY UPDATE → ON CONFLICT DO UPDATE', () => {
        const sql = 'INSERT INTO cfg (channelId, a, b) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE a=VALUES(a), b=VALUES(b)';
        expect(pg(sql, { conflictColumns: ['channelId'] }))
            .toBe('INSERT INTO cfg (channelId, a, b) VALUES ($1, $2, $3) ON CONFLICT (channelId) DO UPDATE SET a=EXCLUDED.a, b=EXCLUDED.b');
    });

    it('ON DUPLICATE without conflictColumns throws', () => {
        expect(() => pg('INSERT INTO t (a) VALUES (1) ON DUPLICATE KEY UPDATE a=VALUES(a)')).toThrow(/conflictColumns/);
    });

    it('COUNT/SUM casts', () => {
        expect(pg('SELECT COUNT(*) AS n, SUM(total) AS s FROM t'))
            .toBe('SELECT COUNT(*)::int AS n, SUM(total)::float8 AS s FROM t');
    });

    it('GROUP_CONCAT plain and with ORDER BY/SEPARATOR', () => {
        expect(pg('SELECT GROUP_CONCAT(name) FROM t'))
            .toBe("SELECT STRING_AGG((name)::text, ',') FROM t");
        expect(pg("SELECT GROUP_CONCAT(ve.url ORDER BY ve.createdAt ASC SEPARATOR '|') FROM t"))
            .toBe("SELECT STRING_AGG((ve.url)::text, '|' ORDER BY ve.createdAt ASC) FROM t");
    });

    it('SUBSTRING_INDEX nested → split_part', () => {
        expect(pg("SELECT SUBSTRING_INDEX(SUBSTRING_INDEX(meta, ':', -1), ',', 1) FROM t"))
            .toBe("SELECT split_part(split_part(meta, ':', -1), ',', 1) FROM t");
    });

    it('IF → CASE WHEN', () => {
        expect(pg("SELECT IF(referrerDomain IS NOT NULL, 'referral', 'none') FROM t"))
            .toBe("SELECT CASE WHEN referrerDomain IS NOT NULL THEN 'referral' ELSE 'none' END FROM t");
    });

    it('AS UNSIGNED → AS BIGINT', () => {
        expect(pg('SELECT CAST(x AS UNSIGNED) FROM t')).toBe('SELECT CAST(x AS BIGINT) FROM t');
    });

    it('TIMESTAMPDIFF SECOND', () => {
        expect(pg('SELECT TIMESTAMPDIFF(SECOND, MIN(createdAt), MAX(createdAt)) FROM t'))
            .toBe('SELECT (EXTRACT(EPOCH FROM (MAX(createdAt) - MIN(createdAt))))::int FROM t');
    });

    it('DDL: AUTO_INCREMENT, TINYINT, DATETIME, inline INDEX extraction', () => {
        const ddl = `CREATE TABLE IF NOT EXISTS review_log (
                id INT AUTO_INCREMENT PRIMARY KEY,
                enabled TINYINT NOT NULL DEFAULT 0,
                createdAt DATETIME NOT NULL,
                INDEX idx_rl_order (orderId),
                INDEX idx_rl_email (email, createdAt)
            )`;
        const out = pg(ddl);
        expect(out).toContain('BIGSERIAL PRIMARY KEY');
        expect(out).toContain('SMALLINT NOT NULL DEFAULT 0');
        expect(out).toContain('TIMESTAMP NOT NULL');
        expect(out).not.toMatch(/INDEX idx_rl_order \(orderId\),/);
        expect(out).toContain('CREATE INDEX IF NOT EXISTS idx_rl_order ON review_log (orderId)');
        expect(out).toContain('CREATE INDEX IF NOT EXISTS idx_rl_email ON review_log (email, createdAt)');
    });
});

describe('postgres translation — round 2', () => {
    it('UPDATE alias SET alias.col strips alias in SET only', () => {
        const sql = "UPDATE abandoned_cart ac SET ac.status = 'converted', ac.recoveredAt = NOW() WHERE ac.status = 'abandoned' AND EXISTS (SELECT 1 FROM visitor_event ve WHERE ve.sessionId = ac.sessionId)";
        const out = translateSql(sql, 'postgres');
        expect(out).toContain("SET status = 'converted', recoveredAt = NOW()");
        expect(out).toContain("WHERE ac.status = 'abandoned'");
        expect(out).toContain('ve.sessionId = ac.sessionId');
    });

    it('DELETE ORDER BY LIMIT → ctid subselect', () => {
        expect(translateSql('DELETE FROM `visitor_event` ORDER BY `createdAt` ASC LIMIT ?', 'postgres'))
            .toBe('DELETE FROM "visitor_event" WHERE ctid IN (SELECT ctid FROM "visitor_event" ORDER BY "createdAt" ASC LIMIT $1)');
    });

    it('NOW(3) → NOW()', () => {
        expect(translateSql('UPDATE t SET lastUpdated = NOW(3) WHERE id = ?', 'postgres'))
            .toBe('UPDATE t SET lastUpdated = NOW() WHERE id = $1');
    });

    it('ON UPDATE CURRENT_TIMESTAMP stripped from DDL', () => {
        const out = translateSql('CREATE TABLE IF NOT EXISTS s (updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP)', 'postgres');
        expect(out).toBe('CREATE TABLE IF NOT EXISTS s (updatedAt TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)');
    });

    it('upsert with non-VALUES assignment (increment)', () => {
        const out = translateSql(
            'INSERT INTO product_co_view (a, b, viewsTogether) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE viewsTogether = viewsTogether + 1, lastUpdated = NOW(3)',
            'postgres', { conflictColumns: ['a', 'b'] });
        expect(out).toBe('INSERT INTO product_co_view (a, b, viewsTogether) VALUES ($1, $2, 1) ON CONFLICT (a, b) DO UPDATE SET viewsTogether = viewsTogether + 1, lastUpdated = NOW()');
    });
});

describe('adapter row-key restoration (postgres)', () => {
    it('renames lowercase pg keys back to the camelCase used in the query', async () => {
        const { createDbAdapter } = await import('../src/sql-dialect');
        const fake = {
            options: { type: 'postgres' },
            query: async () => [{ sessionid: 's1', firsturl: '/a', plainlower: 1 }],
        };
        const db = createDbAdapter(fake as any);
        const rows = await db.query('SELECT sessionId, x AS firstUrl, plainlower FROM visitor_event');
        expect(rows[0].sessionId).toBe('s1');
        expect(rows[0].firstUrl).toBe('/a');
        expect(rows[0].plainlower).toBe(1);
        expect(rows[0]).not.toHaveProperty('sessionid');
    });

    it('mysql path is a pure passthrough', async () => {
        const { createDbAdapter } = await import('../src/sql-dialect');
        let seen = '';
        const fake = { options: { type: 'mariadb' }, query: async (s: string) => { seen = s; return [{ a: 1 }]; } };
        const db = createDbAdapter(fake as any);
        await db.query('SELECT `a` FROM t WHERE x = ?', [1]);
        expect(seen).toBe('SELECT `a` FROM t WHERE x = ?');
    });
});

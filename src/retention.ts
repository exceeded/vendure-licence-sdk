import { Logger } from '@vendure/core';

const loggerCtx = 'LicenceSdk:Retention';

export interface RetentionOptions {
    /**
     * Maximum age in days. Rows older than this are deleted by the
     * scheduled sweeper. `null` or `0` keeps everything (no pruning).
     */
    days: number | null;
    /**
     * Optional hard cap on total rows. When the table exceeds this,
     * the oldest rows are pruned regardless of age. `null` disables
     * this safety valve.
     */
    maxRows?: number | null;
    /**
     * How often the sweeper runs, in milliseconds. Default 24h. The
     * sweeper is debounced to one run per process and is `.unref()`d
     * so it doesn't keep the Node event loop alive.
     */
    sweepIntervalMs?: number;
}

/**
 * Schedule a recurring `DELETE FROM <table> WHERE createdAt < ?` sweep
 * that prunes rows older than `opts.days`. Optionally also caps total
 * row count by `opts.maxRows`.
 *
 *   startRetentionSweeper({
 *     getQueryRunner: () => connection.rawConnection,
 *     table: 'email_log',
 *     dateColumn: 'createdAt',
 *     options: { days: 180 },
 *   });
 *
 * Returns a stop function so tests can shut the sweeper down.
 */
export function startRetentionSweeper(input: {
    /** Run a raw SQL query; returns a Promise of any result. Plugins
     *  typically pass `() => connection.rawConnection`. */
    getConnection: () => { query: (sql: string, params?: any[]) => Promise<any> } | null;
    table: string;
    dateColumn?: string;
    options: RetentionOptions;
    /** Optional human-readable plugin name used in log lines. */
    label?: string;
}): () => void {
    const opts = input.options;
    const interval = Math.max(60_000, opts.sweepIntervalMs ?? 24 * 60 * 60 * 1000);
    const dateColumn = input.dateColumn || 'createdAt';
    const label = input.label || input.table;

    if ((!opts.days || opts.days <= 0) && !opts.maxRows) {
        // Nothing to do — caller wants infinite retention.
        return () => undefined;
    }

    let stopped = false;
    let timer: NodeJS.Timeout | null = null;

    const sweep = async () => {
        if (stopped) return;
        const conn = input.getConnection();
        if (!conn) return;
        try {
            if (opts.days && opts.days > 0) {
                const res = await conn.query(
                    `DELETE FROM \`${input.table}\` WHERE \`${dateColumn}\` < DATE_SUB(NOW(), INTERVAL ? DAY)`,
                    [opts.days],
                );
                const affected = (res?.affectedRows ?? res?.[1] ?? 0) as number;
                if (affected) {
                    Logger.info(`[${label}] pruned ${affected} row(s) older than ${opts.days}d`, loggerCtx);
                }
            }
            if (opts.maxRows && opts.maxRows > 0) {
                const countRows = await conn.query(`SELECT COUNT(*) AS n FROM \`${input.table}\``);
                const total = Number(countRows?.[0]?.n ?? 0);
                const over = total - opts.maxRows;
                if (over > 0) {
                    // Delete the `over` oldest rows.
                    const res = await conn.query(
                        `DELETE FROM \`${input.table}\` ORDER BY \`${dateColumn}\` ASC LIMIT ?`,
                        [over],
                    );
                    const affected = (res?.affectedRows ?? res?.[1] ?? 0) as number;
                    Logger.info(`[${label}] pruned ${affected} oldest row(s) — cap=${opts.maxRows}`, loggerCtx);
                }
            }
        } catch (e: any) {
            Logger.warn(`[${label}] retention sweep failed: ${e?.message}`, loggerCtx);
        }
    };

    // First sweep 60s after start (don't slow boot), then on the interval.
    setTimeout(() => { void sweep(); }, 60_000);
    timer = setInterval(() => { void sweep(); }, interval);
    if (typeof timer.unref === 'function') timer.unref();

    return () => {
        stopped = true;
        if (timer) {
            clearInterval(timer);
            timer = null;
        }
    };
}

/**
 * Persistence for licence keys activated from the admin UI.
 *
 * Historically the only way to licence a plugin was the `licenceKey`
 * init option (an env var), which means editing `.env` and redeploying
 * — the single biggest drop-off between "bought a key" and "running
 * licensed". With this store a key pasted into the plugin's admin UI
 * is verified at runtime, applied immediately, and persisted so it
 * survives restarts.
 *
 * All HULO plugins share ONE table (`hulo_licence_store`, one row per
 * pluginId) so a store admin who buys three plugins sees one coherent
 * mechanism. The store never validates keys itself — callers verify
 * with `verifyLicence()` BEFORE saving, so only keys that validated at
 * least once are ever persisted.
 *
 * Precedence at boot: a stored admin-activated key is only applied when
 * the init-option/env key is absent or invalid — an explicitly
 * configured env key always wins.
 */

export type SqlQueryFn = (sql: string, params?: any[]) => Promise<any>;

const TABLE_DDL = `
    CREATE TABLE IF NOT EXISTS hulo_licence_store (
        pluginId VARCHAR(128) PRIMARY KEY,
        licenceKey TEXT NOT NULL,
        updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )`;

export class LicenceStore {
    constructor(private readonly query: SqlQueryFn) {}

    /** Idempotent; call once at service init. Never throws — a store
     *  failure must not stop the host booting. */
    async ensureTable(): Promise<void> {
        try { await this.query(TABLE_DDL); } catch { /* fail-soft */ }
    }

    async load(pluginId: string): Promise<string | null> {
        try {
            const rows = await this.query(
                'SELECT licenceKey FROM hulo_licence_store WHERE pluginId = ?', [pluginId]);
            const key = rows?.[0]?.licenceKey;
            return typeof key === 'string' && key.length > 0 ? key : null;
        } catch {
            return null;
        }
    }

    /** Persist a key the caller has ALREADY verified. */
    async save(pluginId: string, licenceKey: string): Promise<void> {
        await this.query(
            'INSERT INTO hulo_licence_store (pluginId, licenceKey) VALUES (?, ?) ' +
            'ON DUPLICATE KEY UPDATE licenceKey = VALUES(licenceKey)',
            [pluginId, licenceKey]);
    }

    async clear(pluginId: string): Promise<void> {
        await this.query('DELETE FROM hulo_licence_store WHERE pluginId = ?', [pluginId]);
    }
}

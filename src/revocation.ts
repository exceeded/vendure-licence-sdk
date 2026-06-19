import { Logger } from '@vendure/core';

const loggerCtx = 'LicenceSdk:Revocation';

interface RevocationListResponse {
    revoked: string[];
    /** When the list was last updated server-side. */
    updatedAt?: string;
}

/**
 * Periodically polls the HULO revocation endpoint and exposes the
 * latest set of revoked licence ids. Each plugin instantiates one
 * `RevocationChecker` at boot and reads `getRevokedIds()` whenever it
 * re-verifies (which is cheap because the JWT check is already
 * cached).
 *
 * Failures (network, 500s) keep the previous cached set in memory so a
 * brief outage at HULO never disables paid features at the customer's
 * end. The cache is wiped only when a fresh list arrives.
 */
export class RevocationChecker {
    private revokedIds = new Set<string>();
    private timer: NodeJS.Timeout | null = null;
    private lastFetchedAt: Date | null = null;
    private lastError: string | null = null;

    constructor(
        private readonly url: string,
        private readonly pollMs: number = 7 * 24 * 60 * 60 * 1000, // 7 days
    ) {}

    /** Start the background poll. Idempotent. */
    start(): void {
        if (this.timer) return;
        // Run the first refresh on the next tick so the host can finish
        // bootstrapping; subsequent refreshes follow the poll interval.
        setTimeout(() => this.refresh().catch(() => undefined), 5_000);
        this.timer = setInterval(() => this.refresh().catch(() => undefined), this.pollMs);
        // Don't keep the Node event loop alive purely for licence polling.
        if (typeof this.timer.unref === 'function') this.timer.unref();
    }

    /** Stop the background poll. Useful for tests and graceful shutdown. */
    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    getRevokedIds(): Set<string> {
        return this.revokedIds;
    }

    getStatus(): { lastFetchedAt: Date | null; count: number; lastError: string | null } {
        return {
            lastFetchedAt: this.lastFetchedAt,
            count: this.revokedIds.size,
            lastError: this.lastError,
        };
    }

    /** Force an immediate refresh — useful from a CLI / admin button. */
    async refresh(): Promise<void> {
        try {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 10_000);
            const res = await fetch(this.url, { signal: controller.signal });
            clearTimeout(t);
            if (!res.ok) {
                this.lastError = `HTTP ${res.status}`;
                Logger.warn(`Revocation fetch failed: ${this.lastError}`, loggerCtx);
                return;
            }
            const body = await res.json() as RevocationListResponse;
            if (!body || !Array.isArray(body.revoked)) {
                this.lastError = 'malformed response';
                Logger.warn(`Revocation list malformed`, loggerCtx);
                return;
            }
            this.revokedIds = new Set(body.revoked.map(String));
            this.lastFetchedAt = new Date();
            this.lastError = null;
        } catch (e: any) {
            this.lastError = e?.message || 'fetch failed';
            // Soft failure — keep the previously cached set in place.
            Logger.warn(`Revocation fetch error: ${this.lastError}`, loggerCtx);
        }
    }
}

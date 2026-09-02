/**
 * Buy-from-the-admin with automatic licence installation.
 *
 * Flow:
 *   1. The admin clicks "Buy licence" in the plugin's admin page. The
 *      plugin calls `createPurchaseLink(plan)`, which mints a random
 *      claim token, persists it (one row per plugin in the shared
 *      `hulo_licence_claim` table) and returns the HULO buy-page URL
 *      carrying `instance=<evaluation instance id>&claim=<token>`.
 *   2. Stripe Checkout completes → the licence server mints the licence
 *      and records the claim token + instance id against it.
 *   3. This client polls `POST /licence/claim` with {plugin, instanceId,
 *      claim}. While the purchase is unfinished the server answers
 *      `pending`; once minted it returns the signed key, which the
 *      plugin verifies with the SAME checks as a pasted key and then
 *      persists via its LicenceStore — no email round-trip, no .env edit.
 *   4. After installation the claim stays on file and is re-checked once
 *      a day, so a subscription renewal (which mints a fresh JWT on the
 *      server) lands in the plugin automatically too.
 *
 * The claim token is only ever released to a request presenting BOTH the
 * token and the matching instance id, and the server only holds it on
 * the record it was purchased with. Everything here is fail-soft: a
 * network or SQL failure never throws into the host.
 */
import { createHash, randomBytes } from 'crypto';
import type { SqlQueryFn } from './licence-store';

export type PurchasePlan = 'monthly' | 'annual' | 'lifetime';

export interface PurchaseClaimOptions {
    /** e.g. '@huloglobal/vendure-plugin-review-requests' */
    packageName: string;
    /** Stable per-install id (the evaluation client's instance id). */
    instanceId: () => string | null;
    /** SQL runner (the same one the plugin hands to LicenceStore). */
    query: SqlQueryFn;
    /** Verify + apply + persist a key. Return true only when it validated. */
    onLicence: (key: string) => Promise<boolean>;
    /** Override the HULO buy page base (default https://elite.charity/licence/buy). */
    buyBase?: string;
    /** Override the claim endpoint (default https://elite.charity/licence/claim). */
    claimEndpoint?: string;
    /** Poll cadence while a purchase is pending (default 30 s). */
    pollIntervalMs?: number;
    /** Give up waiting for an unfinished checkout after this long (default 24 h). */
    pendingTtlMs?: number;
    /** Re-check an installed claim this often for renewed keys (default 24 h). */
    refreshIntervalMs?: number;
}

export interface PurchaseClaimStatus {
    state: 'none' | 'pending' | 'installed' | 'expired';
    plan?: PurchasePlan;
    createdAt?: string;
    installedAt?: string;
    lastCheckedAt?: string;
    url?: string;
    message?: string;
}

const DEFAULT_BUY_BASE = 'https://elite.charity/licence/buy';
const DEFAULT_CLAIM_ENDPOINT = 'https://elite.charity/licence/claim';

const TABLE_DDL = `
    CREATE TABLE IF NOT EXISTS hulo_licence_claim (
        pluginId VARCHAR(128) PRIMARY KEY,
        claimToken VARCHAR(64) NOT NULL,
        instanceId VARCHAR(64) NOT NULL,
        plan VARCHAR(16) NOT NULL,
        createdAt DATETIME NOT NULL,
        installedAt DATETIME NULL,
        lastCheckedAt DATETIME NULL,
        keyHash VARCHAR(64) NULL
    )`;

interface ClaimRow {
    pluginId: string;
    claimToken: string;
    instanceId: string;
    plan: PurchasePlan;
    createdAt: Date;
    installedAt: Date | null;
    lastCheckedAt: Date | null;
    keyHash: string | null;
}

function shortId(packageName: string): string {
    return packageName.replace(/^@[^/]+\//, '');
}

function toDate(v: any): Date | null {
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    return isNaN(d.getTime()) ? null : d;
}

export class PurchaseClaimClient {
    private timer: NodeJS.Timeout | null = null;
    private tableReady = false;
    private inFlight = false;

    constructor(private readonly opts: PurchaseClaimOptions) {}

    private get pluginId() { return shortId(this.opts.packageName); }

    async ensureTable(): Promise<void> {
        if (this.tableReady) return;
        try { await this.opts.query(TABLE_DDL); this.tableReady = true; } catch { /* fail-soft */ }
    }

    private async loadRow(): Promise<ClaimRow | null> {
        try {
            await this.ensureTable();
            const rows = await this.opts.query('SELECT * FROM hulo_licence_claim WHERE pluginId = ?', [this.pluginId]);
            const r = rows?.[0];
            if (!r) return null;
            return {
                pluginId: r.pluginId, claimToken: r.claimToken, instanceId: r.instanceId, plan: r.plan,
                createdAt: toDate(r.createdAt) || new Date(0),
                installedAt: toDate(r.installedAt), lastCheckedAt: toDate(r.lastCheckedAt), keyHash: r.keyHash || null,
            };
        } catch {
            return null;
        }
    }

    /** Public buy-page URL for this install; the plan is preselected on the page. */
    buildUrl(claim: string, instanceId: string, plan: PurchasePlan, email?: string): string {
        const base = (this.opts.buyBase || DEFAULT_BUY_BASE).replace(/\/$/, '');
        const q = new URLSearchParams({ plan, instance: instanceId, claim });
        if (email) q.set('email', email);
        return `${base}/${this.pluginId}?${q.toString()}`;
    }

    /** Mint a claim, persist it, start polling, return the buy URL. */
    async createPurchaseLink(plan: PurchasePlan, email?: string): Promise<{ url: string; claim: string }> {
        const instanceId = this.opts.instanceId();
        if (!instanceId) throw new Error('instance id unavailable');
        const claim = randomBytes(24).toString('hex'); // 48 hex chars
        await this.ensureTable();
        await this.opts.query(
            'INSERT INTO hulo_licence_claim (pluginId, claimToken, instanceId, plan, createdAt, installedAt, lastCheckedAt, keyHash) ' +
            'VALUES (?, ?, ?, ?, NOW(), NULL, NULL, NULL) ' +
            'ON DUPLICATE KEY UPDATE claimToken = VALUES(claimToken), instanceId = VALUES(instanceId), plan = VALUES(plan), ' +
            'createdAt = NOW(), installedAt = NULL, lastCheckedAt = NULL, keyHash = NULL',
            [this.pluginId, claim, instanceId, plan],
            { conflictColumns: ['pluginId'] },
        );
        this.startPolling();
        return { url: this.buildUrl(claim, instanceId, plan, email), claim };
    }

    async status(): Promise<PurchaseClaimStatus> {
        const row = await this.loadRow();
        if (!row) return { state: 'none' };
        const ttl = this.opts.pendingTtlMs ?? 24 * 3600_000;
        const state: PurchaseClaimStatus['state'] = row.installedAt
            ? 'installed'
            : (Date.now() - row.createdAt.getTime() > ttl ? 'expired' : 'pending');
        return {
            state, plan: row.plan,
            createdAt: row.createdAt.toISOString(),
            installedAt: row.installedAt?.toISOString(),
            lastCheckedAt: row.lastCheckedAt?.toISOString(),
            url: state === 'pending' ? this.buildUrl(row.claimToken, row.instanceId, row.plan) : undefined,
        };
    }

    /** Ask the licence server once. Installs the key when it is ready. */
    async checkNow(): Promise<PurchaseClaimStatus> {
        if (this.inFlight) return this.status();
        this.inFlight = true;
        try {
            const row = await this.loadRow();
            if (!row) return { state: 'none' };
            const url = this.opts.claimEndpoint || DEFAULT_CLAIM_ENDPOINT;
            let body: any = null;
            try {
                const controller = new AbortController();
                const t = setTimeout(() => controller.abort(), 8_000);
                const resp = await fetch(url, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ plugin: this.opts.packageName, instanceId: row.instanceId, claim: row.claimToken }),
                    signal: controller.signal,
                });
                clearTimeout(t);
                body = resp.ok ? await resp.json().catch(() => null) : null;
            } catch { body = null; }
            try { await this.opts.query('UPDATE hulo_licence_claim SET lastCheckedAt = NOW() WHERE pluginId = ?', [this.pluginId]); } catch { /* ignore */ }

            if (body?.status === 'ready' && typeof body.key === 'string' && body.key.length > 20) {
                const hash = createHash('sha256').update(body.key).digest('hex');
                if (hash !== row.keyHash) {
                    const ok = await this.opts.onLicence(body.key).catch(() => false);
                    if (ok) {
                        await this.opts.query(
                            'UPDATE hulo_licence_claim SET installedAt = COALESCE(installedAt, NOW()), keyHash = ? WHERE pluginId = ?',
                            [hash, this.pluginId]);
                        this.stop();
                        this.scheduleRefresh();
                        const st = await this.status();
                        return { ...st, message: 'Licence installed' };
                    }
                    return { ...(await this.status()), message: body.message || 'The server sent a key that did not validate for this install' };
                }
                return this.status();
            }
            if (body?.status === 'inactive') {
                return { ...(await this.status()), message: body.message || 'This licence is no longer active' };
            }
            const st = await this.status();
            if (st.state === 'expired') this.stop();
            return st;
        } finally {
            this.inFlight = false;
        }
    }

    /** Call once after boot: resumes polling for an unfinished purchase
     *  and schedules the daily renewal check for an installed one. */
    async resume(): Promise<void> {
        const st = await this.status();
        if (st.state === 'pending') this.startPolling();
        else if (st.state === 'installed') this.scheduleRefresh();
    }

    startPolling(): void {
        this.stop();
        const every = this.opts.pollIntervalMs ?? 30_000;
        this.timer = setInterval(() => { void this.checkNow(); }, every);
        (this.timer as any).unref?.();
    }

    private scheduleRefresh(): void {
        this.stop();
        const every = this.opts.refreshIntervalMs ?? 24 * 3600_000;
        this.timer = setInterval(() => { void this.checkNow(); }, every);
        (this.timer as any).unref?.();
    }

    stop(): void {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    /** Stripe billing-portal link (update card, cancel, switch plan) for
     *  the subscription behind this install's licence. Proof of ownership
     *  is the claim (bought from this admin) or, for a pasted/env key, the
     *  signed key itself. Returns null when neither is available or the
     *  licence has no subscription (lifetime, master). */
    async billingPortalUrl(fallbackKey?: string | null): Promise<string | null> {
        const row = await this.loadRow();
        const url = (this.opts.claimEndpoint || DEFAULT_CLAIM_ENDPOINT).replace(/\/claim$/, '/portal-link');
        const body: Record<string, string> = { plugin: this.opts.packageName };
        if (row?.installedAt) { body.instanceId = row.instanceId; body.claim = row.claimToken; }
        else if (fallbackKey) body.key = fallbackKey;
        else return null;
        try {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 8_000);
            const resp = await fetch(url, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify(body), signal: controller.signal,
            });
            clearTimeout(t);
            const j: any = resp.ok ? await resp.json().catch(() => null) : null;
            return typeof j?.url === 'string' && /^https:\/\//.test(j.url) ? j.url : null;
        } catch {
            return null;
        }
    }

    /** Forget the claim (admin deactivated the licence). */
    async clear(): Promise<void> {
        this.stop();
        try { await this.opts.query('DELETE FROM hulo_licence_claim WHERE pluginId = ?', [this.pluginId]); } catch { /* ignore */ }
    }
}

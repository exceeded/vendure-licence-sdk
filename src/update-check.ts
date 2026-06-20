import { Logger } from '@vendure/core';

const loggerCtx = 'LicenceSdk:UpdateCheck';

export interface UpdateStatus {
    packageName: string;
    current: string;
    latest: string | null;
    updateAvailable: boolean;
    /** A "major"-level update is one where the first non-zero version
     *  component changes (semver-friendly for 0.x packages). */
    isMajor: boolean;
    lastCheckedAt: Date | null;
    lastError: string | null;
}

/**
 * Polls the public npm registry for the latest version of a plugin's
 * package and exposes a small status object. Each plugin instantiates
 * one UpdateChecker at boot and surfaces its status via its `/status`
 * endpoint — the admin UI then shows an "update available" banner.
 *
 * Failures (network, 404) keep the previous cached `latest` value in
 * memory so a brief npm outage doesn't make the dashboard misreport.
 * The cache is wiped only when a fresh value arrives.
 */
export class UpdateChecker {
    private latest: string | null = null;
    private timer: NodeJS.Timeout | null = null;
    private lastCheckedAt: Date | null = null;
    private lastError: string | null = null;

    constructor(
        private readonly packageName: string,
        private readonly currentVersion: string,
        private readonly pollMs: number = 24 * 60 * 60 * 1000, // 24h
        private readonly registryUrl: string = 'https://registry.npmjs.org',
    ) {}

    /** Start the background poll. Idempotent. */
    start(): void {
        if (this.timer) return;
        // First check runs 30s after boot so we don't slow down startup.
        setTimeout(() => this.refresh().catch(() => undefined), 30_000);
        this.timer = setInterval(() => this.refresh().catch(() => undefined), this.pollMs);
        if (typeof this.timer.unref === 'function') this.timer.unref();
    }

    stop(): void {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    /** Force a fresh check. Returns the new status. */
    async refresh(): Promise<UpdateStatus> {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 8_000);
        try {
            // The `latest` endpoint is small (a few hundred bytes) and
            // cache-friendly — the registry returns a fresh dist-tags
            // entry without the full package metadata payload.
            const res = await fetch(
                `${this.registryUrl}/${encodeURIComponent(this.packageName)}/latest`,
                { signal: controller.signal, headers: { accept: 'application/json' } },
            );
            if (!res.ok) {
                this.lastError = `npm registry ${res.status}`;
                Logger.warn(`Update check for ${this.packageName} failed: ${this.lastError}`, loggerCtx);
                return this.getStatus();
            }
            const body = await res.json() as { version?: string };
            const next = String(body?.version || '').trim();
            if (!next) {
                this.lastError = 'no version in response';
                return this.getStatus();
            }
            this.latest = next;
            this.lastCheckedAt = new Date();
            this.lastError = null;
        } catch (e: any) {
            this.lastError = e?.message || 'fetch failed';
            Logger.warn(`Update check for ${this.packageName} failed: ${this.lastError}`, loggerCtx);
        } finally {
            clearTimeout(t);
        }
        return this.getStatus();
    }

    getStatus(): UpdateStatus {
        const updateAvailable = !!this.latest && compareVersions(this.latest, this.currentVersion) > 0;
        const isMajor = updateAvailable
            ? isMajorBump(this.currentVersion, this.latest!)
            : false;
        return {
            packageName: this.packageName,
            current: this.currentVersion,
            latest: this.latest,
            updateAvailable,
            isMajor,
            lastCheckedAt: this.lastCheckedAt,
            lastError: this.lastError,
        };
    }
}

/**
 * Tiny semver-ish compare. Treats versions as dot-separated number
 * components; suffix tags (`-rc.1`, `-beta`) sort before the release.
 * Sufficient for our case — both sides come from npm dist-tags.
 */
function compareVersions(a: string, b: string): number {
    const [ah, at] = splitTag(a);
    const [bh, bt] = splitTag(b);
    const ap = ah.split('.').map(n => parseInt(n, 10) || 0);
    const bp = bh.split('.').map(n => parseInt(n, 10) || 0);
    const len = Math.max(ap.length, bp.length);
    for (let i = 0; i < len; i++) {
        const av = ap[i] || 0;
        const bv = bp[i] || 0;
        if (av !== bv) return av - bv;
    }
    // Pre-release sorts BEFORE release (0.2.0-rc.1 < 0.2.0).
    if (at && !bt) return -1;
    if (!at && bt) return 1;
    if (at && bt) return at.localeCompare(bt);
    return 0;
}

function splitTag(v: string): [string, string] {
    const dash = v.indexOf('-');
    return dash === -1 ? [v, ''] : [v.slice(0, dash), v.slice(dash + 1)];
}

/**
 * "Major bump" for the dashboard banner — uses the first non-zero
 * version component as the major identifier (so 0.2.x → 0.3.x is major
 * for 0.x packages, where the user expects breaking changes in 0.y
 * bumps).
 */
function isMajorBump(current: string, next: string): boolean {
    const cp = current.split('.').map(n => parseInt(n, 10) || 0);
    const np = next.split('.').map(n => parseInt(n, 10) || 0);
    // Find the first non-zero index of current.
    let i = 0;
    while (i < cp.length && cp[i] === 0) i++;
    return (cp[i] || 0) !== (np[i] || 0);
}

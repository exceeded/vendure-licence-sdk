import { createHash } from 'crypto';
import { Logger } from '@vendure/core';

const loggerCtx = 'LicenceSdk:Heartbeat';

/**
 * Anti-tamper telemetry.
 *
 * Each plugin starts a `Heartbeat` at boot. Once a day it POSTs:
 *
 *   {
 *     plugin: '@huloglobal/vendure-plugin-geo-block',
 *     version: '0.3.2',
 *     jti: '<licence id, or "unlicensed">',
 *     fingerprint: '<sha256 of public key + verifier source + version>',
 *     uptimeSec: 12345,
 *     ts: 1782120000,
 *   }
 *
 * to `elite.charity/licence/heartbeat`. The server records the
 * fingerprint against the jti. If the fingerprint of a modified
 * install doesn't match a known-good build, we have proof the
 * install has been tampered with — useful for revocation / support
 * triage / spotting bulk piracy.
 *
 * Privacy posture: NO personal data, NO customer data, NO data the
 * plugin sees from the storefront. Just a 96-byte hash + the licence
 * jti the customer already gave us. Disclosed in the Privacy Policy
 * under legitimate interest (anti-piracy).
 *
 * Opt-out: set `HULO_HEARTBEAT_DISABLED=true` in the host env. Useful
 * for genuinely air-gapped deployments. Doing so does NOT disable the
 * licence — it just stops the daily ping. (We don't enforce "must
 * heartbeat" because the privacy promise is "you can run offline".)
 */
export interface HeartbeatOptions {
    /** Full npm package name. */
    packageName: string;
    /** Current version. */
    packageVersion: string;
    /** The licence JWT, if any. The first 32 chars of the jti are
     *  extracted; the rest of the JWT is never sent. */
    licenceKey?: string;
    /** SHA-256 of the embedded public key used by the verifier. */
    publicKeyFingerprint: string;
    /** SHA-256 of the verifier module's source (computed at build
     *  time and embedded in the plugin — used to detect tampering). */
    verifierFingerprint?: string;
    /** Override the endpoint URL. Default `elite.charity/licence/heartbeat`. */
    endpoint?: string;
    /** Override the period. Default 24h. Minimum enforced 1h. */
    intervalMs?: number;
}

const DEFAULT_ENDPOINT = process.env.HULO_LICENCE_HEARTBEAT_URL
    || 'https://elite.charity/licence/heartbeat';

export class Heartbeat {
    private readonly opts: HeartbeatOptions;
    private readonly started = Date.now();
    private timer: NodeJS.Timeout | null = null;
    private stopped = false;

    constructor(opts: HeartbeatOptions) {
        this.opts = opts;
    }

    start(): void {
        if (this.timer) return;
        if (String(process.env.HULO_HEARTBEAT_DISABLED || '').toLowerCase() === 'true') {
            Logger.info(`Heartbeat disabled for ${this.opts.packageName} via HULO_HEARTBEAT_DISABLED`, loggerCtx);
            return;
        }
        // First send 60s after boot (gives the host time to settle).
        setTimeout(() => this.ping().catch(() => undefined), 60_000);
        const interval = Math.max(60 * 60 * 1000, this.opts.intervalMs ?? 24 * 60 * 60 * 1000);
        this.timer = setInterval(() => this.ping().catch(() => undefined), interval);
        if (typeof this.timer.unref === 'function') this.timer.unref();
    }

    stop(): void {
        this.stopped = true;
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    private async ping(): Promise<void> {
        if (this.stopped) return;
        const url = this.opts.endpoint || DEFAULT_ENDPOINT;
        const fingerprint = createHash('sha256')
            .update(this.opts.packageName + '|' + this.opts.packageVersion + '|' + (this.opts.publicKeyFingerprint || '') + '|' + (this.opts.verifierFingerprint || ''))
            .digest('hex');
        const jti = this.extractJti(this.opts.licenceKey) || 'unlicensed';
        const body = JSON.stringify({
            plugin: this.opts.packageName,
            version: this.opts.packageVersion,
            jti,
            fingerprint,
            uptimeSec: Math.round((Date.now() - this.started) / 1000),
            ts: Math.floor(Date.now() / 1000),
        });
        try {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 8_000);
            await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body,
                signal: controller.signal,
            }).catch(() => undefined);
            clearTimeout(t);
        } catch {
            // Heartbeat MUST NEVER take down the host. Swallow everything.
        }
    }

    /** Read the `jti` claim out of a JWT without verifying — only used
     *  as an identifier for telemetry. */
    private extractJti(jwt: string | undefined): string | null {
        if (!jwt) return null;
        try {
            const middle = jwt.split('.')[1] || '';
            const payload = JSON.parse(Buffer.from(middle.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
            return typeof payload?.jti === 'string' ? payload.jti.slice(0, 32) : null;
        } catch {
            return null;
        }
    }
}

/** Helper for plugins that embed a public key as a string constant.
 *  Returns the hex SHA-256 of that string. Build-time fingerprinting. */
export function fingerprintPublicKey(pem: string): string {
    return createHash('sha256').update(pem).digest('hex');
}

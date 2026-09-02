/**
 * Server-anchored evaluation ("full-featured trial") for unlicensed
 * installs.
 *
 * Without a licence key a plugin no longer sits in the degraded free
 * tier from day one. Instead it registers this install with the HULO
 * licence server and receives an evaluation clock: N days (default 14)
 * of the FULL feature set, after which the plugin drops to the free
 * tier it has today. The clock is computed **server-side**, keyed on a
 * stable hashed instance id, so wiping local state or reinstalling the
 * package does not restart the trial.
 *
 * Privacy: the only identifier sent is a SHA-256 of hostname+platform —
 * no raw hostname, no IPs, no emails. Same policy as the heartbeat.
 *
 * Fail-open by design: if the licence server is unreachable the plugin
 * behaves as if the evaluation is active (`daysRemaining: null`). Our
 * outage must never brick a customer's store. The response is cached
 * in memory and refreshed daily.
 */
import { createHash } from 'crypto';
import { hostname, platform } from 'os';
import { Logger } from '@vendure/core';

const loggerCtx = 'HuloLicence';

const DEFAULT_ENDPOINT = process.env.HULO_LICENCE_EVAL_URL
    || 'https://elite.charity/licence/eval/register';

export interface EvaluationState {
    /** True while the full feature set should stay enabled. */
    active: boolean;
    /** Whole days remaining, or null when unknown (server unreachable). */
    daysRemaining: number | null;
    /** ISO date the evaluation ends, when known. */
    endsAt: string | null;
    /** 'server' once a server response has been applied, else 'fallback'. */
    source: 'server' | 'fallback';
}

/** Optional anonymous usage aggregates (numbers only) included with the
 *  daily registration ping — e.g. {invitesSent: 34}. The licence server
 *  uses them to personalise the reminder emails the admin opted into.
 *  Never include personal data. */
export type EvalStatsProvider = () => Promise<Record<string, number>> | Record<string, number>;

export interface EvaluationClientOptions {
    /** Full npm package name, e.g. "@huloglobal/vendure-plugin-x". */
    packageName: string;
    packageVersion: string;
    /** Override the register endpoint (tests / self-hosted). */
    endpoint?: string;
    /** Re-poll period. Default 24h, minimum 1h. */
    intervalMs?: number;
}

/** Stable, non-reversible identifier for this host. */
export function evalInstanceId(): string {
    return createHash('sha256')
        .update(hostname() + '|' + platform())
        .digest('hex')
        .slice(0, 32);
}

export class EvaluationClient {
    private readonly opts: EvaluationClientOptions;
    // Fail-closed: premium is only ever granted by an explicit 'eval'
    // answer from the licence server (which, since the card-backed trial,
    // it no longer gives — trials mint real licences instead).
    private state: EvaluationState = { active: false, daysRemaining: null, endsAt: null, source: 'fallback' };
    private timer: NodeJS.Timeout | null = null;
    private lastWarnDay: number | null = null;
    private statsProvider: EvalStatsProvider | null = null;

    constructor(opts: EvaluationClientOptions) {
        this.opts = opts;
    }

    getState(): EvaluationState {
        return this.state;
    }

    /** The instance id this client registers under (also used by the
     *  admin-UI "remind me" lead capture so server records join up). */
    getInstanceId(): string {
        return evalInstanceId();
    }

    /** Install the stats provider after boot (the client is created at
     *  plugin init, before services exist). */
    setStatsProvider(fn: EvalStatsProvider): void {
        this.statsProvider = fn;
    }

    start(): void {
        if (this.timer) return;
        // First check shortly after boot; then daily.
        setTimeout(() => this.check().catch(() => undefined), 15_000);
        const interval = Math.max(60 * 60 * 1000, this.opts.intervalMs ?? 24 * 60 * 60 * 1000);
        this.timer = setInterval(() => this.check().catch(() => undefined), interval);
        if (typeof this.timer.unref === 'function') this.timer.unref();
    }

    stop(): void {
        if (this.timer) { clearInterval(this.timer); this.timer = null; }
    }

    /** Exposed for tests; normally driven by the internal timer. */
    async check(): Promise<EvaluationState> {
        const url = this.opts.endpoint || DEFAULT_ENDPOINT;
        try {
            const controller = new AbortController();
            const t = setTimeout(() => controller.abort(), 8_000);
            let stats: Record<string, number> | undefined;
            if (this.statsProvider) {
                try { stats = await this.statsProvider(); } catch { /* stats are best-effort */ }
            }
            const resp = await fetch(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    plugin: this.opts.packageName,
                    version: this.opts.packageVersion,
                    instanceId: evalInstanceId(),
                    ts: Math.floor(Date.now() / 1000),
                    ...(stats ? { stats } : {}),
                }),
                signal: controller.signal,
            });
            clearTimeout(t);
            if (resp && resp.ok) {
                const j: any = await resp.json().catch(() => null);
                if (j && (j.status === 'eval' || j.status === 'expired')) {
                    this.state = {
                        active: j.status === 'eval',
                        daysRemaining: typeof j.daysRemaining === 'number' ? j.daysRemaining : null,
                        endsAt: typeof j.endsAt === 'string' ? j.endsAt : null,
                        source: 'server',
                    };
                    this.logProgress();
                }
            }
        } catch {
            // Unreachable → keep last known state. Never throw.
        }
        return this.state;
    }

    /** Low-noise nudges in the host's server log: one line per day at
     *  most, only in the final 3 days and after expiry. */
    private logProgress(): void {
        const d = this.state.daysRemaining;
        const today = Math.floor(Date.now() / 86_400_000);
        if (this.lastWarnDay === today) return;
        if (!this.state.active) {
            this.lastWarnDay = today;
            Logger.warn(
                `${this.opts.packageName}: evaluation period has ended — now running in the free tier. ` +
                `Keep the full feature set: https://elite.charity/licence/buy/${shortId(this.opts.packageName)}`,
                loggerCtx,
            );
        } else if (typeof d === 'number' && d <= 3) {
            this.lastWarnDay = today;
            Logger.warn(
                `${this.opts.packageName}: ${d} day${d === 1 ? '' : 's'} left of the full-featured evaluation. ` +
                `After that the plugin drops to the free tier. https://elite.charity/licence/buy/${shortId(this.opts.packageName)}`,
                loggerCtx,
            );
        }
    }
}

function shortId(packageName: string): string {
    return packageName.replace(/^@[^/]+\//, '');
}

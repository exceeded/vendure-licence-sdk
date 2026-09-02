import type { LicenceStatus } from './types';

/** Admin-facing summary of a verified licence (what the "Licence &
 *  billing" card shows). Null when there is no valid licence. */
export interface LicenceSummary {
    plan: string | null;
    customer: string | null;
    /** ISO date the current key expires (subscriptions get a fresh key on renewal). */
    expiresAt: string | null;
    /** ISO date the card-backed free trial ends (first charge), when on trial. */
    trialEndsAt: string | null;
    /** A master licence (pluginId '*') covering every HULO plugin. */
    master: boolean;
    jti: string | null;
}

export function describeLicence(status: LicenceStatus | null | undefined): LicenceSummary | null {
    const p: any = status?.valid ? status.payload : null;
    if (!p) return null;
    const iso = (sec: unknown) => (typeof sec === 'number' && sec > 0 ? new Date(sec * 1000).toISOString() : null);
    return {
        plan: typeof p.plan === 'string' ? p.plan : null,
        customer: typeof p.customer === 'string' ? p.customer : null,
        expiresAt: iso(p.exp),
        trialEndsAt: iso(p.trialEnd),
        master: p.pluginId === '*',
        jti: typeof p.jti === 'string' ? p.jti : null,
    };
}

/**
 * Tier gating — used by every plugin to decide whether a code path
 * runs in the **paid** mode or the **free / unlicensed** mode.
 *
 *   import { isLicensed } from '@huloglobal/vendure-licence-sdk';
 *
 *   if (!isLicensed(status)) {
 *       return res.status(402).json({ error: 'Premium feature' });
 *   }
 *
 * This module is small on purpose. The whole *point* of tier gating is
 * that the check is repeated in many places. Each plugin imports
 * `isLicensed` and sprinkles it through every premium code path —
 * commenting out one line no longer unlocks anything.
 *
 * `tierOf(status)` returns either `'paid'` (valid licence) or `'free'`
 * (no licence, expired, revoked, domain-mismatch, or any other invalid
 * state). Plugins should treat `'free'` as a permanently-degraded mode
 * — clear in the admin UI, not a temporary failure.
 */
import { LicenceStatus } from './types';
import { EvaluationState } from './evaluation';

export type Tier = 'paid' | 'free';

/** Tier including the server-anchored evaluation window: 'trial' gets
 *  the full paid feature set until the evaluation clock runs out. */
export type EffectiveTier = 'paid' | 'trial' | 'free';

export function isLicensed(status: LicenceStatus | null | undefined): boolean {
    return !!(status && status.valid);
}

export function tierOf(status: LicenceStatus | null | undefined): Tier {
    return isLicensed(status) ? 'paid' : 'free';
}

/**
 * Tier with the evaluation window applied. Plugins that adopt the
 * evaluation flow should gate premium paths on
 * `hasPremiumAccess(status, evalState)` instead of `isLicensed(status)`:
 * licensed installs and installs inside their evaluation window both
 * get the full feature set; everyone else is 'free'.
 */
export function effectiveTierOf(
    status: LicenceStatus | null | undefined,
    evalState?: EvaluationState | null,
): EffectiveTier {
    if (isLicensed(status)) return 'paid';
    if (evalState && evalState.active) return 'trial';
    return 'free';
}

export function hasPremiumAccess(
    status: LicenceStatus | null | undefined,
    evalState?: EvaluationState | null,
): boolean {
    return effectiveTierOf(status, evalState) !== 'free';
}

/**
 * 402 Payment Required body the plugins return when a premium endpoint
 * is hit unlicensed. Centralised so the customer sees one consistent
 * message regardless of which plugin emitted it.
 */
export function premiumFeatureError(plugin: string): {
    error: 'premium-feature';
    plugin: string;
    message: string;
    buyUrl: string;
} {
    return {
        error: 'premium-feature',
        plugin,
        message:
            `This is a paid feature of ${plugin}. ` +
            `It is disabled in unlicensed mode. Buy a licence to enable it.`,
        buyUrl: `https://elite.charity/licence/buy/${plugin}`,
    };
}

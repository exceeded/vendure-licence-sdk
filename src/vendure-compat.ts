/**
 * Runtime Vendure-version compatibility check.
 *
 * Peer-dep ranges warn at install time. This module warns at BOOT
 * time — the difference matters, because a monorepo `yarn install`
 * might succeed while the actual `@vendure/core` version at runtime
 * is outside the range the plugin was tested against.
 *
 * We test our HULO plugins against the range documented as
 * `SUPPORTED_VENDURE_RANGE` on each plugin. If the runtime version
 * is inside that range we say nothing. If outside, we log a helpful
 * warning telling the operator exactly what to do — but we DO NOT
 * throw. The plugin still boots and works; the operator just knows
 * they're on an untested version and support is best-effort.
 */
import { Logger } from '@vendure/core';

/** Semver-lite range check for `>=A.B.C <X.Y.Z` style strings.
 *  Doesn't do the full spec — just what our plugins need. */
export function isVendureVersionCompatible(
    detected: string,
    range: { min: string; max: string },
): boolean {
    const dv = parseVersion(detected);
    const mn = parseVersion(range.min);
    const mx = parseVersion(range.max);
    if (!dv || !mn || !mx) return true; // fail-open: don't scream on unparseable
    return cmp(dv, mn) >= 0 && cmp(dv, mx) < 0;
}

/**
 * Emit a boot-time compatibility warning if the running
 * `@vendure/core` version is outside the plugin's tested range.
 *
 * Safe to call from a plugin's `onApplicationBootstrap`. Idempotent:
 * calling it twice on the same package emits one warning.
 */
const _warned = new Set<string>();
export function warnIfIncompatibleVendure(input: {
    pluginPackageName: string;
    pluginPackageVersion: string;
    supportedRange: { min: string; max: string };
}): void {
    if (_warned.has(input.pluginPackageName)) return;
    _warned.add(input.pluginPackageName);
    let vendureVersion: string;
    try {
        // Nested require so this file compiles even when @vendure/core
        // isn't installed (SDK-only consumers).
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        vendureVersion = require('@vendure/core/package.json').version;
    } catch {
        return; // no Vendure at all → nothing to check against
    }
    if (isVendureVersionCompatible(vendureVersion, input.supportedRange)) {
        return;
    }
    const { min, max } = input.supportedRange;
    Logger.warn(
        `${input.pluginPackageName}@${input.pluginPackageVersion} is running against ` +
            `@vendure/core@${vendureVersion}, which is outside the tested range ` +
            `>=${min} <${max}. The plugin will still boot and work in most cases, ` +
            `but this configuration is not covered by our CI. Upgrade the plugin ` +
            `to a version that lists ${vendureVersion} as supported, or roll back ` +
            `@vendure/core to a version inside the tested range.`,
        'HuloCompat',
    );
}

// ── tiny semver helpers ─────────────────────────────────────────────

interface V {
    major: number;
    minor: number;
    patch: number;
}

function parseVersion(s: string): V | null {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(s || '').trim());
    if (!m) return null;
    return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function cmp(a: V, b: V): number {
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    return a.patch - b.patch;
}

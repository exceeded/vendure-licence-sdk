/**
 * Decoded payload from a HULO licence JWT.
 *
 * Plugins must check `pluginId` matches their own identifier and that
 * the host domain matches one of `allowedDomains` (or the wildcard
 * `*`). The SDK does both checks for you.
 */
export interface LicencePayload {
    /** Stable plugin identifier — e.g. "vendure-plugin-visitor-analytics". */
    pluginId: string;
    /** Customer-facing identifier, usually the buyer's email. */
    customer: string;
    /** Domains the host install is permitted to run on. Use `["*"]` to
     *  allow any. Normally one or two domains. */
    allowedDomains: string[];
    /** Plan tier, e.g. "starter" / "pro" / "enterprise". Plugins can
     *  read this to gate per-tier features. */
    plan: string;
    /** Issued-at (seconds since epoch). */
    iat: number;
    /** Expiry (seconds since epoch). After this the SDK reports
     *  `valid: false, reason: "expired"`. */
    exp: number;
    /** Unique licence id used for revocation lookup. */
    jti: string;
}

/** Result of a `verifyLicence(...)` call. Plugins should branch on
 *  `valid` and surface `reason` in their admin UI. */
export interface LicenceStatus {
    /** `true` only when the JWT signature is valid, the plugin id and
     *  host domain match, the licence has not expired and it does not
     *  appear in the revocation list. */
    valid: boolean;
    /** Short machine-readable reason — one of `ok`, `missing`,
     *  `malformed`, `bad-signature`, `plugin-mismatch`,
     *  `domain-mismatch`, `expired`, `revoked`, `unknown`. */
    reason: string;
    /** Decoded payload if the JWT structure was readable, otherwise
     *  `null`. Available even on some failure paths (`expired`,
     *  `revoked`) so plugins can show "expired on 2026-12-31". */
    payload: LicencePayload | null;
    /** Human-readable message intended for the admin UI. */
    message: string;
}

/** Options the plugin passes to `verifyLicence`. */
export interface VerifyLicenceOptions {
    /** The licence JWT supplied by the customer in their plugin
     *  `init()` config. Pass `undefined` or empty string for unlicensed
     *  installs — the SDK reports `valid: false, reason: "missing"`. */
    licenceKey?: string | null;
    /** Stable identifier of the plugin checking. The SDK rejects the
     *  licence if the JWT's `pluginId` doesn't match. */
    pluginId: string;
    /** Hostname of the install. Compared against `allowedDomains`.
     *  Read from `process.env.VENDURE_HOST` or the Vendure config when
     *  available. */
    host: string;
    /** RSA public key the SDK uses to verify the JWT signature.
     *  Embedded in the plugin source code at build time. */
    publicKey: string;
    /** Optional set of revoked `jti` values fetched from the
     *  revocation server. Pass an empty Set for an offline-only check. */
    revokedIds?: Set<string>;
}

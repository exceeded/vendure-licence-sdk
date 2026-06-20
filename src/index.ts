/**
 * @huloglobal/vendure-licence-sdk
 *
 * Licence-key validation helpers shared by every commercial HULO
 * Vendure plugin. Each plugin embeds the SDK and calls
 * `verifyLicence(...)` at boot. The SDK:
 *
 *  - Verifies an offline RSA-signed JWT payload (no boot-time network
 *    call required — Vendure stays bootable even when our licence
 *    server is unreachable).
 *  - Optionally polls a revocation list every 7 days so leaked or
 *    refunded keys can be cancelled.
 *  - Exposes a single `LicenceStatus` object plugins can read to
 *    decide whether to enable write paths / paid features.
 *
 * Plugins are expected to fail-soft: if no key is supplied or the key
 * is invalid, the plugin should still register without crashing, log a
 * clear warning, and disable mutation paths or restrict to a free
 * tier. The end-user can always upgrade by supplying a valid key.
 */

export { verifyLicence } from './verify';
export { LicenceStatus, LicencePayload, VerifyLicenceOptions } from './types';
export { RevocationChecker } from './revocation';
export { UpdateChecker, UpdateStatus } from './update-check';

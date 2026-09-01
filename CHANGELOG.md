# Changelog

All notable changes to `@huloglobal/vendure-licence-sdk` are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and
this project adheres to [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.11.0] — 2026-09-01

### Added
- **Master licences + hardware binding.** `verifyLicence` now accepts a
  `pluginId: '*'` master licence that activates every HULO plugin, and an
  optional `instanceId` claim that binds any licence to one machine's
  stable fingerprint (the evaluation client's hostname|platform hash).
  Master licences are only ever accepted with a hardware binding; a bound
  key is inert on any other machine. Ordinary per-plugin keys are
  unchanged.

## [0.10.0] — 2026-08-25

### Added
- **PostgreSQL support.** New `sql-dialect` module: `createDbAdapter()` /
  `adapterFor()` wrap a TypeORM connection and transparently translate the
  plugins' MySQL-flavoured SQL for Postgres — placeholders (`?` → `$n`),
  identifier quoting, upserts (`ON DUPLICATE KEY UPDATE` → `ON CONFLICT`),
  `INSERT IGNORE`, `DATE_SUB`/`DATE_ADD`, `GROUP_CONCAT`, `SUBSTRING_INDEX`,
  `IF()`, `TIMESTAMPDIFF`, DDL type mapping with inline-index extraction,
  aggregate casts, `DELETE … ORDER BY … LIMIT` emulation, and camelCase
  result-key restoration. MySQL/MariaDB installs are byte-identical
  passthrough. Verified against PostgreSQL 17 with the full query corpus of
  all five plugins.

## [0.6.0] — 2026-07-04

### Added
- `warnIfIncompatibleVendure()` — helper each HULO plugin can call in its
  `init()` to log a non-fatal warning when `@vendure/core` at runtime is
  outside the range the plugin was tested against. Fail-open on unparseable
  versions so we never spam production logs.
- `isVendureVersionCompatible()` — the underlying semver-lite comparison used
  by the helper, exposed separately so callers can gate features on the
  detected version. Handles pre-release suffixes.
- Unit test suite for the classifier and the new compat helper. Runs on push
  and PR via GitHub Actions. 31 tests, no snapshots.

### Changed
- Bumped internally to signal the new public API. No breaking changes; the
  0.5.x classifier surface is unchanged.

## [0.5.0] — 2026-06-30

### Added
- `classifyEmailEvent()` — moved out of the ELITE backend into the SDK so any
  HULO plugin (or third-party Vendure plugin) can classify email events
  consistently. Returns `human_likely` / `machine_likely` / `unknown` plus a
  list of short reason codes: `gmail-proxy`, `ampp` (Apple Mail Privacy
  Protection), `safelinks`, `outlook-proxy`, `proofpoint`, `mimecast`,
  `barracuda`, `symantec`, `forcepoint`, `datacentre`, `vpn`, `tor`,
  `bot-ua`, `headless`, `cli-ua`, `prefetch`, `scanner-ua`, and more.
- Advisory-not-decisive by design — reason codes surface *why* an event was
  scored machine-likely, but the classifier is documented as never being the
  sole basis for any operational decision.

## [0.4.0] — 2026-06-23

### Added
- `Heartbeat` class — plugins send one anonymous fingerprint per day to the
  licence server. Contains a SHA-256 of the embedded public key + verifier
  source; no personal data, no customer data. Lets us detect tampered
  installs running modified builds. Opt-out via
  `HULO_HEARTBEAT_DISABLED=true`.
- `fingerprintPublicKey()` — helper for computing the fingerprint the
  heartbeat needs, so plugins can pass it in at boot.
- Tier-gating helpers: `isLicensed()`, `tierOf()`, `premiumFeatureError()`.
  A single import so paid features can be gated at each call site with one
  line of code — commenting out a boot check is no longer enough to unlock
  the plugin.

### Changed
- Relicensed the GitHub source to AGPL-3.0. Published npm builds remain
  under the commercial licence documented at
  <https://huloglobal.com/legal/terms/>.

## [0.3.1] — 2026-06-21

### Changed
- README refresh — documents every shipped helper with copy-paste examples.

## [0.3.0] — 2026-06-20

### Added
- Shared security primitives: `verifyHmacSha256`, `signValue` /
  `verifySignedValue`, `RateLimiter` with LRU keyspace cap,
  `applySecurityHeaders`, `isUrlOnAllowlist`, `hashIp`, `randomToken`. Every
  plugin uses these instead of hand-rolling crypto — one audit surface, one
  place to patch.
- Opt-in retention sweeper: `startRetentionSweeper()` schedules a rolling
  DELETE-by-age job for any entity table, wired via plugin options.

## [0.2.0] — 2026-06-20

### Added
- `UpdateChecker` — plugins poll the npm registry every 24h and surface
  "update available" in the admin UI. Zero-op in dev.

## [0.1.0] — 2026-06-19

### Added
- Initial release. RS256 licence-key verification (offline JWT plus periodic
  revocation polling), `LicenceStatus` object, `RevocationChecker`, plugin
  `init()` scaffolding.

[0.6.0]: https://github.com/exceeded/vendure-licence-sdk/releases/tag/v0.6.0
[0.5.0]: https://github.com/exceeded/vendure-licence-sdk/releases/tag/v0.5.0
[0.4.0]: https://github.com/exceeded/vendure-licence-sdk/releases/tag/v0.4.0
[0.3.1]: https://github.com/exceeded/vendure-licence-sdk/releases/tag/v0.3.1
[0.3.0]: https://github.com/exceeded/vendure-licence-sdk/releases/tag/v0.3.0
[0.2.0]: https://github.com/exceeded/vendure-licence-sdk/releases/tag/v0.2.0
[0.1.0]: https://github.com/exceeded/vendure-licence-sdk/releases/tag/v0.1.0

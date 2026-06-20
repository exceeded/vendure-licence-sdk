# Changelog

All notable changes to `@huloglobal/vendure-licence-sdk` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and
this project adheres to [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0]

### Added
- `startRetentionSweeper({ ... })` — schedules a recurring
  `DELETE FROM <table> WHERE createdAt < ?` sweep that prunes rows
  older than `options.days`. Optional `options.maxRows` adds a hard cap
  on total rows (oldest pruned first when exceeded). `options.days = 0`
  or `null` keeps everything (no pruning). Sweeper interval defaults to
  24h, is `.unref()`d so it doesn't block shutdown, and runs first 60s
  after start so boot stays snappy.
- Shared security primitives module (`security.ts`), exported from the
  package root:
  - `verifyHmacSha256(body, signature, secret)` — timing-safe HMAC-SHA256
    verification for webhooks. Tolerates the GitHub-style `sha256=`
    prefix.
  - `signValue(value, secret)` / `verifySignedValue(signed, secret)` —
    HMAC tag a string so we can detect tampering when it round-trips
    through a cookie or URL parameter. 64-bit tag keeps cookies short.
  - `RateLimiter` — token-bucket rate limiter with an LRU cap on the
    keyspace so a flood of keys can't grow memory.
  - `applySecurityHeaders(res, { strict })` — recommended baseline of
    security headers (X-Content-Type-Options, X-Frame-Options,
    Referrer-Policy, Permissions-Policy, Cross-Origin-Resource-Policy).
    `strict` adds a tight CSP for JSON / API endpoints.
  - `isUrlOnAllowlist(url, allowedDomains)` — guards click redirectors
    against being used as an open redirector. Supports wildcard suffixes
    (`*.example.com`).
  - `hashIp(ip, salt)` — sha256 IP hashing with a per-install salt.
  - `randomToken(bytes)` — URL-safe random tokens for secrets / one-shot
    nonces.

## [0.2.0]

### Added
- **`UpdateChecker`** — polls the public npm registry every 24h for the
  package's latest version. Exposes `current`, `latest`, `updateAvailable`,
  `isMajor`, `lastCheckedAt`, `lastError`. Soft-fails on network errors
  (keeps the previous cached value in memory). Each consuming plugin
  surfaces its status via a `/status` endpoint so the admin dashboard
  can render an "update available" banner.
- `UpdateStatus` exported type.

## [0.1.0]

### Added
- Offline RSA-SHA256 JWT licence verification (`verifyLicence`).
- `RevocationChecker` with a 7-day default poll interval and soft-failure
  caching of the previous revocation list.
- `LicenceStatus` and `LicencePayload` shared types.

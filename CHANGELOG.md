# Changelog

All notable changes to `@huloglobal/vendure-licence-sdk` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and
this project adheres to [semantic versioning](https://semver.org/spec/v2.0.0.html).

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

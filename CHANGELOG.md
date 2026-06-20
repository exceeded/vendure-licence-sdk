# Changelog

All notable changes to `@huloglobal/vendure-licence-sdk` are documented here. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and
this project adheres to [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — Unreleased

### Added
- Offline RSA-SHA256 JWT licence verification (`verifyLicence`).
- `RevocationChecker` with a 7-day default poll interval and soft-failure
  caching of the previous revocation list.
- `LicenceStatus` and `LicencePayload` shared types.

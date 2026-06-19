# @hulo/vendure-licence-sdk

Licence-key verification helpers shared by every commercial HULO Vendure plugin.

The SDK is consumed by plugins, not by Vendure storefronts directly. Install it
as a runtime dependency of your plugin package, embed your `publicKey`
constant in the plugin source, and call `verifyLicence(...)` once at boot.

## Install

```bash
yarn add @hulo/vendure-licence-sdk
```

## Usage in a plugin

```ts
import { verifyLicence, RevocationChecker } from '@hulo/vendure-licence-sdk';
import { VendurePlugin } from '@vendure/core';

const HULO_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
... your plugin's embedded RSA public key ...
-----END PUBLIC KEY-----`;

const revocation = new RevocationChecker('https://licence.hulo-global.com/revoked.json');
revocation.start();

@VendurePlugin({ /* ... */ })
export class MyPlugin {
  static init(options: { licenceKey?: string }) {
    const status = verifyLicence({
      licenceKey: options.licenceKey,
      pluginId: 'vendure-plugin-my-thing',
      host: process.env.VENDURE_HOST || 'localhost',
      publicKey: HULO_PUBLIC_KEY,
      revokedIds: revocation.getRevokedIds(),
    });
    // status.valid → enable all features
    // !status.valid → log status.message, run in unlicensed mode
    MyPlugin.licenceStatus = status;
    return MyPlugin;
  }
  static licenceStatus: LicenceStatus;
}
```

## Why offline JWT + periodic revocation?

- **Boot-time offline check.** Vendure stays bootable even when our licence
  server is unreachable. The customer's storefront never hangs on a network call.
- **Soft revocation.** Refunded / leaked keys are revoked by adding the JWT
  `jti` to a flat list at `https://licence.hulo-global.com/revoked.json`. The
  plugin re-fetches the list every 7 days.
- **Soft failure.** Network outages keep the previous cached revocation list in
  memory — your customer is never accidentally locked out of features they paid
  for because our server hiccuped.

## Licence status reasons

`LicenceStatus.reason` is one of:

| reason | meaning |
| --- | --- |
| `ok` | Licence verified and active. |
| `missing` | No key supplied. Run in unlicensed mode. |
| `malformed` | Key isn't a valid JWT. |
| `bad-signature` | Signature didn't verify — possible tampering. |
| `plugin-mismatch` | Licence is for a different HULO plugin. |
| `domain-mismatch` | Host domain not in `allowedDomains`. |
| `expired` | `exp` is in the past. |
| `revoked` | Key appears in the revocation list. |

## Licence

Commercial — see LICENSE.

# @huloglobal/vendure-licence-sdk

Shared runtime utilities used by every commercial HULO Vendure plugin.

Consumed by plugins, not by Vendure storefronts directly. Install it as a
runtime dependency of your plugin package, embed your `publicKey` constant
in the plugin source, and wire the helpers in your plugin's `init()`.

Maintained by Wayne Garrison.

## Install

```bash
yarn add @huloglobal/vendure-licence-sdk
```

## What's in the box

| Helper | Purpose |
| --- | --- |
| `verifyLicence(opts)` | Offline RSA-SHA256 JWT verification. No boot-time network call required — Vendure stays bootable even when the licence server is unreachable. |
| `RevocationChecker` | Weekly poll of `revoked.json` with soft-fail caching. Each plugin instantiates one at boot. |
| `UpdateChecker` | 24-hour poll of the npm registry for the package's latest version. Surfaced via the plugin's `/status` endpoint so the admin UI can show an "update available" banner. |
| `startRetentionSweeper({...})` | Daily DELETE-by-age sweeper for log tables. Opt-in via the plugin's `options.retention`. |
| `verifyHmacSha256(body, sig, secret)` | Timing-safe HMAC-SHA256 verification for webhooks. Tolerates the GitHub-style `sha256=` prefix. |
| `signValue(value, secret)` / `verifySignedValue(signed, secret)` | HMAC-tag any string. Used to seal cookies, query parameters and webhook payloads. |
| `RateLimiter` | Token-bucket rate limiter with an LRU-capped keyspace so a flood of keys can't grow memory. |
| `applySecurityHeaders(res, {strict})` | Recommended baseline of security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`, `Cross-Origin-Resource-Policy`). `strict` adds a tight CSP for JSON / API endpoints. |
| `isUrlOnAllowlist(url, allowed)` | Defends click redirectors from being abused as open redirectors. Wildcard suffixes (`*.example.com`) supported. |
| `hashIp(ip, salt)` | SHA-256 IP hashing with a per-install salt. Lets you keep unique-visitor counts without storing raw addresses. |
| `randomToken(bytes)` | URL-safe random tokens for secrets / one-shot nonces. |

## Minimal plugin boot example

```ts
import {
    RevocationChecker,
    UpdateChecker,
    verifyLicence,
} from '@huloglobal/vendure-licence-sdk';
import { VendurePlugin } from '@vendure/core';

const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
... your plugin's embedded RSA public key ...
-----END PUBLIC KEY-----`;

const PKG_NAME = '@youorg/your-plugin';
const PKG_VERSION = require('../package.json').version;

@VendurePlugin({ /* ... */ })
export class YourPlugin {
    private static revocation: RevocationChecker | null = null;
    private static updates: UpdateChecker | null = null;

    static init(opts: { licenceKey?: string; publicBaseUrl: string }) {
        if (!YourPlugin.revocation) {
            YourPlugin.revocation = new RevocationChecker(
                'https://elite.charity/licence/revoked.json',
            );
            YourPlugin.revocation.start();
        }
        if (!YourPlugin.updates) {
            YourPlugin.updates = new UpdateChecker(PKG_NAME, PKG_VERSION);
            YourPlugin.updates.start();
        }

        const host = (opts.publicBaseUrl || '')
            .replace(/^https?:\/\//, '').replace(/\/.*$/, '');
        const status = verifyLicence({
            licenceKey: opts.licenceKey,
            pluginId: 'your-plugin',
            host,
            publicKey: PUBLIC_KEY,
            revokedIds: YourPlugin.revocation.getRevokedIds(),
        });
        if (!status.valid) {
            console.warn(`[${PKG_NAME}] ${status.message} — running unlicensed`);
        }
        return YourPlugin;
    }
}
```

## Adding rate limiting + retention to a plugin

```ts
import {
    applySecurityHeaders,
    RateLimiter,
    startRetentionSweeper,
} from '@huloglobal/vendure-licence-sdk';

const limiter = new RateLimiter({ capacity: 60, windowMs: 60_000 });

@Controller('your-route')
export class YourController implements OnApplicationBootstrap {
    constructor(private connection: TransactionalConnection) {}

    onApplicationBootstrap() {
        startRetentionSweeper({
            getConnection: () => this.connection.rawConnection,
            table: 'your_log',
            options: { days: 180, maxRows: 1_000_000 },
            label: 'your-plugin',
        });
    }

    @Get('public-endpoint')
    handle(@Req() req: Request, @Res() res: Response) {
        applySecurityHeaders(res);
        if (!limiter.allow(`endpoint|${req.ip}`)) {
            return res.status(429).json({ error: 'Too many requests' });
        }
        return res.json({ ok: true });
    }
}
```

## Webhook HMAC verification

```ts
import { verifyHmacSha256 } from '@huloglobal/vendure-licence-sdk';

@Post('webhook')
async webhook(@Req() req: Request, @Res() res: Response) {
    const sig = req.headers['x-signature'] as string;
    const raw = (req as any).rawBody || JSON.stringify((req as any).body);
    if (!verifyHmacSha256(raw, sig, process.env.WEBHOOK_SECRET!)) {
        return res.status(401).json({ error: 'bad signature' });
    }
    // ...your handler...
    return res.json({ received: true });
}
```

## Licence delivery

HULO mints commercial licences via Stripe Checkout at
[elite.charity/licence/buy/&lt;plugin-id&gt;](https://elite.charity).
Keys arrive by email and are paste-in JWTs. Subscribers manage their
plan via the Stripe Customer Portal link in the receipt email; lost
keys can be re-sent from
[elite.charity/licence/forgot](https://elite.charity/licence/forgot).

## Licence

MIT for the runtime helpers in this package. The plugin code embedding
it sells under a separate commercial licence.

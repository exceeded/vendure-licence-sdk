/**
 * Shared security primitives for HULO Vendure plugins.
 *
 *   - HMAC-SHA256 verification (timing-safe) for webhooks
 *   - Signed-value helpers (sign / verify) — used to seal cookies,
 *     query parameters and any other untrusted-channel value
 *   - In-memory token-bucket rate limiter keyed by an arbitrary string
 *   - Recommended security-headers helper for Express responses
 *   - URL allowlist verifier — defends the click redirector from being
 *     used as an open redirector
 *   - One-shot IP hashing helper (sha256 with a per-install salt)
 *
 * All helpers are dependency-free (Node built-ins only) and run in
 * sub-millisecond time on a modern CPU. They never throw — errors bubble
 * out as `false` / `null` returns so the calling code never crashes a
 * request on a hostile input.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { URL } from 'url';

// ── HMAC ────────────────────────────────────────────────────────────────

/**
 * Verify an HMAC-SHA256 hex signature against `body` using `secret`.
 *
 *   const ok = verifyHmacSha256(req.rawBody, req.header('x-signature'), secret);
 *
 * Constant-time comparison so the signature can't be brute-forced via
 * timing. Returns `false` on any malformed input.
 */
export function verifyHmacSha256(
    body: string | Buffer,
    providedSignature: string | undefined | null,
    secret: string,
): boolean {
    if (!secret || !providedSignature) return false;
    try {
        // Tolerate both bare hex and the `sha256=<hex>` GitHub-style prefix.
        const provided = providedSignature.replace(/^sha256=/, '').trim().toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(provided)) return false;
        const expected = createHmac('sha256', secret).update(body).digest('hex');
        const a = Buffer.from(expected, 'utf8');
        const b = Buffer.from(provided, 'utf8');
        if (a.length !== b.length) return false;
        return timingSafeEqual(a, b);
    } catch {
        return false;
    }
}

// ── Signed values ──────────────────────────────────────────────────────

/**
 * Append a short HMAC tag to a value so we can detect tampering when the
 * value round-trips through a cookie / URL parameter / form field.
 *
 *   const signed = signValue('visitor-abc', SECRET);
 *   // -> 'visitor-abc.QRwy3...'
 *
 * The tag is 16 hex characters (64 bits) — enough to defeat brute-force
 * for any value we sign here, while keeping cookies short.
 */
export function signValue(value: string, secret: string): string {
    const tag = createHmac('sha256', secret).update(value).digest('hex').slice(0, 16);
    return `${value}.${tag}`;
}

/**
 * Verify the tag and return the original value, or `null` if the tag
 * doesn't match or the format is malformed.
 */
export function verifySignedValue(signed: string | undefined | null, secret: string): string | null {
    if (!signed || typeof signed !== 'string') return null;
    const lastDot = signed.lastIndexOf('.');
    if (lastDot <= 0 || lastDot >= signed.length - 1) return null;
    const value = signed.slice(0, lastDot);
    const tag = signed.slice(lastDot + 1).toLowerCase();
    if (!/^[a-f0-9]{16}$/.test(tag)) return null;
    const expected = createHmac('sha256', secret).update(value).digest('hex').slice(0, 16);
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(tag, 'utf8');
    if (a.length !== b.length) return null;
    return timingSafeEqual(a, b) ? value : null;
}

// ── Rate limiter ───────────────────────────────────────────────────────

export interface RateLimiterOptions {
    /** Allowed events per window. */
    capacity: number;
    /** Window length in milliseconds. */
    windowMs: number;
    /** Maximum tracked keys (LRU-evicted past this). Default 10 000. */
    maxKeys?: number;
}

/**
 * Token-bucket rate limiter with an LRU cap on the keyspace so we can't
 * be DoS'd by an attacker pushing keys to grow memory. `allow(key)`
 * returns `true` if the request fits in the bucket. Keys are arbitrary
 * strings — typically `${ip}|${route}`.
 */
export class RateLimiter {
    private readonly capacity: number;
    private readonly windowMs: number;
    private readonly maxKeys: number;
    /** Map<key, [tokensRemaining, lastRefillEpochMs]>. JS Map preserves
     *  insertion order, which is good enough LRU for this use. */
    private readonly buckets = new Map<string, [number, number]>();

    constructor(opts: RateLimiterOptions) {
        this.capacity = Math.max(1, opts.capacity);
        this.windowMs = Math.max(1, opts.windowMs);
        this.maxKeys = Math.max(100, opts.maxKeys || 10_000);
    }

    allow(key: string, cost: number = 1): boolean {
        if (!key) return true;
        const now = Date.now();
        const ratePerMs = this.capacity / this.windowMs;
        let entry = this.buckets.get(key);
        if (entry) {
            const [tokens, last] = entry;
            const refilled = Math.min(this.capacity, tokens + (now - last) * ratePerMs);
            if (refilled < cost) {
                // Update last so timing leaks aren't useful.
                this.buckets.set(key, [refilled, now]);
                this.touchLru(key);
                return false;
            }
            this.buckets.set(key, [refilled - cost, now]);
            this.touchLru(key);
            return true;
        }
        // New key — start with a full bucket minus this request.
        if (this.buckets.size >= this.maxKeys) {
            // Drop the oldest entry (Map.keys() is insertion-ordered).
            const oldest = this.buckets.keys().next().value;
            if (oldest !== undefined) this.buckets.delete(oldest);
        }
        this.buckets.set(key, [this.capacity - cost, now]);
        return true;
    }

    private touchLru(key: string): void {
        // Move to "most recently used" by re-inserting.
        const entry = this.buckets.get(key);
        if (entry) {
            this.buckets.delete(key);
            this.buckets.set(key, entry);
        }
    }

    /** Reset all buckets — useful in tests. */
    clear(): void { this.buckets.clear(); }
}

// ── Security headers ───────────────────────────────────────────────────

/**
 * Apply a recommended security-headers baseline to an Express response.
 *
 *   import { applySecurityHeaders } from '@huloglobal/vendure-licence-sdk';
 *   applySecurityHeaders(res, { strict: true });
 *
 * `strict` adds a tight Content-Security-Policy suitable for JSON / API
 * endpoints that never embed third-party content. For HTML responses
 * that need styling / scripts, leave `strict` off and set your own CSP.
 */
export function applySecurityHeaders(res: { setHeader: (name: string, value: string) => unknown }, opts: { strict?: boolean } = {}): void {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=(), payment=()');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (opts.strict) {
        res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    }
}

// ── URL allowlist ──────────────────────────────────────────────────────

/**
 * Returns `true` only when `url` parses as an http(s) URL and its
 * hostname matches one of `allowedDomains`. Wildcard suffixes are
 * supported — `*.example.com` matches `foo.example.com` and
 * `bar.foo.example.com` but not `example.com`.
 *
 * Empty `allowedDomains` means "allow any http(s) URL" — the function
 * still rejects `javascript:`, `data:`, `file:` and similar.
 */
export function isUrlOnAllowlist(url: string | undefined | null, allowedDomains: string[]): boolean {
    if (!url || typeof url !== 'string') return false;
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    if (!allowedDomains?.length) return true;
    const host = parsed.hostname.toLowerCase();
    for (const allowed of allowedDomains) {
        const norm = allowed.trim().toLowerCase();
        if (!norm) continue;
        if (norm.startsWith('*.')) {
            const suffix = norm.slice(2);
            if (host === suffix) continue; // *.example.com must NOT match example.com
            if (host.endsWith('.' + suffix)) return true;
        } else if (host === norm) {
            return true;
        }
    }
    return false;
}

// ── IP hashing ─────────────────────────────────────────────────────────

/**
 * Hash an IP with a per-install salt so we can store it for unique-visitor
 * counts without exposing the raw address. 32-char output (128 bits).
 */
export function hashIp(ip: string | null | undefined, salt: string): string | null {
    if (!ip) return null;
    return createHash('sha256').update(salt + '|' + ip).digest('hex').slice(0, 32);
}

// ── Random ─────────────────────────────────────────────────────────────

/** Generate a URL-safe random token of N bytes (base64url-encoded). */
export function randomToken(bytes: number = 32): string {
    return randomBytes(bytes).toString('base64url');
}

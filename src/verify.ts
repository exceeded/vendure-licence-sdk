import { createVerify } from 'crypto';
import { LicencePayload, LicenceStatus, VerifyLicenceOptions } from './types';

/**
 * Verify a HULO licence JWT. The JWT uses the `RS256` algorithm:
 * `base64url(header).base64url(payload).base64url(signature)` where the
 * signature is RSA-SHA256 over the dot-joined header+payload.
 *
 * We implement the verification inline (rather than pulling in
 * `jsonwebtoken`) because it removes a runtime dependency and keeps
 * the plugin install lean. The JWT format is small and stable.
 */
export function verifyLicence(opts: VerifyLicenceOptions): LicenceStatus {
    const { licenceKey, pluginId, host, publicKey, revokedIds } = opts;

    if (!licenceKey || !licenceKey.trim()) {
        return missing();
    }

    const parts = licenceKey.trim().split('.');
    if (parts.length !== 3) return malformed();

    const [headerB64, payloadB64, sigB64] = parts;
    let header: any;
    let payload: LicencePayload;
    try {
        header = JSON.parse(base64UrlDecode(headerB64).toString('utf8'));
        payload = JSON.parse(base64UrlDecode(payloadB64).toString('utf8'));
    } catch {
        return malformed();
    }

    if (header.alg !== 'RS256' || header.typ !== 'JWT') return malformed();

    // Verify the RSA signature.
    let signatureValid = false;
    try {
        const verifier = createVerify('RSA-SHA256');
        verifier.update(`${headerB64}.${payloadB64}`);
        verifier.end();
        signatureValid = verifier.verify(publicKey, base64UrlDecode(sigB64));
    } catch {
        signatureValid = false;
    }
    if (!signatureValid) return badSignature(payload);

    // Structural checks.
    if (!payload.pluginId || payload.pluginId !== pluginId) {
        return pluginMismatch(payload);
    }
    if (!Array.isArray(payload.allowedDomains)) return malformed();

    const hostNorm = (host || '').toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
    const matchesDomain = payload.allowedDomains.some(d => {
        const dn = (d || '').toLowerCase().trim();
        return dn === '*' || dn === hostNorm
            || (dn.startsWith('*.') && hostNorm.endsWith(dn.slice(1)));
    });
    if (!matchesDomain) return domainMismatch(payload, hostNorm);

    const nowSec = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < nowSec) return expired(payload);

    if (revokedIds && payload.jti && revokedIds.has(payload.jti)) {
        return revoked(payload);
    }

    return {
        valid: true,
        reason: 'ok',
        payload,
        message: `Licensed to ${payload.customer} (${payload.plan}); expires ${formatExpiry(payload.exp)}.`,
    };
}

// --- Status factories ------------------------------------------------------

function missing(): LicenceStatus {
    return {
        valid: false,
        reason: 'missing',
        payload: null,
        message: 'No licence key configured. The plugin will run in unlicensed (degraded) mode.',
    };
}
function malformed(): LicenceStatus {
    return {
        valid: false,
        reason: 'malformed',
        payload: null,
        message: 'Licence key is malformed. Re-copy the key from your purchase confirmation.',
    };
}
function badSignature(payload: LicencePayload): LicenceStatus {
    return {
        valid: false,
        reason: 'bad-signature',
        payload,
        message: 'Licence signature failed verification. The key may be tampered with — contact support.',
    };
}
function pluginMismatch(payload: LicencePayload): LicenceStatus {
    return {
        valid: false,
        reason: 'plugin-mismatch',
        payload,
        message: `Licence is for "${payload.pluginId}" but the plugin checking is different — wrong key?`,
    };
}
function domainMismatch(payload: LicencePayload, host: string): LicenceStatus {
    return {
        valid: false,
        reason: 'domain-mismatch',
        payload,
        message: `Licence does not cover host "${host}". Allowed: ${payload.allowedDomains.join(', ')}.`,
    };
}
function expired(payload: LicencePayload): LicenceStatus {
    return {
        valid: false,
        reason: 'expired',
        payload,
        message: `Licence expired on ${formatExpiry(payload.exp)}. Renew to re-enable paid features.`,
    };
}
function revoked(payload: LicencePayload): LicenceStatus {
    return {
        valid: false,
        reason: 'revoked',
        payload,
        message: 'Licence has been revoked. Contact support if this is unexpected.',
    };
}

// --- Helpers ---------------------------------------------------------------

function base64UrlDecode(s: string): Buffer {
    const norm = s.replace(/-/g, '+').replace(/_/g, '/');
    const pad = norm.length % 4 ? norm + '='.repeat(4 - (norm.length % 4)) : norm;
    return Buffer.from(pad, 'base64');
}

function formatExpiry(secSinceEpoch: number): string {
    if (!secSinceEpoch) return 'never';
    return new Date(secSinceEpoch * 1000).toISOString().slice(0, 10);
}

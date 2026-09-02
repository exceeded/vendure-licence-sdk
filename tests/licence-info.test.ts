import { describe, it, expect, vi, beforeEach } from 'vitest';
import { describeLicence } from '../src/licence-info';
import { PurchaseClaimClient } from '../src/purchase-claim';

describe('describeLicence', () => {
    it('returns null without a valid licence', () => {
        expect(describeLicence(null)).toBeNull();
        expect(describeLicence({ valid: false, reason: 'x', payload: null, message: '' } as any)).toBeNull();
    });
    it('summarises plan, expiry, trial end and master flag', () => {
        const s = describeLicence({
            valid: true, reason: 'ok', message: '',
            payload: { pluginId: '*', customer: 'a@b.c', allowedDomains: ['*'], plan: 'lifetime', iat: 1, exp: 1_800_000_000, jti: 'j1', trialEnd: 1_760_000_000 } as any,
        });
        expect(s).toEqual({
            plan: 'lifetime', customer: 'a@b.c', expiresAt: new Date(1_800_000_000 * 1000).toISOString(),
            trialEndsAt: new Date(1_760_000_000 * 1000).toISOString(), master: true, jti: 'j1',
        });
    });
});

describe('PurchaseClaimClient.billingPortalUrl', () => {
    let fetchMock: any;
    beforeEach(() => { fetchMock = vi.fn(); (globalThis as any).fetch = fetchMock; });

    it('proves ownership with the key when no claim is installed, and only accepts https urls', async () => {
        const query = vi.fn(async () => []);
        const c = new PurchaseClaimClient({ packageName: '@huloglobal/vendure-plugin-geo-block', instanceId: () => 'a'.repeat(32), query, onLicence: async () => true });
        expect(await c.billingPortalUrl(null)).toBeNull();
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ url: 'https://elite.charity/licence/portal?email=x&sig=y' }) });
        expect(await c.billingPortalUrl('eyJ.key')).toMatch(/^https:\/\/elite\.charity\/licence\/portal/);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('https://elite.charity/licence/portal-link');
        expect(JSON.parse(init.body)).toEqual({ plugin: '@huloglobal/vendure-plugin-geo-block', key: 'eyJ.key' });
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ url: 'http://evil.example/portal' }) });
        expect(await c.billingPortalUrl('eyJ.key')).toBeNull();
    });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PurchaseClaimClient } from '../src/purchase-claim';

/** Minimal in-memory stand-in for the single-row claim table. */
function memoryQuery() {
    const rows = new Map<string, any>();
    const query = vi.fn(async (sql: string, params: any[] = []) => {
        if (/CREATE TABLE/i.test(sql)) return [];
        if (/^SELECT \* FROM hulo_licence_claim/i.test(sql)) return rows.has(params[0]) ? [rows.get(params[0])] : [];
        if (/^INSERT INTO hulo_licence_claim/i.test(sql)) {
            rows.set(params[0], { pluginId: params[0], claimToken: params[1], instanceId: params[2], plan: params[3], createdAt: new Date(), installedAt: null, lastCheckedAt: null, keyHash: null });
            return { affectedRows: 1 };
        }
        if (/SET lastCheckedAt/i.test(sql)) { const r = rows.get(params[0]); if (r) r.lastCheckedAt = new Date(); return {}; }
        if (/SET installedAt/i.test(sql)) { const r = rows.get(params[1]); if (r) { r.installedAt = r.installedAt || new Date(); r.keyHash = params[0]; } return {}; }
        if (/^DELETE FROM hulo_licence_claim/i.test(sql)) { rows.delete(params[0]); return {}; }
        throw new Error('unexpected sql: ' + sql);
    });
    return { query, rows };
}

describe('PurchaseClaimClient', () => {
    let fetchMock: any;
    beforeEach(() => { fetchMock = vi.fn(); (globalThis as any).fetch = fetchMock; });
    afterEach(() => { vi.restoreAllMocks(); });

    it('builds a buy link carrying plan, instance and a 48-hex claim, and persists it', async () => {
        const { query, rows } = memoryQuery();
        const c = new PurchaseClaimClient({ packageName: '@huloglobal/vendure-plugin-geo-block', instanceId: () => 'a'.repeat(32), query, onLicence: async () => true });
        const { url, claim } = await c.createPurchaseLink('annual', 'me@example.com');
        c.stop();
        expect(claim).toMatch(/^[0-9a-f]{48}$/);
        const u = new URL(url);
        expect(u.pathname).toBe('/licence/buy/vendure-plugin-geo-block');
        expect(u.searchParams.get('plan')).toBe('annual');
        expect(u.searchParams.get('instance')).toBe('a'.repeat(32));
        expect(u.searchParams.get('claim')).toBe(claim);
        expect(u.searchParams.get('email')).toBe('me@example.com');
        expect(rows.get('vendure-plugin-geo-block').claimToken).toBe(claim);
        expect((await c.status()).state).toBe('pending');
    });

    it('stays pending until the server has a key, then installs it exactly once', async () => {
        const { query } = memoryQuery();
        const onLicence = vi.fn(async () => true);
        const c = new PurchaseClaimClient({ packageName: '@huloglobal/vendure-plugin-geo-block', instanceId: () => 'b'.repeat(32), query, onLicence });
        await c.createPurchaseLink('monthly');
        c.stop();
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'pending' }) });
        expect((await c.checkNow()).state).toBe('pending');
        expect(onLicence).not.toHaveBeenCalled();

        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ready', key: 'eyJ.' + 'x'.repeat(40) }) });
        const st = await c.checkNow();
        c.stop();
        expect(st.state).toBe('installed');
        expect(onLicence).toHaveBeenCalledTimes(1);
        const sent = JSON.parse(fetchMock.mock.calls[1][1].body);
        expect(sent.plugin).toBe('@huloglobal/vendure-plugin-geo-block');
        expect(sent.instanceId).toBe('b'.repeat(32));
        expect(sent.claim).toMatch(/^[0-9a-f]{48}$/);

        // Same key again (daily refresh) → no re-install; a new key → re-install.
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ready', key: 'eyJ.' + 'x'.repeat(40) }) });
        await c.checkNow(); c.stop();
        expect(onLicence).toHaveBeenCalledTimes(1);
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ready', key: 'eyJ.' + 'y'.repeat(40) }) });
        await c.checkNow(); c.stop();
        expect(onLicence).toHaveBeenCalledTimes(2);
    });

    it('does not mark installed when the key fails local verification', async () => {
        const { query } = memoryQuery();
        const c = new PurchaseClaimClient({ packageName: '@huloglobal/vendure-plugin-geo-block', instanceId: () => 'c'.repeat(32), query, onLicence: async () => false });
        await c.createPurchaseLink('lifetime');
        c.stop();
        fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ status: 'ready', key: 'eyJ.' + 'z'.repeat(40) }) });
        const st = await c.checkNow();
        c.stop();
        expect(st.state).toBe('pending');
        expect(st.message).toMatch(/did not validate/);
    });

    it('survives network and SQL failures without throwing', async () => {
        const query = vi.fn(async () => { throw new Error('db down'); });
        const c = new PurchaseClaimClient({ packageName: '@huloglobal/vendure-plugin-geo-block', instanceId: () => 'd'.repeat(32), query, onLicence: async () => true });
        expect((await c.status()).state).toBe('none');
        expect((await c.checkNow()).state).toBe('none');
        await expect(c.resume()).resolves.toBeUndefined();
    });
});

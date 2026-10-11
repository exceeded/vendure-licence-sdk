import { describe, it, expect, vi } from 'vitest';
import { PluginPrefs, composeDigest, licenceLifecycleNotice, WeeklyDigest } from '../src/engagement';
import { Heartbeat } from '../src/heartbeat';

vi.mock('@vendure/core', () => ({ Logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

/** In-memory stand-in for hulo_plugin_prefs with MySQL-ish affectedRows. */
function memoryPrefs() {
    const rows = new Map<string, string>();
    const k = (p: string, key: string) => `${p}|${key}`;
    const query = vi.fn(async (sql: string, params: any[] = []) => {
        if (/CREATE TABLE/i.test(sql)) return [];
        if (/^SELECT prefValue FROM/i.test(sql)) return rows.has(k(params[0], params[1])) ? [{ prefValue: rows.get(k(params[0], params[1])) }] : [];
        if (/^SELECT prefKey, prefValue/i.test(sql)) return [...rows.entries()].filter(([key]) => key.startsWith(params[0] + '|')).map(([key, v]) => ({ prefKey: key.split('|')[1], prefValue: v }));
        if (/^INSERT IGNORE/i.test(sql)) { if (rows.has(k(params[0], params[1]))) return { affectedRows: 0 }; rows.set(k(params[0], params[1]), params[2]); return { affectedRows: 1 }; }
        if (/^INSERT INTO/i.test(sql)) { rows.set(k(params[0], params[1]), params[2]); return { affectedRows: 1 }; }
        if (/^UPDATE hulo_plugin_prefs SET prefValue = \?,.* AND prefValue = \?/i.test(sql)) {
            const key = k(params[1], params[2]);
            if (rows.get(key) !== params[3]) return { affectedRows: 0 };
            rows.set(key, params[0]); return { affectedRows: 1 };
        }
        if (/^DELETE/i.test(sql)) { rows.delete(k(params[0], params[1])); return { affectedRows: 1 }; }
        throw new Error('unexpected sql: ' + sql);
    });
    return { query, rows };
}

const baseInput = () => ({
    pluginName: 'Fraud Prevention', shortId: 'vendure-plugin-fraud-prevention',
    periodStart: new Date('2026-10-05T08:00:00Z'), periodEnd: new Date('2026-10-12T08:00:00Z'),
    stats: [
        { key: 'ordersHeld', label: 'risky orders held for review', value: 7, previous: 4 },
        { key: 'riskyValuePence', label: 'of risky orders intercepted', value: 123456, previous: 200000, format: 'pence' as const },
        { key: 'zero', label: 'never shown', value: 0 },
    ],
    tier: 'paid' as const,
    tips: [{ title: 'Turn on enforce mode', body: 'Monitor mode only logs.', url: 'https://shop.test/admin/extensions/fraud-prevention' }],
    adminUrl: 'https://shop.test/admin/extensions/fraud-prevention',
});

describe('composeDigest', () => {
    it('renders headline stats with deltas, hides zeros and escapes html', () => {
        const m = composeDigest({ ...baseInput(), storeName: 'A & B <Ltd>' });
        expect(m.subject).toBe('Fraud Prevention: 7 risky orders held for review last week');
        expect(m.text).toContain('7 risky orders held for review (▲ 75% vs previous week)');
        expect(m.text).toContain('£1,234.56 of risky orders intercepted (▼ 38% vs previous week)');
        expect(m.text).not.toContain('never shown');
        expect(m.html).toContain('A &amp; B &lt;Ltd&gt;');
        expect(m.html).toContain('Turn on enforce mode');
        expect(m.text).toContain('Weekly report');
    });
    it('shows the premium block and buy link for trial and free tiers only', () => {
        const paid = composeDigest(baseInput());
        expect(paid.text).not.toContain('elite.charity/licence/buy');
        const free = composeDigest({ ...baseInput(), tier: 'free', premiumFeatures: ['Enforce mode', 'Threat feeds'] });
        expect(free.text).toContain('Switch on with a licence:');
        expect(free.text).toContain('https://elite.charity/licence/buy/vendure-plugin-fraud-prevention');
        expect(free.html).toContain('Start the 14-day free trial');
    });
    it('falls back to a quiet-week subject when nothing happened', () => {
        const m = composeDigest({ ...baseInput(), stats: [{ key: 'x', label: 'x', value: 0 }] });
        expect(m.subject).toBe('Fraud Prevention: your weekly report');
        expect(m.text).toContain('was quiet last week');
    });
});

describe('licenceLifecycleNotice', () => {
    const now = new Date('2026-10-12T00:00:00Z');
    const lic = (o: any) => ({ plan: 'monthly', customer: 'a@b.c', expiresAt: null, trialEndsAt: null, master: false, jti: 'x', ...o });
    it('warns in the last 7 days of a card-backed trial', () => {
        const n = licenceLifecycleNotice(lic({ trialEndsAt: '2026-10-15T00:00:00Z' }), null, 'p', now);
        expect(n?.kind).toBe('trial-ending'); expect(n?.daysLeft).toBe(3);
    });
    it('is silent for a healthy subscription and for lifetime/master keys', () => {
        expect(licenceLifecycleNotice(lic({ expiresAt: '2027-01-01T00:00:00Z' }), null, 'p', now)).toBeNull();
        expect(licenceLifecycleNotice(lic({ plan: 'lifetime', expiresAt: '2026-10-13T00:00:00Z' }), null, 'p', now)).toBeNull();
        expect(licenceLifecycleNotice(lic({ master: true, expiresAt: '2026-10-13T00:00:00Z' }), null, 'p', now)).toBeNull();
    });
    it('warns when a key expires within 14 days, and on evaluation end', () => {
        expect(licenceLifecycleNotice(lic({ expiresAt: '2026-10-20T00:00:00Z' }), null, 'p', now)?.kind).toBe('key-expiring');
        expect(licenceLifecycleNotice(null, { active: true, daysRemaining: 2, endsAt: null, source: 'server' }, 'p', now)?.kind).toBe('eval-ending');
        expect(licenceLifecycleNotice(null, { active: false, daysRemaining: 0, endsAt: null, source: 'server' }, 'p', now)?.kind).toBe('eval-ended');
        expect(licenceLifecycleNotice(null, { active: false, daysRemaining: null, endsAt: null, source: 'fallback' }, 'p', now)).toBeNull();
    });
});

describe('PluginPrefs + WeeklyDigest', () => {
    const mk = (send = vi.fn(async () => undefined), extra: any = {}) => {
        const { query, rows } = memoryPrefs();
        const prefs = new PluginPrefs(query, 'vendure-plugin-geo-block');
        const collect = vi.fn(async () => ({ stats: [{ key: 'requestsBlocked', label: 'unwanted requests blocked', value: 12 }], tier: 'paid' as const }));
        const d = new WeeklyDigest({ pluginId: 'vendure-plugin-geo-block', pluginName: 'Geo Block', prefs, collect, send, defaultRecipient: () => 'owner@shop.test', ...extra });
        return { d, prefs, rows, send, collect };
    };
    it('round-trips settings and validates the recipient', async () => {
        const { d } = mk();
        expect((await d.settings()).recipient).toBeNull();
        expect((await d.settings()).defaultRecipient).toBe('owner@shop.test');
        await expect(d.updateSettings({ recipient: 'nope' })).rejects.toThrow('valid email');
        const s = await d.updateSettings({ recipient: 'Me@Shop.Test', enabled: false });
        expect(s.recipient).toBe('me@shop.test'); expect(s.enabled).toBe(false); expect(s.nextDueAt).toBeNull();
    });
    it('sends once on the first due tick, never twice in the same week, and retries after a failure', async () => {
        const monday = new Date('2026-10-12T09:00:00'); // local Monday 09:00
        const { d, send, rows } = mk();
        expect(await d.tick(monday)).toBe(true);
        expect(send).toHaveBeenCalledWith('owner@shop.test', expect.objectContaining({ subject: expect.stringContaining('12 unwanted requests blocked') }));
        expect(await d.tick(new Date(monday.getTime() + 3_600_000))).toBe(false);
        expect(await d.tick(new Date(monday.getTime() + 3 * 86_400_000))).toBe(false);
        expect(await d.tick(new Date(monday.getTime() + 7 * 86_400_000))).toBe(true);
        expect(send).toHaveBeenCalledTimes(2);
        // Failure gives the clock back.
        send.mockRejectedValueOnce(new Error('smtp down'));
        const t3 = new Date(monday.getTime() + 14 * 86_400_000);
        expect(await d.tick(t3)).toBe(false);
        expect(rows.get('vendure-plugin-geo-block|digest.lastSentAt')).toBe(new Date(monday.getTime() + 7 * 86_400_000).toISOString());
        expect(await d.tick(new Date(t3.getTime() + 3_600_000))).toBe(true);
    });
    it('does nothing when disabled or without any recipient', async () => {
        const monday = new Date('2026-10-12T09:00:00');
        const a = mk(); await a.prefs.set('digest.enabled', 'off');
        expect(await a.d.tick(monday)).toBe(false);
        const b = mk(vi.fn(async () => undefined), { defaultRecipient: () => null });
        expect(await b.d.tick(monday)).toBe(false);
        expect((await b.d.sendNow()).reason).toBe('no-recipient');
    });
    it('sendNow previews and delivers without moving the weekly clock', async () => {
        const { d, send, rows } = mk();
        const r = await d.sendNow('test@shop.test');
        expect(r.sent).toBe(true); expect(r.to).toBe('test@shop.test'); expect(r.preview.subject).toContain('Geo Block');
        expect(send).toHaveBeenCalledTimes(1);
        expect(rows.has('vendure-plugin-geo-block|digest.lastSentAt')).toBe(false);
    });
});

describe('Heartbeat stats', () => {
    it('includes sanitised usage numbers in the ping body', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true }));
        (globalThis as any).fetch = fetchMock;
        const hb = new Heartbeat({ packageName: '@huloglobal/vendure-plugin-geo-block', packageVersion: '1.0.0', publicKeyFingerprint: 'abc' });
        hb.setStatsProvider(() => ({ requestsBlocked: 12.6, 'bad key!': 1, nan: NaN, str: 'x' as any }));
        await hb.pingNow();
        const body = JSON.parse((fetchMock.mock.calls[0] as any)[1].body);
        expect(body.stats).toEqual({ requestsBlocked: 13 });
        expect(body.jti).toBe('unlicensed');
    });
    it('reports the key in force after admin activation and via a live provider', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true }));
        (globalThis as any).fetch = fetchMock;
        const jwt = (jti: string) => 'eyJ.' + Buffer.from(JSON.stringify({ jti })).toString('base64url') + '.sig';
        let live: string | null = null;
        const hb = new Heartbeat({ packageName: 'p', packageVersion: '1', publicKeyFingerprint: 'abc', licenceKeyProvider: () => live });
        expect(hb.currentJti()).toBe('unlicensed');
        hb.setLicenceKey(jwt('from-admin'));
        expect(hb.currentJti()).toBe('from-admin');
        live = jwt('live-one');
        expect(hb.currentJti()).toBe('live-one');
        await hb.pingNow();
        expect(JSON.parse((fetchMock.mock.calls[0] as any)[1].body).jti).toBe('live-one');
        live = null; hb.setLicenceKey(null);
        expect(hb.currentJti()).toBe('unlicensed');
    });
});

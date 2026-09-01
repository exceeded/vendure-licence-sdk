import { describe, expect, it } from 'vitest';
import { generateKeyPairSync, createSign } from 'crypto';
import { hostname, platform } from 'os';
import { createHash } from 'crypto';
import { verifyLicence } from '../src/verify';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' }) as string;

function mint(payload: any): string {
    const b64 = (o: any) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    const h = b64({ alg: 'RS256', typ: 'JWT' });
    const p = b64(payload);
    const s = createSign('RSA-SHA256');
    s.update(`${h}.${p}`); s.end();
    const sig = s.sign(privateKey).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
    return `${h}.${p}.${sig}`;
}

const localId = createHash('sha256').update(hostname() + '|' + platform()).digest('hex').slice(0, 32);
const base = { customer: 't@example.com', allowedDomains: ['*'], plan: 'lifetime', iat: 1, exp: 9999999999, jti: 'test' };

describe('master licence', () => {
    it('wildcard pluginId + matching hardware activates any plugin', () => {
        const key = mint({ ...base, pluginId: '*', instanceId: localId });
        for (const pid of ['vendure-plugin-quotations', 'vendure-plugin-fraud-prevention']) {
            const st = verifyLicence({ licenceKey: key, pluginId: pid, host: 'elite.charity', publicKey: pubPem });
            expect(st.valid).toBe(true);
        }
    });
    it('master key on the wrong hardware is rejected', () => {
        const key = mint({ ...base, pluginId: '*', instanceId: 'f'.repeat(32) });
        const st = verifyLicence({ licenceKey: key, pluginId: 'vendure-plugin-quotations', host: 'elite.charity', publicKey: pubPem });
        expect(st.valid).toBe(false);
        expect(st.message).toMatch(/hardware-bound/);
    });
    it('master key without hardware binding is rejected', () => {
        const key = mint({ ...base, pluginId: '*' });
        const st = verifyLicence({ licenceKey: key, pluginId: 'vendure-plugin-quotations', host: 'elite.charity', publicKey: pubPem });
        expect(st.valid).toBe(false);
        expect(st.message).toMatch(/instanceId/);
    });
    it('ordinary per-plugin keys still verify (no instanceId claim)', () => {
        const key = mint({ ...base, pluginId: 'vendure-plugin-quotations' });
        const st = verifyLicence({ licenceKey: key, pluginId: 'vendure-plugin-quotations', host: 'elite.charity', publicKey: pubPem });
        expect(st.valid).toBe(true);
    });
    it('hardware-bound per-plugin key on wrong machine rejected', () => {
        const key = mint({ ...base, pluginId: 'vendure-plugin-quotations', instanceId: 'a'.repeat(32) });
        const st = verifyLicence({ licenceKey: key, pluginId: 'vendure-plugin-quotations', host: 'elite.charity', publicKey: pubPem });
        expect(st.valid).toBe(false);
    });
});

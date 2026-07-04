import { describe, expect, it } from 'vitest';
import { classifyEmailEvent } from '../src/email-event-classifier';

/**
 * The classifier is advisory + heuristic — these tests document the
 * intended behaviour for the well-known reason codes. Regressions here
 * mean an email event will be scored differently, which affects the
 * per-email human_likely / machine_likely counters in the admin UI.
 */
describe('classifyEmailEvent', () => {
    describe('user-agent driven signals', () => {
        it('marks a real browser UA as human_likely with no reasons', () => {
            const r = classifyEmailEvent({
                userAgent:
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15',
            });
            expect(r.classification).toBe('human_likely');
            expect(r.reasons).toEqual([]);
        });

        it('flags Microsoft Safe Links as machine_likely with outlook-proxy + safelinks', () => {
            const r = classifyEmailEvent({
                userAgent: 'Mozilla/5.0 (compatible; Microsoft-Outlook-SafeLinks/1.0)',
            });
            expect(r.classification).toBe('machine_likely');
            expect(r.reasons).toContain('outlook-proxy');
            expect(r.reasons).toContain('safelinks');
        });

        it('flags GoogleImageProxy as machine_likely with gmail-proxy', () => {
            const r = classifyEmailEvent({
                userAgent:
                    'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) GoogleImageProxy',
            });
            expect(r.classification).toBe('machine_likely');
            expect(r.reasons).toContain('gmail-proxy');
        });

        it('flags Apple Mail Privacy Protection UAs as machine_likely with ampp', () => {
            const r = classifyEmailEvent({
                userAgent:
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:100.0) Gecko/20100101 Firefox/100.0 AppleMailPrivacyProtection',
            });
            expect(r.classification).toBe('machine_likely');
            expect(r.reasons).toContain('ampp');
        });

        it.each([
            ['Proofpoint URL Defense', 'proofpoint'],
            ['Mimecast Email Security', 'mimecast'],
            ['Barracuda Networks', 'barracuda'],
            ['Symantec Email.cloud', 'symantec'],
            ['Forcepoint Web Security', 'forcepoint'],
        ])('flags %s as machine_likely with reason %s', (ua, expectedReason) => {
            const r = classifyEmailEvent({ userAgent: ua });
            expect(r.classification).toBe('machine_likely');
            expect(r.reasons).toContain(expectedReason);
        });

        it.each([
            ['curl/8.5.0', 'cli-ua'],
            ['python-requests/2.31.0', 'cli-ua'],
            ['Go-http-client/1.1', 'cli-ua'],
            ['Mozilla/5.0 HeadlessChrome/122.0.0.0 Safari/537.36', 'headless'],
            ['Googlebot/2.1', 'bot-ua'],
        ])('flags %s as machine_likely with reason %s', (ua, expectedReason) => {
            const r = classifyEmailEvent({ userAgent: ua });
            expect(r.classification).toBe('machine_likely');
            expect(r.reasons).toContain(expectedReason);
        });

        it('classifies as unknown when UA is missing and no IP flags', () => {
            const r = classifyEmailEvent({ userAgent: null });
            expect(r.classification).toBe('unknown');
            expect(r.reasons).toContain('no-ua');
        });
    });

    describe('IP-driven signals', () => {
        it('flags Tor exit as machine_likely with tor', () => {
            const r = classifyEmailEvent({
                userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Firefox/128.0',
                ipIsTor: true,
            });
            expect(r.classification).toBe('machine_likely');
            expect(r.reasons).toContain('tor');
        });

        it('flags known-scanner IPs as machine_likely with known-scanner', () => {
            const r = classifyEmailEvent({
                userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0',
                ipIsKnownSecurityScanner: true,
            });
            expect(r.classification).toBe('machine_likely');
            expect(r.reasons).toContain('known-scanner');
        });

        it('flags datacentre IPs as machine_likely with datacentre', () => {
            const r = classifyEmailEvent({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0.0.0',
                ipIsDatacentre: true,
            });
            expect(r.classification).toBe('machine_likely');
            expect(r.reasons).toContain('datacentre');
        });

        it('surfaces datacentre-org as an advisory reason without flipping classification', () => {
            // Design choice: org-substring match is a weak signal
            // (someone browsing at work could resolve to "Amazon Inc.")
            // — we surface the reason so the admin sees WHY the event
            // is suspicious, but the classification stays human_likely
            // unless a stronger flag also fires (ipIsDatacentre=true,
            // tor, known-scanner, etc.).
            const r = classifyEmailEvent({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0.0.0',
                ipOrg: 'Amazon Technologies Inc.',
            });
            expect(r.reasons).toContain('datacentre-org');
            expect(r.classification).toBe('human_likely');
        });

        it('but datacentre-org PLUS ipIsDatacentre flips to machine_likely', () => {
            const r = classifyEmailEvent({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0.0.0',
                ipOrg: 'Amazon Technologies Inc.',
                ipIsDatacentre: true,
            });
            expect(r.classification).toBe('machine_likely');
            expect(r.reasons).toContain('datacentre');
            expect(r.reasons).toContain('datacentre-org');
        });

        it('surfaces high-risk-ip when the provider risk score is >= 70', () => {
            const r = classifyEmailEvent({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0.0.0',
                ipRiskScore: 85,
            });
            expect(r.classification).toBe('machine_likely');
            expect(r.reasons).toContain('high-risk-ip');
        });

        it('does NOT flag low-risk IPs', () => {
            const r = classifyEmailEvent({
                userAgent: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0.0.0',
                ipRiskScore: 20,
            });
            expect(r.reasons).not.toContain('high-risk-ip');
        });
    });

    describe('reason dedup + shape', () => {
        it('deduplicates reasons when multiple patterns match the same code', () => {
            // Two matches for 'gmail-proxy' (both patterns fire on this UA).
            const r = classifyEmailEvent({
                userAgent: 'GoogleImageProxy Mozilla/5.0 GmailFetcher',
            });
            const gmailProxyCount = r.reasons.filter(x => x === 'gmail-proxy').length;
            expect(gmailProxyCount).toBe(1);
        });
    });

    describe('classification precedence', () => {
        it('any strong machine signal beats a browser UA', () => {
            const r = classifyEmailEvent({
                userAgent:
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15',
                ipIsTor: true,
            });
            expect(r.classification).toBe('machine_likely');
        });
    });
});

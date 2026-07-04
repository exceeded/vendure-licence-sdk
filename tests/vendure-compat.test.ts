import { describe, expect, it } from 'vitest';
import { isVendureVersionCompatible } from '../src/vendure-compat';

describe('isVendureVersionCompatible', () => {
    const range = { min: '3.5.0', max: '4.0.0' };

    it('accepts a version at the low boundary', () => {
        expect(isVendureVersionCompatible('3.5.0', range)).toBe(true);
    });

    it('accepts a version inside the range', () => {
        expect(isVendureVersionCompatible('3.6.3', range)).toBe(true);
        expect(isVendureVersionCompatible('3.7.0', range)).toBe(true);
        expect(isVendureVersionCompatible('3.7.99', range)).toBe(true);
    });

    it('rejects a version below the minimum', () => {
        expect(isVendureVersionCompatible('3.4.99', range)).toBe(false);
        expect(isVendureVersionCompatible('3.0.0', range)).toBe(false);
    });

    it('rejects the max (exclusive upper bound)', () => {
        expect(isVendureVersionCompatible('4.0.0', range)).toBe(false);
    });

    it('rejects a version above the max', () => {
        expect(isVendureVersionCompatible('4.0.1', range)).toBe(false);
        expect(isVendureVersionCompatible('5.0.0', range)).toBe(false);
    });

    it('handles pre-release suffixes by trimming to major.minor.patch', () => {
        expect(isVendureVersionCompatible('3.7.0-rc.1', range)).toBe(true);
        expect(isVendureVersionCompatible('3.7.0-beta.42', range)).toBe(true);
    });

    it('fails-open on unparseable input (no false alarm)', () => {
        // If the runtime version can't be parsed we DO NOT warn.
        // Better to be silent than to spam production logs.
        expect(isVendureVersionCompatible('not-a-version', range)).toBe(true);
        expect(isVendureVersionCompatible('', range)).toBe(true);
    });
});

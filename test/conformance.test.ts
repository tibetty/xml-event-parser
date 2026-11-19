import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { XmlParser } from '../src/xmlparser';
import { saxTree } from './sax-tree';

/**
 * W3C XML Conformance Test Suite, James Clark's xmltest, valid/sa: each
 * document must parse to the same tree as its canonical form in out/.
 *
 * The suite is not vendored (its licence allows redistribution only as the
 * unmodified archive); `npm run conformance:data` downloads it. Without it the
 * test is skipped, unless XMLTS_REQUIRED=1, as in CI.
 *
 * The parser does not process DTDs, so documents whose internal subset declares
 * entities or attribute lists are out of scope: their canonical form depends on
 * those declarations.
 */
const DIR = '.cache/xmlts/xmlconf/xmltest/valid/sa/';
const present = existsSync(DIR);

/** Decode by byte-order mark, as a caller of the core entry must. */
function decode(bytes: Buffer): string {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) {
        return new TextDecoder('utf-16le').decode(bytes);
    }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) {
        return new TextDecoder('utf-16be').decode(bytes);
    }
    return new TextDecoder('utf-8').decode(bytes);
}

describe('W3C xmltest valid/sa', () => {
    if (!present && process.env.XMLTS_REQUIRED === '1') {
        it('has the suite downloaded', () => {
            expect.fail(`${DIR} is missing: run npm run conformance:data`);
        });
        return;
    }

    it.skipIf(!present)('parses every in-scope document to its canonical tree', () => {
        const files = readdirSync(DIR).filter((name) => name.endsWith('.xml')).sort();
        let checked = 0;
        for (const name of files) {
            const source = decode(readFileSync(DIR + name));
            if (/<!ENTITY|<!ATTLIST/.test(source)) {
                continue;
            }
            // Canonical forms keep PIs; the tree drops them, and sax rejects the empty
            // '<??>' of 017a. Canonical XML has no comments or CDATA, so the regex is safe.
            const canonical = readFileSync(`${DIR}out/${name}`, 'utf8').replace(/<\?[\s\S]*?\?>/g, '');
            const expected = saxTree(canonical);
            expect(new XmlParser().parse(source), name).toEqual(expected);
            checked++;
        }
        expect(checked).toBe(57);
    });
});

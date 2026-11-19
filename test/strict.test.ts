import { describe, expect, it } from 'vitest';
import { XmlParseError, XmlParser } from '../src/index';

const strict = (xml: string): any[] => new XmlParser({ strict: true }).parse(xml);

/** The error strict parsing throws for `xml`, chunked in `size` characters (whole if omitted). */
function errorOf(xml: string, size?: number): XmlParseError {
    const parser = new XmlParser({ strict: true });
    try {
        if (size === undefined) {
            parser.parse(xml);
        } else {
            for (let at = 0; at < xml.length; at += size) {
                parser.write(xml.slice(at, at + size));
            }
            parser.end();
        }
    } catch (error) {
        expect(error).toBeInstanceOf(XmlParseError);
        return error as XmlParseError;
    }
    throw new Error(`no error for ${JSON.stringify(xml)}`);
}

describe('strict mode: well-formed input', () => {
    it('parses the same tree as lenient mode', () => {
        const xml = '<?xml version="1.0"?>\n<!DOCTYPE r>\n<!-- c -->\n<r a="1" b=\'&amp;\'>\n'
            + '  <x>t &lt; &#65;<![CDATA[<raw>]]><?pi d?></x>\n  <y/>\n  <z ></z >\n</r>\n<!-- after -->\n';
        expect(strict(xml)).toEqual(new XmlParser().parse(xml));
    });

    it('accepts a byte-order mark and whitespace around the root', () => {
        expect(strict('﻿\n <r/> \n')).toEqual([{ tagName: 'r' }]);
    });

    it('lets several roots attach to a parse() parent', () => {
        const parent = { tagName: 'host' };
        new XmlParser({ strict: true }).parse('<a/><b/>', parent);
        expect(parent).toEqual({ tagName: 'host', children: [{ tagName: 'a' }, { tagName: 'b' }] });
    });

    it('applies to createStream through its options', async () => {
        const { createStream } = await import('../src/stream');
        const stream = createStream({ event: '</r.i>', strict: true });
        const failed = new Promise((resolve) => stream.on('error', resolve));
        stream.resume();
        stream.end(Buffer.from('<r><i></r>'));
        expect(await failed).toBeInstanceOf(XmlParseError);
    });
});

describe('strict mode: errors', () => {
    const cases: [string, string, RegExp, number, number][] = [
        ['mismatched close tag', '<a><b></a>', /expected <\/b>/, 1, 7],
        ['stray close tag', '<a/></b>', /unexpected <\/b>/, 1, 5],
        ['unclosed element', '<a>\n<b>x', /<b> is not closed/, 2, 5],
        ['unterminated open tag', '<a>\n  <b x="1"', /unterminated tag/, 2, 3],
        ['unterminated close tag', '<a>x</a', /unterminated tag/, 1, 5],
        ['< at the end of input', '<a>x<', /unterminated tag/, 1, 5],
        ['unterminated comment', '<a><!-- c', /unterminated comment/, 1, 4],
        ['unterminated CDATA', '<a><![CDATA[x', /unterminated CDATA/, 1, 4],
        ['unterminated PI', '<a><?pi x', /unterminated processing instruction/, 1, 4],
        ['unterminated doctype', '<!DOCTYPE r', /unterminated doctype/, 1, 1],
        ['unterminated internal subset', '<!DOCTYPE r [ <!ELEMENT r ANY>', /unterminated doctype/, 1, 1],
        ['unknown declaration', '<a><!ELEMENT a ANY></a>', /unknown declaration/, 1, 4],
        ['doctype after the root', '<a/><!DOCTYPE a>', /doctype after the root/, 1, 5],
        ['-- inside a comment', '<a><!-- a -- b --></a>', /'--' inside a comment/, 1, 4],
        ['comment ending in -', '<a><!-- a ---></a>', /'--' inside a comment/, 1, 4],
        ['CDATA outside the root', '<![CDATA[x]]><a/>', /text outside the root/, 1, 1],
        [']]> in text', '<a>x]]>y</a>', /']]>' in text/, 1, 5],
        ['< in an attribute value', '<a v="x<y"/>', /'<' in an attribute value/, 1, 8],
        ['invalid element name', '<a><1b/></a>', /'<' does not start markup/, 1, 4],
        ['invalid name character', '<a><b!c/></a>', /invalid element name/, 1, 5],
        ['invalid attribute name', '<a 1x="y"/>', /invalid attribute name/, 1, 4],
        ['/ not followed by >', '<a / >', /'\/' not followed by '>'/, 1, 4],
        ['PI without a target', '<a><? x?></a>', /without a target/, 1, 4],
        ['XML declaration not first', '<a/><?xml version="1.0"?>', /not at the start/, 1, 5],
        ['malformed XML declaration', '<?xml encoding="UTF-8" version="1.0"?><a/>', /malformed XML declaration/, 1, 1],
        ['upper-case hex reference', '<a>&#X41;</a>', /'&' does not start a reference/, 1, 4],
        ['control character', '<a>x\fy</a>', /character U\+000C is not allowed/, 1, 5],
        ['lone surrogate', '<a>\uD800x</a>', /character U\+D800 is not allowed/, 1, 4],
        ['unquoted attribute', '<a x=1/>', /value of x must be quoted/, 1, 6],
        ['attribute without value', '<a x/>', /x has no value/, 1, 4],
        ['duplicate attribute', '<a x="1" x="2"/>', /duplicate attribute x/, 1, 10],
        ['text before the root', 'hi<a/>', /text outside the root/, 1, 1],
        ['text after the root', '<a/>\n bye', /text outside the root/, 2, 2],
        ['second root', '<a/><b/>', /second root element/, 1, 5],
        ['no root', '<!-- only -->', /no root element/, 1, 14],
        ['< that is not markup', '<a>1 < 2</a>', /'<' does not start markup/, 1, 6],
        ['bare ampersand in text', '<a>AT&T</a>', /'&' does not start a reference/, 1, 6],
        ['unknown entity in an attribute', '<a v="&nbsp;"/>', /'&' does not start a reference/, 1, 7],
        ['bad character reference', '<a>&#0;</a>', /'&' does not start a reference/, 1, 4],
    ];

    for (const [label, xml, message, line, column] of cases) {
        it(`${label}: line ${line}, column ${column}`, () => {
            for (const size of [undefined, 1, 3]) {
                const error = errorOf(xml, size);
                expect(error.message, `size ${size}`).toMatch(message);
                expect([error.line, error.column], `size ${size}`).toEqual([line, column]);
                expect(error.message).toContain(`line ${line}, column ${column}`);
            }
        });
    }

    it('counts lines and columns across chunks that were already dropped', () => {
        const xml = '<r>\n' + '  <i>x</i>\n'.repeat(5000) + '  <i>y</j>\n</r>';
        const error = errorOf(xml, 64);
        expect([error.line, error.column]).toEqual([5002, 7]);
        expect(error.offset).toBe(xml.indexOf('</j>'));
    });

    it('accepts a surrogate pair split across chunks', () => {
        const parser = new XmlParser({ strict: true });
        parser.write('<a>\uD83D');
        parser.write('\uDE00</a>');
        expect(parser.end()).toEqual([{ tagName: 'a', text: '\u{1F600}' }]);
    });

    it('accepts an XML declaration after a byte-order mark', () => {
        expect(strict('\uFEFF<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a/>')).toEqual([{ tagName: 'a' }]);
    });

    it('counts CRLF as one line break', () => {
        expect(errorOf('<a>\r\n\r\n<b></a>').line).toBe(3);
    });

    it('can parse again after an error', () => {
        const parser = new XmlParser({ strict: true });
        expect(() => parser.parse('<a><b></a>')).toThrow(XmlParseError);
        expect(parser.parse('<a/>')).toEqual([{ tagName: 'a' }]);
    });
});

describe('strict mode off', () => {
    it('stays lenient by default', () => {
        expect(new XmlParser().parse('<a><b></a>x<c/>')).toEqual([
            { tagName: 'a', children: [{ tagName: 'b' }, { tagName: 'c' }] },
        ]);
    });
});

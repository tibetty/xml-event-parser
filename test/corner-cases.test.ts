import { describe, expect, it } from 'vitest';
import { XmlParser } from '../src/xmlparser';

const parse = (xml: string, opts: object = {}): any[] => new XmlParser(opts).parse(xml);

/** Parse `xml` in chunks of `size` characters. */
function parseChunked(xml: string, size: number): any[] {
    const parser = new XmlParser();
    for (let at = 0; at < xml.length; at += size) {
        parser.write(xml.slice(at, at + size));
    }
    return parser.end();
}

describe('attributes', () => {
    it('keeps the last of duplicate attributes', () => {
        expect(parse('<a x="1" x="2"/>')[0]).toEqual({ tagName: 'a', x: '2' });
    });

    it('accepts whitespace around =', () => {
        expect(parse('<a x = "1"\n\ty\t=\t\'2\'/>')[0]).toEqual({ tagName: 'a', x: '1', y: '2' });
    });

    it('keeps the other quote character inside a value', () => {
        expect(parse('<a x="it\'s" y=\'say "hi"\'/>')[0]).toEqual({ tagName: 'a', x: "it's", y: 'say "hi"' });
    });

    it('keeps > and / inside a quoted value', () => {
        expect(parse('<a href="/x?a>b"/>')[0].href).toBe('/x?a>b');
        expect(parse('<a v="/>"><b/></a>')[0].children).toHaveLength(1);
    });

    it('reads empty and valueless attributes as empty strings', () => {
        expect(parse('<a x="" y/>')[0]).toEqual({ tagName: 'a', x: '', y: '' });
    });

    it('reads attributes without separating whitespace', () => {
        expect(parse('<a b="1"c="2"/>')[0]).toEqual({ tagName: 'a', b: '1', c: '2' });
    });

    it('keeps prefixed names as written', () => {
        expect(parse('<a:b xmlns:a="u" a:c="d"/>')[0]).toEqual({ tagName: 'a:b', 'xmlns:a': 'u', 'a:c': 'd' });
    });

    it('keeps very long names and values', () => {
        const name = 'n'.repeat(100000);
        const value = 'v'.repeat(1000000);
        const node = parse(`<${name} ${name}="${value}">${value}</${name}>`)[0];
        expect(node.tagName).toBe(name);
        expect(node[name]).toBe(value);
        expect(node.text).toBe(value);
    });
});

describe('a < that does not start markup', () => {
    it('is text when no name character follows', () => {
        expect(parse('<a>1 < 2</a>')[0]).toEqual({ tagName: 'a', text: '1 < 2' });
        expect(parse('<a>x<</a>')[0]).toEqual({ tagName: 'a', text: 'x<' });
        expect(parse('<a>a<=b</a>')[0]).toEqual({ tagName: 'a', text: 'a<=b' });
        expect(parse('<a><3</a>')[0]).toEqual({ tagName: 'a', text: '<3' });
    });

    it('does not swallow the tags that follow', () => {
        expect(parse('<r><a>1 <</a><b/></r>')[0]).toEqual({
            tagName: 'r',
            children: [{ tagName: 'a', text: '1 <' }, { tagName: 'b' }],
        });
    });

    it('produces no element with an empty name', () => {
        expect(parse('<>')).toEqual([]);
        expect(parse('< a/>')).toEqual([]);
        expect(parse('<r><></r>')[0]).toEqual({ tagName: 'r', text: '<>' });
    });

    it('is text at a chunk boundary', () => {
        const xml = '<r><a>1 < 2</a><b>x<</b></r>';
        for (const size of [1, 2, 3, 5]) {
            expect(parseChunked(xml, size)).toEqual(parse(xml));
        }
    });

    it('still opens non-ASCII names', () => {
        expect(parse('<été ü="1">x</été>')[0]).toEqual({ tagName: 'été', ü: '1', text: 'x' });
        expect(parse('<_a/>')[0].tagName).toBe('_a');
        expect(parse('<:a/>')[0].tagName).toBe(':a');
    });
});

describe('truncated input', () => {
    const cases: [string, any[]][] = [
        ['<a', [{ tagName: 'a' }]],
        ['<a x', [{ tagName: 'a', x: '' }]],
        ['<a x=', [{ tagName: 'a' }]],
        ['<a x="v', [{ tagName: 'a', x: 'v' }]],
        ['<a x="v"', [{ tagName: 'a', x: 'v' }]],
        ['<a>t', [{ tagName: 'a', text: 't' }]],
        ['<a>t<', [{ tagName: 'a', text: 't<' }]],
        ['<a>t</', [{ tagName: 'a', text: 't' }]],
        ['<a>t</a', [{ tagName: 'a', text: 't' }]],
        ['<r><a>t</a', [{ tagName: 'r', children: [{ tagName: 'a', text: 't' }] }]],
        ['<a>t<!--', [{ tagName: 'a', text: 't' }]],
        ['<a>t<!-- c -', [{ tagName: 'a', text: 't' }]],
        ['<a>t<![CDATA[c', [{ tagName: 'a', text: 'tc' }]],
        ['<a>t<?pi', [{ tagName: 'a', text: 't' }]],
        ['<a>t<!DOCTYPE', [{ tagName: 'a', text: 't' }]],
        ['<!DOCTYPE', []],
        ['<?xml', []],
        ['', []],
    ];

    for (const [xml, expected] of cases) {
        it(`keeps what was parsed from ${JSON.stringify(xml)}`, () => {
            expect(parse(xml)).toEqual(expected);
            expect(parseChunked(xml, 1)).toEqual(expected);
        });
    }
});

describe('structure', () => {
    it('ignores a stray close tag', () => {
        expect(parse('</a>')).toEqual([]);
        expect(parse('</a><b/>')).toEqual([{ tagName: 'b' }]);
    });

    it('accepts whitespace inside close and self-closing tags', () => {
        expect(parse('<a>x</a >')[0]).toEqual({ tagName: 'a', text: 'x' });
        expect(parse('<a/ >')[0]).toEqual({ tagName: 'a' });
        expect(parse('<a\n/>')[0]).toEqual({ tagName: 'a' });
    });

    it('keeps ]]> outside CDATA as text', () => {
        expect(parse('<a>]]></a>')[0].text).toBe(']]>');
    });

    it('decodes lower-case hex digits in character references', () => {
        expect(parse('<a v="&#xe9;">&#x1f600;</a>')[0]).toEqual({ tagName: 'a', v: 'é', text: '\u{1F600}' });
    });

    it('drops a declaration inside text', () => {
        expect(parse('<a>x<!DOCTYPE y>z</a>')[0].text).toBe('xz');
    });

    it('re-tracks only the open elements a new listener can reach', () => {
        const parser = new XmlParser({ progressive: true });
        const seen: string[] = [];
        parser.write('<r><a><b><c><d>');
        parser.on('</r.a>', (node) => seen.push(node.tagName));
        parser.write('</d></c></b></a></r>');
        parser.end();
        expect(seen).toEqual(['a']);
    });

    it('keeps a bare & as text', () => {
        expect(parse('<a>&</a>')[0].text).toBe('&');
    });

    it('ignores a byte-order mark before the root', () => {
        expect(parse('﻿<a/>')).toEqual([{ tagName: 'a' }]);
    });

    it('skips a doctype internal subset with > inside quotes and comments', () => {
        const xml = '<!DOCTYPE r [\n<!ELEMENT r (#PCDATA)>\n<!ENTITY e "a>]b">\n<!-- ]> -->\n]>\n<r>x</r>';
        expect(parse(xml)).toEqual([{ tagName: 'r', text: 'x' }]);
        expect(new XmlParser({ strict: true }).parse(xml)).toEqual([{ tagName: 'r', text: 'x' }]);
        expect(parseChunked(xml, 1)).toEqual([{ tagName: 'r', text: 'x' }]);
    });

    it('ignores the prolog, doctype and comments around the root', () => {
        const xml = '<?xml version="1.0"?>\n<!DOCTYPE r>\n<!-- c -->\n<r>x</r>\n<!-- after -->\n';
        expect(parse(xml)).toEqual([{ tagName: 'r', text: 'x' }]);
    });
});

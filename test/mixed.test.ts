import { describe, expect, it } from 'vitest';
import { XmlParser } from '../src/xmlparser';

const mixed = (xml: string, opts: object = {}): any[] => new XmlParser({ mixed: true, ...opts }).parse(xml);
const t = (text: string) => ({ tagName: '#text', text });

/** Parse `xml` in mixed mode, in chunks of `size` characters. */
function chunked(xml: string, size: number, opts: object = {}): any[] {
    const parser = new XmlParser({ mixed: true, ...opts });
    for (let at = 0; at < xml.length; at += size) {
        parser.write(xml.slice(at, at + size));
    }
    return parser.end();
}

describe('mixed content', () => {
    it('keeps text runs around child elements in document order', () => {
        expect(mixed('<p>a<b>bold</b>c</p>')).toEqual([
            { tagName: 'p', children: [t('a'), { tagName: 'b', text: 'bold' }, t('c')] },
        ]);
    });

    it('keeps text around self-closing children', () => {
        expect(mixed('<p>line<br/>next</p>')[0].children).toEqual([t('line'), { tagName: 'br' }, t('next')]);
    });

    it('keeps whitespace runs, which separate inline elements', () => {
        expect(mixed('<p>x <b>y</b> <i>z</i></p>')[0].children).toEqual([
            t('x '), { tagName: 'b', text: 'y' }, t(' '), { tagName: 'i', text: 'z' },
        ]);
    });

    it('merges CDATA into a run and drops comments and PIs', () => {
        expect(mixed('<p>a<!--x-->b<![CDATA[<c>]]><?pi?><i/>d</p>')[0].children).toEqual([
            t('ab<c>'), { tagName: 'i' }, t('d'),
        ]);
    });

    it('emits no text node for a run of only comments', () => {
        expect(mixed('<p><!--x--><i/><!--y--></p>')[0].children).toEqual([{ tagName: 'i' }]);
    });

    it('decodes entities and normalises line endings in runs', () => {
        expect(mixed('<p>a &amp;\r\n<i/>&lt;</p>')[0].children).toEqual([t('a &\n'), { tagName: 'i' }, t('<')]);
    });

    it('leaves text-only elements with their text field', () => {
        expect(mixed('<a>t</a>')).toEqual([{ tagName: 'a', text: 't' }]);
        expect(mixed('<r><a>t</a></r>')).toEqual([{ tagName: 'r', children: [{ tagName: 'a', text: 't' }] }]);
    });

    it('nests', () => {
        expect(mixed('<p>a<b>x<i>y</i>z</b>c</p>')[0].children).toEqual([
            t('a'),
            { tagName: 'b', children: [t('x'), { tagName: 'i', text: 'y' }, t('z')] },
            t('c'),
        ]);
    });

    it('gives the same tree at every chunk split', () => {
        const xml = '<r>\n  <p>one <b>two</b> &amp; <!-- c --><i>three</i><br/>four<![CDATA[<5>]]></p>\n</r>';
        const whole = mixed(xml);
        for (let cut = 1; cut < xml.length; cut++) {
            const parser = new XmlParser({ mixed: true });
            parser.write(xml.slice(0, cut));
            parser.write(xml.slice(cut));
            expect(parser.end(), `cut ${cut}`).toEqual(whole);
        }
        for (const size of [1, 2, 3, 7]) {
            expect(chunked(xml, size), `size ${size}`).toEqual(whole);
        }
    });

    it('keeps the text parsed so far from truncated input', () => {
        expect(mixed('<p>a<b>x')[0].children).toEqual([t('a'), { tagName: 'b', text: 'x' }]);
        expect(mixed('<p>a<b>x</b>tail')[0].children).toEqual([t('a'), { tagName: 'b', text: 'x' }, t('tail')]);
        expect(chunked('<p>a<b>x</b>tail', 1)[0].children).toEqual([t('a'), { tagName: 'b', text: 'x' }, t('tail')]);
    });

    it('keeps runs inside kept subtrees under retain: none', () => {
        const parser = new XmlParser({ mixed: true, progressive: true, retain: 'none', keep: ['doc.p'] });
        const seen: any[] = [];
        parser.on('</doc.p>', (node) => seen.push(node));
        parser.parse('<doc>skip<p>a<b>x</b>c</p>skip</doc>');
        expect(seen).toEqual([{ tagName: 'p', children: [t('a'), { tagName: 'b', text: 'x' }, t('c')] }]);
    });

    it('does not emit events for text nodes', () => {
        const parser = new XmlParser({ mixed: true, progressive: true });
        const seen: string[] = [];
        parser.on('</p.b>', (node) => seen.push(node.tagName));
        parser.on('</p>', (node) => seen.push(node.tagName + ':' + node.children!.length));
        parser.parse('<p>a<b>x</b>c</p>');
        expect(seen).toEqual(['b', 'p:3']);
    });

    it('works with strict mode', () => {
        expect(mixed('<p>a<b>x</b>c</p>', { strict: true })[0].children).toHaveLength(3);
    });

    it('is off by default', () => {
        expect(new XmlParser().parse('<p>a<b>bold</b>c</p>')).toEqual([
            { tagName: 'p', children: [{ tagName: 'b', text: 'bold' }] },
        ]);
    });

    it('passes through createStream', async () => {
        const { createStream } = await import('../src/stream');
        const stream = createStream({ event: '</doc.p>', mixed: true });
        const items: any[] = [];
        stream.on('data', (node) => items.push(node));
        const done = new Promise((resolve) => stream.on('end', resolve));
        stream.end(Buffer.from('<doc><p>a<b>x</b>c</p></doc>'));
        await done;
        expect(items[0].children).toEqual([t('a'), { tagName: 'b', text: 'x' }, t('c')]);
    });
});

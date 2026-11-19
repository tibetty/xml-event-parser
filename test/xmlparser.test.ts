import { describe, expect, it, vi } from 'vitest';
import { XmlParser, decodeEntities } from '../src/xmlparser';

const parse = (xml: string, opts: any = {}): any => new XmlParser(opts).parse(xml);

describe('decodeEntities', () => {
    it('leaves entity-free text untouched', () => {
        expect(decodeEntities('plain text')).toBe('plain text');
    });

    it('decodes named entities', () => {
        expect(decodeEntities('&amp;&lt;&gt;&quot;&apos;')).toBe('&<>"\'');
    });

    it('decodes decimal, lower-case hex and upper-case hex entities', () => {
        expect(decodeEntities('&#65;&#x42;&#X43;')).toBe('ABC');
    });

    it('keeps unknown and out-of-range entities unchanged', () => {
        expect(decodeEntities('&bogus;')).toBe('&bogus;');
        expect(decodeEntities('&#x110000;')).toBe('&#x110000;');
        expect(decodeEntities('&#99999999999999999999;')).toBe('&#99999999999999999999;');
        expect(decodeEntities('&#x;')).toBe('&#x;');
    });

    it('decodes mixed content', () => {
        expect(decodeEntities('a&amp;&#65;&bogus;z')).toBe('a&A&bogus;z');
    });

    it('keeps a bare ampersand and decodes the entities after it', () => {
        expect(decodeEntities('AT&T &lt;b&gt;')).toBe('AT&T <b>');
        expect(decodeEntities('& a &amp; b')).toBe('& a & b');
        expect(decodeEntities('a && b &amp;')).toBe('a && b &');
        expect(decodeEntities('tail &')).toBe('tail &');
        expect(decodeEntities('&&amp;')).toBe('&&');
    });

    it('keeps numeric references with malformed digits as written', () => {
        for (const ref of ['&#12abc;', '&#+5;', '&#-5;', '&# 5;', '&#x+41;', '&#xG;', '&#;', '&#x;', '&#5.0;']) {
            expect(decodeEntities(ref)).toBe(ref);
        }
    });

    it('keeps references to characters XML forbids as written', () => {
        for (const ref of ['&#0;', '&#x8;', '&#xB;', '&#x1F;', '&#xD800;', '&#xDFFF;', '&#xFFFE;', '&#xFFFF;', '&#x110000;']) {
            expect(decodeEntities(ref)).toBe(ref);
        }
    });

    it('decodes the boundaries of the legal character ranges', () => {
        expect(decodeEntities('&#x9;&#xA;&#xD;&#x20;')).toBe('\t\n\r ');
        expect(decodeEntities('&#xD7FF;&#xE000;&#xFFFD;')).toBe('\uD7FF\uE000\uFFFD');
        expect(decodeEntities('&#x10000;&#x10FFFF;')).toBe('\u{10000}\u{10FFFF}');
        expect(decodeEntities('&#x00041;&#0065;')).toBe('AA');
    });

    it('decodes entities in attributes and text', () => {
        const root = parse('<a v="AT&T &amp; co">x &lt; y & z</a>')[0];
        expect(root.v).toBe('AT&T & co');
        expect(root.text).toBe('x < y & z');
    });
});

describe('XmlParser structural parsing', () => {
    it('parses nested elements, attributes and self-closing leaves', () => {
        const roots = parse('<root a="1" b=\'2\'><child x="&amp;"/><empty/></root>');
        expect(roots).toHaveLength(1);
        const root = roots[0];
        expect(root.tagName).toBe('root');
        expect(root.a).toBe('1');
        expect(root.b).toBe('2');
        expect(root.children).toHaveLength(2);
        expect(root.children[0].tagName).toBe('child');
        expect(root.children[0].x).toBe('&');
        expect(root.children[1].tagName).toBe('empty');
    });

    it('returns multiple roots and ignores trailing text', () => {
        const roots = parse('<a/>text<b/>');
        expect(roots.map((node: any) => node.tagName)).toEqual(['a', 'b']);
        expect(parse('<a/>trailing text')).toHaveLength(1);
    });

    it('appends multiple non-self-closing children to a parent', () => {
        const roots = parse('<root><a></a><b></b></root>');
        expect(roots[0].children.map((node: any) => node.tagName)).toEqual(['a', 'b']);
    });

    it('sets innerText only when the element has no child elements', () => {
        expect(parse('<a>hello</a>')[0].text).toBe('hello');
        expect(parse('<a></a>')[0].text).toBeUndefined();
        expect(parse('<a>hello<b/></a>')[0].text).toBeUndefined();
        expect(parse('<a><b>text</b></a>')[0].children[0].text).toBe('text');
    });

    it('decodes entities in attributes and text', () => {
        const [node] = parse('<a x="&amp;&#65;&#x42;&#X43;">&lt;&gt;</a>');
        expect(node.x).toBe('&ABC');
        expect(node.text).toBe('<>');
    });

    it('skips comments, processing instructions and doctypes', () => {
        const roots = parse('<?xml version="1.0"?><!-- a comment --><!DOCTYPE osm><a/>');
        expect(roots).toHaveLength(1);
        expect(roots[0].tagName).toBe('a');
    });

    it('supports quoted, boolean and oddly-spaced attributes', () => {
        const [node] = parse('<a x = "1" y = \'2\' disabled z="a>b"/>');
        expect(node.x).toBe('1');
        expect(node.y).toBe('2');
        expect(node.disabled).toBe('');
        expect(node.z).toBe('a>b');
    });

    it('supports namespaced/dashed tag names and literal whitespace', () => {
        const [node] = parse('<ns:a-b\nx="1"\ty="2"\r/>');
        expect(node.tagName).toBe('ns:a-b');
        expect(node.x).toBe('1');
        expect(node.y).toBe('2');
    });

    it('does not throw on unquoted or unterminated attributes', () => {
        expect(() => parse('<a x=1/>')).not.toThrow();
        expect(() => parse('<a x="1/>')).not.toThrow();
    });

    it('handles malformed and truncated documents gracefully', () => {
        for (const xml of ['', '</a>', '</a', '<a', '<?pi', '<!-- unterminated', '<!DOCTYPE', '<a><b>']) {
            expect(() => parse(xml)).not.toThrow();
        }
        expect(parse('')).toEqual([]);
        expect(parse('</a>')).toEqual([]);
    });

    it('closes open elements at end of input instead of dropping them', () => {
        expect(parse('<a><b>')).toEqual([{ tagName: 'a', children: [{ tagName: 'b' }] }]);
        expect(parse('<r><a>text')).toEqual([{ tagName: 'r', children: [{ tagName: 'a', text: 'text' }] }]);
        expect(parse('<r><a>ok</a><b>trunc'))
            .toEqual([{ tagName: 'r', children: [{ tagName: 'a', text: 'ok' }, { tagName: 'b', text: 'trunc' }] }]);
    });

    it('appends to an existing parent children across parses', () => {
        const parent: any = {};
        const parser = new XmlParser({});
        parser.parse('<a/>', parent);
        parser.parse('<b/>', parent);
        expect(parent.children.map((node: any) => node.tagName)).toEqual(['a', 'b']);
    });
});

describe('reserved attribute names', () => {
    it('does not throw on an attribute named children', () => {
        const root = parse('<a children="x"><b/></a>')[0];
        expect(root.children.map((node: any) => node.tagName)).toEqual(['b']);
    });

    it('keeps tagName, children and text as parser fields', () => {
        expect(parse('<a tagName="y"/>')[0].tagName).toBe('a');
        expect(parse('<a children="x"/>')[0].children).toBeUndefined();
        expect(parse('<a text="t"/>')[0].text).toBeUndefined();
        expect(parse('<a text="t">body</a>')[0].text).toBe('body');
    });

    it('stores __proto__ as data without changing the prototype', () => {
        const node = parse('<a __proto__="x" constructor="c"/>')[0];
        expect(Object.getPrototypeOf(node)).toBe(Object.prototype);
        expect(Object.getOwnPropertyDescriptor(node, '__proto__')?.value).toBe('x');
        expect(node.constructor).toBe('c');
    });

    it('drops reserved names in a tag split across chunks', () => {
        const parser = new XmlParser();
        parser.write('<a tag');
        parser.write('Name="y" chil');
        parser.write('dren="x"><b/></a>');
        const root = parser.end()[0];
        expect(root.tagName).toBe('a');
        expect(root.children).toHaveLength(1);
    });
});

describe('CDATA', () => {
    it('returns the content without the wrapper', () => {
        expect(parse('<r><a><![CDATA[keep <this> & that]]></a></r>')[0].children![0].text)
            .toBe('keep <this> & that');
    });

    it('does not decode entities inside CDATA', () => {
        expect(parse('<r><a><![CDATA[a &amp; b]]></a></r>')[0].children![0].text).toBe('a &amp; b');
    });

    it('decodes entities outside CDATA and keeps CDATA verbatim', () => {
        expect(parse('<r><a>x &amp; y<![CDATA[ &amp; z]]></a></r>')[0].children![0].text)
            .toBe('x & y &amp; z');
    });

    it('handles an unterminated CDATA section without throwing', () => {
        expect(parse('<r><a><![CDATA[unterminated</a></r>')[0].children![0].text)
            .toBe('unterminated</a></r>');
    });
});

describe('markup inside text', () => {
    it('drops comments and processing instructions from text', () => {
        expect(parse('<a>x<!-- c -->y</a>')[0].text).toBe('xy');
        expect(parse('<a>x<?pi z?>y</a>')[0].text).toBe('xy');
        expect(parse('<a><!-- only --></a>')[0].text).toBeUndefined();
        expect(parse('<a>x<?pi a>b?>y</a>')[0].text).toBe('xy');
        expect(parse('<a>x<!-- <b>not a tag</b> -->y</a>')[0]).toEqual({ tagName: 'a', text: 'xy' });
    });

    it('keeps comment and PI syntax inside CDATA verbatim', () => {
        expect(parse('<a><![CDATA[<!-- c --><?pi?>]]></a>')[0].text).toBe('<!-- c --><?pi?>');
        expect(parse('<a>&lt;<!--c--><![CDATA[&amp;]]>&gt;</a>')[0].text).toBe('<&amp;>');
    });

    it('drops an unterminated comment or PI at end of input', () => {
        expect(parse('<a>x<!-- c')[0].text).toBe('x');
        expect(parse('<a>x<?pi')[0].text).toBe('x');
    });

    it('drops a comment split across chunks at every point', () => {
        const xml = '<r><a>x<!-- c -->y</a></r>';
        for (let cut = 1; cut < xml.length; cut++) {
            const parser = new XmlParser();
            parser.write(xml.slice(0, cut));
            parser.write(xml.slice(cut));
            expect(parser.end()[0].children![0].text).toBe('xy');
        }
    });
});

describe('XML 1.0 normalisation', () => {
    it('normalises CRLF and lone CR to LF in text (2.11)', () => {
        expect(parse('<a>x\r\ny\rz\n</a>')[0].text).toBe('x\ny\nz\n');
        expect(parse('<a><![CDATA[x\r\ny]]></a>')[0].text).toBe('x\ny');
    });

    it('keeps a CR written as a character reference', () => {
        expect(parse('<a>x&#13;y</a>')[0].text).toBe('x\ry');
    });

    it('normalises a CRLF split across chunks', () => {
        const parser = new XmlParser();
        parser.write('<a>x\r');
        parser.write('\ny</a>');
        expect(parser.end()[0].text).toBe('x\ny');
    });

    it('turns literal tab, CR and LF in attribute values into spaces (3.3.3)', () => {
        const node = parse('<a v="x\ty\nz\r\nw\rq" e=""/>')[0];
        expect(node.v).toBe('x y z w q');
        expect(node.e).toBe('');
    });

    it('normalises every attribute and text run in a multi-line document', () => {
        const pieces = ['x', 'y\nz', '\t', 'a\r\nb', 'plain', '\r', 'q w'];
        let xml = '<r>\n';
        const expected: string[] = [];
        for (let k = 0; k < 60; k++) {
            const v = pieces[k % pieces.length];
            const t = pieces[(k * 3) % pieces.length];
            xml += `  <i\n    a="${v}" b='${t}'>${t}</i>\r\n`;
            expected.push(v.replace(/\r\n|[\t\n\r]/g, ' '), t.replace(/\r\n|[\t\n\r]/g, ' '), t.replace(/\r\n?/g, '\n'));
        }
        xml += '</r>';
        for (const chunk of [xml.length, 7, 1]) {
            const parser = new XmlParser();
            for (let at = 0; at < xml.length; at += chunk) {
                parser.write(xml.slice(at, at + chunk));
            }
            const got = parser.end()[0].children!.flatMap((i: any) => [i.a, i.b, i.text]);
            expect(got).toEqual(expected);
        }
    });

    it('keeps whitespace written as character references in attribute values', () => {
        expect(parse('<a v="x&#9;y&#10;z&#13;"/>')[0].v).toBe('x\ty\nz\r');
    });
});

describe('XmlParser progressive events', () => {
    it('emits open and close events with parent nodes', () => {
        const parser = new XmlParser({ progressive: true });
        const events: string[] = [];
        parser.on('<root>', (node, parent) => events.push(`open:${node.tagName}:${parent ? parent.tagName : '-'}`));
        parser.on('</root>', (node, parent) => events.push(`close:${node.tagName}:${parent ? parent.tagName : '-'}`));
        parser.on('<root.a>', (node, parent) => events.push(`open-a:${node.tagName}:${parent ? parent.tagName : '-'}`));
        parser.on('</root.a>', (node, parent) => events.push(`close-a:${node.tagName}:${parent ? parent.tagName : '-'}`));
        parser.parse('<root><a/></root>');
        expect(events).toEqual([
            'open:root:-',
            'open-a:a:root',
            'close-a:a:root',
            'close:root:-',
        ]);
    });

    it('emits open and close for non-self-closing watched elements', () => {
        const parser = new XmlParser({ progressive: true });
        const open = vi.fn();
        const close = vi.fn();
        parser.on('<root.a>', open);
        parser.on('</root.a>', close);
        parser.parse('<root><a></a></root>');
        expect(open).toHaveBeenCalledTimes(1);
        expect(close).toHaveBeenCalledTimes(1);
    });

    it('does not emit events for unobserved paths', () => {
        const parser = new XmlParser({ progressive: true });
        const open = vi.fn();
        const close = vi.fn();
        parser.on('<root.a>', open);
        parser.on('</root.a>', close);
        parser.parse('<root><b/></root>');
        expect(open).not.toHaveBeenCalled();
        expect(close).not.toHaveBeenCalled();
    });

    it('supports multiple listeners for one event', () => {
        const parser = new XmlParser({ progressive: true });
        const first = vi.fn();
        const second = vi.fn();
        parser.on('</root.a>', first);
        parser.on('</root.a>', second);
        parser.parse('<root><a/></root>');
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);
    });

    it('registers multiple children of the same parent', () => {
        const parser = new XmlParser({ progressive: true });
        const a = vi.fn();
        const b = vi.fn();
        parser.on('</root.a>', a);
        parser.on('</root.b>', b);
        parser.parse('<root><a/><b/></root>');
        expect(a).toHaveBeenCalledTimes(1);
        expect(b).toHaveBeenCalledTimes(1);
    });

    it('removes listeners with on/off and removeListener', () => {
        const parser = new XmlParser({ progressive: true });
        const closed = vi.fn();
        const opened = vi.fn();
        parser.on('</root.a>', closed);
        parser.off('</root.a>', closed);
        parser.on('<root.a>', opened);
        parser.removeListener('<root.a>', opened);
        parser.parse('<root><a/></root>');
        expect(closed).not.toHaveBeenCalled();
        expect(opened).not.toHaveBeenCalled();
    });

    it('ignores removals for unknown events or different functions', () => {
        const parser = new XmlParser({ progressive: true });
        const added = vi.fn();
        const other = vi.fn();
        parser.removeListener('</never>', other);
        parser.on('</root.a>', added);
        parser.removeListener('</root.a>', other);
        parser.parse('<root><a/></root>');
        expect(added).toHaveBeenCalledTimes(1);
        expect(other).not.toHaveBeenCalled();
    });

    it('accepts and removes non-tag event names', () => {
        const parser = new XmlParser({ progressive: true });
        const fn = vi.fn();
        parser.addListener('custom-event', fn);
        parser.removeListener('custom-event', fn);
        parser.parse('<a/>');
        expect(fn).not.toHaveBeenCalled();
    });

    it('does not emit progressive events when progressive is false', () => {
        const parser = new XmlParser({ progressive: false });
        const fn = vi.fn();
        parser.on('</root.a>', fn);
        parser.parse('<root><a/></root>');
        expect(fn).not.toHaveBeenCalled();
    });
});

describe('XmlParser parent tracking and dir prefixes', () => {
    it('tracks parents with queryParent', () => {
        const parser = new XmlParser({ queryParent: true });
        const roots = parser.parse('<root><a><b/></a></root>');
        const root = roots[0];
        const a = root.children![0];
        const b = a.children![0];
        expect(parser.getParent(a)).toBe(root);
        expect(parser.getParent(b)).toBe(a);
        expect(parser.getParent(root)).toBeUndefined();
        expect(parser.getParent({})).toBeUndefined();
    });

    it('returns null from getParent without queryParent', () => {
        const parser = new XmlParser({ queryParent: false });
        parser.parse('<a/>');
        expect(parser.getParent({})).toBeNull();
    });

    it('attaches parsed nodes to a supplied parent', () => {
        const parent: any = { tagName: 'container' };
        const parser = new XmlParser({ queryParent: true });
        const roots = parser.parse('<child x="1">text</child>', parent);
        expect(roots).toEqual([]);
        expect(parent.children).toHaveLength(1);
        expect(parent.children[0].x).toBe('1');
        expect(parent.children[0].text).toBe('text');
        expect(parser.getParent(parent.children[0])).toBe(parent);
    });

    it('applies a dir prefix to events', () => {
        const parser = new XmlParser({ progressive: true });
        const events: string[] = [];
        parser.on('<osm.root>', () => events.push('open'));
        parser.on('</osm.root>', () => events.push('close'));
        parser.parse('<root></root>', undefined, 'osm');
        expect(events).toEqual(['open', 'close']);
    });

    it('applies a dir prefix to self-closing top-level events', () => {
        const parser = new XmlParser({ progressive: true });
        const events: string[] = [];
        parser.on('<osm.tag>', () => events.push('open'));
        parser.on('</osm.tag>', () => events.push('close'));
        parser.parse('<tag/>', undefined, 'osm');
        expect(events).toEqual(['open', 'close']);
    });

    it('combines parent and dir prefixes', () => {
        const parent: any = { tagName: 'container' };
        const parser = new XmlParser({ progressive: true });
        const events: string[] = [];
        parser.on('<osm.child>', () => events.push('open'));
        parser.on('</osm.child>', () => events.push('close'));
        parser.parse('<child/>', parent, 'osm');
        expect(events).toEqual(['open', 'close']);
        expect(parent.children).toHaveLength(1);
    });

    it('uses the top-level path when a parent has no dir', () => {
        const parent: any = { tagName: 'container' };
        const parser = new XmlParser({ progressive: true });
        const events: string[] = [];
        parser.on('<child>', () => events.push('open'));
        parser.on('</child>', () => events.push('close'));
        parser.parse('<child/>', parent);
        expect(events).toEqual(['open', 'close']);
    });
});

describe('streaming input', () => {
    const doc = '<osm version="0.6"><node id="1" lat="0" lon="0"><tag k="a" v="x &amp; y"/></node>'
        + '<way id="2"><nd ref="1"/></way><!-- comment -->'
        + '<relation id="3"><member type="way" ref="2" role=""/></relation>'
        + '<![CDATA[ignored]]></osm>';

    it('produces the same tree for every single split point', () => {
        const expected = JSON.stringify(new XmlParser().parse(doc));
        for (let at = 1; at < doc.length; at++) {
            const parser = new XmlParser();
            parser.write(doc.slice(0, at));
            parser.write(doc.slice(at));
            expect(JSON.stringify(parser.end()), `split at ${at}`).toBe(expected);
        }
    });

    it('produces the same tree for many small chunks', () => {
        const expected = JSON.stringify(new XmlParser().parse(doc));
        for (const size of [1, 2, 3, 5, 7, 13]) {
            const parser = new XmlParser();
            for (let at = 0; at < doc.length; at += size) {
                parser.write(doc.slice(at, at + size));
            }
            expect(JSON.stringify(parser.end()), `chunk size ${size}`).toBe(expected);
        }
    });

    it('survives tokens split across chunks', () => {
        const cases = [
            ['<r><a><!-- co', 'mment -->text</a></r>'],
            ['<r><a><![CD', 'ATA[x < y]]></a></r>'],
            ['<r><a v="x &am', 'p; y">t</a></r>'],
            ['<r><a>te', 'xt</a></r>'],
            ['<r><a', '/></r>'],
            ['<r><a', ' b="1">t</a></r>'],
        ];
        for (const parts of cases) {
            const xml = parts.join('');
            const expected = JSON.stringify(new XmlParser().parse(xml));
            const parser = new XmlParser();
            for (const part of parts) {
                parser.write(part);
            }
            expect(JSON.stringify(parser.end()), xml).toBe(expected);
        }
    });

    it('emits events while chunks arrive, before end()', () => {
        const parser = new XmlParser({ progressive: true });
        const seen: string[] = [];
        parser.on('</osm.node>', (node) => seen.push(String(node.id)));
        parser.write('<osm><node id="1" lat="0" lon="0"/>');
        expect(seen).toEqual(['1']);
        parser.write('<node id="2" lat="1" lon="1"/></osm>');
        expect(seen).toEqual(['1', '2']);
        expect(parser.end()).toHaveLength(1);
    });

    it('retains nothing with retain: none', () => {
        const parser = new XmlParser({ progressive: true, retain: 'none' });
        const ids: string[] = [];
        parser.on('</osm.node>', (node) => ids.push(String(node.id)));
        parser.write('<osm><node id="1"/><node id="2"/></osm>');
        expect(parser.end()).toEqual([]);
        expect(ids).toEqual(['1', '2']);
    });

    it('keeps one root at a time with retain: root', () => {
        const parser = new XmlParser({ progressive: true, retain: 'root' });
        const roots: string[] = [];
        parser.on('</osm>', (node) => roots.push(node.children!.map((child) => String(child.id)).join(',')));
        parser.write('<osm><node id="1"/><node id="2"/></osm><osm><node id="3"/></osm>');
        expect(parser.end()).toEqual([]);
        expect(roots).toEqual(['1,2', '3']);
    });

    it('parses consecutive documents on one instance', () => {
        const parser = new XmlParser();
        expect(parser.write('<a/>').end()).toEqual([{ tagName: 'a' }]);
        expect(parser.write('<b><c/></b>').end())
            .toEqual([{ tagName: 'b', children: [{ tagName: 'c' }] }]);
    });
});

describe('retain: none with keep', () => {
    it('emits complete subtrees for the kept path and drops the rest', () => {
        const parser = new XmlParser({
            progressive: true,
            retain: 'none',
            keep: ['testsuites.testsuite.testcase'],
        });
        const cases: any[] = [];
        parser.on('</testsuites.testsuite.testcase>', (node) => cases.push(node));
        parser.write('<testsuites><testsuite><testcase name="a"><failure message="boom">trace</failure>'
            + '<system-out>log</system-out></testcase><testcase name="b"/></testsuite></testsuites>');
        expect(parser.end()).toEqual([]);
        expect(cases).toHaveLength(2);
        expect(cases[0].name).toBe('a');
        expect(cases[0].children).toHaveLength(2);
        expect(cases[0].children[0].tagName).toBe('failure');
        expect(cases[0].children[0].text).toBe('trace');
        expect(cases[0].children[1].text).toBe('log');
        expect(cases[1].children).toBeUndefined();
    });

    it('accepts the event spelling of the path', () => {
        const parser = new XmlParser({ progressive: true, retain: 'none', keep: ['</r.item>'] });
        const items: any[] = [];
        parser.on('</r.item>', (node) => items.push(node));
        parser.parse('<r><item><child>text</child></item></r>');
        expect(items[0].children[0].tagName).toBe('child');
    });
});

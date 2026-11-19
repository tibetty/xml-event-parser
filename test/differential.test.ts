import { describe, expect, it } from 'vitest';
import { XmlParser } from '../src/xmlparser';
import { saxTree } from './sax-tree';

/**
 * Differential test: random well-formed documents parsed by this library and by
 * `sax` in strict mode must give the same tree. Seeded, so a failure names a
 * seed that reproduces it.
 */

function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const NAME_START = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ_é';
const NAME_REST = NAME_START + '0123456789-:';
const TEXT_PIECES = ['x', 'word', ' ', '1 2', '&amp;', '&lt;', '&gt;', '&quot;', '&apos;', '&#65;', '&#x1F600;', '中文', 'é', '>', '"', "'", '\n', '\t'];

class Generator {
    constructor(private readonly random: () => number) {}

    pick<T>(items: readonly T[]): T {
        return items[Math.floor(this.random() * items.length)];
    }

    name(): string {
        let out = this.pick([...NAME_START]);
        const length = Math.floor(this.random() * 6);
        for (let k = 0; k < length; k++) {
            out += this.pick([...NAME_REST]);
        }
        return out;
    }

    text(): string {
        let out = '';
        const length = 1 + Math.floor(this.random() * 5);
        for (let k = 0; k < length; k++) {
            out += this.pick(TEXT_PIECES);
        }
        return out;
    }

    attributeValue(quote: string): string {
        return this.text().replace(quote === '"' ? /"/g : /'/g, quote === '"' ? '&quot;' : '&apos;');
    }

    /** Content of a text-only element: text, CDATA, comments and PIs. */
    content(): string {
        let out = '';
        const parts = Math.floor(this.random() * 4);
        for (let k = 0; k < parts; k++) {
            const roll = this.random();
            if (roll < 0.6) {
                out += this.text();
            } else if (roll < 0.75) {
                out += `<![CDATA[${this.text().replace(/]]>/g, '')}<b>&amp;</b>]]>`;
            } else if (roll < 0.9) {
                out += '<!-- c <x> & -->';
            } else {
                out += '<?pi data?>';
            }
        }
        return out;
    }

    element(depth: number): string {
        const tag = this.name();
        let open = `<${tag}`;
        const seen = new Set<string>();
        const attributes = Math.floor(this.random() * 4);
        for (let k = 0; k < attributes; k++) {
            const name = this.name();
            if (seen.has(name) || name === 'tagName' || name === 'children' || name === 'text') {
                continue;
            }
            seen.add(name);
            const quote = this.random() < 0.5 ? '"' : "'";
            open += `${this.pick([' ', '\n', '\t '])}${name}${this.pick(['=', ' = '])}${quote}${this.attributeValue(quote)}${quote}`;
        }
        const roll = this.random();
        if (roll < 0.2) {
            return `${open}${this.pick(['/>', ' />'])}`;
        }
        if (depth >= 6 || roll < 0.5) {
            return `${open}>${this.content()}</${tag}>`;
        }
        let body = '';
        const children = 1 + Math.floor(this.random() * 4);
        for (let k = 0; k < children; k++) {
            body += this.pick(['', '\n  ', '<!-- between -->']) + this.element(depth + 1);
        }
        return `${open}>${body}\n</${tag}>`;
    }

    document(): string {
        return `<?xml version="1.0"?>\n<!-- head -->\n${this.element(0)}\n`;
    }
}

describe('differential: same tree as sax', () => {
    const documents = 400;

    it(`agrees on ${documents} random documents, whole and chunked`, () => {
        for (let seed = 1; seed <= documents; seed++) {
            const random = mulberry32(seed);
            const xml = new Generator(random).document();
            // XML 1.0 3.3.3, which sax does not apply: literal tabs and newlines in a value become spaces
            const expected = saxTree(xml, (value) => value.replace(/\r\n|[\t\n\r]/g, ' '));
            expect(new XmlParser().parse(xml), `seed ${seed}: ${xml}`).toEqual(expected);

            const parser = new XmlParser();
            for (let at = 0; at < xml.length;) {
                const size = 1 + Math.floor(random() * 16);
                parser.write(xml.slice(at, at + size));
                at += size;
            }
            expect(parser.end(), `seed ${seed} chunked: ${xml}`).toEqual(expected);
        }
    });
});

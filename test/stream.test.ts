import { describe, expect, it } from 'vitest';
import { Readable, Writable, pipeline } from 'node:stream';
import { createStream } from '../src/stream';

/** Run chunks through the stream adapter and collect every emitted node. */
const collect = async (chunks: Array<string | Buffer>, options: { event: string }) => {
    const items: any[] = [];
    await new Promise<void>((resolve, reject) => {
        pipeline(
            Readable.from(chunks),
            createStream(options),
            new Writable({
                objectMode: true,
                write(node: any, _encoding, callback) {
                    items.push(node);
                    callback();
                },
            }),
            (error) => (error ? reject(error) : resolve()),
        );
    });
    return items;
};

const JUNIT = '<testsuites><testsuite name="s1">'
    + '<testcase name="a" time="0.1"><failure message="boom">trace</failure></testcase>'
    + '<testcase name="b" time="0.2"/>'
    + '</testsuite></testsuites>';

describe('createStream', () => {
    it('emits the selected elements with their subtree', async () => {
        const items = await collect([JUNIT], { event: '</testsuites.testsuite.testcase>' });
        expect(items).toHaveLength(2);
        expect(items[0].name).toBe('a');
        expect(items[0].children[0].tagName).toBe('failure');
        expect(items[0].children[0].text).toBe('trace');
        expect(items[1].children).toBeUndefined();
    });

    it('gives the same result however the chunks are split', async () => {
        const bytes = Buffer.from(JUNIT, 'utf8');
        for (const size of [1, 2, 3, 7, 64]) {
            const chunks: Buffer[] = [];
            for (let at = 0; at < bytes.length; at += size) {
                chunks.push(bytes.subarray(at, at + size));
            }
            const items = await collect(chunks, { event: '</testsuites.testsuite.testcase>' });
            expect(items.map((item) => item.name), `chunk size ${size}`).toEqual(['a', 'b']);
            expect(items[0].children[0].text, `chunk size ${size}`).toBe('trace');
        }
    });

    it('reassembles multibyte characters split across chunks', async () => {
        const doc = '<r><item><name>café 😀 ünïcode</name></item></r>';
        const bytes = Buffer.from(doc, 'utf8');
        // Split inside the emoji and inside the accented characters.
        const cut = doc.indexOf('😀');
        const cuts = [doc.indexOf('é'), cut + 1, cut + 2, cut + 3].filter((at) => at > 0);
        for (const at of cuts) {
            const items = await collect([bytes.subarray(0, at), bytes.subarray(at)], { event: '</r.item>' });
            expect(items[0].children[0].text, `cut at ${at}`).toBe('café 😀 ünïcode');
        }
    });

    it('accepts string chunks', async () => {
        const items = await collect([JUNIT.slice(0, 40), JUNIT.slice(40)], { event: '</testsuites.testsuite.testcase>' });
        expect(items.map((item) => item.name)).toEqual(['a', 'b']);
    });

    it('accepts the bare path as well as the event form', async () => {
        const items = await collect([JUNIT], { event: 'testsuites.testsuite.testcase' });
        expect(items.map((item) => item.name)).toEqual(['a', 'b']);
    });

    it('requires an event path', () => {
        expect(() => createStream({} as any)).toThrow(/requires \{ event \}/);
    });

    it('fails the stream when a listener throws', async () => {
        const stream = createStream({ event: '</r.i>' });
        stream.on('data', () => {
            throw new Error('consumer');
        });
        const failed = new Promise((resolve) => stream.on('error', resolve));
        stream.end(Buffer.from('<r><i/></r>'));
        expect(String(await failed)).toMatch(/consumer/);
    });
});

/** Split `bytes` into chunks of `size` bytes. */
const split = (bytes: Buffer, size: number): Buffer[] => {
    const chunks: Buffer[] = [];
    for (let at = 0; at < bytes.length; at += size) {
        chunks.push(bytes.subarray(at, at + size));
    }
    return chunks;
};

const utf16be = (text: string): Buffer => {
    const le = Buffer.from(text, 'utf16le');
    const be = Buffer.alloc(le.length);
    for (let k = 0; k < le.length; k += 2) {
        be[k] = le[k + 1];
        be[k + 1] = le[k];
    }
    return be;
};

describe('createStream encodings', () => {
    const DOC = '<r><i>café 😀 中文</i></r>';
    const names = async (chunks: Buffer[]) => (await collect(chunks, { event: '</r.i>' })).map((item) => item.text);

    it('strips a UTF-8 byte-order mark', async () => {
        const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(DOC)]);
        for (const size of [1, 2, 3, 4, 64]) {
            expect(await names(split(bytes, size)), `size ${size}`).toEqual(['café 😀 中文']);
        }
    });

    it('decodes UTF-16LE and UTF-16BE by byte-order mark, split at every byte', async () => {
        const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(DOC, 'utf16le')]);
        const be = Buffer.concat([Buffer.from([0xfe, 0xff]), utf16be(DOC)]);
        for (const bytes of [le, be]) {
            for (const size of [1, 3, 64]) {
                expect(await names(split(bytes, size)), `size ${size}`).toEqual(['café 😀 中文']);
            }
        }
    });

    it('detects UTF-16 without a byte-order mark from the declaration (Appendix F)', async () => {
        const decl = '<?xml version="1.0" encoding="UTF-16"?>';
        expect(await names([Buffer.from(decl + DOC, 'utf16le')])).toEqual(['café 😀 中文']);
        expect(await names([utf16be(decl + DOC)])).toEqual(['café 😀 中文']);
    });

    it('honours a declared single-byte or multi-byte encoding', async () => {
        const latin1 = Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><r><i>caf\u00e9 \u00fc</i></r>', 'latin1');
        expect(await names(split(latin1, 1))).toEqual(['café ü']);
        const sjis = Buffer.from([
            ...Buffer.from("<?xml version='1.0' encoding='Shift_JIS'?><r><i>"),
            0x93, 0xfa, 0x96, 0x7b, // 日本 in Shift_JIS
            ...Buffer.from('</i></r>'),
        ]);
        for (const size of [1, 2, 64]) {
            expect(await names(split(sjis, size)), `size ${size}`).toEqual(['日本']);
        }
    });

    it('lets a byte-order mark win over the declaration', async () => {
        const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?>' + DOC)]);
        expect(await names([bytes])).toEqual(['café 😀 中文']);
    });

    it('defaults to UTF-8 without a declaration or with one that names no encoding', async () => {
        expect(await names([Buffer.from(DOC)])).toEqual(['café 😀 中文']);
        expect(await names(split(Buffer.from('<?xml version="1.0"?>' + DOC), 1))).toEqual(['café 😀 中文']);
    });

    it('decodes a document shorter than the detection window', async () => {
        expect(await names([Buffer.from('<r><i>x</i></r>')])).toEqual(['x']);
        expect(await names([Buffer.from('<?xml')])).toEqual([]);
        expect(await names([])).toEqual([]);
    });

    it('fails the stream for an encoding it cannot decode', async () => {
        const bytes = Buffer.from('<?xml version="1.0" encoding="x-unknown-7"?><r><i>x</i></r>');
        await expect(names([bytes])).rejects.toThrow(/x-unknown-7/);
    });
});

describe('core entry', () => {
    it('does not import node builtins in the core entry', async () => {
        const core = await import('../src/index');
        expect(Object.keys(core)).not.toContain('createStream');
    });
});

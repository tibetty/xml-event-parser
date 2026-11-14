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

    it('requires an event path', () => {
        expect(() => createStream({} as any)).toThrow(/requires \{ event \}/);
    });

    it('does not import node builtins in the core entry', async () => {
        const core = await import('../src/index');
        expect(Object.keys(core)).not.toContain('createStream');
    });
});

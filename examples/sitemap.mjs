#!/usr/bin/env node
/**
 * Read a sitemap and print its URLs.
 *
 *   node examples/sitemap.mjs
 *
 * Why streaming: a sitemap tops out at 50,000 URLs / 50 MB, which is common in
 * SEO tooling and fits in a Worker's 128 MB budget only if you never build the
 * tree. One path subscription, constant memory.
 */
import { createReadStream } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createStream } from 'xml-event-parser/stream';

const file = process.argv[2] ?? new URL('./data/sitemap.xml', import.meta.url);
let count = 0;

await pipeline(
    createReadStream(file),
    createStream({ event: '</urlset.url>' }),
    new Writable({
        objectMode: true,
        write(url, _encoding, done) {
            const loc = url.children?.find((child) => child.tagName === 'loc');
            const lastmod = url.children?.find((child) => child.tagName === 'lastmod');
            count++;
            console.log(`${loc?.text ?? '(no loc)'}  ${lastmod?.text ?? ''}`);
            done();
        },
    }),
);

console.log(`${count} URLs`);

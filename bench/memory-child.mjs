#!/usr/bin/env node
/**
 * One parser, one file, one process - spawned by bench/memory.mjs so each
 * measurement starts from a clean heap and can be capped.
 *
 * Prints a single JSON line: { ok, ms, maxRssMiB, items }.
 */

import fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const [, , parser, file] = process.argv;
const started = performance.now();
let items = 0;

const ours = async () => {
    // Measure the published artifact, not the TypeScript source.
    const { createStream } = await import('../dist/stream.mjs');
    await pipeline(
        fs.createReadStream(file),
        createStream({ event: '</testsuites.testsuite.testcase>' }),
        new Writable({
            objectMode: true,
            write(testcase, _encoding, done) {
                items++;
                // Touch the payload so a lazy parser cannot skip the work.
                if (testcase.children && testcase.children.length > 0) {
                    items += 0;
                }
                done();
            },
        }),
    );
};

const sax = async () => {
    const { default: saxParser } = await import('sax');
    const parser = saxParser.parser(true);
    parser.onopentag = (node) => {
        if (node.name === 'testcase') items++;
    };
    await pipeline(
        fs.createReadStream(file),
        new Writable({
            write(chunk, _encoding, done) {
                parser.write(chunk.toString('utf8'));
                done();
            },
        }),
    );
    parser.close();
};

const fxp = async () => {
    const { XMLParser } = await import('fast-xml-parser');
    const xml = fs.readFileSync(file, 'utf8');
    const doc = new XMLParser({ ignoreAttributes: false }).parse(xml);
    items = doc.testsuites.testsuite.length;
};

const run = { ours, sax, fxp }[parser];
if (!run) {
    process.stderr.write(`unknown parser: ${parser}\n`);
    process.exit(2);
}

try {
    await run();
    const ms = performance.now() - started;
    const maxRssMiB = process.resourceUsage().maxRSS / 1024;
    console.log(JSON.stringify({ ok: true, ms, maxRssMiB, items }));
} catch (error) {
    process.stderr.write(String(error && error.stack ? error.stack : error));
    process.exit(1);
}

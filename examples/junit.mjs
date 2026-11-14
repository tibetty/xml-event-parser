#!/usr/bin/env node
/**
 * Stream a JUnit XML report and print the failing testcases.
 *
 *   node examples/junit.mjs                      # uses examples/data/junit.xml
 *   node examples/junit.mjs /tmp/big-junit.xml   # 240 MB works the same
 *
 * Why streaming: CI reports reach hundreds of megabytes, and a tree parser
 * needs several times the file size in heap. Here each <testcase> is handed
 * over complete (with its <failure>/<system-out> children) and dropped
 * immediately, so memory is the largest testcase, not the report.
 */
import { createReadStream } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createStream } from 'xml-event-parser/stream';

const file = process.argv[2] ?? new URL('./data/junit.xml', import.meta.url);
let total = 0;
let failed = 0;

await pipeline(
    createReadStream(file),
    createStream({ event: '</testsuites.testsuite.testcase>' }),
    new Writable({
        objectMode: true,
        write(testcase, _encoding, done) {
            total++;
            const failure = testcase.children?.find((child) => child.tagName === 'failure');
            if (failure) {
                failed++;
                console.log(`${testcase.classname} › ${testcase.name}: ${failure.message}`);
            }
            done();
        },
    }),
);

console.log(`${total} testcases, ${failed} failing`);

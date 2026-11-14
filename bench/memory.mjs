#!/usr/bin/env node
/**
 * Memory benchmark: what each parser costs to read a CI-sized report.
 *
 *   node bench/memory.mjs                 # 60 MB and 240 MB reports
 *   node bench/memory.mjs --mb 20,60,240
 *
 * Each parser runs in its own child process capped at 512 MB of old space - a
 * typical CI container - so a tree parser's failure is reported as OOM instead
 * of swapping the machine. The reported figure is the child's `maxRSS`
 * (`process.resourceUsage()`), which is portable, not an OS-specific tool.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? args[at + 1] : fallback;
};
const sizes = option('mb', '60,240').split(',').map(Number);
const heap = option('heap', '512');
const dir = path.join(import.meta.dirname, 'data');
fs.mkdirSync(dir, { recursive: true });

/** Deterministic JUnit XML of roughly `megabytes`, written incrementally. */
const generate = (megabytes) => {
    const file = path.join(dir, `junit-${megabytes}mb.xml`);
    if (fs.existsSync(file) && fs.statSync(file).size >= megabytes * 1024 * 1024 * 0.95) {
        return file;
    }
    const target = megabytes * 1024 * 1024;
    const fd = fs.openSync(file, 'w');
    fs.writeSync(fd, '<?xml version="1.0"?><testsuites>');
    let written = 0;
    let suite = 0;
    while (written < target) {
        let chunk = `<testsuite name="suite-${suite % 500}" tests="50" time="12.5">`;
        for (let i = 0; i < 50; i++) {
            const id = suite * 50 + i;
            chunk += `<testcase classname="com.example.Service" name="test${id}" time="0.012">`
                + (i === 3 ? '<failure message="expected 1 but was 2" type="AssertionError">at com.example.Service.test(Service.java:42)</failure>' : '')
                + `<system-out>stdout for test ${id}</system-out></testcase>`;
        }
        chunk += '</testsuite>';
        fs.writeSync(fd, chunk);
        written += chunk.length;
        suite++;
    }
    fs.writeSync(fd, '</testsuites>');
    fs.closeSync(fd);
    return file;
};

const run = (parser, file) => {
    try {
        const out = execFileSync(process.execPath, [
            `--max-old-space-size=${heap}`,
            path.join(import.meta.dirname, 'memory-child.mjs'),
            parser,
            file,
        ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return JSON.parse(out.trim().split('\n').pop());
    } catch (error) {
        const stderr = String(error.stderr ?? '');
        const oom = /heap out of memory|Allocation failed/i.test(stderr);
        return { ok: false, ms: 0, maxRssMiB: 0, error: oom ? 'OOM' : `exit ${error.status}` };
    }
};

const parsers = [
    ['xml-event-parser', 'ours'],
    ['sax', 'sax'],
    ['fast-xml-parser', 'fxp'],
];

for (const megabytes of sizes) {
    const file = generate(megabytes);
    const bytes = fs.statSync(file).size;
    console.log(`\n### ${megabytes} MB JUnit report (${(bytes / 1024 / 1024).toFixed(0)} MiB, cap ${heap} MB heap)\n`);
    console.log('| parser | wall | max RSS | result |');
    console.log('| --- | --- | --- | --- |');
    for (const [label, id] of parsers) {
        const result = run(id, file);
        const wall = result.ok ? `${(result.ms / 1000).toFixed(2)} s` : '-';
        const rss = result.ok ? `${result.maxRssMiB.toFixed(0)} MiB` : '-';
        console.log(`| ${label} | ${wall} | ${rss} | ${result.ok ? 'ok' : result.error} |`);
    }
}

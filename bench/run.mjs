#!/usr/bin/env node
/**
 * Benchmarks xmlparser against txml, sax, htmlparser2 and fast-xml-parser on
 * the generated corpus.
 *
 * Two workloads, because the libraries do not do the same job:
 *
 *   tree    parse into a document tree and walk it, counting every element.
 *           Comparable for xmlparser, txml and fast-xml-parser.
 *   stream  consume element callbacks without keeping a document, counting
 *           nodes, ways and relations. Comparable for xmlparser's progressive
 *           events, sax and htmlparser2.
 *
 * xmlparser always builds the tree, even with `progressive` set, so its stream
 * row pays for a document the other two never build. That is a property of the
 * library, not a measurement artefact, and the report says so.
 *
 * Usage: node --expose-gc bench/run.mjs [--only osm-dense,boundary] [--json]
 */

import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import { parse as txml, transformStream } from 'txml';
import sax from 'sax';
import { Parser as HtmlParser } from 'htmlparser2';
import { XMLParser } from 'fast-xml-parser';
import { XmlParser } from '../src/xmlparser.ts';

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? args[at + 1] : fallback;
};
const only = option('only', '').split(',').filter(Boolean);
const asJson = args.includes('--json');
const dataDir = path.resolve(option('data', path.join(import.meta.dirname, 'data')));

const files = fs.readdirSync(dataDir).filter((f) => f.endsWith('.xml')).sort();
if (files.length === 0) {
    console.error('no data: run `npm run bench:data` first');
    process.exit(1);
}

/* ------------------------------- walkers ------------------------------- */

/** xmlparser: document roots with `$innerNodes` arrays. */
const walkOurs = (roots) => {
    let elements = 0;
    const stack = [...roots];
    while (stack.length > 0) {
        const node = stack.pop();
        elements++;
        const children = node.children;
        if (children !== undefined) {
            for (let i = 0; i < children.length; i++) stack.push(children[i]);
        }
    }
    return elements;
};

/** txml: { tagName, attributes, children }. */
const walkTxml = (nodes) => {
    let elements = 0;
    const stack = [...nodes];
    while (stack.length > 0) {
        const node = stack.pop();
        if (typeof node !== 'object' || node === null) continue;
        elements++;
        const children = node.children;
        if (Array.isArray(children)) {
            for (let i = 0; i < children.length; i++) stack.push(children[i]);
        }
    }
    return elements;
};

/** fast-xml-parser: plain nested objects; every object that is not a scalar counts. */
const walkFxp = (value) => {
    let elements = 0;
    const stack = [value];
    while (stack.length > 0) {
        const node = stack.pop();
        if (Array.isArray(node)) {
            for (let i = 0; i < node.length; i++) stack.push(node[i]);
        } else if (typeof node === 'object' && node !== null) {
            elements++;
            for (const key of Object.keys(node)) stack.push(node[key]);
        }
    }
    return elements;
};

/* ------------------------------- parsers ------------------------------- */

const ELEMENT_PATHS = ['</osm.node>', '</osm.way>', '</osm.relation>'];
const ELEMENT_NAMES = new Set(['node', 'way', 'relation']);

/**
 * Tree parsers are split into `build` (parse into a document) and `walk`
 * (count every element), so the retained-heap probe can hold the document of
 * one build instead of measuring a value that has already been discarded.
 */
const treeParsers = {
    'xmlparser': { build: (xml) => new XmlParser().parse(xml), walk: walkOurs },
    'txml': { build: (xml) => txml(xml), walk: walkTxml },
    'fast-xml-parser': {
        build: (xml) => new XMLParser({ ignoreAttributes: false, preserveOrder: true }).parse(xml),
        walk: walkFxp,
    },
};

const streamParsers = {
    'xmlparser events': (xml) => {
        const parser = new XmlParser({ progressive: true });
        let seen = 0;
        for (const event of ELEMENT_PATHS) parser.on(event, () => seen++);
        parser.parse(xml);
        return seen;
    },
    'sax': (xml) => {
        const parser = sax.parser(true);
        let seen = 0;
        parser.onclosetag = (name) => {
            if (ELEMENT_NAMES.has(name)) seen++;
        };
        parser.write(xml).close();
        return seen;
    },
    'htmlparser2': (xml) => {
        let seen = 0;
        const parser = new HtmlParser({
            onclosetag: (name) => {
                if (ELEMENT_NAMES.has(name)) seen++;
            },
        }, { xmlMode: true, decodeEntities: true });
        parser.write(xml);
        parser.end();
        return seen;
    },
};

/* --------------------------- streamed input --------------------------- */

const CHUNK = 64 * 1024;

/**
 * Streaming input, synchronous `write()` loops. txml's streaming API is a Node
 * stream (`transformStream`), so it is measured separately below.
 */
const chunkParsers = {
    'xmlparser (retain none)': (xml, emit) => {
        const parser = new XmlParser({ progressive: true, retain: 'none' });
        for (const event of ELEMENT_PATHS) parser.on(event, () => emit());
        for (let at = 0; at < xml.length; at += CHUNK) parser.write(xml.slice(at, at + CHUNK));
        parser.end();
    },
    'sax': (xml, emit) => {
        const parser = sax.parser(true);
        parser.onclosetag = (name) => {
            if (ELEMENT_NAMES.has(name)) emit();
        };
        for (let at = 0; at < xml.length; at += CHUNK) parser.write(xml.slice(at, at + CHUNK));
        parser.close();
    },
    'htmlparser2': (xml, emit) => {
        const parser = new HtmlParser({
            onclosetag: (name) => {
                if (ELEMENT_NAMES.has(name)) emit();
            },
        }, { xmlMode: true, decodeEntities: true });
        for (let at = 0; at < xml.length; at += CHUNK) parser.write(xml.slice(at, at + CHUNK));
        parser.end();
    },
};

/** txml's `transformStream` over Node streams: async, yields top-level nodes. */
const txmlStream = async (xml) => {
    const chunks = [];
    for (let at = 0; at < xml.length; at += CHUNK) chunks.push(xml.slice(at, at + CHUNK));
    const started = performance.now();
    let seen = 0;
    const stream = Readable.from(chunks).pipe(transformStream());
    for await (const node of stream) {
        if (node) seen++;
    }
    return { ms: performance.now() - started, seen };
};

/* ----------------------------- measurement ----------------------------- */

const TIME_BUDGET_MS = 1500;
const heapUsed = () => process.memoryUsage().heapUsed;
const gc = () => {
    if (typeof globalThis.gc === 'function') globalThis.gc();
};

/**
 * Run `fn` for at least the time budget, keeping the minimum duration: the
 * fastest run is the one least disturbed by the collector and the machine.
 */
const measure = (fn, xml) => {
    fn(xml); // warm-up: JIT, caches, lazy initialisation
    let best = Infinity;
    let runs = 0;
    const started = performance.now();
    do {
        const t0 = performance.now();
        fn(xml);
        const elapsed = performance.now() - t0;
        if (elapsed < best) best = elapsed;
        runs++;
    } while (performance.now() - started < TIME_BUDGET_MS && runs < 40);
    return { ms: best, runs };
};

/** Keeps the measured document reachable while the heap is sampled. */
let held;

/** Heap retained by one built document, sampled with that document still alive. */
const retained = (build, xml) => {
    gc();
    const before = heapUsed();
    held = build(xml);
    gc();
    const after = heapUsed();
    held = undefined;
    return Math.max(0, after - before);
};

const mbPerSecond = (bytes, ms) => (bytes / 1024 / 1024) / (ms / 1000);
const mib = (bytes) => (bytes / 1024 / 1024).toFixed(1);

const report = [];
for (const file of files) {
    const name = file.replace(/\.xml$/, '');
    if (only.length > 0 && !only.includes(name)) continue;
    const xml = fs.readFileSync(path.join(dataDir, file), 'utf8');
    const bytes = Buffer.byteLength(xml);

    const tree = [];
    for (const [parser, { build, walk }] of Object.entries(treeParsers)) {
        const parseAndWalk = (input) => walk(build(input));
        const { ms, runs } = measure(parseAndWalk, xml);
        tree.push({
            parser,
            ms,
            mbps: mbPerSecond(bytes, ms),
            retained: retained(build, xml),
            count: walk(build(xml)),
            runs,
        });
    }

    const stream = [];
    for (const [parser, fn] of Object.entries(streamParsers)) {
        const { ms, runs } = measure(fn, xml);
        stream.push({ parser, ms, mbps: mbPerSecond(bytes, ms), count: fn(xml), runs });
    }

    const chunked = [];
    for (const [parser, fn] of Object.entries(chunkParsers)) {
        let seen = 0;
        const count = () => seen++;
        fn(xml, count);
        seen = 0;
        let best = Infinity;
        const started = performance.now();
        let runs = 0;
        do {
            seen = 0;
            const t0 = performance.now();
            fn(xml, count);
            const elapsed = performance.now() - t0;
            if (elapsed < best) best = elapsed;
            runs++;
        } while (performance.now() - started < TIME_BUDGET_MS && runs < 40);
        chunked.push({ parser, ms: best, mbps: mbPerSecond(bytes, best), seen, runs });
    }

    report.push({ name, bytes, tree, stream, chunked });
    if (!asJson) {
        console.log(`\n### ${name} — ${mib(bytes)} MiB`);
        console.log('\n| parser | tree: fastest ms | MB/s | retained | elements |');
        console.log('| --- | --- | --- | --- | --- |');
        for (const row of tree) {
            console.log(`| ${row.parser} | ${row.ms.toFixed(1)} | ${row.mbps.toFixed(0)} | ${mib(row.retained)} MiB | ${row.count.toLocaleString()} |`);
        }
        console.log('\n| parser | stream: fastest ms | MB/s | elements seen |');
        console.log('| --- | --- | --- | --- |');
        for (const row of stream) {
            console.log(`| ${row.parser} | ${row.ms.toFixed(1)} | ${row.mbps.toFixed(0)} | ${row.count.toLocaleString()} |`);
        }
        console.log(`\n| parser (64 KiB chunks) | streamed: fastest ms | MB/s | elements seen |`);
        console.log('| --- | --- | --- | --- |');
        for (const row of chunked) {
            console.log(`| ${row.parser} | ${row.ms.toFixed(1)} | ${row.mbps.toFixed(0)} | ${row.seen.toLocaleString()} |`);
        }
    }
}

// txml's streaming API is stream-shaped, so it is timed separately.
const streamTargets = ['osm-dense', 'tag-storm'];
if (!asJson) {
    console.log('\n### txml `transformStream` (async, 64 KiB chunks, top-level nodes)');
    console.log('\n| dataset | ms | MB/s | nodes yielded |');
    console.log('| --- | --- | --- | --- |');
}
for (const entry of report) {
    if (!streamTargets.includes(entry.name)) continue;
    const xml = fs.readFileSync(path.join(dataDir, `${entry.name}.xml`), 'utf8');
    const { ms, seen } = await txmlStream(xml);
    entry.txmlStream = { ms, mbps: mbPerSecond(entry.bytes, ms), seen };
    if (!asJson) {
        console.log(`| ${entry.name} | ${ms.toFixed(1)} | ${mbPerSecond(entry.bytes, ms).toFixed(0)} | ${seen} |`);
    }
}

if (asJson) {
    console.log(JSON.stringify(report, null, 2));
}

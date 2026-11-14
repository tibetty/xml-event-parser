#!/usr/bin/env node
/**
 * Deterministic benchmark corpus for the XML parsers.
 *
 * Every shape isolates one cost so the numbers say *why* a parser is fast:
 *
 *   osm-dense   realistic Overpass-style document: many elements, few children
 *   boundary    one relation whose members carry inline coordinates inlined
 *               (thousands of <nd> children under a single <member>)
 *   leaf-storm  self-closing leaves only: the per-element entry cost
 *   tag-storm   many small children (<tag>) per element: the per-child cost
 *               where a tree parser allocates an object per child
 *   text        180-character tag values with entities and CDATA: the
 *               text/decoding cost
 *   deep        40-level nesting: the open-element stack cost
 *
 * Usage: node bench/generate.mjs [--out bench/data] [--scale 1]
 * The data is generated, not committed (see .gitignore).
 */

import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const option = (name, fallback) => {
    const at = args.indexOf(`--${name}`);
    return at >= 0 ? args[at + 1] : fallback;
};
const outDir = path.resolve(option('out', path.join(import.meta.dirname, 'data')));
const scale = Number(option('scale', '1'));

/** Deterministic PRNG so every run measures the same bytes. */
const mulberry32 = (seed) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rnd = mulberry32(0x5eed);
const lat = () => (rnd() * 160 - 80).toFixed(6);
const lon = () => (rnd() * 350 - 175).toFixed(6);
let nextId = 1_000_000;
const id = () => ++nextId;
const count = (n) => Math.max(1, Math.round(n * scale));

const header = '<osm version="0.6" generator="xml-event-tree-bench">\n';
const footer = '</osm>\n';

const tags = (n, prefix) => {
    let out = '';
    for (let i = 0; i < n; i++) {
        out += `<tag k="${prefix}:${i}" v="value-${Math.floor(rnd() * 1e6)}"/>\n`;
    }
    return out;
};

const shapes = {
    /** Realistic document: 30k nodes, 2.5k ways (12 nodes each), 200 relations. */
    'osm-dense': () => {
        const parts = [header];
        for (let i = 0; i < count(30_000); i++) {
            parts.push(`<node id="${id()}" lat="${lat()}" lon="${lon()}" version="3">\n${tags(3, 'node')}</node>\n`);
        }
        for (let w = 0; w < count(2_500); w++) {
            parts.push(`<way id="${id()}" version="2">\n`);
            for (let n = 0; n < 12; n++) parts.push(`<nd ref="${1_000_000 + Math.floor(rnd() * 30_000)}"/>\n`);
            parts.push(tags(2, 'way'), '</way>\n');
        }
        for (let r = 0; r < count(200); r++) {
            parts.push(`<relation id="${id()}" version="1">\n`);
            for (let m = 0; m < 5; m++) parts.push(`<member type="way" ref="${1_000_000 + Math.floor(rnd() * 2_500)}" role="outer"/>\n`);
            parts.push(tags(1, 'relation'), '</relation>\n');
        }
        parts.push(footer);
        return parts.join('');
    },

    /** A boundary extract: 400 members, each with 250 inline coordinates. */
    boundary: () => {
        const parts = [header, `<relation id="${id()}" version="1">\n`];
        for (let m = 0; m < count(400); m++) {
            parts.push(`<member type="way" ref="${id()}" role="${m % 7 === 0 ? 'inner' : 'outer'}">\n`);
            for (let n = 0; n < 250; n++) parts.push(`<nd lat="${lat()}" lon="${lon()}"/>\n`);
            parts.push('</member>\n');
        }
        parts.push(tags(1, 'boundary'), '</relation>\n', footer);
        return parts.join('');
    },

    /** 120k self-closing nodes: pure per-element cost. */
    'leaf-storm': () => {
        const parts = [header];
        for (let i = 0; i < count(120_000); i++) {
            parts.push(`<node id="${id()}" lat="${lat()}" lon="${lon()}"/>\n`);
        }
        parts.push(footer);
        return parts.join('');
    },

    /** 15k nodes with 12 <tag> children each: per-child cost. */
    'tag-storm': () => {
        const parts = [header];
        for (let i = 0; i < count(15_000); i++) {
            parts.push(`<node id="${id()}" lat="${lat()}" lon="${lon()}">\n${tags(12, 'tag')}</node>\n`);
        }
        parts.push(footer);
        return parts.join('');
    },

    /** Long values, entities and CDATA: text and decoding cost. */
    text: () => {
        const value = 'Bundesautobahn &amp; Straße &#x2013; Abschnitt &quot;Nord&quot; '.padEnd(180, 'x');
        const parts = [header];
        for (let i = 0; i < count(6_000); i++) {
            parts.push(`<node id="${id()}" lat="${lat()}" lon="${lon()}">\n`
                + `<tag k="name" v="${value}"/>\n`
                + `<tag k="note"><![CDATA[keep <this> & that ${Math.floor(rnd() * 1e9)}]]></tag>\n`
                + `</node>\n`);
        }
        parts.push(footer);
        return parts.join('');
    },

    /** 1,500 trees nested 40 levels deep: open-element stack cost. */
    deep: () => {
        const parts = [header];
        for (let r = 0; r < count(1_500); r++) {
            parts.push('<osm>');
            for (let d = 0; d < 40; d++) parts.push(`<level index="${d}" name="lvl-${d}">`);
            parts.push('<tag k="leaf" v="1"/>');
            for (let d = 0; d < 40; d++) parts.push('</level>');
            parts.push('</osm>\n');
        }
        parts.push(footer);
        return parts.join('');
    },
};

fs.mkdirSync(outDir, { recursive: true });
const written = [];
for (const [name, build] of Object.entries(shapes)) {
    const started = performance.now();
    const xml = build();
    const file = path.join(outDir, `${name}.xml`);
    fs.writeFileSync(file, xml);
    const mb = Buffer.byteLength(xml) / 1024 / 1024;
    written.push([name, mb]);
    console.log(`${name.padEnd(12)} ${mb.toFixed(2).padStart(6)} MiB  ${path.relative(process.cwd(), file)}  (${(performance.now() - started).toFixed(0)} ms)`);
}
console.log(`\ntotal ${written.reduce((sum, [, mb]) => sum + mb, 0).toFixed(1)} MiB in ${outDir}`);

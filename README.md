xml-event-parser
================

**Stream XML without loading it.** A tiny parser that gives you a document tree
and path-based events in one pass: constant heap on a 240 MB CI report, 2.2 KiB
gzipped, zero dependencies, and no `node:*` imports in the core entry.

- **Bounded memory**: `retain: 'none'` plus a path subscription keeps only the
  element being read. 240 MB in, 81 MiB of RSS.
- **Fast**: ~3.7x `sax` and ~4x `fast-xml-parser` on the same report, and faster
  than `txml` on every shape we benchmark ([numbers](bench/RESULTS.md)).
- **Two views, one pass**: a tree node and an `open`/`close` event per element -
  no second traversal, no DOM.
- **Small and portable**: 6.4 KiB minified / 2.2 KiB gzipped, zero dependencies,
  no `eval`, works in Node, browsers and edge runtimes (the Node adapter is a
  separate `xml-event-parser/stream` entry).

## When to use this

| your job | use |
| --- | --- |
| Read a file bigger than memory: CI/test reports (JUnit, SARIF, coverage), sitemaps, GPX/KML tracks, OSM extracts | **this**, `xml-event-parser/stream` |
| Pick elements while streaming without writing a SAX state machine | **this**, path events |
| Parse occasionally in a browser or Worker where a 20 KiB parser is too much | **this**, core entry (2.2 KiB) |
| Turn a small config XML into a plain object | `fast-xml-parser` or `xml2js` (richer object mapping) |
| DOM semantics: namespaces, XPath, mutation | `@xmldom/xmldom` |
| Zero allocation, hand-tuned callbacks, no tree at all | `sax` (slightly less memory than ours, ~3.7x slower here) |

## 240 MB in one second

A generated JUnit report, each parser in its own process capped at 512 MB of
heap - a typical CI container ([reproduce it](#development)):

| parser | 60 MB report | 240 MB report |
| --- | --- | --- |
| **xml-event-parser** | **0.27 s, 65 MiB** | **1.03 s, 81 MiB** |
| sax | 0.96 s, 67 MiB | 3.80 s, 79 MiB |
| fast-xml-parser | 1.52 s, 637 MiB | **out of memory** |

The file grows 4x; the heap does not. `fast-xml-parser` builds a tree, so it
needs roughly 7-11x the file size and dies on the larger report.

## Quick start

```sh
npm install xml-event-parser
```

Tree, when the document fits:

```js
import { XmlParser } from 'xml-event-parser';

const roots = new XmlParser().parse(xml);
// roots[0].tagName, roots[0].children, roots[0].text, attributes are flat
```

Stream, when it does not:

```js
import { createReadStream } from 'node:fs';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createStream } from 'xml-event-parser/stream';

await pipeline(
    createReadStream('junit.xml'),
    createStream({ event: '</testsuites.testsuite.testcase>' }),
    new Writable({
        objectMode: true,
        write(testcase, _encoding, done) {
            // complete element: attributes + <failure>/<system-out> children
            if (testcase.children?.some((child) => child.tagName === 'failure')) {
                console.log(testcase.name);
            }
            done();
        },
    }),
);
```

Without Node streams, `write()`/`end()` work anywhere:

```js
const parser = new XmlParser({ progressive: true, retain: 'none', keep: ['testsuites.testsuite.testcase'] });
parser.on('</testsuites.testsuite.testcase>', (testcase) => { /* ... */ });
for await (const chunk of response.body) parser.write(chunk);  // no node: imports
parser.end();
```

Runnable examples: [`examples/junit.mjs`](examples/junit.mjs),
[`examples/sitemap.mjs`](examples/sitemap.mjs),
[`examples/gpx.mjs`](examples/gpx.mjs) - `node examples/junit.mjs`.

## Node shape

```ts
interface XmlNode {
    tagName: string;          // element name, e.g. 'way'
    children?: XmlNode[];     // present only when the element has child elements
    text?: string;            // present only for text-only elements
    [attribute: string]: any; // attributes, copied flat onto the node
}
```

Attributes are flat rather than nested in an `attributes` object on purpose: one
object per element keeps a parsed document small (see the heap column in
[`bench/RESULTS.md`](bench/RESULTS.md)). Names that collide with `tagName`,
`children` or `text` are shadowed by the element's own values; if that matters
for your vocabulary, read attributes off the source XML instead.

An element with nested tags is emitted on close **after** its children are
attached, so `node.children` is complete inside a close listener.

## Streaming

```js
import { createReadStream } from 'node:fs';
import { XmlParser } from 'xml-event-parser';

const parser = new XmlParser({ progressive: true, retain: 'none' });
parser.on('</osm.way>', (way) => {
    // one complete element; `way` is released after this returns
});

for await (const chunk of createReadStream('planet.osm.xml', 'utf8')) {
    parser.write(chunk);
}
parser.end();
```

`write()` consumes everything complete in the buffer and keeps the rest for the
next call, so a chunk boundary can fall inside a tag, an attribute value, a text
run, a comment or a `]]>` terminator without changing the result: parsing a
document whole or in 1-byte chunks produces the same tree (the suite checks every
split point).

`retain` is what makes streaming bounded:

| `retain` | keeps | `end()` returns | memory |
| --- | --- | --- | --- |
| `'all'` (default) | the document | the roots | grows with the document |
| `'root'` | the root being built | `[]`; a finished root is emitted and dropped | largest root |
| `'none'` | nothing | `[]`; every element is emitted and dropped | nesting depth |

Measured on a 60 MiB document (ten concatenated extracts, 327k elements):
`retain: 'all'` holds 302 MiB, `retain: 'none'` holds ~0 MiB, both emit the same
327k elements. Without listeners, `retain: 'none'` still parses - it just throws
the result away.

Under `retain: 'none'`, `keep` restores the subtree of the elements you actually
want, so a streamed element is complete rather than a bare tag:

```js
new XmlParser({
    progressive: true,
    retain: 'none',
    keep: ['testsuites.testsuite.testcase'],   // 'testsuites.testsuite.testcase' or '</testsuites.testsuite.testcase>'
});
```

Memory is then the largest matched element, not the document. `createStream`
sets this up for you from its `event` path.

## Events

| form | fires |
| --- | --- |
| `'<osm.way>'` | when a `<way>` inside `<osm>` opens |
| `'</osm.way>'` | when it closes, with `children` populated |

The path is the dotted chain of ancestors. Event names are only built for paths
that have a listener, so subscribing to one path costs nothing for the elements
you ignore. Filter inside the listener:

```js
parser.on('</osm.way>', (way) => {
    if (!way.tags) return; // or any other predicate
});
```

## Options

| option | default | meaning |
| --- | --- | --- |
| `progressive` | `false` | emit events. Without it, `parse()` only builds the tree |
| `queryParent` | `false` | track parents so `parser.getParent(node)` works (costs a `WeakMap`) |
| `retain` | `'all'` | what survives an element: `'all'`, `'root'` or `'none'` (see [Streaming](#streaming)) |
| `keep` | `[]` | under `retain: 'none'`, dotted paths whose elements keep their subtree |

`parse(xml, parent?, dir?)` also accepts an existing node to attach the parsed
roots to, and a dotted path prefix used when building event names.

The parser is non-validating and never throws on malformed input: unterminated
tags, comments, processing instructions and doctypes are skipped, and elements
still open at end of input are closed so a truncated download yields the
document parsed so far (`'<r><a>text'` returns `r` with an `a` child whose
`text` is `'text'`).

CDATA sections are content, not markup: their text is kept verbatim and is not
entity-decoded, while text outside them is decoded (the five predefined
entities and numeric character references).

## Benchmarks

Six generated shapes, each isolating one cost (per-element, per-child, text,
nesting). Methodology, per-shape tables and caveats live in
[`bench/RESULTS.md`](bench/RESULTS.md); rerun with `npm run bench:data && npm run bench`.

Realistic Overpass-style document, 6.0 MiB, Apple M4 Pro / Node 26:

| workload | xml-event-parser | txml | fast-xml-parser | sax | htmlparser2 |
| --- | --- | --- | --- | --- | --- |
| tree (parse + walk) | **26.0 ms, 230 MB/s** | 50.6 ms, 118 MB/s | 167.8 ms, 36 MB/s | — | — |
| tree, retained heap | **30.0 MiB** | 42.5 MiB | 35.2 MiB | — | — |
| element callbacks | **27.8 ms, 215 MB/s** | — | — | 100.0 ms, 60 MB/s | 44.9 ms, 133 MB/s |
| streamed, 64 KiB chunks | **27.3 ms, 219 MB/s** | 77.4 ms, 77 MB/s | — | 103.3 ms, 58 MB/s | 50.8 ms, 118 MB/s |

Notes on reading the table:

- The callback and streamed rows for `xml-event-parser` use `retain: 'none'`, so
  they do not build a document either; the tree row is the only one that holds
  memory. `txml`'s streaming API is a Node stream (`transformStream`), measured
  separately and asynchronously.
- Text-heavy documents with many entities and CDATA used to be the weak shape;
  replacing the regex decoder with a manual scan took it from 325 to 442 MB/s,
  ahead of `txml` (382 MB/s).

## Status

Extracted from [osm2geojson-lite](https://github.com/tibetty/osm2geojson-lite),
where this parser served until 2.2.0 and was then replaced by a purpose-built
OSM scanner. The code and its original unit tests are unchanged apart from the
public naming (`children`/`tagName`/`text` instead of `$innerNodes`/`$tag`/
`$innerText`) and the removal of the `new Function`-based conditioned-path
events.

Published as `xml-event-parser` (current version on npm). Releases are cut by
changing `version` on `main`: `release.yml` publishes through npm trusted
publishing (OIDC, with provenance), tags `v<version>` and creates the GitHub
release. The job runs only when the repository variable
`NPM_TRUSTED_PUBLISHER` is `true`.

## Development

```sh
npm ci
npm test              # unit tests
npm run typecheck
npm run build         # dist/index.mjs, dist/index.cjs, dist/index.d.ts
npm run bench:data    # generate ~27 MiB benchmark corpus (gitignored)
npm run bench:memory  # JUnit memory/time table under a 512 MB heap cap
npm run bench         # compare against txml / sax / htmlparser2 / fast-xml-parser
```

## Releasing

`release.yml` publishes with npm trusted publishing (OIDC) and is gated on the
repository variable `NPM_TRUSTED_PUBLISHER`, which stays unset until a trusted
publisher exists.

One-time bootstrap, because npm cannot attach a trusted publisher to a package
that does not exist yet:

1. Publish the first version locally:

   ```sh
   npm login
   npm publish --access public
   ```

2. npmjs.com -> Packages -> `xml-event-parser` -> Settings -> **Trusted
   publishing** -> GitHub Actions:

   | field | value |
   | --- | --- |
   | Organization or user | `tibetty` |
   | Repository | `xml-event-parser` |
   | Workflow filename | `release.yml` (filename only, case-sensitive) |
   | Environment name | leave empty |
   | Allowed actions | tick **npm publish** |

   Configurations created after September 2026 default to `npm stage publish`
   only, so `npm publish` has to be ticked explicitly. The first publish through
   that workflow must complete within **two days**, or the configuration expires.

3. GitHub -> Settings -> Secrets and variables -> Actions -> Variables: add
   `NPM_TRUSTED_PUBLISHER` = `true`.

4. Optional hardening, once a workflow publish has succeeded: npmjs.com ->
   package Settings -> Publishing access -> *Require two-factor authentication
   and disallow tokens*.

After that, changing `version` in `package.json` on `main` publishes through
`release.yml`, tags `v<version>` and creates the GitHub release. npm generates
provenance automatically only for a public repository; from a private one the
package is published without an attestation.

## License

MIT. Includes work contributed to `osm2geojson-lite` by Harel Mazor.

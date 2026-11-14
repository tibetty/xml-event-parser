xml-event-parser
================

**Stream XML without loading it.** A tiny parser that gives you a document tree
and path-based events in one pass.

- **Bounded memory**: keep only the element you are reading. A 240 MB report
  parses in 81 MiB of RSS.
- **Fast**: ~3.7x `sax` and ~4x `fast-xml-parser` on the same report.
- **Portable**: 6.4 KiB minified / 2.2 KiB gzipped, zero dependencies, no
  `node:*` imports in the core entry, no `eval`.
- **One pass, two views**: a tree node and an `open`/`close` event per element.

## When to use this

| your job | use |
| --- | --- |
| Read a file bigger than memory: CI/test reports (JUnit, SARIF, coverage), sitemaps, GPX/KML tracks, OSM extracts | **this**, `xml-event-parser/stream` |
| Pick elements while streaming without writing a SAX state machine | **this**, path events |
| Parse occasionally in a browser or Worker where a 20 KiB parser is too much | **this**, core entry |
| Turn a small config XML into a plain object | `fast-xml-parser` or `xml2js` |
| DOM semantics: namespaces, XPath, mutation | `@xmldom/xmldom` |
| Hand-tuned callbacks with no tree at all | `sax` |

## 240 MB in one second

Generated JUnit reports, each parser in its own process capped at 512 MB of heap:

| parser | 60 MB report | 240 MB report |
| --- | --- | --- |
| **xml-event-parser** | **0.27 s, 65 MiB** | **1.03 s, 81 MiB** |
| sax | 0.96 s, 67 MiB | 3.80 s, 79 MiB |
| fast-xml-parser | 1.52 s, 637 MiB | **out of memory** |

The file grows 4x; the heap does not.

## Install

```sh
npm install xml-event-parser
```

## Typical usage

Stream a report and act on each element. This is the case the library is built
for: the file can be any size, memory stays flat.

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
            // testcase is complete: attributes plus <failure>/<system-out> children
            if (testcase.children?.some((child) => child.tagName === 'failure')) {
                console.log(`${testcase.classname} › ${testcase.name}`);
            }
            done();
        },
    }),
);
```

> **The path is the full chain from the document root.** For
> `<testsuites><testsuite><testcase>` the event is
> `'</testsuites.testsuite.testcase>'`; `'</testcase>'` matches nothing.
> `event` also accepts the bare path (`'testsuites.testsuite.testcase'`).

Without Node streams - a Worker, Deno, Bun or a plain callback loop:

```js
const parser = new XmlParser({
    progressive: true,
    retain: 'none',
    keep: ['testsuites.testsuite.testcase'],
});

parser.on('</testsuites.testsuite.testcase>', (testcase) => { /* ... */ });

for await (const chunk of stream) {
    parser.write(chunk);
}
parser.end();
```

When the document fits in memory, skip streaming:

```js
import { XmlParser } from 'xml-event-parser';

const roots = new XmlParser().parse(xml);
console.log(roots[0].tagName, roots[0].children);
```

Runnable examples, one per common job: [`examples/junit.mjs`](examples/junit.mjs)
(test report), [`examples/sitemap.mjs`](examples/sitemap.mjs),
[`examples/gpx.mjs`](examples/gpx.mjs) (track length).

## API

### Node shape

```ts
interface XmlNode {
    tagName: string;          // element name
    children?: XmlNode[];     // present only when the element has child elements
    text?: string;            // present only for text-only elements
    [attribute: string]: any; // attributes, flat on the node
}
```

An element is emitted on close after its children are attached, so
`node.children` is complete inside a close listener. Attributes whose names
collide with `tagName`, `children` or `text` are shadowed by those fields.

### Streaming and retention

`write(chunk)` accepts a document in pieces; chunks may split anywhere, and
`end()` closes whatever is still open and returns the roots.

| `retain` | keeps | `end()` returns | memory |
| --- | --- | --- | --- |
| `'all'` (default) | the document | the roots | grows with the document |
| `'root'` | the root being built | `[]`; a finished root is emitted and dropped | largest root |
| `'none'` | nothing | `[]`; every element is emitted and dropped | nesting depth |

With `retain: 'none'`, `keep` restores the subtree of the elements you want, so
a streamed element arrives complete rather than as a bare tag:

```js
new XmlParser({
    progressive: true,
    retain: 'none',
    keep: ['testsuites.testsuite.testcase'],
});
```

`createStream` applies `keep` for you from its `event` path.

### Events

| form | fires |
| --- | --- |
| `'<osm.way>'` | when a `<way>` inside `<osm>` opens |
| `'</osm.way>'` | when it closes, with `children` populated |

The path is the dotted chain from the document root, not just the element name:
`'</osm.way>'`, never `'</way>'`. The same applies to `keep`. Filter inside the
listener:

```js
parser.on('</osm.way>', (way) => {
    if (!way.tags) return;
});
```

### Options

| option | default | meaning |
| --- | --- | --- |
| `progressive` | `false` | emit events; without it `parse()` only builds the tree |
| `queryParent` | `false` | track parents for `parser.getParent(node)` |
| `retain` | `'all'` | `'all'`, `'root'` or `'none'` (see [Streaming and retention](#streaming-and-retention)) |
| `keep` | `[]` | under `retain: 'none'`, paths whose elements keep their subtree |

`parse(xml, parent?, dir?)` can attach the parsed roots to an existing node and
prefix event paths.

Malformed input never throws: comments, processing instructions and doctypes
are skipped, and elements still open at end of input are closed, so a truncated
download yields the document parsed so far. CDATA content is kept verbatim and
not entity-decoded; text outside CDATA is.

## Benchmarks

Speed on six generated shapes (Overpass-style documents, children-heavy, text,
nesting), against `txml`, `fast-xml-parser`, `sax` and `htmlparser2`:

| workload | xml-event-parser | txml | fast-xml-parser | sax | htmlparser2 |
| --- | --- | --- | --- | --- | --- |
| tree (parse + walk) | **26.0 ms, 230 MB/s** | 50.6 ms, 118 MB/s | 167.8 ms, 36 MB/s | — | — |
| element callbacks | **27.8 ms, 215 MB/s** | — | — | 100.0 ms, 60 MB/s | 44.9 ms, 133 MB/s |
| streamed, 64 KiB chunks | **27.3 ms, 219 MB/s** | 77.4 ms, 77 MB/s | — | 103.3 ms, 58 MB/s | 50.8 ms, 118 MB/s |

Full tables, methodology and caveats: [`bench/RESULTS.md`](bench/RESULTS.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development commands, tests,
benchmarks and the release process.

## License

MIT. Includes work contributed to
[osm2geojson-lite](https://github.com/tibetty/osm2geojson-lite) by Harel Mazor.

xml-event-parser
================

**Stream XML without loading it.** A tiny parser that gives you a document tree
and path-based events in one pass.

- **Bounded memory**: keep only the element you are reading. A 240 MB report
  parses in 82 MiB of RSS.
- **Fast**: ~3.7x `sax` and ~5x `fast-xml-parser` on the same report.
- **Portable**: 14.3 KiB minified / 5.0 KiB gzipped, zero dependencies, no
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
| **xml-event-parser** | **0.27 s, 67 MiB** | **1.00 s, 82 MiB** |
| sax | 0.95 s, 67 MiB | 3.71 s, 79 MiB |
| fast-xml-parser | 1.56 s, 648 MiB | **out of memory** |

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
    text?: string;            // present only for text-only elements and #text nodes
    [attribute: string]: any; // attributes, flat on the node
}
```

An element is emitted on close after its children are attached, so
`node.children` is complete inside a close listener. Attributes named
`tagName`, `children` or `text` are dropped, because those fields belong to the
parser. Any other name, `__proto__` included, is stored as an own property.

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

`createStream` applies `keep` for you from its `event` path. It decodes bytes
in the encoding the document declares (XML 1.0 Appendix F):

1. A byte-order mark for UTF-8 or UTF-16, if there is one.
2. Otherwise, the `encoding` of the XML declaration.
3. Otherwise, UTF-8.

Any encoding `TextDecoder` supports works, including ISO-8859-1, Shift_JIS and
GBK. An unsupported encoding fails the stream with an error. The core entry
takes strings, so there the caller decodes.

### Events

| form | fires |
| --- | --- |
| `'<osm.way>'` | when a `<way>` inside `<osm>` opens |
| `'</osm.way>'` | when it closes, with `children` populated |

The path is the dotted chain from the document root, not just the element name:
`'</osm.way>'`, never `'</way>'`. The same applies to `keep`. `on()` throws a
`TypeError` for a name that is not in one of the two bracketed forms, so a bare
`'osm.way'` fails loudly instead of never firing. Filter inside the
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
| `mixed` | `false` | keep text around child elements as `#text` children (see [Mixed content](#mixed-content)) |
| `strict` | `false` | throw an `XmlParseError` on the first well-formedness error (see [Strict mode](#strict-mode)) |

`parse(xml, parent?, dir?)` can attach the parsed roots to an existing node and
prefix event paths.

By default, malformed input never throws: comments, processing instructions and doctypes
are skipped, and elements still open at end of input are closed, so a truncated
download yields the document parsed so far. CDATA content is kept verbatim and
not entity-decoded; text outside CDATA is. As XML 1.0 requires, line endings
become `\n`, and a literal tab or newline in an attribute value becomes a space.
Whitespace written as a character reference, such as `&#10;`, is kept.

### Mixed content

By default, an element with child elements keeps no text, which suits
data-shaped XML. For document-shaped XML, such as XHTML fragments, DocBook,
RSS descriptions or test failure messages with inline markup, `mixed: true`
keeps each run of text between children as a `#text` child, in document order:

```js
new XmlParser({ mixed: true }).parse('<p>a <b>bold</b> c</p>');
// [{ tagName: 'p', children: [
//     { tagName: '#text', text: 'a ' },
//     { tagName: 'b', text: 'bold' },
//     { tagName: '#text', text: ' c' },
// ] }]
```

Runs are entity-decoded, CDATA is merged in, comments and PIs are dropped, and
whitespace-only runs are kept. Elements without child elements keep their
`text` field. Text nodes emit no events, and they follow `retain` and `keep`
like any other child.

### Strict mode

`strict: true` rejects malformed input instead of recovering from it. It
throws an `XmlParseError` that carries `line`, `column` (1-based) and `offset`
(0-based, across every `write()`):

```js
import { XmlParser, XmlParseError } from 'xml-event-parser';

try {
    new XmlParser({ strict: true }).parse('<a><b></a>');
} catch (error) {
    if (error instanceof XmlParseError) {
        console.log(error.message); // expected </b>, found </a> at line 1, column 7
    }
}
```

It checks:

- close tags against the open element, and elements left open at the end;
- unterminated tags, comments, CDATA sections, PIs and doctypes;
- attributes that are unquoted, valueless or duplicated, or that contain `<`;
- that there is exactly one root element, with no text outside it;
- names, references, `]]>` in text, `--` in comments, the XML declaration,
  and characters XML forbids.

DTDs are skipped, not validated. Strict mode rejects every well-formedness
case in the W3C `xmltest` suite except those inside a DTD. The default
lenient path runs at the same speed with or without the option. In
`createStream`, an error fails the stream.

## Benchmarks

Speed on six generated shapes (Overpass-style documents, children-heavy, text,
nesting), against `txml`, `fast-xml-parser`, `sax` and `htmlparser2`:

| workload | xml-event-parser | txml | fast-xml-parser | sax | htmlparser2 |
| --- | --- | --- | --- | --- | --- |
| tree (parse + walk) | **31.4 ms, 190 MB/s** | 51.0 ms, 117 MB/s | 170.0 ms, 35 MB/s | — | — |
| element callbacks | **32.5 ms, 184 MB/s** | — | — | 97.8 ms, 61 MB/s | 45.6 ms, 131 MB/s |
| streamed, 64 KiB chunks | **29.2 ms, 205 MB/s** | 80.7 ms, 74 MB/s | — | 102.3 ms, 58 MB/s | 54.6 ms, 109 MB/s |

Full tables, methodology and caveats: [`bench/RESULTS.md`](bench/RESULTS.md).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for development commands, tests,
benchmarks and the release process.

## License

MIT. Includes work contributed to
[osm2geojson-lite](https://github.com/tibetty/osm2geojson-lite) by Harel Mazor.

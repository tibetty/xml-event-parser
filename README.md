xml-event-parser
================

A tiny XML parser with a document tree and path-based events, produced in a
single pass.

- **Zero dependencies**, no DOM, no `node:*` imports, no `eval`.
- **One pass, two views**: every element is available as a tree node and as an
  `open`/`close` event keyed by its dotted path, so a consumer can convert while
  parsing without a second traversal.
- **Streaming**: feed `write(chunk)` from a file or socket and call `end()`.
  Chunks may split anywhere - mid-tag, mid-attribute, inside CDATA or a comment -
  and `retain` decides whether the parser keeps the tree, one root, or nothing,
  so a 60 MiB document can be parsed with ~0 MiB of retained heap.
- **Small**: 6.1 KiB minified, 2.1 KiB gzipped (ESM), streaming included.
- **Fastest on every shape we benchmarked**: ~1.9x `txml`'s throughput on
  OSM-style documents at ~30% less retained heap, and ahead of `txml` on
  text/entity-heavy input too; ~1.6x `htmlparser2`'s on element callbacks. See
  [Benchmarks](#benchmarks).

```js
import { XmlParser } from 'xml-event-parser';

const parser = new XmlParser({ progressive: true });

parser.on('</osm.way>', (way) => {
    // way.tagName === 'way', way.id, way.version, way.children ...
    console.log(way.id, way.children?.length ?? 0);
});

const roots = parser.parse(xml);
```

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

Not published yet. The release workflow publishes only when the repository
variable `NPM_TRUSTED_PUBLISHER` is `true`; before that, a release is published
locally because npm cannot configure a trusted publisher for a package that does
not exist yet.

## Development

```sh
npm ci
npm test              # unit tests
npm run typecheck
npm run build         # dist/index.mjs, dist/index.cjs, dist/index.d.ts
npm run bench:data    # generate ~27 MiB benchmark corpus (gitignored)
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

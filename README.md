xml-event-parser
================

A tiny XML parser with a document tree and path-based events, produced in a
single pass.

- **Zero dependencies**, no DOM, no `node:*` imports, no `eval`.
- **One pass, two views**: every element is available as a tree node and as an
  `open`/`close` event keyed by its dotted path, so a consumer can convert while
  parsing without a second traversal.
- **Small**: 3.6 KiB minified, 1.4 KiB gzipped (ESM).
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

Two honest caveats:

- `progressive` still builds the document, so the callback row does strictly more
  work than `sax` or `htmlparser2` (it holds 30 MiB for a 6 MiB input) and is
  still faster.
- On text-heavy documents with many entities and CDATA the entity decoder
  dominates; replacing the regex callback with a manual scan moved this shape
  from 325 to 442 MB/s, ahead of `txml` (382 MB/s).

## Status

Extracted from [osm2geojson-lite](https://github.com/tibetty/osm2geojson-lite),
where this parser served until 2.2.0 and was then replaced by a purpose-built
OSM scanner. The code and its original unit tests are unchanged apart from the
public naming (`children`/`tagName`/`text` instead of `$innerNodes`/`$tag`/
`$innerText`) and the removal of the `new Function`-based conditioned-path
events.

Not published yet.

## Development

```sh
npm ci
npm test              # unit tests
npm run typecheck
npm run build         # dist/index.mjs, dist/index.cjs, dist/index.d.ts
npm run bench:data    # generate ~27 MiB benchmark corpus (gitignored)
npm run bench         # compare against txml / sax / htmlparser2 / fast-xml-parser
```

## License

MIT. Includes work contributed to `osm2geojson-lite` by Harel Mazor.

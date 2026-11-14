xml-event-tree
==============

A tiny, dependency-free XML parser that builds a document tree and emits
path-based events in the same single pass.

- **Zero dependencies**, no DOM, no `node:*` imports.
- **One pass**: elements are available both as a tree (`$innerNodes`) and as
  `open`/`close` events keyed by dotted path (`</osm.way>`), so a consumer can
  convert as it parses without a second traversal.
- **Leaf elements cost nothing extra**: `<nd>`/`<tag>` children are ordinary
  tree nodes; a consumer that wants them adds listeners instead of walking.

Status: extraction in progress. The parser lived inside
[osm2geojson-lite](https://github.com/tibetty/osm2geojson-lite) until 2.2.0,
where a purpose-built OSM scanner replaced it; this repository is the same code
(plus its original unit tests) prepared for standalone publication.

```js
import { XmlParser } from 'xml-event-tree';

const parser = new XmlParser({ progressive: true });

parser.on('</osm.way>', (way) => {
    console.log(way.id, way.$innerNodes.length);
});

const roots = parser.parse(xml);
```

Development
-----------

```sh
npm ci
npm test              # unit tests (recovered from the original project)
npm run bench:data    # generate the benchmark corpus (~25 MiB, gitignored)
npm run bench         # xmlparser vs txml / fast-xml-parser / sax / htmlparser2
```

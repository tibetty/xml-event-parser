# Contributing

## Development

```sh
git clone https://github.com/tibetty/xml-event-parser.git
cd xml-event-parser
npm ci
```

| command | purpose |
| --- | --- |
| `npm test` | unit tests |
| `npm run coverage` | unit tests with the coverage floor in `vitest.config.ts` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | `dist/index.{mjs,cjs,d.mts,d.cts}` and `dist/stream.{mjs,cjs,d.mts,d.cts}` |
| `npm run check:package` | `publint` and `attw`: exports and types resolve for ESM and CommonJS consumers |
| `npm run bench:data` | generate the ~27 MiB speed corpus (gitignored) |
| `npm run bench` | speed against `txml`, `sax`, `htmlparser2`, `fast-xml-parser` |
| `npm run bench:memory` | time and peak RSS on 60 MB and 240 MB JUnit reports, each parser capped at 512 MB of heap |

`npm run bench:memory` writes generated reports under `bench/data/` (gitignored)
and runs each parser in a child process, so the numbers in the README can be
reproduced without trusting them.

## Tests

`test/xmlparser.test.ts` covers the scanner (structure, entities, CDATA,
truncation, events, retention) including an equivalence sweep that parses a
document at every split point and in 1-13 byte chunks.
`test/stream.test.ts` covers the Node stream adapter: chunk splits, multibyte
characters split across chunks, and the core entry staying free of `node:*`
imports.

Add a failing test before fixing a bug. Keep the split-point sweep honest: a
streaming change that only works on chunk boundaries the test happens to use is
not a fix.

## Releasing

`release.yml` publishes with npm trusted publishing (OIDC) and is gated on the
repository variable `NPM_TRUSTED_PUBLISHER`.

### One-time bootstrap

npm cannot attach a trusted publisher to a package that does not exist yet, so
the first publish is local:

1. ```sh
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

### Cutting a release

Open a `chore(release): X.Y.Z` PR that changes `version` in `package.json` and moves
the `## [Unreleased]` entries in `CHANGELOG.md` under the new version. Once it is
merged to `main`, `release.yml` publishes
through OIDC, tags `v<version>` and creates the GitHub release. npm generates
provenance automatically for a public repository.

The release job is idempotent: publish skips a version already on the registry
and the tag step skips an existing tag, so a run that failed part-way can be
re-run with **Run workflow** on `release.yml`.

## Implementation notes

Details that are useful here but not in the README:

- **Attributes are flat on the node**, one object per element, rather than a
  nested `attributes` map. That is what keeps a parsed document smaller than
  `txml`'s (see the retained-heap column in `bench/RESULTS.md`). The cost is
  that an attribute named `tagName`, `children` or `text` is shadowed.
- **Event names are lazy.** The scanner only builds `<path>` strings for paths
  that have a listener (`watchedPaths` / `watchedChildren` / `watchedTopLevel`),
  and only counts open listeners when deciding whether to emit opens, so
  subscribing to `</osm.node>` costs nothing for the `</osm.nd>` leaves.
- **Streaming is the same code path as `parse()`.** `parse(xml)` is
  `write(xml).end()`; `test/xmlparser.test.ts` parses a document at every split
  point and in 1-13 byte chunks to keep that true.
- **Compaction keeps from the innermost frame that can still need its text.**
  A frame with a child never reads its text start again (`hasChild`), which is
  what lets consumed input be dropped. Without that check the buffer never
  shrinks and each `write()` becomes a quadratic string append - 4 KiB chunks
  were 12x slower than one string before the fix.
- **Entity decoding is a manual scan**, not `String.replace` with a callback:
  ~2.5x faster on attribute-heavy shapes (the `text` benchmark went from 325 to
  442 MB/s).
- **Benchmark corpus**: `bench/generate.mjs` emits six shapes, each isolating one
  cost - per element (`leaf-storm`), per child (`tag-storm`), per byte of text
  (`text`), nesting depth (`deep`), and realistic mixes (`osm-dense`,
  `boundary`). `bench/memory.mjs` covers the file-bigger-than-memory case with a
  512 MB heap cap per child process.
- **Origin**: extracted from `osm2geojson-lite`, where this parser served until
  2.2.0 and was replaced by a purpose-built OSM scanner. The public naming
  changed (`children`/`tagName`/`text` instead of `$innerNodes`/`$tag`/
  `$innerText`), and the `new Function`-based conditioned-path events were
  removed: filtering belongs in the listener, and `eval` is a CSP liability.

## License

MIT.

# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Before 1.0.0, a minor version may
contain breaking changes; they are listed under "Upgrading".

## [Unreleased]

## [0.4.0] - 2026-11-19

Two opt-in modes: strict well-formedness checking and mixed content. Neither changes the default
output or its speed.

### Added

- `mixed: true` keeps the text around child elements as `{ tagName: '#text', text }` children,
  in document order ([#8]).
- `strict: true` throws an `XmlParseError` with `line`, `column` and `offset` on the first
  well-formedness error. The lenient default and its speed do not change ([#7]).

### Fixed

- A doctype with an internal subset ended at the first `>` inside the subset. The whole
  subset is now skipped, respecting its quoted literals and comments ([#7]).

### Changed

- The core entry is 14.3 KiB minified and 5.0 KiB gzipped, up from 9.0 KiB and 3.2 KiB, for
  strict mode and mixed content.

## [0.3.0] - 2026-11-19

Correctness and hardening release. It fixes a crash, a memory exhaustion on deep nesting, and
several XML 1.0 deviations. `createStream` now detects the document encoding. See "Upgrading"
for the behaviour changes.

### Upgrading

- Node.js 22 or newer is required for the `xml-event-parser/stream` entry and for development.
  The core entry has no Node dependency.
- `on()` and `addListener()` throw a `TypeError` for an event name that is not `'<a.b>'` or
  `'</a.b>'`. Such a listener never fired before.
- Output changes for input that hits a fixed defect: `&#0;` and other references to characters
  XML forbids are kept as written instead of decoded, line endings become `\n`, and a literal
  tab or newline in an attribute value becomes a space. A `<` that does not start a name is
  text, and an element whose only content is a comment or PI has no `text` field.

### Added

- `createStream` detects the document's encoding: a UTF-8 or UTF-16 byte-order mark, the UTF-16
  `<?` pattern, or the `encoding` in the XML declaration. Any encoding `TextDecoder` supports
  works, and an unsupported one fails the stream. Previously, every input was decoded as UTF-8
  ([#6]).

### Fixed

- An attribute named `children` threw `push is not a function`, and one named `tagName` renamed
  the element. Attributes named `tagName`, `children` or `text` are dropped, and `__proto__` is
  stored as an own property ([#1]).
- A bare `&` stopped every entity after it from being decoded (`AT&T &lt;`). Numeric references
  with malformed digits (`&#12abc;`, `&#+5;`) or naming a forbidden character are kept as
  written ([#2]).
- Comments and processing instructions inside a text-only element were copied into `text`. A
  processing instruction ends at `?>`, not at the first `>` ([#3]).
- XML 1.0 end-of-line handling (§2.11) and attribute-value normalisation (§3.3.3) ([#4]).
- An event name that is not in bracketed form, such as `'a.b'`, registered a listener that
  never fired. Removing the last listener of a path stops the scanner watching it ([#5]).
- Deep nesting cost quadratic time and memory: 100,000 levels (300 KB of input) exhausted a
  4 GB heap. Path strings are now built and looked up only down to the deepest watched or kept
  path, so 100,000 levels parse in about 20 ms ([#19]).
- A `<` that does not start a name, as in `1 < 2` or `x<</a>`, opened an element with an empty or
  bogus name and could swallow the tags after it. It is now text ([#11]).
- An unterminated close tag at end of input (`<a>t</a`) leaked into the text, and a declaration
  such as `<!DOCTYPE …>` inside a text-only element was kept as text ([#11]).
- `require('xml-event-parser')` resolved to ESM type declarations. The package ships `.d.cts`
  and `.d.mts` declarations and names each in the export map ([#9]).

### Changed

- Parsing without listeners or `keep` builds no path strings: 15-20% faster on the JUnit and
  deep-nesting benchmark shapes ([#19]).
- Corner-case, differential (against `sax`) and W3C conformance tests ([#11]).
- The core entry is 9.0 KiB minified and 3.2 KiB gzipped, up from 6.4 KiB and 2.2 KiB, for the
  validation and normalisation above.
- CI tests Node 22, 24 and 26, enforces a coverage floor, and checks the package with `publint`
  and `attw` ([#9]).

## [0.2.2] - 2026-11-14

### Changed

- README shows the typical streaming usage and states that event paths start at the document
  root.

## [0.2.1] - 2026-11-14

### Changed

- README reduced to user documentation; maintainer instructions moved to `CONTRIBUTING.md`.

## [0.2.0] - 2026-11-14

### Added

- `xml-event-parser/stream`: `createStream({ event })`, a Node `Transform` that emits one object
  per matching element and reassembles multibyte characters split across chunks.
- `retain: 'root' | 'none'` and `keep`, so a streamed element arrives with its subtree while
  memory stays bounded by the largest matched element.
- Runnable examples for JUnit reports, sitemaps and GPX tracks, and a memory benchmark.

## [0.1.1] - 2026-11-14

### Changed

- First release published through npm trusted publishing. No code change.

## [0.1.0] - 2026-11-14

First release, extracted from [osm2geojson-lite](https://github.com/tibetty/osm2geojson-lite).

### Added

- `XmlParser`: one-pass tree building with path-based `<path>` / `</path>` events.
- Streaming input through `write()` / `end()`, with chunks split anywhere.

### Fixed

- CDATA content is read as text, not as markup.
- Elements still open at end of input are closed, so truncated input keeps what was parsed.
- Conditioned event paths, which needed `new Function`, are removed: the parser contains no
  `eval`.

[Unreleased]: https://github.com/tibetty/xml-event-parser/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/tibetty/xml-event-parser/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/tibetty/xml-event-parser/compare/v0.2.2...v0.3.0
[0.2.2]: https://github.com/tibetty/xml-event-parser/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/tibetty/xml-event-parser/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/tibetty/xml-event-parser/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/tibetty/xml-event-parser/releases/tag/v0.1.1
[0.1.0]: https://www.npmjs.com/package/xml-event-parser/v/0.1.0
[#1]: https://github.com/tibetty/xml-event-parser/issues/1
[#2]: https://github.com/tibetty/xml-event-parser/issues/2
[#3]: https://github.com/tibetty/xml-event-parser/issues/3
[#4]: https://github.com/tibetty/xml-event-parser/issues/4
[#5]: https://github.com/tibetty/xml-event-parser/issues/5
[#6]: https://github.com/tibetty/xml-event-parser/issues/6
[#7]: https://github.com/tibetty/xml-event-parser/issues/7
[#8]: https://github.com/tibetty/xml-event-parser/issues/8
[#9]: https://github.com/tibetty/xml-event-parser/issues/9
[#11]: https://github.com/tibetty/xml-event-parser/issues/11
[#19]: https://github.com/tibetty/xml-event-parser/issues/19

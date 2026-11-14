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
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | `dist/index.{mjs,cjs,d.ts}` and `dist/stream.{mjs,cjs,d.ts}` |
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

Change `version` in `package.json` on `main`. `release.yml` then publishes
through OIDC, tags `v<version>` and creates the GitHub release. npm generates
provenance automatically for a public repository.

The release job is idempotent: publish skips a version already on the registry
and the tag step skips an existing tag, so a run that failed part-way can be
re-run with **Run workflow** on `release.yml`.

## License

MIT.

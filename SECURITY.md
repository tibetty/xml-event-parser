# Security Policy

## Supported versions

| Version | Supported                  |
| ------- | -------------------------- |
| 0.2.x   | Yes                        |
| < 0.2   | No — upgrade to the latest |

Before 1.0.0, fixes land in the latest minor version only.

## Reporting a vulnerability

Do not open a public issue for a security problem. Report it privately through
[GitHub Security Advisories](https://github.com/tibetty/xml-event-parser/security/advisories/new).

Please include:

- the affected version and runtime (Node version, browser or edge runtime);
- a minimal input document and the call that misbehaves;
- the impact you expect, for example unbounded memory, a hang, or a thrown exception.

You can expect an initial response within 7 days. A confirmed issue is fixed in a patch release,
and the details are published in [CHANGELOG.md](./CHANGELOG.md) once the fix is available.

## Threat model

The parser is built to read untrusted input. These properties are in scope; a report that breaks
one of them is a vulnerability:

- **No entity expansion.** Only the five predefined entities and character references are
  decoded. A DTD is skipped, never read, so internal or external entities cannot expand
  (no "billion laughs") and no file or URL is ever fetched (no XXE).
- **No code execution.** The parser contains no `eval` or `new Function`, and attribute names
  cannot change a node's prototype.
- **Bounded memory per retention mode.** With `retain: 'none'`, memory is bounded by the
  nesting depth plus the largest element listed in `keep` and the pending text. With
  `retain: 'root'`, it is bounded by the largest root. With `retain: 'all'` (the default), the
  whole tree is kept by design.
- **No throw on malformed input.** Malformed or truncated documents are parsed as far as they
  go. A listener you register can still throw.
- **Linear time on whole input.** Scanning a complete string is linear in its size. One limit
  is known: a construct that is still open is rescanned on each `write()`. A single very large
  tag, comment or CDATA section delivered in many small chunks therefore costs more than linear
  time. Text between elements does not have this cost.

Out of scope: the content you build from the parsed tree, such as text inserted into HTML
without escaping, and memory use under `retain: 'all'` on a document you chose to hold in full.

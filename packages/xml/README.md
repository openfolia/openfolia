# @openfolia/xml

A strict reader for XML from outside (`readXml`): the XLIFF import (`@openfolia/xliff`) and the DITA
import (`@openfolia/dita`) read untrusted documents with it. Framework-free: no Node APIs, no
dependencies.

```ts
const root = readXml(text); // throws XmlReadError with a `reason`
```

- **Its own parser**, iterative (no recursion, so depth never costs stack): no DTD at all
  (`<!DOCTYPE>`, so no entity declaration, internal or external, is ever read: `dtd-forbidden`),
  no entity but the five XML predefines (`&amp;` …) and character references, so nothing is
  fetched and nothing expands (no billion laughs).
- **Bounded** by `XmlLimits` (`DEFAULT_XML_LIMITS`: length, element depth 64, nodes, attributes
  per element; at most `MAX_PREFIXES` namespace prefixes in scope).
- XML 1.0 characters only (`isXmlChar`); namespaces resolved (`XML_NAMESPACE` for `xml:`);
  comments and processing instructions skipped, CDATA as text. A document declaring another
  encoding than UTF-8 is `unsupported-encoding`. Each refusal has a stable `reason`
  (`XmlRefusal`).
- **`sanitizeSvg(text)`**: an SVG from content made inert, for a file that is opened with no
  response header to guard it (an offline package, #59). Read with `readXml` (`SVG_LIMITS`: 8 MiB,
  48 deep), then written again with drawing elements only (`svg`, shapes, text, gradients,
  `use`, filters but `feImage`, …); `script`, `foreignObject`, `style`, the animation elements,
  `image` and any other namespace go with all they hold, an `a`'s shapes are kept as a `g` without the link, a `style` sheet only when nothing in it reaches out; the SVG 1.1 DOCTYPE is skipped (never opened), an internal subset refused; no `on*` attribute, a link only to
  `#id`, a `url(…)` only to `url(#id)`, no `javascript:`/`data:`/`http(s):`, CSS escape or `@`.
  Throws `XmlReadError`, or `TypeError` for a root that is no SVG.
- **A DOCTYPE naming an external DTD** (`readXml(text, limits, { doctype: 'external-id' })`, as
  every DITA file has one): one `<!DOCTYPE name>`, `… SYSTEM "uri">` or `… PUBLIC "id" "uri">`
  before the root is skipped; its identifiers are never opened, so no DTD is read and no
  attribute default is filled in. An internal subset (`[ … ]`), a second declaration or one after
  the root stays `dtd-forbidden`. The default (`doctype: 'refuse'`) refuses any DOCTYPE.

# Product

<!-- impeccable:product-schema 1 -->

<!-- The portal's product context for design work (#784), from the issue and the README. -->

## Platform

web

## Users

- **Readers** of released technical documentation: operators, service technicians, installers
  and end customers of a machine or product. They arrive with a question ("how do I charge it",
  "what does this warning mean", "which steps for the large model"), often on a phone next to
  the machine, or at a desk before a job. (inferred)
- **The publishing organisation**: it builds one static site per audience (public, internal,
  …) and wants it to carry its own name, logo and colours. (from the issue)

## Product Purpose

The static portal is where released manuals are read: per product and variant, per language,
searchable, without the API. Success: a reader finds the right manual for their product and
variant, reads a procedure or safety notice without friction, and trusts that it is the
current release.

## Positioning

Modular content assembled per variant and language: the reader always sees exactly the manual
for their variant, with the variant and language switch on the page, and the same content as
the PDF of that release.

## Operating Context

- Static files on any host; no sign-in in the portal itself; strict Content Security Policy (no
  inline script).
- One build = one audience; a site per language (English and German today, right-to-left
  languages possible).
- Content is `@openfolia/render-html` output: modules, procedures (numbered steps), safety
  notices (ISO 3864 / ANSI Z535 signal words and colours, fixed), tables, figures, glossary
  terms, attachments.
- Search is Pagefind, filtered by product and variant attributes.

## Capabilities and Constraints

- Organisation-agnostic: no company names in code or samples; branding comes from the API's
  public `GET /branding` at build time (product name, logos light and dark, mark, favicon,
  primary and accent colours, derived tokens with contrast checked).
- Without branding, the neutral OpenFolia defaults of `frontend/theme` (Geist, paper and Iron
  Grey, UI green accent).
- Safety colours and status colours are never brandable.
- Every list is paginated and scrolls inside its own container with the pagination outside it;
  long values wrap.

## Brand Commitments

- The default look uses `@openfolia/theme` tokens and fonts (Geist, Geist Mono), bundled, never
  from a CDN.
- An installation's brand replaces only `BRAND_TOKENS` (primary, accent, their tints), never
  surfaces, text, status or safety colours.

## Evidence on Hand

- The fixture content (`frontend/portal/testing/`) and the sample content repository
  (`.local/sample-content.git`): operating manual, quick start, safety leaflet, safety notices,
  service manual, in two products, English and German. No real customer content, no real brand.

## Product Principles

1. The reader's question first: find the manual, then the section, then the step.
2. Safety content is unmistakable and never decorative.
3. The organisation's brand frames the documentation; it never competes with the text.
4. Works on a phone next to the machine as well as on a desk.

## Accessibility & Inclusion

WCAG 2.1 AA in light and dark, with brand colours too (checked with axe in the portal's
browser tests); keyboard access; reduced motion respected; right-to-left languages.

# iiRDS export: research note (#431)

What the iiRDS export is built against, and how the content model maps to it. The export itself
is described in `backend/api/README.md` ("iiRDS export"), the mapping's configuration in
`packages/content-model/README.md` ("iiRDS mapping").

## Version and sources

- **iiRDS 1.3**, released 3 November 2025 by the iiRDS Consortium: the current 1.x release.
- **Specification:** `https://github.com/iirds-consortium/specification`, tag `v1.3`
  (iiRDS Specification, parts on the package, the metadata and conformance), licensed
  **CC BY-ND 4.0** (its README; the published 1.3 HTML: "© 2025 iiRDS Consortium … licensed under
  a Creative Commons Attribution-NoDerivatives 4.0 International License"; `iirds.org`: "iiRDS is
  published under Creative Commons CC BY ND"). The HTML's footer also carries the ReSpec
  template's generic "CC BY 4.0" line; the consortium's own statements are BY-ND.
- **RDF schema:** the core vocabulary `iirds-core.rdf`. For 1.2 it is public at
  `https://github.com/iirds-consortium/models` (commit `336aa72c7f2ce25adb8f595492eb6fe6bfbc4ac1`;
  the file is byte for byte the one committed as "iiRDS Version 1.2 (Release Date 10 November
  2023)", `a6d0fae4`), © 2023 tekom, **CC BY-ND 4.0** (its header; 1.1's file says the same). The 1.3 RDF file is downloadable from `iirds.org` only after
  registration. 1.3's core vocabulary adds terms to 1.2 (among them `DCC`, `ObjectTypeURI`, VDI 2770
  document categories, `is-based-on`, `is-translation-of`) and removes none.
- **Validator:** the iiRDS Validation Tool, `https://github.com/plusmeta/iirds-validation-tool`
  (commit `f1119bea7b64fd826ded9e06d9abae287cbad9c1`), **MIT**, supports iiRDS 1.3: the container
  rules (ZIP layout, `mimetype`, names) and the schema rules (classes, properties, cardinalities).

## Licences

Checked against the primary sources above (the files' own headers, the consortium's repositories
at their release tags, `iirds.org`), for a repository that is public, AGPL-licensed and also used
for a commercial hosted offering, where test-only files are still redistributed by the repository.

- **Which release, which licence.** The vendored schema is iiRDS **1.2** (released 10 November
  2023), under **CC BY-ND 4.0**. Every release in the consortium's repositories (specification
  tags `v1.1`, `v1.2`, `v1.3`; schema files of 1.1 and 1.2) says CC BY-ND 4.0. None says
  CC BY-NC-ND 4.0: that licence appears only in the validator's licence note, presumably for iiRDS
  1.0, which those repositories do not hold (not verified).
- **The schema: kept.** CC BY-ND 4.0 allows reproducing and sharing the material unchanged, also
  commercially, with attribution and the licence named, and forbids sharing adapted material. The
  file is shared byte for byte with its header (copyright and licence) and a README naming source,
  commit and hash; the tests read it, never change it. It keeps its own licence: the repository's
  AGPL covers our code, not this file, which sits beside it (the AGPL's aggregate). The
  `IIRDS_*` lists in `@openfolia/content-model` name the standard's terms (identifiers, needed to
  interoperate) and are checked against the file; they are not an adapted schema.
- **The validator's rule files: not kept, fetched when the tests run.** The code is MIT. But the
  rules embed iiRDS material, not only refer to it: each of their 158 rules quotes the
  specification's normative sentence verbatim (`rule.en`), with a German version (`rule.de`), and
  links the specification. The English quotes are excerpts of BY-ND material (sharable unchanged
  with attribution, which the files do not carry in the form the licence asks); the German
  versions are not in the English specification and so are, as far as can be seen, the tool's
  translations: adapted material, which BY-ND does not allow sharing. Its licence note naming
  CC BY-NC-ND adds a non-commercial reading the repository's commercial use could not meet. So
  redistribution is not clearly allowed. The tests therefore fetch the files from the tool's
  repository when they start, pinned to commit `f1119bea` and checked by SHA-256, into a
  git-ignored cache (`backend/api/tests/iirds/fetch-validator.ts`): using a copy is what both the
  MIT licence and BY-ND allow; the repository shares none of it. Without network on a first run the
  e2e test that runs the rules fails with the reason.
- **The specification** is followed and cited (rule names, section references, short quotes of
  terms); this note does not reproduce it.

Options weighed: keeping the rule files (not clearly allowed, above); a newer release under a
permissive licence (none exists: 1.3 is BY-ND too, and the tool has no other licence); dropping
the rules (the issue asks for the official validation in the tests); fetching them when the tests
run (chosen).

**Version decision:** write `iiRDSVersion` 1.3 and use only terms of the 1.2 core vocabulary,
which 1.3 keeps: a 1.3 consumer reads them, and every term used is checked against a schema file
the repository may hold.

## Package (from the specification's package part)

| Rule                                                                                          | How the export meets it                                    |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| A ZIP; its first entry `mimetype`, stored, holding `application/iirds+zip` with no line break | `mimetype` first, every entry stored (`zipStream`)         |
| Metadata in `META-INF/metadata.rdf`, RDF 1.1 XML syntax                                       | `iirds-metadata.ts`                                        |
| Content files in folders, not in the root or in `META-INF`                                    | `content/`, `media/`, `symbols/`, `pdf/`                   |
| Names without `/ , " * : < > \`; a path at most 260 characters, a name at most 255            | IDs, hashes and slugs only; the e2e test checks every name |
| File extension `.iirds`                                                                       | `<manual>_<variant>_<lang>_<revision>.iirds`               |
| Exactly one `iirds:Package`; absolute IRIs for packages, documents and topics                 | one package; every IRI under the configured `baseIri`      |
| A document has at least one `has-document-type`; a rendition one `format` and one `source`    | `documentTypes` requires one; each rendition has both      |
| Directory nodes as linked lists ending in `iirds:nil`; the root of type `TableOfContents`     | the manual's structure, groups as nodes with a label       |

## Mapping (content model to iiRDS)

| Content model                               | iiRDS                                                                                             | Configured by                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------- |
| a release                                   | `iirds:Package` (version, title, language, revision, `dateOfCreation` = published)                | —                                      |
| a manual in a variant and language          | `iirds:Document`, a version of the manual's `iirds:InformationObject`                             | —                                      |
| its document type                           | `has-document-type` (`iirds:DocumentType` instances, e.g. `OperatingInstructions`)                | `documentTypes`, `manualDocumentTypes` |
| its PDF                                     | `iirds:Rendition` of the document (`application/pdf`)                                             | —                                      |
| the release standing or withdrawn           | `ContentLifeCycleStatus` `Released` / `Withdrawn` with `dateOfStatus`                             | —                                      |
| a module in the manual                      | `iirds:Topic`, a version of the module's `iirds:InformationObject`; its HTML as a rendition       | —                                      |
| a module type                               | `has-topic-type` (`GenericConcept`, `GenericTask`, …) and `has-subject` (`InformationSubject`)    | `moduleTypes`                          |
| an audience                                 | `relates-to-qualification`, an instance of `iirds:Role` or `iirds:SkillLevel`                     | `audiences`                            |
| a variant attribute's value                 | `relates-to-product-variant` / `-component` / `-product-feature`, an instance of the class mapped | `variantAttributes`                    |
| a facet's value (and the release's product) | as a variant attribute's                                                                          | `facets`                               |
| a lifecycle-phase facet's value             | `relates-to-product-lifecycle-phase` (`iirds:ProductLifeCyclePhase` instances, e.g. `Operation`)  | `lifecyclePhases`                      |
| a manual's groups and order                 | `iirds:DirectoryNode`s, `TableOfContents`                                                         | —                                      |
| images, attachments, safety symbols         | files the topics' HTML refers to                                                                  | —                                      |

**No counterpart (left out):** text attributes (resolved into the text), keywords, a module's
source and deprecation, translation records, comments, change sets and the review workflow, the
PDF page design. Variant conditions are resolved: a package holds one variant.

## Defaults taken for open questions

- Made on request and kept a while (the last 32 packages), not generated with the release.
- The lifecycle phase is a facet the mapping names (a configured, optional module attribute), not
  a new field of the module model.
- Plain iiRDS (not iiRDS/A or iiRDS/H), HTML topics without a stylesheet, no glossary topic.
- Something unmapped is left out of the metadata with a warning, never refused.
- No editor screen yet: the API's routes only.

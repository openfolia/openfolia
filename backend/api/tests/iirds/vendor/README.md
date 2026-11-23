# Vendored iiRDS material (tests only)

Third-party files the iiRDS export's tests (#431) check packages against. Copied unchanged, never
edited, never part of the built API; only `tests/` reads them. Lint and Prettier skip this folder.
To update one, download it again from the source below, replace the file whole and update its
SHA-256 here.

## `iirds-schema/iirds-core.rdf`

The iiRDS RDF schema (core vocabulary), from the iiRDS Consortium's `models` repository:
`https://github.com/iirds-consortium/models`, commit `336aa72c7f2ce25adb8f595492eb6fe6bfbc4ac1`,
file `iirds-core.rdf`.

- Version: iiRDS 1.2: the file as committed with the message "iiRDS Version 1.2 (Release Date 10
  November 2023)" (`a6d0fae4`), byte for byte; `336aa72c` changed only another file.
- Version note: The 1.3 schema is published only after registration; 1.3's core vocabulary
  adds terms to 1.2 and removes none, and the export uses only 1.2's terms (so a 1.3 consumer reads
  them) while writing `iiRDSVersion` 1.3.
- Licence: © tekom, Creative Commons Attribution-NoDerivatives 4.0 International (CC BY-ND 4.0),
  as stated in the file's header. Shared unchanged, with that attribution; no adapted version of it
  is made or shared (`tests/iirds/iirds-schema.ts` reads it as it is).
- SHA-256: `a047ae2bc6246e836158ee8083b4c75339e81bbc8b9b511372880b8d109f7405`

## The iiRDS Validation Tool (not here)

Its rule files are MIT code, but they quote the iiRDS specification (CC BY-ND 4.0) sentence by
sentence, with German translations, so this repository does not redistribute them. The tests
fetch them when they start, pinned to a commit and checked by SHA-256
(`tests/iirds/fetch-validator.ts`), into the git-ignored `backend/api/.cache/`. Details:
`docs/iirds-export.md`, "Licences".

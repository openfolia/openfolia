// Puts the sample content repository (the one `pnpm nx run api:setup-local` makes: bare, branches
// main and draft, tag v1, snippets and terms on main) at CCMS_CONTENT_DIR, for trying the images
// out (deploy/README.md, "Content repository"). Refuses when something is already there, so it never
// replaces real content.
//
//   docker compose run --rm api node docker/sample-content.mjs
import { existsSync } from 'node:fs';
import {
  addSampleSnippets,
  addSampleTerms,
  createBareSampleRepo,
} from '@openfolia/content-repo/testing';

const dir = process.env.CCMS_CONTENT_DIR;
if (!dir) {
  console.error('sample-content: CCMS_CONTENT_DIR is not set.');
  process.exit(64);
}
if (existsSync(dir)) {
  console.error(
    `sample-content: ${dir} already exists; nothing was changed. Remove it first to start over.`,
  );
  process.exit(65);
}
createBareSampleRepo(dir);
await addSampleSnippets(dir);
await addSampleTerms(dir);
console.log(
  `sample-content: created ${dir} (bare; branches main and draft, tag v1).`,
);

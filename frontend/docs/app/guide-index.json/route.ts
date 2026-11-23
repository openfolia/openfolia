import { guideIndex } from '../../scripts/lib/guide-index.mjs';

/**
 * The user guide's article IDs with each page's address, title and summary per language (#447,
 * #221): the editor's in-app help links by ID and searches the titles and summaries. The editor's
 * build makes the same file from the same function (`scripts/guide-index.mjs`). A guide page
 * without an ID, or two pages with one ID, fail the build.
 */
export const revalidate = false;

export function GET() {
  // `next build` runs in this project's folder (`project.json`'s `cwd`).
  return Response.json(guideIndex(process.cwd()));
}

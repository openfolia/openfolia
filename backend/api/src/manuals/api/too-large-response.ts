import { TABLE_TOO_LARGE_FILE } from '../../content/api/read-content.js';

/**
 * How a route that resolves a manual (or a module on its own) documents 422
 * `expansion-too-large` (#679).
 */
export const MANUAL_TOO_LARGE =
  '`expansion-too-large`: once its module references are included the manual holds more than 500,000 content nodes, 12,000,000 characters or 1,000,000 table cells (rows × columns) (a module referred to over several paths counts once per path), or its blocks and references nest more than 100 deep, so nothing of it is made (`meta.nodes`, `meta.chars`, `meta.tableCells`, `meta.depth`: the limits).';

/**
 * The same, for a route whose only other 422 is a broken file (`ReadsContent`'s, which a
 * method's own 422 replaces).
 */
export const BROKEN_OR_TOO_LARGE = `\`invalid-content\`: a file needed for the answer is broken; the error's \`meta.path\` names it. ${TABLE_TOO_LARGE_FILE} ${MANUAL_TOO_LARGE}`;

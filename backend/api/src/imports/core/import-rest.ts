import {
  IMPORT_DOCUMENT_PATH,
  type ImportBundle,
  type ImportValidation,
} from '@openfolia/content-model';
import type { ImportReport, ReportItem } from './import.js';
import {
  decisionsOf,
  type ImportPlan,
  type PlanContext,
  planImport,
} from './import-plan.js';

/**
 * Plans an import (`planImport`) and, when it refuses some items, whether the
 * rest can be applied without them (`applicableWithoutRefused`, #758): the
 * bundle without the refused modules, manuals and files is validated and
 * planned again in full, and the rest stands only when that second check is
 * applicable and decides every other item exactly as the first did. A manual
 * naming a refused module, or a module using a refused file, then reads as a
 * dangling reference or a missing file: decided differently, so the rest does
 * not stand, and nothing is written that the first report did not decide.
 *
 * The second check runs only when it can pass: something is refused, nothing
 * about the bundle as a whole is an error, and something is written.
 */
export async function planWithRest(
  bundle: ImportBundle,
  validate: (bundle: ImportBundle) => Promise<ImportValidation>,
  context: PlanContext,
): Promise<ImportPlan> {
  const plan = await planImport(bundle, await validate(bundle), context);
  const { report } = plan;
  if (
    report.counts.refuse === 0 ||
    report.issues.some((i) => i.severity === 'error') ||
    report.counts.create + report.counts.update === 0
  ) {
    return plan;
  }
  const rest = withoutRefused(bundle, report);
  if (!rest) return plan;
  const again = await planImport(rest, await validate(rest), context);
  if (!again.report.applicable || !decidesRestAlike(report, again.report)) {
    return plan;
  }
  return { ...plan, report: { ...report, applicableWithoutRefused: true } };
}

/**
 * The bundle without the items `report` refuses: the refused modules and
 * manuals taken out of `import.json` (by their pointers, `/modules/<i>` and
 * `/manuals/<i>`, into the document as read: no format migration reorders
 * them) and the refused files out of the archive (`assets/<hash>`).
 * `undefined` when a refused item names no place it can take out, or the
 * document is not an object holding those lists.
 */
export function withoutRefused(
  bundle: ImportBundle,
  report: ImportReport,
): ImportBundle | undefined {
  const refused = report.items.filter((i) => i.action === 'refuse');
  const gone = { modules: new Set<number>(), manuals: new Set<number>() };
  const files = new Set<string>();
  for (const item of refused) {
    const place = placeOf(item);
    if (!place) return undefined;
    if (place.in === 'file') {
      if (!bundle.files.has(place.path)) return undefined;
      files.add(place.path);
    } else {
      gone[place.in].add(place.index);
    }
  }
  const bytes = bundle.files.get(IMPORT_DOCUMENT_PATH);
  if (!bytes) return undefined;
  let document: unknown;
  try {
    document = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes),
    );
  } catch {
    return undefined;
  }
  if (
    typeof document !== 'object' ||
    document === null ||
    Array.isArray(document)
  ) {
    return undefined;
  }
  const kept: Record<string, unknown> = { ...document };
  for (const list of ['modules', 'manuals'] as const) {
    const indexes = gone[list];
    if (indexes.size === 0) continue;
    const items = kept[list];
    if (!Array.isArray(items) || [...indexes].some((i) => i >= items.length)) {
      return undefined;
    }
    kept[list] = items.filter((_, i) => !indexes.has(i));
  }
  const out = new Map<string, Uint8Array>();
  for (const [path, file] of bundle.files) {
    if (path === IMPORT_DOCUMENT_PATH || files.has(path)) continue;
    out.set(path, file);
  }
  out.set(IMPORT_DOCUMENT_PATH, new TextEncoder().encode(JSON.stringify(kept)));
  return { files: out };
}

/**
 * Whether `after` (a check of the bundle without the refused items) decides
 * exactly the items `before` did not refuse, in the same order, each the same.
 */
export function decidesRestAlike(
  before: ImportReport,
  after: ImportReport,
): boolean {
  const rest = decisionsOf({
    ...before,
    items: before.items.filter((i) => i.action !== 'refuse'),
  });
  const again = decisionsOf(after);
  return rest.length === again.length && rest.every((d, i) => d === again[i]);
}

type Place =
  | { readonly in: 'modules' | 'manuals'; readonly index: number }
  | { readonly in: 'file'; readonly path: string };

/** Where a refused item lies in the bundle, from its pointer; `undefined` when it names no such place. */
function placeOf(item: ReportItem): Place | undefined {
  if (item.kind === 'asset') {
    return /^assets\/[0-9a-f]{64}$/.test(item.pointer)
      ? { in: 'file', path: item.pointer }
      : undefined;
  }
  const entry = /^\/(modules|manuals)\/(0|[1-9]\d{0,8})$/.exec(item.pointer);
  if (!entry) return undefined;
  const list = entry[1] as 'modules' | 'manuals';
  // A module's pointer is in `modules`, a manual's in `manuals`.
  if ((list === 'modules') !== (item.kind === 'module')) return undefined;
  return { in: list, index: Number(entry[2]) };
}

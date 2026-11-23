import {
  MAX_TEMPLATE_BYTES,
  MAX_TEMPLATE_FILES,
} from '@openfolia/content-model';
import { FakeSnapshot } from '../../../tests/fakes/fake-content.js';
import { InvalidContentError } from '../../base/core/errors.js';
import {
  type ContentOverlay,
  OverlaidSnapshot,
  TEMPLATE_READ_BATCH,
} from './content-overlay.js';

/** An overlay holding drafts of template files only, as `OpenWorkingCopiesAction` gives them. */
function overlayOf(drafts: Record<string, Record<string, string>>): {
  overlay: ContentOverlay;
  draftReads: string[];
} {
  const draftReads: string[] = [];
  const encoder = new TextEncoder();
  const overlay: ContentOverlay = {
    key: 'working-copies:test',
    module: () => Promise.resolve(undefined),
    manifest: () => Promise.resolve(undefined),
    pageDesign: () => Promise.resolve(undefined),
    templateFiles: (id) => {
      draftReads.push(`${id}/*`);
      return Promise.resolve(new Map(Object.entries(drafts[id] ?? {})));
    },
    templateFile: (id, path) => {
      draftReads.push(`${id}/${path}`);
      return Promise.resolve(drafts[id]?.[path]);
    },
    subjects: () =>
      Promise.resolve({
        modules: [],
        manuals: [],
        designs: [],
        templates: Object.entries(drafts).flatMap(([templateId, files]) =>
          Object.entries(files).map(([path, text]) => ({
            templateId,
            path,
            size: encoder.encode(text).length,
          })),
        ),
      }),
    showsAsset: () => Promise.resolve(false),
  };
  return { overlay, draftReads };
}

/**
 * A commit whose template `house` lists `sizes` (path → bytes) without holding that much: what
 * the Git adapter's listing reports from the tree alone. Counts every file read, and how many
 * reads run at once.
 */
function committed(sizes: Record<string, number>) {
  const raw = new FakeSnapshot({
    designTemplates: {
      house: Object.fromEntries(
        Object.keys(sizes).map((path) => [path, `// ${path}\n`]),
      ),
    },
  });
  const reads: string[] = [];
  let running = 0;
  let most = 0;
  raw.designTemplateListing = (id: string) =>
    Promise.resolve(
      id === 'house'
        ? Object.entries(sizes)
            .map(([path, size]) => ({
              path,
              size,
              draft: false,
              committed: true,
            }))
            .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        : [],
    );
  const read = raw.designTemplateFile.bind(raw);
  raw.designTemplateFile = async (id: string, path: string) => {
    reads.push(path);
    running += 1;
    most = Math.max(most, running);
    // Let every read started meanwhile start too, as Git reads would overlap.
    await new Promise((resolve) => setTimeout(resolve, 1));
    running -= 1;
    return read(id, path);
  };
  return { raw, reads, most: () => most };
}

const overlaid = (
  raw: FakeSnapshot,
  drafts: Record<string, Record<string, string>>,
) => {
  const { overlay, draftReads } = overlayOf(drafts);
  return {
    snapshot: new OverlaidSnapshot(raw, overlay, () => Promise.resolve(false)),
    draftReads,
  };
};

describe('OverlaidSnapshot: a template with drafts (#803)', () => {
  it('refuses a folder whose listed sizes pass MAX_TEMPLATE_BYTES before reading any file', async () => {
    const half = Math.ceil(MAX_TEMPLATE_BYTES / 2);
    const { raw, reads } = committed({
      'manual.typ': 10,
      'a.typ': half,
      'b.typ': half,
    });
    const { snapshot, draftReads } = overlaid(raw, {
      house: { 'manual.typ': '// draft\n' },
    });
    await expect(snapshot.designTemplate('house')).rejects.toBeInstanceOf(
      InvalidContentError,
    );
    expect(reads).toEqual([]);
    expect(draftReads).toEqual([]);
  });

  it('counts a draft’s length in place of its file’s, and the drafts only it holds', async () => {
    const { raw } = committed({
      'manual.typ': 10,
      'big.typ': MAX_TEMPLATE_BYTES,
    });
    // The draft of big.typ is small: the folder is within the caps.
    const within = overlaid(raw, { house: { 'big.typ': '// small\n' } });
    const files = await within.snapshot.designTemplate('house');
    expect(Object.keys(files ?? {}).sort()).toEqual(['big.typ', 'manual.typ']);
    expect(new TextDecoder().decode(files?.['big.typ'])).toBe('// small\n');

    // A new draft past the bytes left: refused.
    const { raw: small, reads } = committed({
      'manual.typ': MAX_TEMPLATE_BYTES - 4,
    });
    const past = overlaid(small, { house: { 'new.typ': '12345' } });
    await expect(past.snapshot.designTemplate('house')).rejects.toBeInstanceOf(
      InvalidContentError,
    );
    expect(reads).toEqual([]);
  });

  it('refuses a folder past MAX_TEMPLATE_FILES, drafts that are new counted too', async () => {
    const sizes = Object.fromEntries(
      Array.from({ length: MAX_TEMPLATE_FILES }, (_, i) => [
        i === 0 ? 'manual.typ' : `f${i}.typ`,
        1,
      ]),
    );
    const { raw, reads } = committed(sizes);
    // A draft of a committed file adds no file.
    const same = overlaid(raw, { house: { 'f1.typ': '1' } });
    await expect(same.snapshot.designTemplate('house')).resolves.toBeDefined();
    reads.length = 0;
    const more = overlaid(raw, { house: { 'extra.typ': '1' } });
    await expect(more.snapshot.designTemplate('house')).rejects.toBeInstanceOf(
      InvalidContentError,
    );
    expect(reads).toEqual([]);
  });

  it('reads the committed files in batches, never more at once', async () => {
    const sizes = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [
        i === 0 ? 'manual.typ' : `f${i}.typ`,
        8,
      ]),
    );
    const { raw, reads, most } = committed(sizes);
    const { snapshot } = overlaid(raw, { house: { 'f1.typ': '// d\n' } });
    const files = await snapshot.designTemplate('house');
    expect(Object.keys(files ?? {})).toHaveLength(40);
    // Every committed file but the drafted one, each once.
    expect(reads).toHaveLength(39);
    expect(reads).not.toContain('f1.typ');
    expect(most()).toBeGreaterThan(1);
    expect(most()).toBeLessThanOrEqual(TEMPLATE_READ_BATCH);
  });

  it('is undefined without a manual.typ, committed or drafted, reading nothing', async () => {
    const { raw, reads } = committed({ 'readme.txt': 3 });
    const { snapshot, draftReads } = overlaid(raw, {
      house: { 'notes.txt': 'x' },
    });
    expect(await snapshot.designTemplate('house')).toBeUndefined();
    expect(reads).toEqual([]);
    expect(draftReads).toEqual([]);
  });

  it('lists every draft with its length, past the caps too, reading no draft', async () => {
    const { raw } = committed({ 'manual.typ': MAX_TEMPLATE_BYTES });
    const drafts = Object.fromEntries(
      Array.from({ length: MAX_TEMPLATE_FILES + 5 }, (_, i) => [
        `d${String(i).padStart(3, '0')}.typ`,
        'xy',
      ]),
    );
    const { snapshot, draftReads } = overlaid(raw, { house: drafts });
    const listed = await snapshot.designTemplateListing('house');
    expect(listed).toHaveLength(MAX_TEMPLATE_FILES + 6);
    expect(listed.filter((f) => f.draft).every((f) => f.size === 2)).toBe(true);
    expect(draftReads).toEqual([]);
  });

  it('reads one draft for one file, and the revision’s drafts only within the caps', async () => {
    const { raw } = committed({ 'manual.typ': 10, 'big.typ': 10 });
    const { snapshot, draftReads } = overlaid(raw, {
      house: { 'manual.typ': '// d\n' },
    });
    expect(
      new TextDecoder().decode(
        await snapshot.designTemplateFile('house', 'manual.typ'),
      ),
    ).toBe('// d\n');
    expect(draftReads).toEqual(['house/manual.typ']);

    const { raw: full } = committed({ 'manual.typ': MAX_TEMPLATE_BYTES });
    const past = overlaid(full, { house: { 'new.typ': 'x' } });
    // Past them a key all the same (the render then answers the template's error), no draft read.
    const key = await past.snapshot.designTemplateRevision('house');
    expect(key).toMatch(/^past-caps:[0-9a-f]{64}$/);
    expect(past.draftReads).toEqual([]);
    expect(await snapshot.designTemplateRevision('house')).toMatch(
      /^draft:[0-9a-f]{64}$/,
    );
  });
});

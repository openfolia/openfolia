import { NOBODY, READER } from '../../../../tests/fakes/actors.js';
import {
  FakeSnapshot,
  readable,
} from '../../../../tests/fakes/fake-content.js';
import { RecordingRenderer } from '../../../../tests/fakes/recording-pdf-renderer.js';
import { DEFAULT_PAGE_DESIGN } from '@openfolia/content-model';
import {
  ForbiddenError,
  InvalidContentError,
  NotFoundError,
  UnavailableError,
} from '../../../base/core/errors.js';
import type { ContentOverlay } from '../../../content/core/content-overlay.js';
import { PdfTemplateError } from '../../../manuals/core/pdf-renderer.js';
import {
  GetDesignTemplateFileAction,
  GetExampleDesignTemplateAction,
  ListDesignTemplateFilesAction,
  PreviewDesignTemplateAction,
} from './design-template-files.actions.js';

const designTemplates = {
  house: {
    'manual.typ': '#import "parts/notice.typ": *\n',
    'parts/notice.typ': '#let notice = 1\n',
    'logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    'broken.txt': new Uint8Array([0xff, 0xfe]),
  },
  // No manual.typ: listed, not compiled.
  loose: { 'readme.txt': 'later\n' },
};
const pageDesigns = {
  brand: `schemaVersion: 1
name: Brand
preset: minimal
colours:
  primary: "#1f4e79"
  accent: "#b45309"
  text: "#1f2328"
`,
};
const page = { number: 1, size: 50 };
const snapshot = () => readable({ designTemplates, pageDesigns });

/** A change set's drafts of template files, as `OpenWorkingCopiesAction` gives them. */
function drafted(
  drafts: Record<string, Record<string, string>>,
): ReturnType<typeof readable> {
  const overlay: ContentOverlay = {
    key: 'working-copies:test',
    module: () => Promise.resolve(undefined),
    manifest: () => Promise.resolve(undefined),
    pageDesign: () => Promise.resolve(undefined),
    templateFiles: (id) =>
      Promise.resolve(new Map(Object.entries(drafts[id] ?? {}))),
    templateFile: (id, path) => Promise.resolve(drafts[id]?.[path]),
    subjects: () =>
      Promise.resolve({
        modules: [],
        manuals: [],
        designs: [],
        templates: Object.entries(drafts).flatMap(([templateId, files]) =>
          Object.entries(files).map(([path, text]) => ({
            templateId,
            path,
            size: new TextEncoder().encode(text).length,
          })),
        ),
      }),
    showsAsset: () => Promise.resolve(false),
  };
  return readable(
    new FakeSnapshot({ designTemplates, pageDesigns }),
  ).withOverlay(overlay);
}

describe('ListDesignTemplateFilesAction', () => {
  const action = new ListDesignTemplateFilesAction();

  it('lists a template’s files by path, which are text, from the listing alone', async () => {
    const result = await action.handle({
      actor: READER,
      snapshot: snapshot(),
      templateId: 'house',
      page,
    });
    expect(result.items).toEqual([
      {
        path: 'broken.txt',
        size: 2,
        text: true,
        draft: false,
        committed: true,
      },
      { path: 'logo.png', size: 4, text: false, draft: false, committed: true },
      {
        path: 'manual.typ',
        size: 30,
        text: true,
        draft: false,
        committed: true,
      },
      {
        path: 'parts/notice.typ',
        size: 16,
        text: true,
        draft: false,
        committed: true,
      },
    ]);
    // A folder without manual.typ is listed too: its author is making it.
    expect(
      (
        await action.handle({
          actor: READER,
          snapshot: snapshot(),
          templateId: 'loose',
          page,
        })
      ).total,
    ).toBe(1);
  });

  it('marks the drafts of a change set read through its working copies, and lists files only a draft holds', async () => {
    const result = await action.handle({
      actor: READER,
      snapshot: drafted({
        house: { 'manual.typ': '// new\n', 'parts/extra.typ': '#let x = 2\n' },
      }),
      templateId: 'house',
      page,
    });
    expect(result.items.map((f) => [f.path, f.size, f.draft] as const)).toEqual(
      [
        ['broken.txt', 2, false],
        ['logo.png', 4, false],
        ['manual.typ', 7, true],
        ['parts/extra.typ', 11, true],
        ['parts/notice.typ', 16, false],
      ],
    );
  });

  it('is 404 for a template with no file, and for an ID that is no slug', async () => {
    for (const templateId of ['nope', '../modules', 'House']) {
      await expect(
        action.handle({
          actor: READER,
          snapshot: snapshot(),
          templateId,
          page,
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    }
  });

  it('needs content.read', async () => {
    await expect(
      action.handle({
        actor: NOBODY,
        snapshot: snapshot(),
        templateId: 'house',
        page,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('GetDesignTemplateFileAction', () => {
  const action = new GetDesignTemplateFileAction();
  const read = (path: string, s = snapshot()) =>
    action.handle({ actor: READER, snapshot: s, templateId: 'house', path });

  it('reads a text file by its path in the folder, or its draft', async () => {
    expect(await read('parts/notice.typ')).toEqual({
      path: 'parts/notice.typ',
      text: '#let notice = 1\n',
    });
    expect(
      await read('manual.typ', drafted({ house: { 'manual.typ': '// d\n' } })),
    ).toEqual({ path: 'manual.typ', text: '// d\n' });
  });

  it('reads nothing outside the folder, no image and no bytes that are no text', async () => {
    for (const path of [
      '../loose/readme.txt',
      '/etc/passwd',
      '.hidden.typ',
      'parts/../manual.typ',
      'logo.png',
      'broken.txt',
      'missing.typ',
    ]) {
      await expect(read(path)).rejects.toBeInstanceOf(NotFoundError);
    }
  });
});

describe('PreviewDesignTemplateAction', () => {
  const setUp = () => {
    const renderer = new RecordingRenderer();
    return { renderer, action: new PreviewDesignTemplateAction(renderer) };
  };

  it('lays the probe out with the built-in design and the template, at the page and width asked for', async () => {
    const { renderer, action } = setUp();
    const png = await action.handle({
      actor: READER,
      snapshot: snapshot(),
      templateId: 'house',
      page: 2,
      width: 480,
    });
    expect([...png]).toEqual([7, 8, 9]);
    const [asked] = renderer.previews;
    expect(asked?.design).toEqual({
      ...DEFAULT_PAGE_DESIGN,
      template: 'house',
    });
    expect(asked?.page).toEqual({ number: 2, width: 480 });
    expect(Object.keys(asked?.files ?? {}).sort()).toEqual([
      'broken.txt',
      'logo.png',
      'manual.typ',
      'parts/notice.typ',
    ]);
  });

  it('with a design named, its settings; with working copies, the drafts in place of the files', async () => {
    const { renderer, action } = setUp();
    await action.handle({
      actor: READER,
      snapshot: drafted({ house: { 'manual.typ': '// draft\n' } }),
      templateId: 'house',
      designId: 'brand',
      page: 1,
      width: 240,
    });
    const [asked] = renderer.previews;
    expect(asked?.design).toMatchObject({
      id: 'brand',
      preset: 'minimal',
      template: 'house',
    });
    expect(new TextDecoder().decode(asked?.files['manual.typ'])).toBe(
      '// draft\n',
    );
    expect(new TextDecoder().decode(asked?.files['parts/notice.typ'])).toBe(
      '#let notice = 1\n',
    );
  });

  it('previews a template only a draft makes', async () => {
    const { renderer, action } = setUp();
    await action.handle({
      actor: READER,
      snapshot: drafted({ fresh: { 'manual.typ': '// new\n' } }),
      templateId: 'fresh',
      page: 1,
      width: 240,
    });
    expect(Object.keys(renderer.previews[0]?.files ?? {})).toEqual([
      'manual.typ',
    ]);
  });

  it('is 404 without a manual.typ or for a design that is not there', async () => {
    const { action } = setUp();
    const input = {
      actor: READER,
      snapshot: snapshot(),
      page: 1,
      width: 240,
    };
    await expect(
      action.handle({ ...input, templateId: 'loose' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      action.handle({ ...input, templateId: '../x' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      action.handle({ ...input, templateId: 'house', designId: 'nope' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('passes the renderer’s answer on: a template error with its problems, load', async () => {
    const { renderer, action } = setUp();
    const input = {
      actor: READER,
      snapshot: snapshot(),
      templateId: 'house',
      page: 1,
      width: 240,
    };
    renderer.preview = () =>
      new PdfTemplateError('builtin', 'house', [
        {
          file: 'templates/house/manual.typ',
          line: 3,
          column: 5,
          message: 'unknown variable: nope',
          trace: [],
        },
      ]);
    await expect(action.handle(input)).rejects.toMatchObject({
      code: 'template-error',
      meta: { problems: [{ line: 3, column: 5 }] },
    });
    renderer.preview = () => new UnavailableError('renderer-busy', 'busy', 30);
    await expect(action.handle(input)).rejects.toBeInstanceOf(UnavailableError);
  });

  it('answers a folder past the caps as the template’s problem, without compiling', async () => {
    const { renderer, action } = setUp();
    const many = Object.fromEntries(
      Array.from({ length: 201 }, (_, i) => [
        i === 0 ? 'manual.typ' : `f${i}.typ`,
        '\n',
      ]),
    );
    const s = new FakeSnapshot({ designTemplates: { many } });
    // The Git adapter refuses past the caps, from the listing.
    s.designTemplate = (): Promise<Record<string, Uint8Array> | undefined> =>
      Promise.reject(
        new InvalidContentError('templates/many', 'too many files'),
      );
    await expect(
      action.handle({
        actor: READER,
        snapshot: readable(s),
        templateId: 'many',
        page: 1,
        width: 240,
      }),
    ).rejects.toBeInstanceOf(PdfTemplateError);
    expect(renderer.previews).toEqual([]);
  });
});

describe('GetExampleDesignTemplateAction', () => {
  it('gives the renderer’s example template, file by file, by path', async () => {
    const renderer = new RecordingRenderer();
    const result = await new GetExampleDesignTemplateAction(renderer).handle({
      actor: READER,
      page,
    });
    expect(result.items.map((f) => f.path)).toEqual([
      'design.typ',
      'manual.typ',
    ]);
    expect(result.items[1]?.text).toBe('#import "design.typ": *\n');
  });

  it('needs content.read', async () => {
    await expect(
      new GetExampleDesignTemplateAction(new RecordingRenderer()).handle({
        actor: NOBODY,
        page,
      }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

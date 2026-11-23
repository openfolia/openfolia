import { NOBODY, READER } from '../../../../tests/fakes/actors.js';
import { FakeBlobStore } from '../../../../tests/fakes/fake-blob-store.js';
import { readable } from '../../../../tests/fakes/fake-content.js';
import {
  ForbiddenError,
  InvalidContentError,
  NotFoundError,
} from '../../../base/core/errors.js';
import { GetPageDesignAction } from './get-page-design.action.js';
import { ListPageDesignsAction } from './list-page-designs.action.js';

const hash = (digit: string) => digit.repeat(64);

const pageDesigns: Record<string, string> = {
  classic: `schemaVersion: 1
name: Classic
preset: classic
colours:
  primary: "#1f4e79"
  accent: "#b45309"
  text: "#1f2328"
logo:
  light: sha256:${hash('1')}
fonts:
  body:
    family: Sample Sans
    regular: sha256:${hash('2')}
    bold: sha256:${hash('3')}
  embeddingAllowed: true
footer:
  default:
    left: placeholder:no-such-value[]
`,
  pale: `schemaVersion: 1
name: Pale
preset: minimal
colours:
  primary: "#eeeeee"
  accent: "#555555"
  text: "#111111"
`,
  broken: 'preset: [\n',
};

const page = { number: 1, size: 50 };
const snapshot = () => readable({ pageDesigns });

describe('ListPageDesignsAction', () => {
  const action = new ListPageDesignsAction();

  it('lists every design by ID, a broken file with why, and the issues of each', async () => {
    const result = await action.handle({
      actor: READER,
      snapshot: snapshot(),
      page,
    });
    expect(result.total).toBe(3);
    expect(result.items.map((e) => e.id)).toEqual([
      'broken',
      'classic',
      'pale',
    ]);
    expect(result.items[0]).toEqual({
      id: 'broken',
      error: expect.stringContaining('design/broken.yaml'),
    });
    const [, classic, pale] = result.items;
    expect(classic && 'issues' in classic && classic.issues).toEqual([
      expect.objectContaining({
        code: 'unknown-placeholder',
        at: 'footer.default.left',
      }),
    ]);
    expect(pale && 'issues' in pale && pale.issues).toEqual([
      expect.objectContaining({
        severity: 'warning',
        code: 'low-contrast',
        at: 'colours.primary',
      }),
    ]);
  });

  it('pages', async () => {
    const result = await action.handle({
      actor: READER,
      snapshot: snapshot(),
      page: { number: 2, size: 2 },
    });
    expect(result.items.map((e) => e.id)).toEqual(['pale']);
    expect(result.total).toBe(3);
  });

  it('needs content.read', async () => {
    await expect(
      action.handle({ actor: NOBODY, snapshot: snapshot(), page }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe('GetPageDesignAction', () => {
  const ttf = Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00, 0x10]);
  const blobs = () => {
    const store = new FakeBlobStore();
    // The logo and the regular face are stored; the bold face is no font.
    store.blobs.set(hash('1'), {
      data: Buffer.from('png'),
      contentType: 'image/png',
    });
    store.blobs.set(hash('2'), { data: ttf, contentType: 'font/ttf' });
    store.blobs.set(hash('3'), {
      data: Buffer.from('<svg/>'),
      contentType: 'image/svg+xml',
    });
    return store;
  };

  it('reads one, with its assets checked against the blob store', async () => {
    const action = new GetPageDesignAction(blobs());
    const { design, issues } = await action.handle({
      actor: READER,
      snapshot: snapshot(),
      id: 'classic',
    });
    expect(design.name).toBe('Classic');
    expect(issues.map((i) => [i.code, i.at])).toEqual([
      ['unknown-placeholder', 'footer.default.left'],
      ['invalid-font', 'fonts.body.bold'],
    ]);
  });

  it('reports an asset not stored', async () => {
    const action = new GetPageDesignAction(new FakeBlobStore());
    const { issues } = await action.handle({
      actor: READER,
      snapshot: snapshot(),
      id: 'classic',
    });
    expect(
      issues.filter((i) => i.code === 'missing-asset').map((i) => i.at),
    ).toEqual(['logo.light', 'fonts.body.regular', 'fonts.body.bold']);
  });

  it('finds assets in the older layout too, `assets/<sha256>` in the repository (#554)', async () => {
    const action = new GetPageDesignAction(new FakeBlobStore());
    const { issues } = await action.handle({
      actor: READER,
      snapshot: readable({
        pageDesigns,
        assets: {
          [hash('1')]: Buffer.from('png'),
          [hash('2')]: ttf,
          [hash('3')]: Buffer.from('<svg/>'),
        },
      }),
      id: 'classic',
    });
    expect(issues.map((i) => [i.code, i.at])).toEqual([
      ['unknown-placeholder', 'footer.default.left'],
      ['invalid-font', 'fonts.body.bold'],
    ]);
  });

  it('is not found for no design, invalid content for a file that is none', async () => {
    const action = new GetPageDesignAction(blobs());
    await expect(
      action.handle({ actor: READER, snapshot: snapshot(), id: 'nothing' }),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      action.handle({ actor: READER, snapshot: snapshot(), id: 'broken' }),
    ).rejects.toBeInstanceOf(InvalidContentError);
  });

  it('needs content.read', async () => {
    const action = new GetPageDesignAction(blobs());
    await expect(
      action.handle({ actor: NOBODY, snapshot: snapshot(), id: 'classic' }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

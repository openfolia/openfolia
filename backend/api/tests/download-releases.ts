import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { type Module, printModule } from '@openfolia/content-model';
import { UnitOfWork } from '../src/base/core/unit-of-work.js';
import { newReleaseId } from '../src/releases/core/release.js';
import { ReleaseStore } from '../src/releases/core/release-store.js';
import type { TestApp } from './test-app.js';

const sha256 = (data: string) =>
  createHash('sha256').update(data).digest('hex');

/** The ID of the datasheet's attachment, for `product` (`manyReleases`). */
export const sheetOf = (product: string): string =>
  `attachment:${product}:datasheet:sheet:en`;

/** The datasheet module (for every product) holding one attachment of `bytes`. */
function datasheet(bytes: string, audience: string): string {
  return printModule({
    schemaVersion: 1,
    id: 'datasheet',
    meta: {
      title: 'Data sheet',
      type: 'concept',
      lang: 'en',
      audience,
      facets: {},
    },
    blocks: [
      {
        type: 'attachment',
        id: 'sheet',
        asset: `sha256:${sha256(bytes)}`,
        name: 'Data sheet',
        fileName: 'sheet.zip',
        mediaType: 'application/zip',
        size: bytes.length,
      },
    ],
  } as Module);
}

/**
 * `count` releases of `product` (a value of the sample's `region` facet) on the test app's
 * repository (#764): a commit on `main` each, the datasheet's attachment changing every
 * `changeEvery`, all made in one `git fast-import`, with their rows written straight to the
 * release store (no release cut, no outputs planned). So a history of hundreds of releases
 * costs seconds to set up. `audience(i)` is the datasheet's audience at the `i`th (default
 * `public`). The tagger dates are a second apart, oldest first, before now.
 */
export async function manyReleases(
  t: TestApp,
  product: string,
  count: number,
  {
    changeEvery = 20,
    audience = () => 'public',
  }: { changeEvery?: number; audience?: (i: number) => string } = {},
): Promise<void> {
  const dir = process.env['CCMS_CONTENT_DIR'] as string;
  const git = (args: string[], input?: string) =>
    execFileSync('git', ['-C', dir, ...args], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      ...(input === undefined ? {} : { input }),
    }).trim();
  const head = git(['rev-parse', 'refs/heads/main']);
  const started = Math.floor(Date.now() / 1000) - count - 10;
  const data = (text: string) => `data ${Buffer.byteLength(text)}\n${text}\n`;
  let stream = '';
  for (let i = 0; i < count; i++) {
    const when = `${started + i} +0000`;
    stream +=
      `commit refs/heads/main\nmark :${i + 1}\n` +
      `committer Someone <someone@example.com> ${when}\n` +
      data(`Change ${i}`) +
      (i === 0 ? `from ${head}\n` : '') +
      `M 100644 inline modules/en/datasheet.adoc\n` +
      data(
        datasheet(
          `${product} sheet ${Math.floor(i / changeEvery)}`,
          audience(i),
        ),
      ) +
      `tag release/${product}/r${i}\nfrom :${i + 1}\n` +
      `tagger Someone <someone@example.com> ${when}\n` +
      data(`Release r${i}`);
  }
  git(['fast-import', '--quiet'], stream);
  const tags = new Map(
    git([
      'for-each-ref',
      '--format=%(refname:strip=2) %(objectname) %(*objectname)',
      `refs/tags/release/${product}`,
    ])
      .split('\n')
      .map((line) => {
        const [name = '', object = '', commit = ''] = line.split(' ');
        return [name, { object, commit }] as const;
      }),
  );
  const store = t.app.get(ReleaseStore);
  await t.app.get(UnitOfWork).run(async (tx) => {
    for (let i = 0; i < count; i++) {
      const tag = `release/${product}/r${i}`;
      const found = tags.get(tag);
      if (!found) throw new Error(`no tag ${tag}`);
      const at = (started + i) * 1000;
      const id = newReleaseId(at);
      await store.reserve(tx, {
        id,
        product,
        productFacet: 'region',
        revision: `r${i}`,
        tag,
        commit: found.commit,
        notes: `Release r${i}`,
        notesByLanguage: {},
        major: false,
        publishedBy: { kind: 'user', id: 'sample-publisher' },
        publishedAt: new Date(at),
      });
      await store.publish(tx, id, found.object);
    }
  });
}

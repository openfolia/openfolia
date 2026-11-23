import {
  PageDesign,
  ProjectConfig,
  type PageDesignInput,
} from '@openfolia/content-model';
import { config as baseConfig } from '../../../tests/fakes/fake-content.js';
import { InvalidContentError } from '../../base/core/errors.js';
import { DesignsInUse } from './design-in-use.js';

const config = ProjectConfig.parse(baseConfig);

const design = (extra: Partial<PageDesignInput> = {}): PageDesign =>
  PageDesign.parse({
    schemaVersion: 1,
    id: 'plain',
    name: 'Plain',
    preset: 'minimal',
    colours: { primary: '#1f4e79', accent: '#b45309', text: '#1f2328' },
    ...extra,
  });

/** Designs by ID; `broken` reads as a file that is no design. */
const reader = (designs: Record<string, PageDesign>) => ({
  pageDesign: (id: string) =>
    id === 'broken'
      ? Promise.reject(
          new InvalidContentError('design/broken.yaml', 'no design'),
        )
      : Promise.resolve(designs[id]),
});

const cover = {
  default: { asset: `sha256:${'a'.repeat(64)}`, alt: 'A machine' },
  variants: [],
};

describe('DesignsInUse.printsRelease (#395)', () => {
  const designs = new DesignsInUse(
    reader({
      stamped: design(),
      quiet: design({ titlePage: { fields: ['title'] } }),
    }),
  );

  it("follows the manual's design: whether it prints the release or its date", async () => {
    expect(await designs.printsRelease({ design: 'stamped' }, config)).toBe(
      true,
    );
    expect(await designs.printsRelease({ design: 'quiet' }, config)).toBe(
      false,
    );
    // The project's default design, for a manual that names none.
    expect(
      await designs.printsRelease(
        {},
        { ...config, pdf: { ...config.pdf, design: 'stamped' } },
      ),
    ).toBe(true);
  });

  it('prints nothing of it in the default PDF, unless a cover image of its own lays it out with the built-in design', async () => {
    expect(await designs.printsRelease({}, config)).toBe(false);
    expect(await designs.printsRelease({ coverImage: cover }, config)).toBe(
      true,
    );
    // A design that is missing or no design: the built-in one, by the same rule.
    for (const id of ['missing', 'broken']) {
      expect(await designs.printsRelease({ design: id }, config)).toBe(false);
      expect(
        await designs.printsRelease({ design: id, coverImage: cover }, config),
      ).toBe(true);
    }
  });
});

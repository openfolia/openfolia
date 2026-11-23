import { PageDesign } from '@openfolia/content-model';
import { xliffSchemaErrors } from '../testing/validate.js';
import { readXliff } from './read.js';
import { targetParts } from './target.js';
import { xliffUnitsOfDesign } from './units.js';
import { writeXliff } from './write.js';

/** A design whose back page holds a paragraph with a placeholder, and a list. */
const design = PageDesign.parse({
  schemaVersion: 1,
  id: 'plain',
  name: 'Plain & simple',
  preset: 'classic',
  colours: { primary: '#1f4e79', accent: '#2563eb', text: '#1f2328' },
  regions: {
    back: [
      {
        type: 'paragraph',
        id: 'imprint',
        content: [
          { type: 'text', text: 'Printed on ' },
          { type: 'placeholder', key: 'date' },
        ],
      },
      {
        type: 'list',
        id: 'facts',
        ordered: false,
        items: [
          {
            id: 'fact-1',
            content: [{ type: 'text', text: 'Made here' }],
            blocks: [],
          },
        ],
      },
    ],
  },
});

const xml = () =>
  writeXliff({
    srcLang: 'en',
    trgLang: 'de',
    meta: { job: 'job-1', commit: 'a'.repeat(40) },
    modules: [
      {
        moduleId: 'design.plain',
        title: design.name,
        original: 'design/plain.yaml',
        units: xliffUnitsOfDesign(design, 'en'),
      },
    ],
  });

/** The document with a target added to the unit `id`. */
const withTarget = (id: string, target: string) =>
  xml().replace(
    new RegExp(`(<unit id="${id.replace('.', '\\.')}"[\\s\\S]*?</source>)`),
    `$1\n        <target>${target}</target>`,
  );

describe('a page design’s region text in XLIFF (#568)', () => {
  it('writes a file of its own, units keyed by slot and block, placeholders as <ph>, schema-valid', async () => {
    const out = xml();
    expect(await xliffSchemaErrors(out)).toEqual([]);
    expect(out).toContain(
      '<file id="design.plain" original="design/plain.yaml">',
    );
    expect(out).toContain('<unit id="back.imprint"');
    expect(out).toContain('<unit id="back.fact-1"');
    expect(out).toContain(
      '<ph id="1" type="other" subType="ccms:placeholder" disp="[date]" ccms:key="date"/>',
    );
    expect(out).toContain(
      '<note category="ccms:path">region#back &gt; list#facts &gt; item#fact-1</note>',
    );
  });

  it('reads a translation back, its placeholder kept', () => {
    const read = readXliff(
      withTarget('back.imprint', 'Gedruckt am <ph id="1"/>'),
    );
    const file = read.files[0];
    expect(file?.moduleId).toBe('design.plain');
    const unit = file?.units.find((u) => u.blockId === 'back.imprint');
    const sent = xliffUnitsOfDesign(design, 'en', new Set(['back.imprint']))[0];
    const result = targetParts(sent as never, unit as never);
    expect(result).toEqual({
      ok: true,
      parts: [
        {
          field: 'content',
          content: [
            { type: 'text', text: 'Gedruckt am ' },
            { type: 'placeholder', key: 'date' },
          ],
        },
      ],
    });
  });

  it('refuses a placeholder the source has not', () => {
    const read = readXliff(
      withTarget(
        'back.imprint',
        'Gedruckt am <ph id="1"/> <ph id="2" type="other" subType="ccms:placeholder" disp="[secret]" ccms:key="secret"/>',
      ),
    );
    const unit = read.files[0]?.units.find((u) => u.blockId === 'back.imprint');
    const sent = xliffUnitsOfDesign(design, 'en', new Set(['back.imprint']))[0];
    const result = targetParts(sent as never, unit as never);
    expect(result.ok).toBe(false);
  });
});

import type { Block, Inline, Module } from '@openfolia/content-model/core';

/**
 * What the playground opens with: a module with every block type of the content model, and
 * every inline type and mark, in neutral words. The ones the editor can't edit yet show as
 * labelled placeholders and come back out unchanged. In normal form (`normalizeModule`), so
 * `toEditor` and back gives exactly this.
 *
 * Written here rather than taken from `@openfolia/content-repo/testing`: that helper builds a Git
 * repository with Node's file system and can't run in a browser, and its modules hold only a
 * paragraph, a module reference and an image.
 */
const t = (text: string): Inline => ({ type: 'text', text });

const p = (id: string, ...content: Inline[]): Block => ({
  type: 'paragraph',
  id,
  content,
});

export const SAMPLE_MODULE: Module = {
  schemaVersion: 1,
  id: 'getting-started',
  meta: {
    title: 'Getting started',
    type: 'concept',
    lang: 'en',
    facets: {},
  },
  blocks: [
    p(
      'intro',
      t('This guide sets up '),
      { type: 'attribute', name: 'product-name' },
      t(' for a first project. Type '),
      { type: 'text', text: '/', marks: [{ type: 'code' }] },
      t(' on an empty line to insert a block, and drag a block by its grip.'),
    ),
    {
      type: 'safety',
      id: 'unplug-first',
      severity: 'warning',
      hazard: [t('Loose cables on the floor')],
      symbols: [],
      blocks: [p('unplug-first-measure', t('Route every cable along a wall.'))],
    },
    {
      type: 'section',
      id: 'before',
      title: [t('Before you begin')],
      blocks: [
        p(
          'before-text',
          t('Check that you have '),
          { type: 'text', text: 'everything', marks: [{ type: 'strong' }] },
          t(' at hand, and read the '),
          {
            type: 'text',
            text: 'release notes',
            marks: [{ type: 'link', href: 'https://example.com/notes' }],
          },
          t('.'),
        ),
        {
          type: 'list',
          id: 'before-list',
          ordered: false,
          items: [
            {
              id: 'before-account',
              content: [t('An account with write access.')],
              blocks: [],
            },
            {
              id: 'before-tools',
              content: [t('The command line tools, version 2 or later.')],
              blocks: [
                {
                  type: 'list',
                  id: 'before-tools-list',
                  ordered: false,
                  items: [
                    {
                      id: 'before-tools-shell',
                      content: [t('A shell such as '), emphasis('bash')],
                      blocks: [],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'admonition',
          id: 'before-tip',
          kind: 'tip',
          blocks: [
            p('before-tip-text', t('Keep this page open while you work.')),
          ],
        },
        {
          type: 'faq',
          id: 'before-faq',
          question: [t('Do I need an account?')],
          blocks: [
            p(
              'before-faq-answer',
              t('No: the playground keeps everything in this page.'),
            ),
          ],
        },
      ],
    },
    {
      type: 'section',
      id: 'setup',
      title: [t('Set up the project')],
      blocks: [
        {
          type: 'procedure',
          id: 'setup-steps',
          title: [t('Create the project')],
          steps: [
            {
              id: 'setup-open',
              content: [
                t('Choose '),
                { type: 'text', text: 'New project', marks: [{ type: 'ui' }] },
                t(' to open a '),
                {
                  type: 'text',
                  text: 'project',
                  marks: [{ type: 'term', termId: 'project' }],
                },
                t('.'),
              ],
              blocks: [],
            },
            {
              id: 'setup-name',
              content: [t('Enter a name and confirm.')],
              blocks: [
                {
                  type: 'image',
                  id: 'setup-dialog',
                  asset:
                    'sha256:0000000000000000000000000000000000000000000000000000000000000000',
                  alt: 'The new project dialog',
                  width: 60,
                },
              ],
            },
          ],
        },
        {
          type: 'table',
          id: 'setup-limits',
          title: [t('Limits')],
          columns: [{ width: 2 }, { width: 1, align: 'right' }],
          header: true,
          rows: [
            row(['setup-limits-h1', 'Item'], ['setup-limits-h2', 'Maximum']),
            row(['setup-limits-r1', 'Members'], ['setup-limits-r1v', '50']),
          ],
        },
        {
          type: 'image',
          id: 'setup-overview',
          asset:
            'sha256:1111111111111111111111111111111111111111111111111111111111111111',
          alt: 'The project page after setup',
          callouts: [
            {
              id: 'setup-overview-members',
              anchor: { x: 0.2, y: 0.3 },
              legend: [t('Members')],
            },
            {
              id: 'setup-overview-settings',
              anchor: { x: 0.8, y: 0.3 },
              label: { x: 0.9, y: 0.1 },
              legend: [t('Settings')],
            },
          ],
        },
        p(
          'setup-overview-hint',
          t('Invite people from the members list '),
          {
            type: 'calloutRef',
            block: 'setup-overview',
            callout: 'setup-overview-members',
          },
          t('.'),
        ),
        {
          type: 'attachment',
          id: 'setup-sample',
          asset:
            'sha256:2222222222222222222222222222222222222222222222222222222222222222',
          name: 'Sample project settings',
          description: 'Import them to start from a working setup.',
          fileName: 'sample-settings.zip',
          mediaType: 'application/zip',
          size: 48_213,
        },
        { type: 'pageBreak', id: 'setup-break' },
        {
          type: 'section',
          id: 'setup-options',
          title: [t('Options')],
          blocks: [
            p(
              'setup-options-text',
              t('Press '),
              { type: 'kbd', keys: ['Ctrl', 'S'] },
              t(' to save. H'),
              { type: 'text', text: '2', marks: [{ type: 'sub' }] },
              t('O and m'),
              { type: 'text', text: '2', marks: [{ type: 'sup' }] },
              t(' read as text. See '),
              { type: 'xref', module: 'getting-started', block: 'before' },
              t('.'),
            ),
            {
              type: 'variant',
              id: 'setup-large',
              when: { op: 'in', attr: 'edition', values: ['large'] },
              blocks: [
                p(
                  'setup-large-text',
                  t('Large editions also show a dashboard.'),
                ),
              ],
            },
            {
              type: 'literal',
              id: 'setup-config',
              language: 'yaml',
              text: 'name: first-project\nmembers: 5',
            },
          ],
        },
      ],
    },
    {
      type: 'section',
      id: 'next',
      title: [t('Next steps')],
      blocks: [
        {
          type: 'list',
          id: 'next-list',
          ordered: true,
          items: [
            {
              id: 'next-invite',
              content: [
                t('Invite your team.'),
                { type: 'hardBreak' },
                t('Each member gets an e-mail.'),
              ],
              blocks: [],
            },
            {
              id: 'next-publish',
              content: [
                t('Publish a draft, as '),
                { type: 'xref', module: 'shared-footer', block: 'footer-help' },
                t(' says.'),
              ],
              blocks: [],
            },
          ],
        },
        { type: 'moduleRef', id: 'next-shared', module: 'shared-footer' },
        {
          type: 'passthrough',
          id: 'next-raw',
          format: 'html',
          raw: '<div class="legacy">Imported as is.</div>',
        },
      ],
    },
  ],
};

/** The module the sample refers to (`shared-footer`), for its cross-references in the playground. */
export const SAMPLE_REFERENCED: Module = {
  schemaVersion: 1,
  id: 'shared-footer',
  meta: { title: 'Shared footer', type: 'concept', lang: 'en', facets: {} },
  blocks: [
    {
      type: 'section',
      id: 'footer-help',
      title: [t('Getting help')],
      blocks: [p('footer-help-text', t('Ask in the team channel.'))],
    },
  ],
};

function emphasis(text: string): Inline {
  return { type: 'text', text, marks: [{ type: 'emphasis' }] };
}

function row(...cells: [id: string, text: string][]) {
  return {
    cells: cells.map(([id, text]) => ({ blocks: [p(id, t(text))] })),
  };
}

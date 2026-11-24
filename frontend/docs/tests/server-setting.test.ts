import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { withServerSettingText } from '../lib/server-setting';

const root = join(import.meta.dirname, '../../..');
const docs = join(root, 'frontend/docs/content/docs');

const pages = (readdirSync(docs, { recursive: true }) as string[])
  .filter((file) => file.endsWith('.mdx'))
  .map((file) => ({ file, text: readFileSync(join(docs, file), 'utf8') }));

describe('<ServerSetting> (#859)', () => {
  it('is written out as two quoted lines in a page’s Markdown', () => {
    expect(
      withServerSettingText(
        'Before.\n\n<ServerSetting>\n  The limit is [`CCMS_X`](/reference/settings#ccms_x).\n  Two lines.\n</ServerSetting>\n\nAfter.',
      ),
    ).toBe(
      'Before.\n\n> **Self-hosted:** The limit is [`CCMS_X`](/reference/settings#ccms_x). Two lines.\n>\n> **Hosted:** Ask your provider or your admin.\n\nAfter.',
    );
    expect(
      withServerSettingText('<ServerSetting lang="de">Text.</ServerSetting>'),
    ).toBe(
      '> **Selbst betrieben:** Text.\n>\n> **Gehostet:** Fragen Sie Ihren Anbieter oder Ihren Admin.',
    );
  });

  it('speaks the page’s language', () => {
    for (const { file, text } of pages) {
      const german = file.endsWith('.de.mdx');
      for (const [tag] of text.matchAll(/<ServerSetting\b[^>]*>/g))
        expect(tag, file).toBe(
          german ? '<ServerSetting lang="de">' : '<ServerSetting>',
        );
    }
  });

  it('links only settings that exist, in the page’s language', () => {
    const settings = new Set(
      [
        ...readFileSync(join(root, '.env.example'), 'utf8').matchAll(
          /^#?\s*(CCMS_[A-Z0-9_]+)=/gm,
        ),
      ].map(([, name]) => (name ?? '').toLowerCase()),
    );
    for (const { file, text } of pages) {
      const german = file.endsWith('.de.mdx');
      for (const [, prefix, anchor] of text.matchAll(
        /\]\((\/de)?\/reference\/settings#([a-z0-9_]+)\)/g,
      )) {
        expect(settings.has(anchor ?? ''), `${file}: #${anchor}`).toBe(true);
        expect(prefix === '/de', `${file}: #${anchor}`).toBe(german);
      }
    }
  });
});

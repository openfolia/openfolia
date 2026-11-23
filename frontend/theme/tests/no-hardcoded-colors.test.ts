import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * No component hard-codes a colour: colours live in `frontend/theme/src/theme.css` only, and
 * components reach them through the Tailwind classes the tokens map to (`bg-primary`, …).
 *
 * Scanned: every `.ts`, `.html` and `.css` file under `frontend/ui/src` and `frontend/editor/src`.
 * Refused: hex, `rgb()`/`hsl()`/`oklch()`/… literals, CSS named colours in a colour property, and
 * Tailwind's fixed palette classes (`bg-white`, `text-red-500`, …), which bypass the theme.
 *
 * Allow-list (what is not checked, and why):
 * - `*.spec.ts`: tests may name a colour to assert on it.
 * - image assets (`*.svg`, `*.png`, …): the logos are branding config, not component code.
 * - `ALLOWED` below: individual files, each with a reason. Keep it empty if you can.
 */
const ALLOWED: Record<string, string> = {
  // The page design screen (#392) shows printed paper, not the UI: a new design's colours are
  // document data, and the logo boxes and preset thumbnails are white (or dark) paper whatever
  // the UI theme, drawn in the design's own colours.
  'frontend/editor/src/app/admin/page-designs/design-model.ts':
    'a new page design’s default colours (document data)',
  'frontend/editor/src/app/admin/page-designs/page-design-editor.page.ts':
    'the logo boxes show light and dark paper',
  'frontend/editor/src/app/admin/page-designs/preset-picker.component.ts':
    'the thumbnails sketch a printed title page',
};

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '../../..');
const roots = ['frontend/ui/src', 'frontend/editor/src'].map((p) =>
  join(repo, p),
);

const PATTERNS: [string, RegExp][] = [
  ['hex colour', /#(?:[0-9a-f]{8}|[0-9a-f]{6}|[0-9a-f]{4}|[0-9a-f]{3})\b/i],
  [
    'colour function',
    /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(/i,
  ],
  [
    'named colour in a colour property',
    /\b(?:color|background(?:-color)?|border(?:-color)?|fill|stroke)\s*:\s*(?:white|black|red|green|blue|yellow|orange|purple|pink|gray|grey|transparent)\b/i,
  ],
  [
    'Tailwind palette class',
    /\b(?:bg|text|border|ring|fill|stroke|from|to|via|outline|divide|shadow|accent|caret|decoration)-(?:white|black|(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3})\b/,
  ],
];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory())
      return entry.name === 'node_modules' ? [] : files(path);
    return /\.(ts|html|css)$/.test(entry.name) &&
      !entry.name.endsWith('.spec.ts')
      ? [path]
      : [];
  });
}

/** Strips `//` and block comments so prose does not trip the patterns. */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function findColors(text: string): string[] {
  return PATTERNS.filter(([, re]) => re.test(stripComments(text))).map(
    ([name]) => name,
  );
}

describe('no hard-coded colours outside frontend/theme', () => {
  it('detects each kind of literal', () => {
    expect(findColors('a { color: #fff }')).toEqual(['hex colour']);
    expect(findColors('x = "rgb(0 0 0)"')).toEqual(['colour function']);
    expect(findColors('a { color: oklch(1 0 0) }')).toEqual([
      'colour function',
    ]);
    expect(findColors('a { background: red }')).toEqual([
      'named colour in a colour property',
    ]);
    expect(findColors('class="bg-red-500 text-white"')).toEqual([
      'Tailwind palette class',
    ]);
    expect(
      findColors(
        'class="bg-primary text-muted-foreground" // #fff in a comment',
      ),
    ).toEqual([]);
    expect(findColors('routerLink="/#section"')).toEqual([]);
  });

  it('finds none in frontend/ui and frontend/editor', () => {
    const all = roots.flatMap(files);
    expect(all.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    for (const file of all) {
      const rel = relative(repo, file);
      if (rel in ALLOWED) continue;
      const found = findColors(readFileSync(file, 'utf8'));
      if (found.length) offenders.push(`${rel}: ${found.join(', ')}`);
    }
    expect(offenders).toEqual([]);
  });
});

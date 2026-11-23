// The settings reference, from `.env.example`: every variable with the comment above it, in the
// file's sections. The file is the one place a setting is described (CLAUDE.md, "Settings"), so a
// variable without a comment fails the docs build.
//
// The file's shape: blocks separated by blank lines. A block of comments alone starts a section
// (its first line the title, the rest an introduction). Otherwise a block holds variables
// (`NAME=` or `NAME=example`), each described by the comment lines right above it; variables
// following each other without a comment between them share the one above the first.
import { anchor, breakableCode, cell, code, mdx, table } from './markdown.mjs';

const VARIABLE = /^([A-Z][A-Z0-9_]*)=(.*)$/;

/**
 * @returns {{ sections: { title: string, intro: string, settings: { name: string, example: string,
 *   description: string, line: number }[] }[], problems: string[] }}
 */
export function parseEnvExample(text) {
  const sections = [];
  const problems = [];
  let section = { title: 'Settings', intro: '', settings: [] };
  const lines = text.split(/\r?\n/);
  let block = [];
  const flush = () => {
    if (block.length === 0) return;
    const comments = block.every((l) => l.text.startsWith('#'));
    if (comments) {
      if (
        section.settings.length > 0 ||
        section.intro ||
        section.title !== 'Settings'
      )
        sections.push(section);
      const [first, ...rest] = block.map((l) => l.text.replace(/^#\s?/, ''));
      section = {
        title: first.trim(),
        intro: rest.join('\n').trim(),
        settings: [],
      };
    } else {
      let pending = [];
      let shared = '';
      for (const { text: lineText, number } of block) {
        if (lineText.startsWith('#')) {
          pending.push(lineText.replace(/^#\s?/, ''));
          continue;
        }
        const match = VARIABLE.exec(lineText);
        if (!match) {
          problems.push(
            `.env.example:${number}: "${lineText}" is no comment and no NAME=value line`,
          );
          continue;
        }
        if (pending.length > 0) {
          shared = pending.join('\n').trim();
          pending = [];
        }
        if (!shared)
          problems.push(
            `.env.example:${number}: ${match[1]} has no comment describing it`,
          );
        section.settings.push({
          name: match[1],
          example: match[2],
          description: shared,
          line: number,
        });
      }
      if (pending.length > 0)
        section.intro = [section.intro, pending.join('\n')]
          .filter(Boolean)
          .join('\n\n');
    }
    block = [];
  };
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === '') flush();
    else block.push({ text: trimmed, number: index + 1 });
  });
  flush();
  if (section.settings.length > 0 || section.intro) sections.push(section);

  const seen = new Map();
  for (const s of sections.flatMap((x) => x.settings)) {
    if (seen.has(s.name))
      problems.push(
        `.env.example:${s.line}: ${s.name} is listed twice (also line ${seen.get(s.name)})`,
      );
    else seen.set(s.name, s.line);
  }
  return { sections, problems };
}

/** Comment text as Markdown: the file's comments wrap at a column, so lines join into paragraphs. */
function prose(text) {
  return text
    .split(/\n(?=\s*[-*] |\s*\n)/)
    .map((paragraph) => mdx(paragraph.replace(/\n(?!\s*[-*] )/g, ' ')))
    .join('\n');
}

/** The settings page's body. */
export function renderSettings({ sections }) {
  const out = [];
  const all = sections.flatMap((s) => s.settings);
  out.push(
    `Every setting the server, its tools and its scripts read from the environment, with what \`.env.example\` says about it. ${all.length} settings in ${sections.length} groups. Copy \`.env.example\` to \`.env\` and set what you need: a setting left empty takes its default.`,
    '',
  );
  for (const section of sections) {
    out.push(`## ${mdx(section.title)}`, '');
    if (section.intro) out.push(prose(section.intro), '');
    if (section.settings.length === 0) continue;
    out.push(
      table(
        ['Setting', 'In `.env.example`'],
        section.settings.map((s) => [
          `[${breakableCode(s.name)}](#${anchor(s.name)})`,
          s.example ? cell(code(s.example)) : 'empty',
        ]),
      ),
      '',
    );
    let previous;
    for (const s of section.settings) {
      out.push(`### ${s.name}`, '');
      if (s.description === previous)
        out.push(`See ${code(previousName(section, s))}.`, '');
      else out.push(prose(s.description), '');
      previous = s.description;
    }
  }
  return out.join('\n');
}

/** The first setting of a run sharing one comment. */
function previousName(section, setting) {
  const index = section.settings.indexOf(setting);
  let at = index;
  while (at > 0 && section.settings[at - 1].description === setting.description)
    at--;
  return section.settings[at].name;
}

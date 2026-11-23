// The German error code reference's texts (#750): each code's message as the editor shows it, from
// its German translations (`frontend/editor/src/i18n/de.json`), so the reference and the editor say
// the same. A code's text is, in this order:
//
// 1. `apiErrors.codes.<code>`, the editor's text for the code wherever it meets it;
// 2. none, for a code the editor's i18n test exempts (`EXEMPT` in `frontend/editor/tools/i18n.test.mjs`):
//    no editor screen meets it, so the German page shows its English description, said so. Checked
//    before the screens' tables on purpose: a table may name the same string for something else
//    (`missing-asset` is also a page design's issue, `chunk-set-too-large` a check's);
// 3. a screen's own table (`'<code>': 'editor.…'` in `frontend/editor/src/app/`, the backups', the
//    branding's or the translation import's), the rule the editor's i18n test reads them by.
//
// Any other code without a German text fails the build.
import ts from 'typescript';

/** What an argument stands for in a reference: the reader sees "…" where a value goes. */
const VALUE = '…';

/**
 * An ICU message as the text a reference shows: each argument (`{path}`, `{n, number}`) as "…", of
 * a plural or a select only its `other` branch (its `#` as "…"), ICU's quoting undone.
 */
export function icuText(message) {
  const s = String(message);
  let i = 0;

  /** Text up to the `}` that closes the current branch (or the end); `#` stands for a plural's number. */
  const text = (inBranch, inPlural) => {
    let out = '';
    while (i < s.length) {
      const c = s[i];
      if (c === "'") {
        // `''` is an apostrophe; `'{…}'` (or `'#'` in a plural) is quoted text; else it is itself.
        if (s[i + 1] === "'") {
          out += "'";
          i += 2;
        } else if (
          /[{}]/.test(s[i + 1] ?? '') ||
          (inPlural && s[i + 1] === '#')
        ) {
          const end = s.indexOf("'", i + 1);
          out += s.slice(i + 1, end < 0 ? s.length : end);
          i = end < 0 ? s.length : end + 1;
        } else {
          out += c;
          i++;
        }
      } else if (c === '{') {
        i++;
        out += argument(inPlural);
      } else if (c === '}' && inBranch) {
        return out;
      } else if (c === '#' && inPlural) {
        out += VALUE;
        i++;
      } else {
        out += c;
        i++;
      }
    }
    return out;
  };

  /** Reads up to (not past) the first of `stops` outside braces. */
  const until = (stops) => {
    const start = i;
    let depth = 0;
    while (i < s.length) {
      const c = s[i];
      if (depth === 0 && stops.includes(c)) break;
      if (c === '{') depth++;
      else if (c === '}') depth--;
      i++;
    }
    return s.slice(start, i);
  };

  /** An argument after its `{`, up to and past its `}`. */
  const argument = (inPlural) => {
    until([',', '}']);
    if (s[i] !== ',') {
      i++;
      return VALUE;
    }
    i++;
    const type = until([',', '}']).trim();
    if (s[i] !== ',' || !['plural', 'select', 'selectordinal'].includes(type)) {
      until(['}']);
      i++;
      return VALUE;
    }
    i++;
    const branches = {};
    for (;;) {
      const key = until(['{', '}']).trim();
      if (i >= s.length || s[i] === '}') break;
      i++;
      const branch = text(true, type === 'select' ? inPlural : true);
      i++;
      // `offset:1 one` → `one`.
      branches[key.split(/\s+/).at(-1)] = branch;
    }
    i++;
    return branches.other ?? Object.values(branches)[0] ?? VALUE;
  };

  // An argument ending a sentence (`… gelesen werden: {path}.`) leaves one stop, not four.
  return text(false, false).replace(/\s+/g, ' ').trim().replace(/…\.$/, VALUE);
}

/** A whole translation key's text (`editor.admin.backups.errors.fixed`) in a language's JSON. */
function messageAt(messages, key) {
  const value = String(key)
    .replace(/^editor\./, '')
    .split('.')
    .reduce(
      (node, part) =>
        node && typeof node === 'object' ? node[part] : undefined,
      messages,
    );
  return typeof value === 'string' ? value : undefined;
}

/**
 * The screens' own tables of error texts, from the editor's sources (`{ path, text }`, spec files
 * left out by the caller): code → the translation keys they give it, in the order found. The same
 * rule as the editor's i18n test: `'<code>': 'editor.…'`.
 */
export function screenErrorTables(files) {
  const tables = new Map();
  for (const { text } of files)
    for (const m of text.matchAll(
      /'([a-z0-9][a-z0-9-]*)':\s*'(editor\.[A-Za-z0-9.-]+)'/g,
    ))
      tables.set(m[1], [...(tables.get(m[1]) ?? []), m[2]]);
  return tables;
}

/**
 * The codes the editor's i18n test exempts from having a text (`const EXEMPT = { … }` of
 * `frontend/editor/tools/i18n.test.mjs`, read as source, never run): no editor screen meets them.
 */
export function exemptErrorCodes(sourceText) {
  const file = ts.createSourceFile(
    'i18n.test.mjs',
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const d of statement.declarationList.declarations)
      if (
        ts.isIdentifier(d.name) &&
        d.name.text === 'EXEMPT' &&
        d.initializer &&
        ts.isObjectLiteralExpression(d.initializer)
      )
        return new Set(
          d.initializer.properties
            .map((p) =>
              p.name && (ts.isStringLiteral(p.name) || ts.isIdentifier(p.name))
                ? p.name.text
                : undefined,
            )
            .filter(Boolean),
        );
  }
  return undefined;
}

/**
 * Each code's German text (`codes`, the catalogue's names), from the editor's German translations
 * (`de`, its JSON), the screens' tables (`screenErrorTables`) and the exempt codes
 * (`exemptErrorCodes`): `{ texts: Map code → text, english: codes shown in English, problems }`.
 */
export function germanErrorTexts(codes, { de, tables, exempt }) {
  const texts = new Map();
  const english = [];
  const problems = [];
  if (!exempt)
    problems.push(
      "frontend/editor/tools/i18n.test.mjs: no EXEMPT object of the codes the editor's screens never meet found",
    );
  for (const code of codes) {
    const own = messageAt(de, `apiErrors.codes.${code}`);
    if (own !== undefined) {
      texts.set(code, icuText(own));
      continue;
    }
    if (exempt?.has(code)) {
      english.push(code);
      continue;
    }
    const keys = tables.get(code) ?? [];
    const text = keys
      .map((key) => messageAt(de, key))
      .find((t) => t !== undefined);
    if (text !== undefined) texts.set(code, icuText(text));
    else
      problems.push(
        keys.length === 0
          ? `the error code ${code} has no German text: the editor's de.json has no apiErrors.codes.${code}, no screen's table names one, and the editor's i18n test does not exempt it`
          : `the error code ${code} has no German text: the editor's de.json has none of ${keys.join(', ')}`,
      );
  }
  return { texts, english, problems };
}

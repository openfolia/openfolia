// The dependency licence check and the third-party notice (`pnpm licences`,
// `pnpm licences:notice`; #370), as pure functions: `licences.mjs` reads pnpm's report and the
// files, this decides. The core is AGPL-3.0-only, so every shipped dependency (the production
// dependencies of every workspace package: what the editor bundles and the servers load) must be
// under a licence that may be combined with it. Dev dependencies ship nothing and are not
// checked.

/**
 * Operating system, processor and C library words in the names of packages built per platform
 * (`@img/sharp-libvips-darwin-arm64`, `@resvg/resvg-js-linux-x64-gnu`). Dropped from such a
 * package's name in the notice, so the notice reads the same on every machine.
 */
export const PLATFORM_WORDS = new Set([
  'aix',
  'android',
  'darwin',
  'freebsd',
  'linux',
  'linuxmusl',
  'netbsd',
  'openbsd',
  'sunos',
  'win32',
  'arm',
  'arm64',
  'armv6',
  'armv7',
  'ia32',
  'loong64',
  'mips64el',
  'ppc64',
  'ppc64le',
  'riscv64',
  's390x',
  'x64',
  'wasm32',
  'universal',
  'eabi',
  'gnu',
  'gnueabihf',
  'musl',
  'musleabihf',
  'msvc',
]);

/**
 * An SPDX licence expression (`MIT`, `(MIT OR Apache-2.0)`, `Apache-2.0 AND BSD-3-Clause`,
 * `GPL-2.0-or-later WITH Classpath-exception-2.0`) as a tree: `{ id }`, `{ id, exception }`,
 * `{ and: [a, b] }` or `{ or: [a, b] }`. WITH binds tighter than AND, AND tighter than OR. Throws
 * on anything else (a free-text licence, `SEE LICENSE IN …`, unbalanced brackets).
 */
export function parseLicence(expression) {
  const tokens = String(expression).match(/\(|\)|[^\s()]+/g) ?? [];
  let at = 0;
  const peek = () => tokens[at];
  const fail = () => {
    throw new Error(`not an SPDX expression: ${String(expression)}`);
  };

  const primary = () => {
    const token = tokens[at++];
    if (token === '(') {
      const inner = or();
      if (tokens[at++] !== ')') fail();
      return inner;
    }
    if (
      token === undefined ||
      token === ')' ||
      /^(AND|OR|WITH)$/i.test(token) ||
      !/^[A-Za-z0-9.+-]+$/.test(token)
    ) {
      fail();
    }
    if (peek()?.toUpperCase() === 'WITH') {
      at++;
      const exception = tokens[at++];
      if (!exception || !/^[A-Za-z0-9.+-]+$/.test(exception)) fail();
      return { id: token, exception };
    }
    return { id: token };
  };
  const and = () => {
    let node = primary();
    while (peek()?.toUpperCase() === 'AND') {
      at++;
      node = { and: [node, primary()] };
    }
    return node;
  };
  const or = () => {
    let node = and();
    while (peek()?.toUpperCase() === 'OR') {
      at++;
      node = { or: [node, and()] };
    }
    return node;
  };

  const tree = or();
  if (at !== tokens.length) fail();
  return tree;
}

/**
 * Whether code under `expression` may ship with the core: OR needs one allowed side, AND both.
 * `X WITH E` needs `X` allowed and `E` among `exceptions`, the reviewed additional permissions
 * (`Classpath-exception-2.0`): a `WITH` can also take rights away (`Commons-Clause`), so an
 * exception not listed is not allowed. An expression that does not parse is not allowed.
 */
export function isAllowed(expression, allowed, exceptions = new Set()) {
  let tree;
  try {
    tree = parseLicence(expression);
  } catch {
    return false;
  }
  const visit = (node) => {
    if ('or' in node) return node.or.some(visit);
    if ('and' in node) return node.and.every(visit);
    if (!allowed.has(node.id)) return false;
    return node.exception === undefined || exceptions.has(node.exception);
  };
  return visit(tree);
}

/** A platform package's name without its platform words (`@img/sharp-libvips-darwin-arm64` → `@img/sharp-libvips`). */
export function familyName(name) {
  const slash = name.lastIndexOf('/');
  const scope = slash === -1 ? '' : name.slice(0, slash + 1);
  const words = name.slice(slash + 1).split('-');
  const kept = words.filter((word) => !PLATFORM_WORDS.has(word));
  return scope + (kept.length > 0 ? kept : words).join('-');
}

/**
 * pnpm's report (`pnpm licenses list --prod --json -r`: `{ [licence]: [{ name, versions, paths,
 * homepage }] }`) as one row per package and licence, sorted by name, with its versions.
 * `isPlatformPackage(path)` says whether the package installed at `path` is built for one
 * platform (its `package.json` names an `os` or a `cpu`): such a row is named by `familyName`.
 */
export function packagesOf(report, isPlatformPackage = () => false) {
  const rows = new Map();
  for (const [licence, entries] of Object.entries(report)) {
    for (const entry of entries) {
      const platform = (entry.paths ?? []).some((path) =>
        isPlatformPackage(path),
      );
      const name = platform ? familyName(entry.name) : entry.name;
      const key = `${name}\u0000${licence}`;
      const row = rows.get(key) ?? {
        name,
        licence,
        versions: new Set(),
        homepage: undefined,
      };
      for (const version of entry.versions ?? []) row.versions.add(version);
      // The package's own homepage wins over a platform build's.
      if (entry.homepage && (!row.homepage || !platform)) {
        row.homepage = entry.homepage;
      }
      rows.set(key, row);
    }
  }
  return [...rows.values()]
    .map((row) => ({
      name: row.name,
      licence: row.licence,
      versions: [...row.versions].sort(compareVersions),
      homepage: row.homepage ?? null,
    }))
    .sort(
      (a, b) =>
        compareText(a.name, b.name) || compareText(a.licence, b.licence),
    );
}

/**
 * The rows whose licence is neither allowed nor a reviewed exception (`policy.exceptions`: the
 * package's name and the licence exactly as reported, with the reason). A changed licence is
 * reviewed again.
 */
export function findViolations(packages, policy) {
  const allowed = new Set(policy.allowed);
  const exceptions = new Set(policy.allowedExceptions ?? []);
  const excepted = new Set(
    (policy.exceptions ?? []).map(
      (exception) => `${exception.package}\u0000${exception.licence}`,
    ),
  );
  return packages.filter(
    (row) =>
      !isAllowed(row.licence, allowed, exceptions) &&
      !excepted.has(`${row.name}\u0000${row.licence}`),
  );
}

/** The third-party notice (`THIRD-PARTY-NOTICES.md`), in Markdown, the same for the same rows. */
export function renderNotice(packages, { fonts = [] } = {}) {
  const cell = (text) =>
    String(text).replaceAll('\\', '\\\\').replaceAll('|', '\\|');
  const lines = [
    '# Third-party notices',
    '',
    'This project is Copyright (C) 2026 The project authors, licensed under the GNU Affero',
    'General Public License, version 3 only (AGPL-3.0-only; `LICENSE`). It ships the third-party',
    'software listed here, each under its own licence, which its package carries in full.',
    '',
    'Generated by `pnpm licences:notice` from the production dependencies of every workspace',
    'package; `pnpm check` fails when it is out of date or a licence is not allowed',
    '(`scripts/licence-policy.json`). Packages built per operating system and processor are',
    'listed once, under their name without the platform. The editor’s production build also',
    'writes the licence texts of what it bundles to `3rdpartylicenses.txt`.',
    '',
  ];
  if (fonts.length > 0) {
    lines.push('## Fonts', '', '| Font | Licence | Licence text |');
    lines.push('| --- | --- | --- |');
    for (const font of fonts) {
      lines.push(
        `| ${cell(font.name)} | ${cell(font.licence)} | \`${cell(font.file)}\` |`,
      );
    }
    lines.push('');
  }
  lines.push(
    '## Packages',
    '',
    `${packages.length} packages.`,
    '',
    '| Package | Version | Licence | Homepage |',
    '| --- | --- | --- | --- |',
  );
  for (const row of packages) {
    lines.push(
      `| ${cell(row.name)} | ${cell(row.versions.join(', '))} | ${cell(row.licence)} | ${row.homepage ? `<${cell(row.homepage)}>` : ''} |`,
    );
  }
  return `${lines.join('\n')}\n`;
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function compareVersions(a, b) {
  return a.localeCompare(b, 'en', { numeric: true });
}

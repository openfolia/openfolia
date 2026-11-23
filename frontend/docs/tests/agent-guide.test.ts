import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  checkAgentGuide,
  codeBlocks,
  GITHUB_ACTIONS_ISSUER,
  guideValues,
  overrideText,
  pinnedServices,
  PLACEHOLDERS,
  renderAgentGuide,
  RULES,
  sha256,
  SIGNATURE_PREDICATE,
} from '../scripts/lib/agent-guide.mjs';
import { docsSettings } from '../scripts/lib/settings.mjs';
import { parse } from 'yaml';

const docsRoot = join(import.meta.dirname, '..');
const template = (lang: 'en' | 'de') =>
  readFileSync(
    join(docsRoot, `agents/agents${lang === 'en' ? '' : '.de'}.mdx`),
    'utf8',
  );
const compose = readFileSync(
  join(docsRoot, '../../deploy/compose.yaml'),
  'utf8',
);
/** A release's images.lock (#739): every image by a digest of its own. */
const lockOf = (images: string, tag: string) =>
  ['api', 'backup', 'editor', 'embedder', 'mcp']
    .map(
      (image, i) =>
        `${images}/${image}:${tag}@sha256:${String(i + 1).repeat(64)}`,
    )
    .join('\n');
const released = docsSettings({
  DOCS_RELEASE: 'v1.2.3',
  DOCS_SITE_URL: 'https://docs.example.com',
  DOCS_RELEASE_DIGESTS: lockOf('ghcr.io/openfolia/openfolia', 'v1.2.3'),
});
const render = (lang: 'en' | 'de', settings = released) =>
  renderAgentGuide(template(lang), guideValues(settings, compose, lang));

describe('the agent guide (#423)', () => {
  for (const lang of ['en', 'de'] as const) {
    it(`(${lang}) holds to its rules once the release is filled in`, () => {
      const page = render(lang);
      expect(
        checkAgentGuide(page, { english: lang === 'en', rendered: true }),
      ).toEqual([]);
      expect(
        checkAgentGuide(template(lang), { english: lang === 'en' }),
      ).toEqual([]);
    });

    it(`(${lang}) pins the release: its images, its compose file and that file's checksum`, () => {
      const page = render(lang);
      const commands = codeBlocks(page).join('\n');
      expect(commands).toContain('OPENFOLIA_VERSION=v1.2.3');
      expect(commands).toContain(
        'OPENFOLIA_IMAGES=ghcr.io/openfolia/openfolia',
      );
      expect(commands).toContain(
        "curl -fsSL -o compose.yaml 'https://github.com/openfolia/openfolia/releases/download/v1.2.3/compose.yaml'",
      );
      expect(commands).toContain(
        `echo '${sha256(compose)}  compose.yaml' | shasum -a 256 -c -`,
      );
      expect(commands).not.toMatch(/\|\s*(ba|z)?sh\b/);
      expect(commands).not.toMatch(/\blatest\b/);
    });

    it(`(${lang}) pins every image by its digest (#739): the override, its checksum, the check of step 7`, () => {
      const page = render(lang);
      const commands = codeBlocks(page).join('\n');
      // The very file the release attaches, made by the release's own code from its images.lock.
      const override = overrideText({
        images: released.images,
        tag: 'v1.2.3',
        digests: released.digests ?? {},
        services: pinnedServices(parse(compose, { merge: true })),
      });
      expect(override).toContain(
        `  worker:\n    image: ghcr.io/openfolia/openfolia/api:v1.2.3@sha256:${'1'.repeat(64)}\n`,
      );
      expect(commands).toContain(
        "curl -fsSL -o compose.digests.yaml 'https://github.com/openfolia/openfolia/releases/download/v1.2.3/compose.digests.yaml'",
      );
      expect(commands).toContain(
        `echo '${sha256(override)}  compose.digests.yaml' | shasum -a 256 -c -`,
      );
      expect(commands).toContain(
        'echo "COMPOSE_FILE=compose.yaml:compose.digests.yaml"',
      );
      // Step 7 compares each service's running image with the digest the release pins for it.
      for (const [service, image, digit] of <const>[
        ['api', 'api', '1'],
        ['worker', 'api', '1'],
        ['editor', 'editor', '3'],
        ['backup', 'backup', '2'],
        ['mcp', 'mcp', '5'],
      ])
        expect(commands).toContain(
          `\n${service} ghcr.io/openfolia/openfolia/${image}@sha256:${digit.repeat(64)} ghcr.io/openfolia/openfolia/${image}:v1.2.3@sha256:${digit.repeat(64)}\n`,
        );
      expect(commands).not.toContain('embedder');
    });
  }

  it("keeps the whole service account token, not only its ID (the run's step 9 found it cut)", () => {
    // The API's format (backend/api/src/access/core/service-token.ts): ccms_sat_<16 hex>_<64 hex>.
    const token = `ccms_sat_${'a'.repeat(16)}_${'b'.repeat(64)}`;
    const grep = /grep -oE '([^']+)'/.exec(
      codeBlocks(template('en')).join('\n'),
    );
    expect(grep).not.toBeNull();
    const kept = new RegExp(grep![1]!).exec(`A token: ${token}\n`)?.[0];
    expect(kept).toBe(token);
    expect(template('en')).toContain(`[ \${#token} -eq ${token.length} ]`);
  });

  it('gives the agent the same commands in both languages', () => {
    expect(codeBlocks(template('de'))).toEqual(codeBlocks(template('en')));
  });

  it('states as many rules in German as in English', () => {
    // The rules are the numbered items between the section's heading and the next paragraph.
    const rules = (lang: 'en' | 'de') =>
      /\n## Rules for the agent\n([\s\S]*?)\nEach step|\n## Regeln für den Agenten\n([\s\S]*?)\nJeder Schritt/
        .exec(template(lang))
        ?.slice(1)
        .join('')
        .match(/^\d+\. \*\*/gm)?.length;
    expect(rules('en')).toBe(8);
    expect(rules('de')).toBe(rules('en'));
  });

  it('names only the values it knows', () => {
    for (const lang of ['en', 'de'] as const)
      for (const [, name] of template(lang).matchAll(/%%([A-Z0-9_]+)%%/g))
        expect(PLACEHOLDERS).toContain(name);
    expect(() => renderAgentGuide('%%NOPE%%', {})).toThrow(/%%NOPE%%/);
  });

  it('tells the agent to stop in the development docs, which pin no release', () => {
    const page = render('en', docsSettings({}));
    expect(page).toContain('These are the development docs');
    expect(page).toContain("Don't install from this page");
    expect(checkAgentGuide(page, { english: true, rendered: true })).toEqual(
      [],
    );
  });

  it('takes the release files and images from where the settings say', () => {
    const page = render(
      'en',
      docsSettings({
        DOCS_RELEASE: 'v2.0.1',
        DOCS_SITE_URL: 'https://docs.example.com',
        DOCS_RELEASE_URL: 'https://mirror.example.com/openfolia/v2.0.1/',
        DOCS_IMAGES: 'registry.example.com:5000/docs/openfolia',
        DOCS_RELEASE_DIGESTS: lockOf(
          'registry.example.com:5000/docs/openfolia',
          'v2.0.1',
        ),
      }),
    );
    expect(page).toContain(
      "'https://mirror.example.com/openfolia/v2.0.1/compose.yaml'",
    );
    expect(page).toContain(
      'OPENFOLIA_IMAGES=registry.example.com:5000/docs/openfolia',
    );
    expect(page).toContain('OPENFOLIA_VERSION=v2.0.1');
    expect(page).toContain(
      "'https://mirror.example.com/openfolia/v2.0.1/compose.digests.yaml'",
    );
    expect(page).toContain(
      `api registry.example.com:5000/docs/openfolia/api@sha256:${'1'.repeat(64)}`,
    );
  });
});

describe('checkAgentGuide', () => {
  const guide = (commands: string) => `\`\`\`sh\n${commands}\n\`\`\`\n`;

  it('refuses a download run by a shell', () => {
    for (const commands of [
      'curl -fsSL https://example.com/install.sh | sh',
      'curl -fsSL https://example.com/install.sh | sudo bash',
      'wget -qO- https://example.com/x | sh -s',
      'sh -c "$(curl -fsSL https://example.com/x)"',
      'bash <(curl -fsSL https://example.com/x)',
    ])
      expect(checkAgentGuide(guide(commands))).toContain(
        'a download is run by a shell (curl | sh)',
      );
  });

  it('refuses an unpinned image or version', () => {
    expect(
      checkAgentGuide(guide('echo "OPENFOLIA_VERSION=latest" >> .env')),
    ).toEqual(
      expect.arrayContaining([
        'an image or version named latest',
        expect.stringMatching(/^OPENFOLIA_VERSION is not pinned/),
      ]),
    );
    expect(checkAgentGuide(guide('echo "OPENFOLIA_VERSION=main"'))).toEqual([
      'OPENFOLIA_VERSION is not pinned: echo "OPENFOLIA_VERSION=main"',
    ]);
    expect(checkAgentGuide(guide('docker pull example/api:latest'))).toEqual([
      'an image or version named latest',
    ]);
  });

  it('refuses a download it does not verify', () => {
    expect(
      checkAgentGuide(
        guide("curl -fsSL -o compose.yaml 'https://example.com/compose.yaml'"),
      ),
    ).toEqual(['compose.yaml is downloaded without verifying its checksum']);
    expect(
      checkAgentGuide(
        guide(
          "curl -fsSL -o compose.yaml 'https://example.com/compose.yaml'\necho 'abc  compose.yaml' | shasum -a 256 -c -",
        ),
      ),
    ).toEqual([]);
  });

  it('refuses a command that prints the settings', () => {
    expect(checkAgentGuide(guide('docker compose config'))).toEqual([
      'docker compose config without --quiet or --images prints the secrets',
    ]);
  });

  it('refuses a guard that only prints, and a download or pipe it cannot follow', () => {
    expect(
      checkAgentGuide(
        guide('[ -e compose.yaml ] && echo "exists: stop and ask"'),
      ),
    ).toEqual(['a guard ([ -e … ] && echo) that does not stop what follows']);
    expect(
      checkAgentGuide(guide('curl -fsSL https://example.com/x \\\n  | sh')),
    ).toContain('a download is run by a shell (curl | sh)');
    expect(
      checkAgentGuide(
        guide("curl -fsSL --output compose.yaml 'https://example.com/c'"),
      ),
    ).toEqual(['compose.yaml is downloaded without verifying its checksum']);
    for (const commands of [
      'wget https://example.com/c',
      'curl -fsSLO https://example.com/c',
      'curl -fsSL https://example.com/c > compose.yaml',
    ])
      expect(checkAgentGuide(guide(commands))[0]).toMatch(
        /^a download the check can't follow/,
      );
  });

  it('wants every rule in the English guide, and every value filled in', () => {
    expect(checkAgentGuide('', { english: true })).toHaveLength(RULES.length);
    expect(checkAgentGuide('`%%RELEASE%%`', { rendered: true })).toEqual([
      'an unfilled value %%RELEASE%%',
    ]);
  });

  it('wants a guide that installs a release to pin its images by digest (#739)', () => {
    const install = 'echo "OPENFOLIA_VERSION=v1.2.3" >> settings';
    expect(checkAgentGuide(guide(install), { rendered: true })).toEqual([
      'the images are not pinned by their digests (COMPOSE_FILE with compose.digests.yaml)',
    ]);
    expect(
      checkAgentGuide(
        guide(
          `${install}\necho "COMPOSE_FILE=compose.yaml:compose.digests.yaml" >> settings`,
        ),
        { rendered: true },
      ),
    ).toEqual([]);
  });
});

describe('the release settings', () => {
  it('pin no release by default, and derive the images from the repository', () => {
    expect(docsSettings({})).toMatchObject({
      release: null,
      releaseUrl: null,
      images: 'ghcr.io/openfolia/openfolia',
    });
    expect(
      docsSettings({
        DOCS_RELEASE: 'v1.0.0',
        DOCS_SITE_URL: 'https://docs.example.com',
        DOCS_REPOSITORY_URL: 'https://github.com/Some-Fork/openfolia',
        DOCS_RELEASE_DIGESTS: lockOf('ghcr.io/some-fork/openfolia', 'v1.0.0'),
      }),
    ).toMatchObject({
      release: 'v1.0.0',
      releaseUrl:
        'https://github.com/Some-Fork/openfolia/releases/download/v1.0.0',
      images: 'ghcr.io/some-fork/openfolia',
    });
  });

  it('refuse a release that is no tag, and an image repository with a tag', () => {
    for (const DOCS_RELEASE of [
      'v1.2.3-rc.1',
      '1.2.3',
      'latest',
      'v1.2',
      'v01.2.3',
      'v1.2.3-',
    ])
      expect(() => docsSettings({ DOCS_RELEASE })).toThrow(/DOCS_RELEASE/);
    for (const DOCS_IMAGES of [
      'ghcr.io/openfolia/openfolia:v1',
      'Ghcr.io/x/y',
      'openfolia',
      'ghcr.io/x/y@sha256:00',
    ])
      expect(() => docsSettings({ DOCS_IMAGES })).toThrow(/DOCS_IMAGES/);
    expect(() =>
      docsSettings({ DOCS_RELEASE: 'v1.0.0', DOCS_RELEASE_URL: 'ftp://x' }),
    ).toThrow(/DOCS_RELEASE_URL/);
    expect(() =>
      docsSettings({ DOCS_RELEASE_URL: 'https://x.example' }),
    ).toThrow(/without DOCS_RELEASE/);
  });

  it('keep shell and MDX syntax out of the URLs, and want https for a release', () => {
    for (const DOCS_SITE_URL of [
      "https://x.example/a'$(id)'",
      'https://x.example/?a=`{1+1}`',
      'https://x.example/#top',
    ])
      expect(() => docsSettings({ DOCS_SITE_URL })).toThrow(/DOCS_SITE_URL/);
    expect(() =>
      docsSettings({
        DOCS_RELEASE: 'v1.0.0',
        DOCS_SITE_URL: 'http://docs.example.com',
      }),
    ).toThrow(/https/);
    expect(() => docsSettings({ DOCS_RELEASE: 'v1.0.0' })).toThrow(
      /DOCS_SITE_URL must be set/,
    );
    expect(
      docsSettings({
        DOCS_RELEASE: 'v1.0.0',
        DOCS_SITE_URL: 'http://127.0.0.1:4114',
        DOCS_RELEASE_DIGESTS: lockOf('ghcr.io/openfolia/openfolia', 'v1.0.0'),
      }).siteUrl,
    ).toBe('http://127.0.0.1:4114');
  });

  it("want a release's images by digest: its images.lock, of its images and its tag (#739)", () => {
    const base = {
      DOCS_RELEASE: 'v1.0.0',
      DOCS_SITE_URL: 'https://docs.example.com',
    };
    expect(() => docsSettings(base)).toThrow(
      /DOCS_RELEASE_DIGESTS must be set/,
    );
    expect(() =>
      docsSettings({
        DOCS_RELEASE_DIGESTS: lockOf('ghcr.io/openfolia/openfolia', 'v1.0.0'),
      }),
    ).toThrow(/without DOCS_RELEASE/);
    for (const lock of [
      lockOf('ghcr.io/other/openfolia', 'v1.0.0'),
      lockOf('ghcr.io/openfolia/openfolia', 'v1.0.1'),
      `ghcr.io/openfolia/openfolia/api:v1.0.0@sha256:${'a'.repeat(63)}`,
      `ghcr.io/openfolia/openfolia/api:v1.0.0`,
      `ghcr.io/openfolia/openfolia/api:v1.0.0@sha256:${'a'.repeat(64)} ghcr.io/openfolia/openfolia/api:v1.0.0@sha256:${'b'.repeat(64)}`,
      `ghcr.io/openfolia/openfolia/api:v1.0.0@sha256:${'a'.repeat(64)}'$(id)'`,
    ])
      expect(() =>
        docsSettings({ ...base, DOCS_RELEASE_DIGESTS: lock }),
      ).toThrow(/DOCS_RELEASE_DIGESTS/);
    // Lines or spaces between the images: the file's text, or the same in one line.
    expect(
      docsSettings({
        ...base,
        DOCS_RELEASE_DIGESTS: lockOf(
          'ghcr.io/openfolia/openfolia',
          'v1.0.0',
        ).replace(/\n/g, ' '),
      }).digests,
    ).toMatchObject({
      api: `sha256:${'1'.repeat(64)}`,
      mcp: `sha256:${'5'.repeat(64)}`,
    });
    // A lock without an image compose.yaml runs fails the guide's build.
    const settings = docsSettings({
      ...base,
      DOCS_RELEASE_DIGESTS: `ghcr.io/openfolia/openfolia/api:v1.0.0@sha256:${'a'.repeat(64)}`,
    });
    expect(() => guideValues(settings, compose, 'en')).toThrow(
      /no digest for editor/,
    );
  });
});

/** A release's signatures.sha256 (#745): the trust root, then a bundle per image. */
const signatureSums = [
  'trusted_root',
  'api',
  'backup',
  'editor',
  'embedder',
  'mcp',
]
  .map(
    (file, i) =>
      `${String.fromCharCode(97 + i).repeat(64)}  ${file === 'trusted_root' ? 'trusted_root.json' : `${file}.sigstore.json`}`,
  )
  .join('\n');
const signedRelease = {
  DOCS_RELEASE: 'v1.2.3',
  DOCS_SITE_URL: 'https://docs.example.com',
  DOCS_RELEASE_DIGESTS: lockOf('ghcr.io/openfolia/openfolia', 'v1.2.3'),
  DOCS_RELEASE_SIGNATURES: signatureSums,
};
/** The guide's signature check of step 5, rendered. */
const signatureCheck = (page: string) =>
  codeBlocks(page).find((block) => block.includes('verify-blob-attestation'));

describe('the agent guide, signatures (#745)', () => {
  const releaseUrl =
    'https://github.com/openfolia/openfolia/releases/download/v1.2.3';

  for (const lang of ['en', 'de'] as const) {
    it(`(${lang}) verifies each image's signature offline, before pulling, against the release's files`, () => {
      const page = render(lang, docsSettings(signedRelease));
      expect(
        checkAgentGuide(page, { english: lang === 'en', rendered: true }),
      ).toEqual([]);
      const block = signatureCheck(page);
      expect(block).toBeDefined();
      expect(block).toContain("if [ 'signed' != signed ]; then");
      // Each file downloaded from the release and verified by the checksum the docs name.
      for (const [file, letter] of <const>[
        ['trusted_root.json', 'a'],
        ['api.sigstore.json', 'b'],
        ['editor.sigstore.json', 'd'],
        ['backup.sigstore.json', 'c'],
        ['mcp.sigstore.json', 'f'],
      ]) {
        expect(block).toContain(
          `curl -fsSL -o ${file} '${releaseUrl}/${file}'`,
        );
        expect(block).toContain(
          `echo '${letter.repeat(64)}  ${file}' | shasum -a 256 -c -`,
        );
      }
      expect(block).not.toContain('embedder');
      // The identity of the release's own workflow at its tag, and GitHub's issuer.
      expect(block).toContain(
        "--certificate-identity 'https://github.com/openfolia/openfolia/.github/workflows/images.yml@refs/tags/v1.2.3'",
      );
      expect(block).toContain(
        `--certificate-oidc-issuer '${GITHUB_ACTIONS_ISSUER}'`,
      );
      expect(block).toContain(`--type ${SIGNATURE_PREDICATE} `);
      expect(block).toContain('--trusted-root "$dir/trusted_root.json"');
      // Against the digests the release pins: images.lock's.
      expect(block).toContain(
        `\napi ${'1'.repeat(64)}\neditor ${'3'.repeat(64)}\nbackup ${'2'.repeat(64)}\nmcp ${'5'.repeat(64)}\nEOF\n`,
      );
      // Before the first pull.
      expect(page.indexOf('verify-blob-attestation')).toBeLessThan(
        page.indexOf('docker compose pull'),
      );
      expect(page).toContain(
        `${lang === 'en' ? 'signed by' : 'signiert von'} \`https://github.com/openfolia/openfolia/.github/workflows/images.yml@refs/tags/v1.2.3\``,
      );
    });

    it(`(${lang}) says a release is not signed, and checks nothing, with signing off`, () => {
      const page = render(lang);
      expect(
        checkAgentGuide(page, { english: lang === 'en', rendered: true }),
      ).toEqual([]);
      expect(signatureCheck(page)).toContain(
        "if [ 'unsigned' != signed ]; then",
      );
      expect(page).toContain(
        lang === 'en'
          ? "none: this release's images are not signed"
          : 'keine: Die Images dieser Veröffentlichung sind nicht signiert',
      );
    });
  }

  it('checks nothing in the development docs either', () => {
    expect(signatureCheck(render('en', docsSettings({})))).toContain(
      "if [ 'unreleased' != signed ]; then",
    );
  });

  it("takes a fork's identity and issuer from the settings", () => {
    const block = signatureCheck(
      render(
        'en',
        docsSettings({
          ...signedRelease,
          DOCS_REPOSITORY_URL: 'https://github.com/Some-Fork/openfolia',
          DOCS_RELEASE_DIGESTS: lockOf('ghcr.io/some-fork/openfolia', 'v1.2.3'),
        }),
      ),
    );
    expect(block).toContain(
      "'https://github.com/Some-Fork/openfolia/.github/workflows/images.yml@refs/tags/v1.2.3'",
    );
    const other = signatureCheck(
      render(
        'en',
        docsSettings({
          ...signedRelease,
          DOCS_REPOSITORY_URL: 'https://git.example.com/docs/openfolia',
          DOCS_IMAGES: 'ghcr.io/openfolia/openfolia',
          DOCS_RELEASE_SIGNER_IDENTITY:
            'https://git.example.com/docs/openfolia//.ci/release.yml@refs/tags/v1.2.3',
          DOCS_RELEASE_SIGNER_ISSUER: 'https://git.example.com',
        }),
      ),
    );
    expect(other).toContain(
      "--certificate-identity 'https://git.example.com/docs/openfolia//.ci/release.yml@refs/tags/v1.2.3'",
    );
    expect(other).toContain(
      "--certificate-oidc-issuer 'https://git.example.com'",
    );
  });
});

describe('checkAgentGuide, cosign (#745)', () => {
  const guide = (commands: string) => `\`\`\`sh\n${commands}\n\`\`\`\n`;
  const offline =
    'cosign verify-blob-attestation --bundle "$dir/a.sigstore.json" --trusted-root trusted_root.json --certificate-identity \'x\' --certificate-oidc-issuer \'y\' --type https://sigstore.dev/cosign/sign/v1 --digest "$digest" --digestAlg sha256';

  it('allows cosign only offline: a bundle against the trust root it is given', () => {
    expect(checkAgentGuide(guide(offline))).toEqual([]);
    expect(
      checkAgentGuide(
        guide(`if out=$(${offline} 2>&1 </dev/null); then echo ok; fi`),
      ),
    ).toEqual([]);
    expect(
      checkAgentGuide(
        guide(
          'if command -v cosign >/dev/null 2>&1; then cosign version 2>&1 | grep GitVersion; else echo "no cosign (optional)"; fi',
        ),
      ),
    ).toEqual([]);
    for (const commands of [
      'cosign verify --certificate-identity x ghcr.io/a/b@sha256:00',
      offline.replace(' --trusted-root trusted_root.json', ''),
      offline.replace(' --bundle "$dir/a.sigstore.json"', ' --signature a.sig'),
      offline.replace(
        " --certificate-identity 'x'",
        " --certificate-identity-regexp '.*'",
      ),
      offline.replace(' --type https://sigstore.dev/cosign/sign/v1', ''),
      offline.replace(' --digest "$digest"', ''),
      `${offline} --insecure-ignore-tlog`,
      `${offline} --insecure-ignore-sct`,
      `${offline} --check-claims=false`,
      `${offline} --key cosign.pub`,
      `${offline} \\\n  --rekor-url https://rekor.example.com`,
      'cosign initialize',
      'cosign --verbose verify ghcr.io/a/b@sha256:00',
      '$(command -v cosign) verify ghcr.io/a/b@sha256:00',
      'out=$(cosign verify-attestation ghcr.io/a/b@sha256:00)',
      `cosign version; cosign verify ghcr.io/a/b@sha256:00`,
    ])
      expect(checkAgentGuide(guide(commands))[0]).toMatch(
        /^cosign only as verify-blob-attestation of a bundle against --trusted-root/,
      );
  });
});

describe('the release settings, signatures (#745)', () => {
  it('are none unless set, and only with a release', () => {
    expect(docsSettings({}).signatures).toBeNull();
    expect(
      docsSettings({ ...signedRelease, DOCS_RELEASE_SIGNATURES: '' })
        .signatures,
    ).toBeNull();
    expect(() =>
      docsSettings({ DOCS_RELEASE_SIGNATURES: signatureSums }),
    ).toThrow(/DOCS_RELEASE_SIGNATURES is set without DOCS_RELEASE/);
    for (const name of [
      'DOCS_RELEASE_SIGNER_IDENTITY',
      'DOCS_RELEASE_SIGNER_ISSUER',
    ])
      expect(() =>
        docsSettings({
          ...signedRelease,
          DOCS_RELEASE_SIGNATURES: '',
          [name]: 'https://x.example',
        }),
      ).toThrow(new RegExp(`${name} is set without DOCS_RELEASE_SIGNATURES`));
  });

  it("read the release's signatures.sha256 and the identity of its workflow", () => {
    expect(docsSettings(signedRelease).signatures).toEqual({
      trustedRoot: 'a'.repeat(64),
      bundles: {
        api: 'b'.repeat(64),
        backup: 'c'.repeat(64),
        editor: 'd'.repeat(64),
        embedder: 'e'.repeat(64),
        mcp: 'f'.repeat(64),
      },
      identity:
        'https://github.com/openfolia/openfolia/.github/workflows/images.yml@refs/tags/v1.2.3',
      issuer: GITHUB_ACTIONS_ISSUER,
    });
  });

  it('refuse a file list that is not the release signatures, and an identity or issuer that is unsafe', () => {
    for (const DOCS_RELEASE_SIGNATURES of [
      signatureSums.split('\n').slice(1).join('\n'),
      `${signatureSums}\n${'0'.repeat(64)}  compose.yaml`,
      signatureSums.replace('a'.repeat(64), 'a'.repeat(63)),
    ])
      expect(() =>
        docsSettings({ ...signedRelease, DOCS_RELEASE_SIGNATURES }),
      ).toThrow(/DOCS_RELEASE_SIGNATURES/);
    expect(() =>
      docsSettings({
        ...signedRelease,
        DOCS_RELEASE_SIGNER_IDENTITY: "https://x.example/a'$(id)'",
      }),
    ).toThrow(/DOCS_RELEASE_SIGNER_IDENTITY may hold only/);
    expect(() =>
      docsSettings({
        ...signedRelease,
        DOCS_RELEASE_SIGNER_ISSUER: 'http://issuer.example.com',
      }),
    ).toThrow(/DOCS_RELEASE_SIGNER_ISSUER must be an https/);
    for (const DOCS_RELEASE_SIGNER_ISSUER of [
      'https://issuer.example.com/',
      'https://Issuer.example.com',
    ])
      expect(() =>
        docsSettings({ ...signedRelease, DOCS_RELEASE_SIGNER_ISSUER }),
      ).toThrow(/must be written as the certificate names it/);
    // Not on github.com: the identity can't be derived, so it must be given.
    expect(() =>
      docsSettings({
        ...signedRelease,
        DOCS_REPOSITORY_URL: 'https://git.example.com/docs/openfolia',
        DOCS_IMAGES: 'ghcr.io/openfolia/openfolia',
      }),
    ).toThrow(/DOCS_RELEASE_SIGNER_IDENTITY must be set/);
  });
});

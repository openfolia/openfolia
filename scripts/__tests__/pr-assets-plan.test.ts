// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { ASSETS_BRANCH, RACE_RETRIES } from '@/scripts/pr-assets-github.mjs';
import {
  MAX_BYTES,
  assetName,
  collectImages,
  imageProblem,
  markdownLinks,
  parseArgs,
  runPrAssets,
} from '@/scripts/pr-assets-plan.mjs';

const PNG = Buffer.concat([
  Buffer.from('89504e470d0a1a0a', 'hex'),
  Buffer.from('rest'),
]);
const JPEG = Buffer.concat([
  Buffer.from('ffd8ffe0', 'hex'),
  Buffer.from('rest'),
]);
const REPO = 'acme/app';

/** A fake disk: `files` by path; listDir gives the names under a folder. */
function disk(files: Record<string, Buffer>) {
  return {
    readFile: (file: string) => {
      if (!(file in files)) throw new Error(`ENOENT ${file}`);
      return files[file];
    },
    listDir: (dir: string) =>
      Object.keys(files)
        .filter((file) => file.startsWith(`${dir}/`))
        .map((file) => file.slice(dir.length + 1)),
  };
}

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/**
 * A fake GitHub behind `gh api -X <method> <path> [--input -]`: the branch's head (null: no
 * branch), and how many ref updates lose a race first.
 */
function github({ head = null as string | null, races = 0 } = {}) {
  const calls: Call[] = [];
  let lost = 0;
  let n = 0;
  const gh = (args: string[], input?: string) => {
    expect(args.slice(0, 2)).toEqual(['api', '-X']);
    const [, , method, path] = args;
    const body = input === undefined ? undefined : JSON.parse(input);
    calls.push({ method, path, body });
    const answer = (value: unknown) => JSON.stringify(value);
    if (method === 'GET' && path.endsWith(`/git/ref/heads/${ASSETS_BRANCH}`)) {
      if (!head) throw new Error('gh api failed: Not Found (HTTP 404)');
      return answer({ object: { type: 'commit', sha: head } });
    }
    if (method === 'GET' && path.includes('/git/commits/'))
      return answer({ tree: { sha: 'tree0' } });
    if (method === 'POST' && path.endsWith('/git/blobs'))
      return answer({ sha: `blob${++n}` });
    if (method === 'POST' && path.endsWith('/git/trees'))
      return answer({ sha: `tree${++n}` });
    if (method === 'POST' && path.endsWith('/git/commits'))
      return answer({ sha: `commit${++n}` });
    if (
      path.endsWith('/git/refs') ||
      path.endsWith(`/git/refs/heads/${ASSETS_BRANCH}`)
    ) {
      if (lost < races) {
        lost++;
        head = `other${lost}`;
        throw new Error(
          'gh api failed: Update is not a fast forward (HTTP 422)',
        );
      }
      head = (body as { sha: string }).sha;
      return answer({});
    }
    throw new Error(`unexpected ${method} ${path}`);
  };
  return { gh, calls, head: () => head };
}

const run = (argv: string[], files: Record<string, Buffer>, hub = github()) =>
  runPrAssets(parseArgs(argv) as Parameters<typeof runPrAssets>[0], {
    gh: hub.gh,
    ...disk(files),
    currentRepo: () => REPO,
  });

describe('parseArgs', () => {
  it('takes the PR, then files and options', () => {
    expect(parseArgs(['12', 'a.png', '--dry-run', '--dir', 'shots'])).toEqual({
      help: false,
      pr: 12,
      files: ['a.png'],
      dir: 'shots',
      dryRun: true,
    });
    expect(parseArgs(['--help'])).toEqual({ help: true });
  });

  it('refuses no PR, no images named, an unknown option (another repo among them)', () => {
    expect(() => parseArgs([])).toThrow('No PR number');
    expect(() => parseArgs(['a.png'])).toThrow("the PR's number comes first");
    expect(() => parseArgs(['0', 'a.png'])).toThrow(
      "the PR's number comes first",
    );
    expect(() => parseArgs(['3'])).toThrow('Name the images');
    expect(() => parseArgs(['3', '--dry-run'])).toThrow('Name the images');
    expect(() => parseArgs(['3', 'a.png', '--force'])).toThrow(
      'Unknown option --force',
    );
    expect(() => parseArgs(['3', 'a.png', '--repo', 'o/r'])).toThrow(
      'Unknown option --repo',
    );
    expect(() => parseArgs(['3', '--dir'])).toThrow('--dir needs a value');
    expect(() => parseArgs(['3', '--dir', 'a', '--dir', 'b'])).toThrow(
      'One --dir',
    );
  });
});

describe('the images', () => {
  it('are images by their first bytes, under their own extension, not empty or huge', () => {
    expect(imageProblem('a.png', PNG)).toBeNull();
    expect(imageProblem('a.JPG', JPEG)).toBeNull();
    expect(imageProblem('.env', Buffer.from('SECRET=1'))).toMatch('not a PNG');
    expect(imageProblem('a.png', Buffer.from('SECRET=1'))).toMatch('not a PNG');
    expect(imageProblem('a.jpg', PNG)).toMatch('another extension');
    expect(imageProblem('a.png', Buffer.alloc(0))).toBe('empty');
    expect(
      imageProblem('a.png', Buffer.concat([PNG, Buffer.alloc(MAX_BYTES)])),
    ).toMatch('bigger');
  });

  it('get a plain name on the branch', () => {
    expect(assetName('.screenshots/En Protected (1).PNG')).toBe(
      'en-protected-1-.png',
    );
    expect(assetName('../../x/.hidden.png')).toBe('hidden.png');
  });

  it("are the named files and a named folder's images, and every bad file is refused at once", () => {
    const io = disk({
      '.screenshots/b.png': PNG,
      '.screenshots/a.png': PNG,
      '.screenshots/n.txt': PNG,
    });
    expect(
      collectImages({ pr: 4, files: [], dir: '.screenshots' }, io).map(
        (i) => i.path,
      ),
    ).toEqual(['pr-4/a.png', 'pr-4/b.png']);
    expect(
      collectImages({ pr: 4, files: ['.screenshots/b.png'], dir: null }, io),
    ).toHaveLength(1);
    // Named and in the folder: once.
    expect(
      collectImages(
        { pr: 4, files: ['.screenshots/b.png'], dir: '.screenshots' },
        io,
      ).map((i) => i.path),
    ).toEqual(['pr-4/b.png', 'pr-4/a.png']);
    const bad = disk({
      'x/a.png': PNG,
      'y/a.png': PNG,
      'k.png': Buffer.from('key'),
    });
    expect(() =>
      collectImages(
        { pr: 4, files: ['x/a.png', 'y/a.png', 'k.png'], dir: null },
        bad,
      ),
    ).toThrow(/both become a\.png[\s\S]*k\.png: not a PNG/);
    expect(() =>
      collectImages({ pr: 4, files: [], dir: 'none' }, disk({})),
    ).toThrow('No images');
  });
});

describe('runPrAssets', () => {
  it('writes nothing on a dry run', () => {
    const hub = github();
    const out = run(
      ['7', '--dry-run', '--dir', '.screenshots'],
      { '.screenshots/a.png': PNG },
      hub,
    ).join('\n');
    expect(hub.calls).toEqual([]);
    expect(out).toContain(
      `![a.png](https://github.com/${REPO}/blob/<commit>/pr-7/a.png?raw=true)`,
    );
  });

  it('starts the branch as an orphan when there is none, and links the commit', () => {
    const hub = github();
    const out = run(
      ['7', '--dir', '.screenshots'],
      { '.screenshots/a.png': PNG, '.screenshots/b.png': PNG },
      hub,
    );
    const writes = hub.calls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => `${c.method} ${c.path}`)).toEqual([
      `POST repos/${REPO}/git/blobs`,
      `POST repos/${REPO}/git/blobs`,
      `POST repos/${REPO}/git/trees`,
      `POST repos/${REPO}/git/commits`,
      `POST repos/${REPO}/git/refs`,
    ]);
    expect(writes[0].body).toEqual({
      content: PNG.toString('base64'),
      encoding: 'base64',
    });
    expect(writes[2].body).not.toHaveProperty('base_tree');
    expect(writes[3].body).toMatchObject({ parents: [] });
    expect(writes[4].body).toEqual({
      ref: `refs/heads/${ASSETS_BRANCH}`,
      sha: hub.head(),
    });
    expect(out.join('\n')).toContain(
      `![b.png](https://github.com/${REPO}/blob/${hub.head()}/pr-7/b.png?raw=true)`,
    );
  });

  it('adds to an existing branch with a fast-forward, never force, and only that ref', () => {
    const hub = github({ head: 'old' });
    run(['7', 'a.png'], { 'a.png': PNG }, hub);
    const refWrites = hub.calls.filter((c) => c.path.includes('/git/refs'));
    expect(refWrites).toEqual([
      {
        method: 'PATCH',
        path: `repos/${REPO}/git/refs/heads/${ASSETS_BRANCH}`,
        body: { sha: hub.head(), force: false },
      },
    ]);
    const tree = hub.calls.find((c) => c.path.endsWith('/git/trees'));
    expect(tree?.body).toMatchObject({ base_tree: 'tree0' });
    const commit = hub.calls.find(
      (c) => c.method === 'POST' && c.path.endsWith('/git/commits'),
    );
    expect(commit?.body).toMatchObject({ parents: ['old'] });
  });

  it('builds on the new head when another upload moved the branch, then gives up', () => {
    const hub = github({ head: 'old', races: 1 });
    run(['7', 'a.png'], { 'a.png': PNG }, hub);
    const commits = hub.calls.filter(
      (c) => c.method === 'POST' && c.path.endsWith('/git/commits'),
    );
    expect(
      commits.map((c) => (c.body as { parents: string[] }).parents),
    ).toEqual([['old'], ['other1']]);
    expect(hub.calls.filter((c) => c.path.endsWith('/git/blobs'))).toHaveLength(
      1,
    );

    const losing = github({ head: 'old', races: RACE_RETRIES + 1 });
    expect(() => run(['7', 'a.png'], { 'a.png': PNG }, losing)).toThrow(
      'not a fast forward',
    );
  });

  it('stops on any other GitHub failure', () => {
    const hub = github();
    const failing = {
      ...hub,
      gh: (args: string[], input?: string) => {
        if (args[3].endsWith('/git/trees'))
          throw new Error('gh api failed: (HTTP 500)');
        return hub.gh(args, input);
      },
    };
    expect(() => run(['7', 'a.png'], { 'a.png': PNG }, failing)).toThrow(
      'HTTP 500',
    );
    expect(hub.calls.some((c) => c.path.includes('/git/refs'))).toBe(false);
  });

  it('never retries a refused ref update that is no race', () => {
    const hub = github({ head: 'old' });
    const refusing = {
      ...hub,
      gh: (args: string[], input?: string) => {
        if (args[3].includes('/git/refs')) {
          throw new Error('gh api failed: Object does not exist (HTTP 422)');
        }
        return hub.gh(args, input);
      },
    };
    expect(() => run(['7', 'a.png'], { 'a.png': PNG }, refusing)).toThrow(
      'Object does not exist',
    );
    expect(
      hub.calls.filter((c) => c.path.endsWith('/git/commits')),
    ).toHaveLength(1);
  });

  it('links each image on github.com, pinned to a ref', () => {
    expect(
      markdownLinks('o/r', 'abc', [{ name: 'a.png', path: 'pr-1/a.png' }]),
    ).toBe('![a.png](https://github.com/o/r/blob/abc/pr-1/a.png?raw=true)');
  });
});

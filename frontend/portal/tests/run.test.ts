import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { replaceOutput } from '../build/run.ts';

/** The last step of a build: the new output takes the old one's place, or the old one stays. */
describe('replacing the output folder', () => {
  let root: string;
  let out: string;
  let next: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openfolia-portal-run-'));
    out = join(root, 'site');
    next = `${out}.next`;
    mkdirSync(out);
    writeFileSync(join(out, 'index.html'), 'old');
    mkdirSync(next);
    writeFileSync(join(next, 'index.html'), 'new');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('puts the new output in place and removes the old one', () => {
    replaceOutput(next, out);
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toBe('new');
    expect(existsSync(`${out}.old`)).toBe(false);
    expect(existsSync(next)).toBe(false);
  });

  it('writes a first output where there was none', () => {
    rmSync(out, { recursive: true });
    replaceOutput(next, out);
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toBe('new');
  });

  it('puts the old output back when the new one cannot be moved in', () => {
    const failing = (from: string, to: string) => {
      if (from === next) throw new Error('EXDEV: cannot move');
      renameSync(from, to);
    };
    expect(() => replaceOutput(next, out, failing)).toThrow('EXDEV');
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toBe('old');
    expect(existsSync(`${out}.old`)).toBe(false);
  });

  it('restores an output a failed run left at .old before replacing it, never deleting it', () => {
    rmSync(out, { recursive: true });
    mkdirSync(`${out}.old`);
    writeFileSync(join(`${out}.old`, 'index.html'), 'old');
    const failing = (from: string, to: string) => {
      if (from === next) throw new Error('EXDEV: cannot move');
      renameSync(from, to);
    };
    expect(() => replaceOutput(next, out, failing)).toThrow('EXDEV');
    expect(readFileSync(join(out, 'index.html'), 'utf8')).toBe('old');
  });
});

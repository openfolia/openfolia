import { Generation } from './generation';

describe('Generation', () => {
  it('keeps a read live until another starts', () => {
    const reads = new Generation();
    const first = reads.start();
    expect(first()).toBe(true);
    const second = reads.start();
    expect(first()).toBe(false);
    expect(second()).toBe(true);
  });

  it('ends every read started so far, and the next one is live again', () => {
    const reads = new Generation();
    const first = reads.start();
    const second = reads.start();
    reads.end();
    expect(first()).toBe(false);
    expect(second()).toBe(false);
    expect(reads.start()()).toBe(true);
  });

  it('never makes a stale read live again, however many generations follow', () => {
    const reads = new Generation();
    const old = reads.start();
    for (let i = 0; i < 5; i++) {
      reads.end();
      reads.start();
    }
    expect(old()).toBe(false);
  });

  it('keeps separate guards apart', () => {
    const a = new Generation();
    const b = new Generation();
    const read = a.start();
    b.end();
    b.start();
    expect(read()).toBe(true);
  });

  it('lets only the read started last write, whatever order the answers come in', async () => {
    const reads = new Generation();
    let cache: string | null = null;
    const answers: Record<string, (value: string) => void> = {};
    const read = (name: string) => {
      const live = reads.start();
      return new Promise<string>((resolve) => (answers[name] = resolve)).then(
        (value) => {
          if (live()) cache = value;
        },
      );
    };
    const first = read('first');
    const second = read('second');
    answers['second']?.('second');
    await second;
    answers['first']?.('first');
    await first;
    expect(cache).toBe('second');
  });

  it('keeps reads that join a generation live together, until it ends', () => {
    const reads = new Generation();
    const first = reads.join();
    const second = reads.join();
    expect(first()).toBe(true);
    expect(second()).toBe(true);
    reads.end();
    expect(first()).toBe(false);
    expect(second()).toBe(false);
    expect(reads.join()()).toBe(true);
  });
});

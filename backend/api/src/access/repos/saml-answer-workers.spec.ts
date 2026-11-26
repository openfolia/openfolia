import { Worker } from 'node:worker_threads';
import {
  SamlAnswerRefusedError,
  SamlAnswersBusyError,
  SamlAnswerWorkers,
} from './saml-answer-workers.js';
import type { AnswerConfig } from './saml-answer.js';

/**
 * A stand-in worker (#951): ready at once, then for each answer `then` (its body, with `answer`
 * and `send`): `stall` computes for ever, as an answer nobody bounded would.
 */
const stub = (then: string) => () =>
  new Worker(
    `const { parentPort } = require('node:worker_threads');
const send = (message) => parentPort.postMessage(message);
const stall = () => { for (;;) {} };
parentPort.on('message', (message) => {
  if (message.type !== 'check') return;
  const answer = message.answer;
  ${then}
});
send({ type: 'ready' });`,
    { eval: true },
  );

const CHECKED = "send({ type: 'checked', assertion: undefined });";
const config = {} as AnswerConfig;
const never = () => Promise.reject(new Error('Nothing is recorded here.'));

describe('SamlAnswerWorkers (#951)', () => {
  let workers: SamlAnswerWorkers | undefined;
  afterEach(() => workers?.close());

  it('refuses an answer that takes longer than the limit, in about the limit, and checks the next on a new worker', async () => {
    let started = 0;
    workers = new SamlAnswerWorkers(never, () => {
      started++;
      return stub(`if (answer === 'slow') stall(); ${CHECKED}`)();
    });
    workers.limitMs = 200;
    // Started, so the time is the answer's alone.
    await workers.check('fast', config, undefined);
    const start = performance.now();
    const refused: unknown = await workers
      .check('slow', config, undefined)
      .catch((error: unknown) => error);
    const took = performance.now() - start;
    expect(refused).toBeInstanceOf(SamlAnswerRefusedError);
    expect(refused).toMatchObject({
      status: false,
      message: 'Checking the answer took longer than 200 ms.',
    });
    expect(took).toBeGreaterThanOrEqual(195);
    expect(took).toBeLessThan(1_200);
    await expect(
      workers.check('fast', config, undefined),
    ).resolves.toBeUndefined();
    expect(started).toBe(2);
  });

  it('does not count the time the database takes to record the assertion', async () => {
    const recorded: [string, Date][] = [];
    workers = new SamlAnswerWorkers(
      async (key, until) => {
        recorded.push([key, until]);
        await new Promise((resolve) => setTimeout(resolve, 300));
        return true;
      },
      stub(`send({ type: 'record', key: 'k', until: 1000 });
parentPort.once('message', (reply) => send(reply.saved === true ? { type: 'checked', assertion: { local: 'Assertion' } } : { type: 'refused', status: false, why: 'not recorded' }));`),
    );
    workers.limitMs = 100;
    await expect(workers.check('a', config, undefined)).resolves.toEqual({
      local: 'Assertion',
    });
    expect(recorded).toEqual([['k', new Date(1000)]]);
  });

  it("rejects with the database's own error when the assertion cannot be recorded, never as a refusal", async () => {
    const down = new Error('The database is down.');
    workers = new SamlAnswerWorkers(
      () => Promise.reject(down),
      stub(`send({ type: 'record', key: 'k', until: 1000 });
parentPort.once('message', () => send({ type: 'refused', status: false, why: 'Error: The assertion could not be recorded.' }));`),
    );
    await expect(workers.check('a', config, undefined)).rejects.toBe(down);
  });

  it('passes on a refusal and whether it was the identity provider’s status', async () => {
    workers = new SamlAnswerWorkers(
      never,
      stub(
        "send({ type: 'refused', status: answer === 'status', why: 'Error: ' + answer });",
      ),
    );
    await expect(
      workers.check('status', config, undefined),
    ).rejects.toMatchObject({ status: true, message: 'Error: status' });
    await expect(workers.check('bad', config, undefined)).rejects.toMatchObject(
      { status: false, message: 'Error: bad' },
    );
  });

  it('refuses the answer whose worker ends with it, and checks the next on a new worker', async () => {
    workers = new SamlAnswerWorkers(
      never,
      stub(`if (answer === 'crash') process.exit(3); ${CHECKED}`),
    );
    await expect(
      workers.check('crash', config, undefined),
    ).rejects.toBeInstanceOf(SamlAnswerRefusedError);
    await expect(
      workers.check('fine', config, undefined),
    ).resolves.toBeUndefined();
  });

  it('checks two answers at once, and the rest as workers come free', async () => {
    workers = new SamlAnswerWorkers(
      never,
      stub(`setTimeout(() => { ${CHECKED} }, 100);`),
    );
    // Started first, so the time below is the answers'.
    await Promise.all([1, 2].map(() => workers!.check('a', config, undefined)));
    const start = performance.now();
    await Promise.all(
      [1, 2, 3, 4].map(() => workers!.check('a', config, undefined)),
    );
    const took = performance.now() - start;
    expect(took).toBeGreaterThanOrEqual(195);
    expect(took).toBeLessThan(400 + 1_000);
  });

  it('refuses answers past those that may wait, unchecked', async () => {
    workers = new SamlAnswerWorkers(never, stub('stall();'));
    const waiting = Array.from({ length: 64 }, () =>
      workers!.check('a', config, undefined).catch(() => undefined),
    );
    await expect(workers.check('a', config, undefined)).rejects.toBeInstanceOf(
      SamlAnswersBusyError,
    );
    await workers.close();
    await Promise.all(waiting);
  });

  it('rejects with why when no worker starts, rather than as a refusal', async () => {
    const broken = new Error('No worker here.');
    workers = new SamlAnswerWorkers(never, () => {
      throw broken;
    });
    await expect(workers.check('a', config, undefined)).rejects.toBe(broken);
  });

  const RECORDS = `send({ type: 'record', key: 'k', until: 1000 });
parentPort.once('message', () => send({ type: 'refused', status: false, why: 'Error: The assertion could not be recorded.' }));`;

  it('gives the database a bound of its own: past it an error, never a refusal', async () => {
    workers = new SamlAnswerWorkers(
      () => new Promise<boolean>(() => undefined),
      stub(RECORDS),
    );
    workers.recordLimitMs = 100;
    const failed: unknown = await workers
      .check('a', config, undefined)
      .catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(SamlAnswerRefusedError);
  });

  it("rejects with the database's error when the time runs out after it failed", async () => {
    const down = new Error('The database is down.');
    workers = new SamlAnswerWorkers(
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw down;
      },
      // Answers only long after the time left.
      stub(`send({ type: 'record', key: 'k', until: 1000 });
parentPort.once('message', () => setTimeout(() => send({ type: 'refused', status: false, why: 'late' }), 1000));`),
    );
    workers.limitMs = 50;
    await expect(workers.check('a', config, undefined)).rejects.toBe(down);
  });

  it('takes an answer the worker sent while the server was busy past the limit', async () => {
    workers = new SamlAnswerWorkers(never, stub(CHECKED));
    await workers.check('a', config, undefined);
    workers.limitMs = 20;
    const checked = workers.check('a', config, undefined);
    // The server's event loop held longer than the limit, the worker's answer already sent.
    const until = performance.now() + 1_000;
    while (performance.now() < until);
    await expect(checked).resolves.toBeUndefined();
  });

  it('takes an answer whose record the worker asked for while the server was busy past the limit', async () => {
    workers = new SamlAnswerWorkers(
      () => Promise.resolve(true),
      stub(`send({ type: 'record', key: 'k', until: 1000 });
parentPort.once('message', () => setTimeout(() => { ${CHECKED} }, 30));`),
    );
    await workers.check('a', config, undefined);
    workers.limitMs = 20;
    const checked = workers.check('a', config, undefined);
    const until = performance.now() + 1_000;
    while (performance.now() < until);
    await expect(checked).resolves.toBeUndefined();
  });

  it('serves those waiting with the workers left when one fails to start', async () => {
    let started = 0;
    workers = new SamlAnswerWorkers(never, () =>
      started++ === 1
        ? new Worker('process.exit(1);', { eval: true })
        : stub(`setTimeout(() => { ${CHECKED} }, 50);`)(),
    );
    // The first worker ready, then the second fails to start.
    await workers.check('a', config, undefined);
    await expect(
      Promise.all([1, 2, 3].map(() => workers!.check('a', config, undefined))),
    ).resolves.toEqual([undefined, undefined, undefined]);
    // At most one more start, as the first came free with answers still waiting.
    expect(started).toBeLessThanOrEqual(3);
  });

  it('rejects those waiting, rather than starting worker after worker, when none starts', async () => {
    let started = 0;
    workers = new SamlAnswerWorkers(never, () => {
      started++;
      return new Worker('process.exit(1);', { eval: true });
    });
    const failed = await Promise.all(
      [1, 2, 3].map(() =>
        workers!.check('a', config, undefined).catch((error: unknown) => error),
      ),
    );
    for (const error of failed) {
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(SamlAnswerRefusedError);
    }
    expect(started).toBe(2);
  });
});

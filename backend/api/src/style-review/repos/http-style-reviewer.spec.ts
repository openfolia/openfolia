import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { Logger } from '@nestjs/common';
import type { StyleReviewRequest } from '../core/style-reviewer.js';
import {
  HttpStyleReviewer,
  MAX_OUTPUT_TOKENS,
  MAX_RESPONSE_BYTES,
  proposalsOf,
  StyleReviewerError,
  SYSTEM_PROMPT,
} from './http-style-reviewer.js';

const KEY = 'sk-test-0123456789-very-secret';

const request: StyleReviewRequest = {
  lang: 'en',
  styleGuide: 'Use short words.',
  units: [
    {
      blockId: 'p1',
      kind: 'paragraph',
      parts: [{ field: 'content', text: 'Utilize it. Then utilize it again.' }],
    },
    {
      blockId: 's',
      kind: 'section',
      parts: [{ field: 'title', text: 'Setup' }],
    },
  ],
};

/** A local stand-in for a chat-completions endpoint. */
interface Stub {
  url: string;
  received: { headers: IncomingMessage['headers']; body: string }[];
  handle: (req: IncomingMessage, res: ServerResponse) => void;
  close: () => Promise<void>;
}

async function stub(): Promise<Stub> {
  const state: Stub = {
    url: '',
    received: [],
    handle: (_req, res) => res.end('{}'),
    close: async () => undefined,
  };
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
    req.on('end', () => {
      state.received.push({ headers: req.headers, body });
      state.handle(req, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  state.url = `http://127.0.0.1:${port}/v1/chat/completions`;
  state.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return state;
}

const answer = (content: string) =>
  JSON.stringify({ choices: [{ message: { role: 'assistant', content } }] });

describe('HttpStyleReviewer', () => {
  let s: Stub;
  beforeEach(async () => {
    s = await stub();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await s.close();
  });

  const reviewer = (apiKey: string | undefined = KEY) =>
    new HttpStyleReviewer({ url: s.url, model: 'some-model', apiKey });

  it('posts the text as data with the model and the key, and maps quotes to ranges', async () => {
    s.handle = (_req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        answer(
          '```json\n' +
            JSON.stringify({
              suggestions: [
                {
                  blockId: 'p1',
                  field: 'content',
                  original: 'utilize',
                  occurrence: 1,
                  message: 'Plainer.',
                  replacement: 'use',
                },
                {
                  blockId: 's',
                  field: 'title',
                  original: 'Setup',
                  message: 'Fine?',
                  replacement: null,
                },
                {
                  blockId: 'p1',
                  field: 'content',
                  original: 'nowhere',
                  message: 'x',
                },
              ],
            }) +
            '\n```',
        ),
      );
    };
    const proposals = await reviewer().review(
      request,
      new AbortController().signal,
    );
    expect(proposals).toEqual([
      {
        blockId: 'p1',
        field: 'content',
        start: 17,
        end: 24,
        message: 'Plainer.',
        replacement: 'use',
      },
      {
        blockId: 's',
        field: 'title',
        start: 0,
        end: 5,
        message: 'Fine?',
        replacement: undefined,
      },
      {
        blockId: 'p1',
        field: 'content',
        start: -1,
        end: -1,
        message: 'x',
        replacement: undefined,
      },
    ]);
    const [sent] = s.received;
    expect(sent?.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(sent?.headers['content-type']).toBe('application/json');
    const body = JSON.parse(sent?.body ?? '{}');
    expect(body).toMatchObject({
      model: 'some-model',
      temperature: 0,
      max_tokens: MAX_OUTPUT_TOKENS,
    });
    expect(body.messages[0]).toEqual({
      role: 'system',
      content: SYSTEM_PROMPT,
    });
    expect(JSON.parse(body.messages[1].content)).toEqual({
      language: 'en',
      styleGuide: 'Use short words.',
      units: [
        {
          blockId: 'p1',
          field: 'content',
          text: 'Utilize it. Then utilize it again.',
        },
        { blockId: 's', field: 'title', text: 'Setup' },
      ],
    });
  });

  it('sends no Authorization header without a key', async () => {
    s.handle = (_req, res) => res.end(answer('{"suggestions": []}'));
    await expect(
      reviewer('').review(request, new AbortController().signal),
    ).resolves.toEqual([]);
    expect(s.received[0]?.headers).not.toHaveProperty('authorization');
  });

  it('fails on an error status without the key, the URL or the answer in the error or the log', async () => {
    const warn = vi
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    s.handle = (_req, res) => {
      res.statusCode = 401;
      res.end(`{"error": "bad key ${KEY}"}`);
    };
    const failed = reviewer().review(request, new AbortController().signal);
    await expect(failed).rejects.toBeInstanceOf(StyleReviewerError);
    const error = (await failed.catch((e: unknown) => e)) as Error;
    expect(error.message).toBe('The style review endpoint answered 401.');
    const logged = JSON.stringify(warn.mock.calls);
    for (const text of [error.message, error.stack ?? '', logged]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(s.url);
    }
  });

  it('refuses a redirect, so the key never goes to another host', async () => {
    const other = await stub();
    try {
      s.handle = (_req, res) => {
        res.statusCode = 307;
        res.setHeader('Location', other.url);
        res.end();
      };
      await expect(
        reviewer().review(request, new AbortController().signal),
      ).rejects.toBeInstanceOf(StyleReviewerError);
      expect(other.received).toEqual([]);
    } finally {
      await other.close();
    }
  });

  it('refuses an answer past MAX_RESPONSE_BYTES, also without a length', async () => {
    s.handle = (_req, res) => {
      res.write('{"choices": "');
      res.end('x'.repeat(MAX_RESPONSE_BYTES));
    };
    await expect(
      reviewer().review(request, new AbortController().signal),
    ).rejects.toThrow('too large');
  });

  it('reads the JSON of an answer with braces in prose around it', async () => {
    s.handle = (_req, res) =>
      res.end(
        answer(
          'Here: ```json\n{"suggestions": []}\n``` Note: {product} is an attribute.',
        ),
      );
    await expect(
      reviewer().review(request, new AbortController().signal),
    ).resolves.toEqual([]);
  });

  it('fails on an answer that is not as asked', async () => {
    for (const body of [
      'not json',
      '{"choices": []}',
      answer('no json here'),
      answer('{"other": 1}'),
    ]) {
      s.handle = (_req, res) => res.end(body);
      await expect(
        reviewer().review(request, new AbortController().signal),
      ).rejects.toBeInstanceOf(StyleReviewerError);
    }
  });

  it('stops when the signal aborts', async () => {
    s.handle = () => undefined; // never answers
    const controller = new AbortController();
    const review = reviewer().review(request, controller.signal);
    setTimeout(() => controller.abort(), 20);
    await expect(review).rejects.toThrow('cut off');
  });
});

describe('proposalsOf', () => {
  const units = [{ blockId: 'p', field: 'content', text: 'a b a b a' }];

  it('finds the n-th occurrence, the first by default, and nothing for a bad one', () => {
    const at = (s: Record<string, unknown>) =>
      proposalsOf(
        JSON.stringify({
          suggestions: [{ blockId: 'p', field: 'content', message: 'm', ...s }],
        }),
        units,
      )[0];
    expect(at({ original: 'a' })).toMatchObject({ start: 0, end: 1 });
    expect(at({ original: 'a', occurrence: 3 })).toMatchObject({
      start: 8,
      end: 9,
    });
    // Counted without overlap.
    expect(
      proposalsOf(
        JSON.stringify({
          suggestions: [
            {
              blockId: 'p',
              field: 'content',
              message: 'm',
              original: 'aa',
              occurrence: 2,
            },
          ],
        }),
        [{ blockId: 'p', field: 'content', text: 'aaaa' }],
      )[0],
    ).toMatchObject({ start: 2, end: 4 });
    expect(at({ original: 'a', occurrence: 4 })).toMatchObject({ start: -1 });
    expect(at({ original: 'a', occurrence: 0 })).toMatchObject({ start: -1 });
    expect(at({ original: '' })).toMatchObject({ start: -1 });
    expect(at({ original: 'a', blockId: 'q' })).toMatchObject({ start: -1 });
  });

  it('skips what is no object and keeps at most 1,000', () => {
    const many = Array.from({ length: 1_500 }, () => ({
      blockId: 'p',
      field: 'content',
      original: 'a',
      message: 'm',
    }));
    expect(
      proposalsOf(
        JSON.stringify({ suggestions: [1, null, 'x', ...many] }),
        units,
      ),
    ).toHaveLength(997);
  });
});

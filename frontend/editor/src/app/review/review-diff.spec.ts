import type { Schema } from '../api';
import {
  diffText,
  inlineDetailChanges,
  inlineDetails,
  inlineText,
  tokens,
  unitsOf,
} from './review-diff';

type Block = Schema<'Block'>;

const p = (id: string, text: string): Block => ({
  type: 'paragraph',
  id,
  content: [{ type: 'text', text }],
});

describe('diffText', () => {
  it('keeps the text when nothing changed', () => {
    expect(diffText('Plug in.', 'Plug in.')).toEqual([
      { op: 'same', text: 'Plug in.' },
    ]);
    expect(diffText('', '')).toEqual([]);
  });

  it('marks the words replaced, the old before the new', () => {
    expect(
      diffText(
        'Request it by e-mail from support.',
        'Request it in the portal.',
      ),
    ).toEqual([
      { op: 'same', text: 'Request it ' },
      { op: 'del', text: 'by e-mail from support' },
      { op: 'ins', text: 'in the portal' },
      { op: 'same', text: '.' },
    ]);
  });

  it('gives back both texts exactly', () => {
    const before = 'One, two  three.';
    const after = 'One, four three!';
    const segments = diffText(before, after);
    const side = (op: 'del' | 'ins') =>
      segments
        .filter((s) => s.op === 'same' || s.op === op)
        .map((s) => s.text)
        .join('');
    expect(side('del')).toBe(before);
    expect(side('ins')).toBe(after);
  });

  it('replaces a very long text whole rather than comparing word by word', () => {
    const before = 'a '.repeat(600);
    const after = 'b '.repeat(600);
    expect(diffText(before, after)).toEqual([
      { op: 'del', text: before },
      { op: 'ins', text: after },
    ]);
  });

  it('splits words in any script', () => {
    expect(tokens('Grüße, 中文!')).toEqual(['Grüße', ',', ' ', '中文', '!']);
  });
});

describe('unitsOf', () => {
  it('shows an attachment by its facts', () => {
    const attachment = (fileName: string, size: number): Block => ({
      type: 'attachment',
      id: 'f1',
      asset: `sha256:${'a'.repeat(64)}`,
      name: 'Settings',
      description: 'For a quick start.',
      fileName,
      mediaType: 'application/zip',
      size,
    });
    expect(unitsOf([attachment('settings.zip', 1200)])).toEqual([
      {
        id: 'f1',
        kind: 'attachment',
        depth: 0,
        text: 'Settings · settings.zip · application/zip · 1200 B · For a quick start.',
        detail: `sha256:${'a'.repeat(64)}`,
      },
    ]);
  });

  it('shows a page break as a unit without text', () => {
    const pageBreak: Block = { type: 'pageBreak', id: 'pb' };
    expect(unitsOf([pageBreak])).toEqual([
      { id: 'pb', kind: 'pageBreak', depth: 0, text: '' },
    ]);
  });

  it('lists every block, item and step by its ID, containers before what they hold', () => {
    const blocks: Block[] = [
      {
        type: 'section',
        id: 's1',
        title: [{ type: 'text', text: 'Charging' }],
        blocks: [
          p('p1', 'Plug in.'),
          {
            type: 'list',
            id: 'l1',
            ordered: false,
            items: [
              {
                id: 'i1',
                content: [{ type: 'text', text: 'Cable' }],
                blocks: [],
              },
            ],
          },
        ],
      },
      {
        type: 'safety',
        id: 'w1',
        severity: 'warning',
        hazard: [{ type: 'text', text: 'Hot surface' }],
        symbols: [],
        blocks: [p('p2', 'Wait.')],
      },
    ];
    expect(unitsOf(blocks).map((u) => [u.id, u.kind, u.depth, u.text])).toEqual(
      [
        ['s1', 'heading', 0, 'Charging'],
        ['p1', 'paragraph', 1, 'Plug in.'],
        ['i1', 'item', 1, 'Cable'],
        ['w1', 'safety', 0, 'Hot surface'],
        ['p2', 'paragraph', 1, 'Wait.'],
      ],
    );
  });

  it('gives each heading its level: 1 at the top, one more in each section', () => {
    const section = (id: string, ...blocks: Block[]): Block => ({
      type: 'section',
      id,
      title: [{ type: 'text', text: id }],
      blocks,
    });
    const units = unitsOf([
      section('a', section('b', section('c'))),
      section('d'),
    ]);
    expect(units.map((u) => [u.id, u.level])).toEqual([
      ['a', 1],
      ['b', 2],
      ['c', 3],
      ['d', 1],
    ]);
  });

  it('reads inline content as plain text', () => {
    expect(
      inlineText([
        { type: 'text', text: 'Press ', marks: [{ type: 'strong' }] },
        { type: 'kbd', keys: ['Ctrl', 'S'] },
        { type: 'text', text: ' on ' },
        { type: 'attribute', name: 'product' },
      ]),
    ).toBe('Press Ctrl+S on {product}');
  });
});

describe('inlineDetails', () => {
  it('lists what the words carry: marked runs, links with their address, atoms', () => {
    expect(
      inlineDetails([
        { type: 'text', text: 'Press ', marks: [{ type: 'strong' }] },
        {
          type: 'text',
          text: 'here',
          marks: [
            { type: 'strong' },
            { type: 'link', href: 'https://a.example' },
          ],
        },
        { type: 'text', text: ' or ' },
        { type: 'kbd', keys: ['Ctrl', 'S'] },
        { type: 'attribute', name: 'product' },
        { type: 'xref', module: 'm', block: 'b' },
      ] as never),
    ).toEqual([
      { kind: 'strong', text: 'Press here' },
      { kind: 'link', text: 'here', target: 'https://a.example' },
      { kind: 'kbd', text: 'Ctrl+S' },
      { kind: 'attribute', text: 'product' },
      { kind: 'xref', text: 'm#b' },
    ]);
  });

  it('says what one side has and the other has not: a new address is one removed, one added', () => {
    const link = (href: string) => [
      { type: 'text', text: 'docs', marks: [{ type: 'link', href }] },
    ];
    expect(
      inlineDetailChanges(
        inlineDetails(link('https://old.example') as never),
        inlineDetails(link('https://new.example') as never),
      ),
    ).toEqual({
      removed: [{ kind: 'link', text: 'docs', target: 'https://old.example' }],
      added: [{ kind: 'link', text: 'docs', target: 'https://new.example' }],
    });
    // Words changed under the same bold, or a link's text with its address kept: no detail.
    const bold = (text: string) => [
      { type: 'text', text, marks: [{ type: 'strong' }] },
    ];
    expect(
      inlineDetailChanges(
        inlineDetails(bold('Press the button') as never),
        inlineDetails(bold('Press the red button') as never),
      ),
    ).toEqual({ added: [], removed: [] });
    // Another attribute is a change, though neither has a target.
    expect(
      inlineDetailChanges(
        inlineDetails([{ type: 'attribute', name: 'a' }] as never),
        inlineDetails([{ type: 'attribute', name: 'b' }] as never),
      ),
    ).toEqual({
      removed: [{ kind: 'attribute', text: 'a' }],
      added: [{ kind: 'attribute', text: 'b' }],
    });
    const same = inlineDetails(link('https://a.example') as never);
    expect(inlineDetailChanges(same, same)).toEqual({ added: [], removed: [] });
  });
});

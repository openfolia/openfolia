import { connectClient, paged, stubContext } from '../../tests/stub-api.js';

describe('list_variants', () => {
  it('lists the variant attributes with their values', async () => {
    const context = stubContext();
    context.api.set(
      '/variants',
      paged([
        {
          type: 'VariantAttribute',
          id: 'model',
          attributes: {
            kind: 'enum',
            label: 'Model',
            values: [
              { id: 'large', label: 'Large' },
              { id: 'old', label: 'Old', archived: true },
            ],
          },
        },
        {
          type: 'VariantAttribute',
          id: 'software',
          attributes: { kind: 'version', label: 'Software' },
        },
      ]),
    );
    const mcp = await connectClient(context);
    const { structured } = await mcp.call('list_variants', { ref: 'v1' });
    expect(structured).toMatchObject({
      ref: 'v1',
      attributes: [
        {
          id: 'model',
          kind: 'enum',
          label: 'Model',
          values: [
            { id: 'large', label: 'Large', archived: false },
            { id: 'old', label: 'Old', archived: true },
          ],
        },
        { id: 'software', kind: 'version', label: 'Software' },
      ],
    });
    expect(context.api.callsTo('/variants')[0]).toMatchObject({
      ref: 'v1',
      'page[number]': '1',
      'page[size]': '50',
    });
    await mcp.close();
  });
});

describe('list_variants with labels per language (#731)', () => {
  it('gives the source language’s label, and every language’s', async () => {
    const context = stubContext();
    context.api.set(
      '/variants',
      paged([
        {
          type: 'VariantAttribute',
          id: 'market',
          attributes: {
            kind: 'enum',
            label: { en: 'Market', de: 'Markt' },
            values: [{ id: 'eu', label: 'EU' }],
          },
        },
      ]),
    );
    const mcp = await connectClient(context);
    const { structured } = await mcp.call('list_variants', { ref: 'v1' });
    expect(structured).toMatchObject({
      attributes: [
        {
          id: 'market',
          label: 'Market',
          labels: { en: 'Market', de: 'Markt' },
          values: [{ id: 'eu', label: 'EU', archived: false }],
        },
      ],
    });
    await mcp.close();
  });
});

describe('list_releases', () => {
  it('lists the releases, marking a withdrawn one', async () => {
    const context = stubContext();
    const mcp = await connectClient(context);
    const { structured } = await mcp.call('list_releases', {
      product: 'tugger',
    });
    expect(context.api.callsTo('/releases').at(-1)).toMatchObject({
      'filter[product]': 'tugger',
      'page[size]': '50',
    });
    expect(structured['releases']).toEqual([
      expect.objectContaining({ tag: 'v1', withdrawn: null }),
      expect.objectContaining({
        tag: 'v0',
        withdrawn: {
          at: '2026-01-02T00:00:00.000Z',
          reason: 'Wrong torque values.',
        },
      }),
    ]);
    await mcp.close();
  });
});

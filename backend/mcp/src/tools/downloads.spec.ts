import { connectClient, paged, stubContext } from '../../tests/stub-api.js';

const release = {
  id: 'r2',
  tag: 'release/tugger/2.0',
  revision: '2.0',
  publishedAt: '2026-03-01T00:00:00.000Z',
};

describe('list_downloads', () => {
  it('lists the downloads with their facts, filtered as asked', async () => {
    const context = stubContext();
    context.api.set(
      '/downloads',
      paged([
        {
          type: 'Download',
          id: 'attachment:tugger:datasheet:sheet:en',
          attributes: {
            kind: 'attachment',
            product: 'tugger',
            lang: 'en',
            name: 'Datasheet',
            description: 'Technical data',
            fileName: 'datasheet.pdf',
            mediaType: 'application/pdf',
            size: 1234,
            sha256: 'a'.repeat(64),
            moduleId: 'datasheet',
            blockId: 'sheet',
            manualId: null,
            variant: null,
            release,
          },
        },
      ]),
    );
    const mcp = await connectClient(context);
    const { structured } = await mcp.call('list_downloads', {
      product: 'tugger',
      kind: 'attachment',
      query: 'data',
    });
    expect(context.api.callsTo('/downloads').at(-1)).toMatchObject({
      'filter[product]': 'tugger',
      'filter[kind]': 'attachment',
      'filter[q]': 'data',
      'page[size]': '50',
    });
    expect(structured).toMatchObject({
      total: 1,
      nextCursor: null,
      downloads: [
        {
          id: 'attachment:tugger:datasheet:sheet:en',
          name: 'Datasheet',
          sha256: 'a'.repeat(64),
          release: { tag: 'release/tugger/2.0', revision: '2.0' },
        },
      ],
    });
    await mcp.close();
  });
});

describe('list_download_versions', () => {
  it('lists a download’s versions with their change notes', async () => {
    const context = stubContext();
    const path = `/downloads/${encodeURIComponent('attachment:tugger:datasheet:sheet:en')}/versions`;
    context.api.set(
      path,
      paged([
        {
          type: 'DownloadVersion',
          id: 'r2',
          attributes: {
            state: 'current',
            sha256: 'b'.repeat(64),
            size: 10,
            mediaType: 'application/pdf',
            fileName: 'datasheet.pdf',
            release,
            changeNote: { notes: 'New values.', description: 'Technical data' },
          },
        },
      ]),
    );
    const mcp = await connectClient(context);
    const { structured } = await mcp.call('list_download_versions', {
      id: 'attachment:tugger:datasheet:sheet:en',
    });
    expect(structured).toMatchObject({
      versions: [
        {
          state: 'current',
          notes: 'New values.',
          description: 'Technical data',
          release: { revision: '2.0' },
        },
      ],
    });
    await mcp.close();
  });
});

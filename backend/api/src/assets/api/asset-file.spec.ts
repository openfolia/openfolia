import { attachmentDisposition } from './asset-file.js';

describe('attachmentDisposition', () => {
  it('lets nothing of the name reach the header unencoded', () => {
    expect(attachmentDisposition('a "b";\r\nc%.zip')).toBe(
      `attachment; filename="a _b____c_.zip"; filename*=UTF-8''a%20%22b%22%3B%0D%0Ac%25.zip`,
    );
    expect(attachmentDisposition("it's (1)*.zip")).toBe(
      `attachment; filename="it's (1)*.zip"; filename*=UTF-8''it%27s%20%281%29%2A.zip`,
    );
  });

  it('encodes a lone surrogate instead of throwing', () => {
    expect(attachmentDisposition('\ud800.zip')).toBe(
      `attachment; filename="_.zip"; filename*=UTF-8''%EF%BF%BD.zip`,
    );
  });
});

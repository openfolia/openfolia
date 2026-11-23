import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The two OpenAPI documents to download (#618): `/openapi/delivery.yaml`, `/openapi/delivery.json`,
 * `/openapi/management.yaml` and `/openapi/management.json`, the documents the reference pages are
 * made from (`scripts/generate.mjs`), with the API's address as their server. They import into
 * Postman, Insomnia or Bruno.
 */
export const revalidate = false;
export const dynamicParams = false;

const FILES = ['delivery', 'management'].flatMap((api) => [
  `${api}.yaml`,
  `${api}.json`,
]);

export function generateStaticParams() {
  return FILES.map((file) => ({ file }));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ file: string }> },
) {
  const { file } = await params;
  if (!FILES.includes(file)) return new Response('Not found', { status: 404 });
  return new Response(
    readFileSync(join(process.cwd(), 'generated/openapi', file), 'utf8'),
    {
      headers: {
        'Content-Type': file.endsWith('.yaml')
          ? 'application/yaml; charset=utf-8'
          : 'application/json; charset=utf-8',
      },
    },
  );
}

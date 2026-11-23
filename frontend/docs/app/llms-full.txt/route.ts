import { docsLlms } from '@/lib/llms';

/** Every page's text in one file, for language models (#423). */
export const revalidate = false;

export async function GET() {
  return new Response(await docsLlms.full('en'), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

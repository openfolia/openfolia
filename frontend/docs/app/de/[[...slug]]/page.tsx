import { DocsRoute, docsMetadata, docsParams } from '@/components/docs-page';

type Props = { params: Promise<{ slug?: string[] }> };

export default async function Page({ params }: Props) {
  const { slug } = await params;
  return <DocsRoute lang="de" slug={slug} />;
}

export function generateStaticParams() {
  return docsParams('de');
}

export async function generateMetadata({ params }: Props) {
  const { slug } = await params;
  return docsMetadata('de', slug);
}

export const dynamicParams = false;

import type { Metadata } from 'next';
import { Viewer } from '@/components/Viewer';

interface Props {
  params: Promise<{ owner: string; repo: string }>;
  searchParams: Promise<{ ref?: string; path?: string; tests?: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { owner, repo } = await params;
  return { title: `${owner}/${repo} · Code Universe` };
}

export default async function UniversePage({ params, searchParams }: Props) {
  const { owner, repo } = await params;
  const { ref, path, tests } = await searchParams;
  return <Viewer repo={`${owner}/${repo}`} gitRef={ref} path={path} tests={tests === '1'} />;
}

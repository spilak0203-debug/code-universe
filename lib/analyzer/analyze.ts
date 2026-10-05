import type { AnalyzeEvent, AnalyzeOptions, CodeGraph } from '../graph/types';
import { buildGraph } from './build';
import { downloadRepo, repoRef, resolveSha, type RepoSpec } from './github';

type Emit = (event: AnalyzeEvent) => void;

interface CacheEntry {
  graph: CodeGraph;
  expires: number;
}

/** Small in-process LRU. Results keyed by commit sha never go stale; branch refs expire. */
class GraphCache {
  private readonly map = new Map<string, CacheEntry>();
  constructor(private readonly capacity: number) {}

  get(key: string): CodeGraph | undefined {
    const hit = this.map.get(key);
    if (!hit) return undefined;
    if (hit.expires < Date.now()) {
      this.map.delete(key);
      return undefined;
    }
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.graph;
  }

  set(key: string, graph: CodeGraph, ttlMs: number): void {
    this.map.delete(key);
    this.map.set(key, { graph, expires: Date.now() + ttlMs });
    while (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value!);
  }
}

const globalCache = globalThis as unknown as { __codeUniverseCache?: GraphCache };
const cache = (globalCache.__codeUniverseCache ??= new GraphCache(10));

/** Bump whenever analyzer output changes so cached graphs from older code are not served. */
const ANALYZER_VERSION = 5;

const cacheKey = (spec: RepoSpec, rev: string, opts: AnalyzeOptions) =>
  `v${ANALYZER_VERSION}:${spec.owner}/${spec.repo}@${rev}:${spec.subdir}:${opts.includeTests ? 't' : ''}:${opts.maxFiles}`.toLowerCase();

const HOUR = 3_600_000;

export async function analyzeRepository(
  spec: RepoSpec,
  options: AnalyzeOptions,
  emit: Emit,
  signal?: AbortSignal,
): Promise<{ graph: CodeGraph; cached: boolean }> {
  emit({ type: 'progress', stage: 'resolve', message: `Locating ${spec.owner}/${spec.repo}` });
  const sha = await resolveSha(spec);
  const preKey = cacheKey(spec, sha ?? spec.ref, options);
  const hit = cache.get(preKey);
  if (hit) return { graph: hit, cached: true };

  const t0 = Date.now();
  emit({ type: 'progress', stage: 'download', message: 'Downloading archive', done: 0 });
  const download = await downloadRepo(
    spec,
    sha,
    options,
    (p) =>
      emit(
        p.via === 'archive'
          ? { type: 'progress', stage: 'download', message: `Streaming archive · ${(p.bytes / 1048576).toFixed(1)} MB · ${p.files} source files` }
          : { type: 'progress', stage: 'download', message: `Fetching source files · ${(p.bytes / 1048576).toFixed(1)} MB`, done: p.files, total: p.total },
      ),
    signal,
  );
  const downloadMs = Date.now() - t0;

  const graph = await buildGraph(
    {
      sources: download.sources,
      configs: download.configs,
      repo: repoRef(spec, download.sha),
      options,
      skipped: download.skipped,
      downloadBytes: download.bytes,
      downloadMs,
      semanticBudgetMs: Number(process.env.SEMANTIC_BUDGET_MS) || 25_000,
    },
    emit,
  );

  const pinned = download.sha ?? sha;
  cache.set(preKey, graph, sha ? 24 * HOUR : HOUR / 6);
  if (pinned && pinned !== sha) cache.set(cacheKey(spec, pinned, options), graph, 24 * HOUR);
  return { graph, cached: false };
}

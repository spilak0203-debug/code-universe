import { analyzeRepository } from '@/lib/analyzer/analyze';
import { normalizeSubdir, parseRepoInput, UserFacingError, type RepoSpec } from '@/lib/analyzer/github';
import { DEFAULT_ANALYZE_OPTIONS, type AnalyzeEvent } from '@/lib/graph/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Each analysis holds a full TypeScript program in memory; don't run many at once. */
const MAX_CONCURRENT = 2;
let running = 0;
const waiters: (() => void)[] = [];

async function acquire(onWait: () => void): Promise<() => void> {
  if (running >= MAX_CONCURRENT) {
    onWait();
    await new Promise<void>((resolve) => waiters.push(resolve));
  }
  running++;
  return () => {
    running--;
    waiters.shift()?.();
  };
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const encoder = new TextEncoder();
  const line = (event: AnalyzeEvent) => encoder.encode(`${JSON.stringify(event)}\n`);
  const headers = {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    // no-transform keeps proxies/compression from buffering the progress stream.
    'Cache-Control': 'no-store, no-transform',
    'X-Accel-Buffering': 'no',
  };

  let spec: RepoSpec;
  try {
    spec = parseRepoInput(params.get('repo') ?? '');
    const ref = params.get('ref');
    const path = params.get('path');
    if (ref) spec.ref = ref;
    if (path) spec.subdir = normalizeSubdir(path);
  } catch (err) {
    return new Response(line({ type: 'error', message: (err as Error).message }), { status: 400, headers });
  }

  const options = {
    ...DEFAULT_ANALYZE_OPTIONS,
    includeTests: params.get('tests') === '1',
  };

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (event: AnalyzeEvent) => {
        if (closed) return;
        try {
          controller.enqueue(line(event));
        } catch {
          closed = true;
        }
      };
      const release = await acquire(() =>
        send({ type: 'progress', stage: 'resolve', message: 'Waiting for a free analyzer slot' }),
      );
      try {
        const { graph, cached } = await analyzeRepository(spec, options, send, request.signal);
        send({ type: 'result', graph, cached });
      } catch (err) {
        const message =
          err instanceof UserFacingError
            ? err.message
            : `Analysis failed: ${err instanceof Error ? err.message : String(err)}`;
        if (!(err instanceof UserFacingError)) console.error('[analyze]', err);
        send({ type: 'error', message });
      } finally {
        release();
        if (!closed) controller.close();
      }
    },
  });

  return new Response(stream, { headers });
}

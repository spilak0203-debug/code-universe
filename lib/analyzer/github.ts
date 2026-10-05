import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import type { RepoRef } from '../graph/types';
import { TarStreamParser } from './tar';
import { classifyPath, looksGenerated, MAX_CONFIG_BYTES, MAX_FILE_BYTES, rankForTruncation } from './filters';

export { UserFacingError, parseRepoInput, normalizeSubdir, type RepoSpec } from '../repoInput';
import { UserFacingError, type RepoSpec } from '../repoInput';

function authHeaders(): Record<string, string> {
  const token = process.env.GITHUB_TOKEN;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * Resolve the commit sha behind a ref without spending REST API quota:
 * github.com/<o>/<r>/archive/HEAD.tar.gz redirects to codeload with the sha in the path.
 * Branch/tag refs redirect to `refs/heads/...`, so for those the sha only becomes known
 * from the tarball's pax header.
 */
export async function resolveSha(spec: RepoSpec): Promise<string | null> {
  if (/^[0-9a-f]{40}$/i.test(spec.ref)) return spec.ref.toLowerCase();
  const url = `https://github.com/${spec.owner}/${spec.repo}/archive/${encodeURIComponent(spec.ref)}.tar.gz`;
  const res = await fetch(url, { method: 'HEAD', redirect: 'manual', headers: authHeaders() });
  if (res.status === 404) {
    throw new UserFacingError(
      spec.ref === 'HEAD'
        ? `Repository ${spec.owner}/${spec.repo} was not found (or is private).`
        : `Ref "${spec.ref}" was not found in ${spec.owner}/${spec.repo}.`,
    );
  }
  const location = res.headers.get('location') ?? '';
  const match = /\/tar\.gz\/([0-9a-f]{40})$/i.exec(location);
  return match ? match[1].toLowerCase() : null;
}

export interface DownloadedRepo {
  /** Repo-relative path (relative to subdir) → file contents. */
  sources: Map<string, string>;
  configs: Map<string, string>;
  sha: string | null;
  bytes: number;
  /** Source files dropped for size/generated reasons. */
  skipped: number;
}

export interface DownloadProgress {
  /** 'archive' = streaming the tarball; 'files' = fetching individual files listed by the tree API. */
  via: 'archive' | 'files';
  bytes: number;
  files: number;
  total?: number;
}

export interface DownloadOptions {
  includeTests: boolean;
  maxFiles: number;
}

const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;

class ArchiveTooLargeError extends UserFacingError {}
class TreeUnavailableError extends Error {}

/**
 * Fetch the analyzable files of a repo.
 *
 * Whole repos stream through the tarball (one request, no API quota). A tarball
 * can't be cut by directory, so for subdirectory requests we list the tree with
 * one REST call and pick the cheaper strategy: stream the whole archive, or pull
 * only the selected sources from raw.githubusercontent.com in parallel (the only
 * option when assets bloat the archive past the size limit, e.g. three.js).
 */
export async function downloadRepo(
  spec: RepoSpec,
  sha: string | null,
  options: DownloadOptions,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<DownloadedRepo> {
  let tree: TreeListing | null = null;
  const listing = async () => {
    try {
      return (tree ??= await listTree(spec, sha, signal));
    } catch (err) {
      if (err instanceof TreeUnavailableError) return null;
      throw err;
    }
  };

  if (spec.subdir) {
    const t = await listing();
    if (t) {
      const plan = planFromTree(t, spec, options);
      // Rough costs: archives compress ~4x and stream at ~20 MB/s; raw files take ~8 ms each with 32 workers.
      const archiveBytes = t.totalBytes / 4;
      const tarballSeconds = archiveBytes / (20 * 1024 * 1024);
      const filesSeconds = (plan.sources.length + plan.configs.length) * 0.008;
      if (archiveBytes > MAX_ARCHIVE_BYTES || t.truncated || filesSeconds < tarballSeconds) {
        return fetchPlanned(spec, sha, plan, onProgress, signal);
      }
    }
  }
  try {
    return await downloadTarball(spec, sha, options.includeTests, onProgress, signal);
  } catch (err) {
    if (!(err instanceof ArchiveTooLargeError)) throw err;
    const t = await listing();
    if (!t) throw err;
    return fetchPlanned(spec, sha, planFromTree(t, spec, options), onProgress, signal);
  }
}

interface TreeEntry {
  path: string;
  type: 'blob' | 'tree' | 'commit';
  size?: number;
}

interface TreeListing {
  entries: TreeEntry[];
  /** Sum of every blob in the repo (≈ uncompressed archive size). */
  totalBytes: number;
  truncated: boolean;
}

interface FetchPlan {
  sources: { rel: string; path: string }[];
  configs: { rel: string; path: string }[];
  skipped: number;
}

async function listTree(spec: RepoSpec, sha: string | null, signal?: AbortSignal): Promise<TreeListing> {
  const rev = sha ?? spec.ref;
  const res = await fetch(
    `https://api.github.com/repos/${spec.owner}/${spec.repo}/git/trees/${encodeURIComponent(rev)}?recursive=1`,
    { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'code-universe', ...authHeaders() }, signal },
  );
  if (res.status === 404) throw new UserFacingError(`Could not find ${spec.owner}/${spec.repo}@${spec.ref}.`);
  if (!res.ok) throw new TreeUnavailableError(`tree API responded ${res.status}`);
  const body = (await res.json()) as { tree: TreeEntry[]; truncated: boolean };
  let totalBytes = 0;
  for (const e of body.tree) if (e.type === 'blob') totalBytes += e.size ?? 0;
  return { entries: body.tree, totalBytes, truncated: body.truncated };
}

function planFromTree(tree: TreeListing, spec: RepoSpec, options: DownloadOptions): FetchPlan {
  const prefix = spec.subdir ? `${spec.subdir}/` : '';
  const plan: FetchPlan = { sources: [], configs: [], skipped: 0 };
  for (const entry of tree.entries) {
    if (entry.type !== 'blob' || !entry.path.startsWith(prefix)) continue;
    const rel = entry.path.slice(prefix.length);
    const cls = classifyPath(rel, options.includeTests);
    if (cls === 'skip') continue;
    const size = entry.size ?? 0;
    if (cls === 'config') {
      if (size <= MAX_CONFIG_BYTES) plan.configs.push({ rel, path: entry.path });
    } else if (size > MAX_FILE_BYTES) {
      plan.skipped++;
    } else {
      plan.sources.push({ rel, path: entry.path });
    }
  }
  if (plan.sources.length === 0) {
    throw new UserFacingError(
      spec.subdir ? `Directory "${spec.subdir}" has no JavaScript/TypeScript sources.` : 'No JavaScript/TypeScript sources found.',
    );
  }
  // Same truncation policy as the graph builder, applied before spending requests.
  if (plan.sources.length > options.maxFiles) {
    plan.sources.sort((a, b) => rankForTruncation(a.rel) - rankForTruncation(b.rel) || a.rel.localeCompare(b.rel));
    plan.skipped += plan.sources.length - options.maxFiles;
    plan.sources.length = options.maxFiles;
  }
  return plan;
}

async function fetchPlanned(
  spec: RepoSpec,
  sha: string | null,
  plan: FetchPlan,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<DownloadedRepo> {
  const rev = sha ?? spec.ref;
  const sources = new Map<string, string>();
  const configs = new Map<string, string>();
  let skipped = plan.skipped;
  const jobs = [
    ...plan.configs.map((e) => ({ ...e, config: true })),
    ...plan.sources.map((e) => ({ ...e, config: false })),
  ];
  const total = jobs.length;
  let done = 0;
  let bytes = 0;
  let lastReport = 0;
  let cursor = 0;
  const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');
  const worker = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor++];
      const url = `https://raw.githubusercontent.com/${spec.owner}/${spec.repo}/${encodeURIComponent(rev)}/${encodePath(job.path)}`;
      let text: string | null = null;
      for (let attempt = 0; attempt < 3 && text === null; attempt++) {
        try {
          const r = await fetch(url, { headers: authHeaders(), signal });
          if (r.ok) text = await r.text();
          else if (r.status === 404) break;
        } catch (err) {
          if (signal?.aborted) throw err;
        }
      }
      done++;
      if (text !== null) {
        bytes += text.length;
        if (job.config) configs.set(job.rel, text);
        else if (looksGenerated(text)) skipped++;
        else sources.set(job.rel, text);
      }
      const now = Date.now();
      if (now - lastReport > 150) {
        lastReport = now;
        onProgress({ via: 'files', bytes, files: done, total });
      }
    }
  };
  await Promise.all(Array.from({ length: 32 }, worker));
  onProgress({ via: 'files', bytes, files: done, total });
  return { sources, configs, sha, bytes, skipped };
}

async function downloadTarball(
  spec: RepoSpec,
  sha: string | null,
  includeTests: boolean,
  onProgress: (p: DownloadProgress) => void,
  signal?: AbortSignal,
): Promise<DownloadedRepo> {
  const ref = sha ?? spec.ref;
  const token = process.env.GITHUB_TOKEN;
  const url = token
    ? `https://api.github.com/repos/${spec.owner}/${spec.repo}/tarball/${encodeURIComponent(ref)}`
    : `https://codeload.github.com/${spec.owner}/${spec.repo}/tar.gz/${encodeURIComponent(ref)}`;

  const res = await fetch(url, { headers: { ...authHeaders(), 'User-Agent': 'code-universe' }, signal });
  if (res.status === 404) throw new UserFacingError(`Could not download ${spec.owner}/${spec.repo}@${spec.ref}.`);
  if (!res.ok || !res.body) throw new Error(`GitHub responded ${res.status} while downloading the archive.`);

  const prefix = spec.subdir ? `${spec.subdir}/` : '';
  const sources = new Map<string, string>();
  const configs = new Map<string, string>();
  let skipped = 0;
  let resolvedSha = sha;
  let bytes = 0;

  /** Strip the `<repo>-<sha>/` root folder and the requested subdir. */
  const relative = (archivePath: string): string | null => {
    const slash = archivePath.indexOf('/');
    if (slash < 0) return null;
    const repoPath = archivePath.slice(slash + 1);
    if (!repoPath.startsWith(prefix)) return null;
    return repoPath.slice(prefix.length) || null;
  };

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const parser = new TarStreamParser({
    select(entry) {
      const path = relative(entry.path);
      if (!path) return false;
      const cls = classifyPath(path, includeTests);
      if (cls === 'skip') return false;
      if (entry.size > (cls === 'config' ? MAX_CONFIG_BYTES : MAX_FILE_BYTES)) {
        if (cls === 'source') skipped++;
        return false;
      }
      return true;
    },
    onFile(entry, body) {
      const path = relative(entry.path)!;
      const text = decoder.decode(body);
      if (classifyPath(path, includeTests) === 'config') {
        configs.set(path, text);
      } else if (looksGenerated(text)) {
        skipped++;
      } else {
        sources.set(path, text);
      }
    },
    onGlobal(records) {
      if (records.comment && /^[0-9a-f]{40}$/i.test(records.comment)) resolvedSha = records.comment.toLowerCase();
    },
  });

  const gunzip = createGunzip();
  const compressed = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream<Uint8Array>);
  compressed.on('data', (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_ARCHIVE_BYTES) {
      compressed.destroy(new ArchiveTooLargeError('Repository archive is larger than 250 MB. Try a subdirectory URL instead.'));
    }
  });
  compressed.on('error', (err) => gunzip.destroy(err));
  compressed.pipe(gunzip);

  let lastReport = 0;
  for await (const chunk of gunzip as AsyncIterable<Buffer>) {
    parser.push(chunk);
    const now = Date.now();
    if (now - lastReport > 150) {
      lastReport = now;
      onProgress({ via: 'archive', bytes, files: sources.size });
    }
    if (parser.finished) break;
  }
  compressed.destroy();
  parser.end();
  onProgress({ via: 'archive', bytes, files: sources.size });

  if (spec.subdir && sources.size === 0 && configs.size === 0) {
    throw new UserFacingError(`Directory "${spec.subdir}" has no JavaScript/TypeScript sources.`);
  }
  return { sources, configs, sha: resolvedSha, bytes, skipped };
}

export function repoRef(spec: RepoSpec, sha: string | null): RepoRef {
  return { owner: spec.owner, repo: spec.repo, ref: spec.ref, sha, subdir: spec.subdir };
}

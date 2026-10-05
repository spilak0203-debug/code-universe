/** Repository input parsing shared by the server analyzer and the landing form (no Node imports). */

export class UserFacingError extends Error {}

export interface RepoSpec {
  owner: string;
  repo: string;
  ref: string;
  subdir: string;
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;

/**
 * Accepts `owner/repo`, `github.com/owner/repo`, full https URLs (optionally
 * `/tree/<ref>/<subdir>`), and `git@github.com:owner/repo.git`.
 */
export function parseRepoInput(input: string): RepoSpec {
  let text = input.trim();
  text = text.replace(/^git@github\.com:/i, 'github.com/');
  text = text.replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '');
  text = text.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const parts = text.split('/').filter(Boolean);
  if (parts.length < 2) throw new UserFacingError('Enter a GitHub repository like "owner/repo" or a github.com URL.');
  const owner = parts[0];
  const repo = parts[1].replace(/\.git$/i, '');
  if (!NAME.test(owner) || !NAME.test(repo)) throw new UserFacingError(`"${owner}/${repo}" is not a valid repository name.`);

  let ref = 'HEAD';
  let subdir = '';
  if ((parts[2] === 'tree' || parts[2] === 'blob') && parts[3]) {
    ref = decodeURIComponent(parts[3]);
    subdir = parts.slice(4).map(decodeURIComponent).join('/');
  }
  return { owner, repo, ref, subdir: normalizeSubdir(subdir) };
}

export function normalizeSubdir(subdir: string): string {
  const clean = subdir.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.').join('/');
  if (clean.split('/').includes('..')) throw new UserFacingError('Invalid subdirectory.');
  return clean;
}

/** In-app URL for a repo spec: /u/owner/repo?ref=…&path=… */
export function viewerHref(spec: RepoSpec, includeTests = false): string {
  const params = new URLSearchParams();
  if (spec.ref && spec.ref !== 'HEAD') params.set('ref', spec.ref);
  if (spec.subdir) params.set('path', spec.subdir);
  if (includeTests) params.set('tests', '1');
  const qs = params.toString();
  return `/u/${spec.owner}/${spec.repo}${qs ? `?${qs}` : ''}`;
}

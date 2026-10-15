// Pull requests of the modpack from GitHub, straight from the browser.
//
// The REST API allows 60 requests an hour per address without a token (5000 with one), so only
// metadata comes from it: the list of open pull requests, one pull request, and one comparison
// (merge base and changed files). File contents come from raw.githubusercontent.com by commit,
// which is not counted, and serves commits of pull requests from forks too.


export const REPO = 'GTNewHorizons/GT-New-Horizons-Modpack';
export const QUESTS_ROOT = 'config/betterquesting/DefaultQuests';
const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';
const TOKEN_KEY = 'nhqe.github-token';


export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}
export function setToken(t: string) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // storage unavailable
  }
}

/** The API's rate limit as of the last answer. */
export const rate = { limit: 0, remaining: -1, reset: 0 };

export class GitHubError extends Error {
  status: number;
  rateLimited: boolean;
  constructor(message: string, status: number, rateLimited = false) {
    super(message);
    this.status = status;
    this.rateLimited = rateLimited;
  }
}

async function api<T>(path: string): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, { headers });
  } catch {
    throw new GitHubError('Could not reach GitHub', 0);
  }
  const h = (k: string) => Number(res.headers.get(k) ?? NaN);
  if (!Number.isNaN(h('x-ratelimit-remaining'))) {
    rate.limit = h('x-ratelimit-limit');
    rate.remaining = h('x-ratelimit-remaining');
    rate.reset = h('x-ratelimit-reset');
  }
  if (res.ok) return (await res.json()) as T;
  if ((res.status === 403 || res.status === 429) && rate.remaining === 0) {
    const at = new Date(rate.reset * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    throw new GitHubError(
      `GitHub's limit of ${rate.limit || 60} requests an hour is used up until ${at}.${token ? '' : ' A GitHub token raises it (Settings below).'}`,
      res.status,
      true,
    );
  }
  if (res.status === 401) throw new GitHubError('GitHub did not accept the token.', 401);
  if (res.status === 404) throw new GitHubError('Not found on GitHub.', 404);
  let msg = `GitHub answered ${res.status}`;
  try {
    const j = (await res.json()) as { message?: string };
    if (j.message) msg += `: ${j.message}`;
  } catch {
    // no body
  }
  throw new GitHubError(msg, res.status);
}

// ---------------------------------------------------------------- pull requests

interface ApiPull {
  number: number;
  title: string;
  html_url: string;
  state: 'open' | 'closed';
  draft?: boolean;
  merged_at?: string | null;
  updated_at: string;
  user: { login: string } | null;
  labels: { name: string }[];
  head: { sha: string; label: string };
  base: { sha: string; ref: string };
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  draft: boolean;
  author: string;
  labels: string[];
  updatedAt: string;
  headSha: string;
  /** "owner:branch" of the head. */
  headLabel: string;
  baseSha: string;
  baseRef: string;
}

const toPull = (p: ApiPull): PullRequest => ({
  number: p.number,
  title: p.title,
  url: p.html_url,
  state: p.merged_at ? 'merged' : p.state,
  draft: !!p.draft,
  author: p.user?.login ?? 'ghost',
  labels: p.labels.map((l) => l.name),
  updatedAt: p.updated_at,
  headSha: p.head.sha,
  headLabel: p.head.label,
  baseSha: p.base.sha,
  baseRef: p.base.ref,
});

export async function openPullRequests(): Promise<PullRequest[]> {
  const out: PullRequest[] = [];
  for (let page = 1; page <= 5; page++) {
    const list = await api<ApiPull[]>(`/repos/${REPO}/pulls?state=open&per_page=100&page=${page}`);
    out.push(...list.map(toPull));
    if (list.length < 100) break;
  }
  return out;
}

export async function pullRequest(n: number): Promise<PullRequest> {
  return toPull(await api<ApiPull>(`/repos/${REPO}/pulls/${n}`));
}

// ---------------------------------------------------------------- changed files

interface ApiFile {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed' | 'copied' | 'changed' | 'unchanged';
  previous_filename?: string;
}

export interface PullFiles {
  /** Commit the branch started from. */
  mergeBase: string;
  /** Paths inside DefaultQuests that differ: their path at the merge base and at the head (null: absent). */
  quests: { base: string | null; head: string | null }[];
  /** Other files the pull request changes (full repo paths). */
  other: string[];
}

const inQuests = (p: string | undefined) => !!p && p.startsWith(`${QUESTS_ROOT}/`);
const rel = (p: string) => p.slice(QUESTS_ROOT.length + 1);

function sortFiles(files: ApiFile[], mergeBase: string): PullFiles {
  const out: PullFiles = { mergeBase, quests: [], other: [] };
  for (const f of files) {
    const prev = f.status === 'renamed' || f.status === 'copied' ? f.previous_filename : f.filename;
    const base = f.status === 'added' || f.status === 'copied' ? null : prev;
    const head = f.status === 'removed' ? null : f.filename;
    const b = inQuests(base ?? undefined) ? rel(base!) : null;
    const h = inQuests(head ?? undefined) ? rel(head!) : null;
    if (b !== null || h !== null) out.quests.push({ base: b, head: h });
    if (!inQuests(f.filename)) out.other.push(f.filename);
  }
  return out;
}

/** The pull request's changed files, by comparing its base with its head. */
export async function pullFiles(pr: PullRequest): Promise<PullFiles> {
  const cmp = await api<{ merge_base_commit: { sha: string }; files?: ApiFile[] }>(
    `/repos/${REPO}/compare/${pr.baseSha}...${pr.headSha}?per_page=1`,
  );
  let files = cmp.files ?? [];
  // The comparison lists at most 300 files; the pull request's own list goes up to 3000.
  if (files.length >= 300) {
    files = [];
    for (let page = 1; page <= 30; page++) {
      const list = await api<ApiFile[]>(`/repos/${REPO}/pulls/${pr.number}/files?per_page=100&page=${page}`);
      files.push(...list);
      if (list.length < 100) break;
    }
  }
  return sortFiles(files, cmp.merge_base_commit.sha);
}

/**
 * How many DefaultQuests files a pull request changes, from the first page (100) of its files,
 * for the list of open pull requests; `more` when there are more files than that page. Kept per
 * head commit, so unchanged pull requests cost nothing.
 */
export interface FileCount {
  n: number;
  more: boolean;
}
const COUNT_KEY = 'nhqe.review.quest-files.v2';
export function knownQuestFileCount(pr: PullRequest): FileCount | undefined {
  try {
    const all = JSON.parse(localStorage.getItem(COUNT_KEY) ?? '{}') as Record<string, FileCount>;
    return all[pr.headSha];
  } catch {
    return undefined;
  }
}
export async function questFileCount(pr: PullRequest): Promise<FileCount> {
  const known = knownQuestFileCount(pr);
  if (known !== undefined) return known;
  const list = await api<ApiFile[]>(`/repos/${REPO}/pulls/${pr.number}/files?per_page=100`);
  const n: FileCount = { n: list.filter((f) => inQuests(f.filename) || inQuests(f.previous_filename)).length, more: list.length >= 100 };
  try {
    const all = JSON.parse(localStorage.getItem(COUNT_KEY) ?? '{}') as Record<string, FileCount>;
    all[pr.headSha] = n;
    const keys = Object.keys(all);
    if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete all[k];
    localStorage.setItem(COUNT_KEY, JSON.stringify(all));
  } catch {
    // storage unavailable
  }
  return n;
}

// ---------------------------------------------------------------- file contents

const rawCache = new Map<string, Promise<string | null>>();

/** A file at a commit (path inside DefaultQuests); null when it does not exist there. */
export function rawFile(commit: string, path: string): Promise<string | null> {
  const url = `${RAW}/${REPO}/${commit}/${`${QUESTS_ROOT}/${path}`.split('/').map(encodeURIComponent).join('/')}`;
  let p = rawCache.get(url);
  if (!p) {
    p = (async () => {
      for (let attempt = 0; ; attempt++) {
        let res: Response;
        try {
          res = await fetch(url);
        } catch (e) {
          if (attempt < 2) continue;
          throw new GitHubError(`Could not download ${path}`, 0);
        }
        if (res.ok) return await res.text();
        if (res.status === 404) return null;
        if (attempt >= 2) throw new GitHubError(`Could not download ${path} (${res.status})`, res.status);
      }
    })();
    p.catch(() => rawCache.delete(url));
    rawCache.set(url, p);
  }
  return p;
}

/** Run `f` over `items`, at most `n` at a time. */
export async function pool<T, R>(items: T[], n: number, f: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await f(items[i], i);
      }
    }),
  );
  return out;
}

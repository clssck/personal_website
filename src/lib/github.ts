/**
 * Public GitHub repo access — no auth, plain unauthenticated requests.
 * Both the API response and anything read back from the browser cache are
 * treated as untrusted: every field is validated and repo links are
 * reconstructed to canonical https://github.com/<user>/<name> form.
 */
import { SITE } from "./profile";

export interface RepoInfo {
  id: number;
  name: string;
  /** Canonical https://github.com/<user>/<name>, reconstructed, never raw. */
  url: string;
  description: string | null;
  language: string | null;
  archived: boolean;
  fork: boolean;
  /** ISO 8601 pushed_at; "" when missing. */
  pushedAt: string;
}

export type ReposErrorKind = "rate" | "http" | "network" | "malformed";

export class ReposError extends Error {
  readonly kind: ReposErrorKind;
  readonly status?: number;
  constructor(kind: ReposErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ReposError";
    this.kind = kind;
    this.status = status;
  }
}

export type ReposResult =
  | { ok: true; repos: RepoInfo[]; fromCache: boolean }
  | {
      ok: false;
      kind: ReposErrorKind;
      message: string;
      /** Repos-tab link — always safe to show when the API fails. */
      fallback: string;
    };

export const FALLBACK_REPOS = SITE.reposUrl;
/** Short browser cache: ~5 minutes, complete validated results only. */
export const CACHE_TTL_MS = 5 * 60 * 1000;
const CACHE_KEY = "clssck:repos:v1";
const PER_PAGE = 100;

/** Exact https://github.com/<user>/<name> — no userinfo, port, query, hash. */
export function isSafeRepoUrl(value: unknown, name: string): value is string {
  if (typeof value !== "string" || !name) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    u.username === "" &&
    u.password === "" &&
    u.hostname === "github.com" &&
    u.port === "" &&
    u.pathname === `/${SITE.githubUser}/${name}` &&
    u.search === "" &&
    u.hash === ""
  );
}

/** Validate one raw API entry; null when anything needed is off. */
export function sanitizeRepo(raw: unknown): RepoInfo | null {
  if (typeof raw !== "object" || raw === null) return null;
  if (!("id" in raw) || typeof raw.id !== "number" || !Number.isFinite(raw.id))
    return null;
  if (
    !("name" in raw) ||
    typeof raw.name !== "string" ||
    raw.name.length === 0 ||
    raw.name.length > 100
  )
    return null;
  const name = raw.name;
  if (
    !("html_url" in raw) ||
    typeof raw.html_url !== "string" ||
    !isSafeRepoUrl(raw.html_url, name)
  )
    return null;
  const description =
    "description" in raw && typeof raw.description === "string"
      ? raw.description.slice(0, 500)
      : null;
  const language =
    "language" in raw &&
    typeof raw.language === "string" &&
    raw.language.length > 0 &&
    raw.language.length < 64
      ? raw.language
      : null;
  return {
    id: raw.id,
    name,
    url: `${SITE.githubUrl}/${name}`,
    description,
    language,
    archived: "archived" in raw && raw.archived === true,
    fork: "fork" in raw && raw.fork === true,
    pushedAt:
      "pushed_at" in raw && typeof raw.pushed_at === "string"
        ? raw.pushed_at
        : "",
  };
}

/** Re-validate one cached entry — the cache is untrusted too. */
function sanitizeCachedRepo(raw: unknown): RepoInfo | null {
  if (typeof raw !== "object" || raw === null) return null;
  if (!("id" in raw) || typeof raw.id !== "number" || !Number.isFinite(raw.id))
    return null;
  if (
    !("name" in raw) ||
    typeof raw.name !== "string" ||
    raw.name.length === 0 ||
    raw.name.length > 100
  )
    return null;
  const name = raw.name;
  if (
    !("url" in raw) ||
    typeof raw.url !== "string" ||
    !isSafeRepoUrl(raw.url, name)
  )
    return null;
  return {
    id: raw.id,
    name,
    url: `${SITE.githubUrl}/${name}`,
    description:
      "description" in raw &&
      (typeof raw.description === "string" || raw.description === null)
        ? raw.description
        : null,
    language:
      "language" in raw && typeof raw.language === "string"
        ? raw.language
        : null,
    archived: "archived" in raw && raw.archived === true,
    fork: "fork" in raw && raw.fork === true,
    pushedAt:
      "pushedAt" in raw && typeof raw.pushedAt === "string" ? raw.pushedAt : "",
  };
}

/** Recent pushed first; unknown/missing dates sink to the end. */
export function sortRepos(repos: RepoInfo[]): RepoInfo[] {
  const time = (pushedAt: string) => {
    const t = Date.parse(pushedAt);
    return Number.isNaN(t) ? 0 : t;
  };
  return [...repos].sort((a, b) => time(b.pushedAt) - time(a.pushedAt));
}

export interface FetchLikeResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type FetchLike = (url: string) => Promise<FetchLikeResponse>;

/**
 * Fetch every public repo page (per_page=100) until a short page ends the
 * list. A page is all-or-nothing: one bad entry fails the whole fetch, so
 * partial or suspect data is never shown or cached. Pagination has no
 * numeric limit — a full page that yields no new repos means a broken
 * endpoint and fails loudly instead of looping.
 */
export async function fetchAllRepos(
  fetchFn: FetchLike = fetch
): Promise<RepoInfo[]> {
  const seen = new Map<number, RepoInfo>();
  for (let page = 1; ; page++) {
    const url = `${SITE.apiReposUrl}?per_page=${PER_PAGE}&page=${page}`;
    let res: FetchLikeResponse;
    try {
      res = await fetchFn(url);
    } catch {
      throw new ReposError(
        "network",
        "Couldn't reach api.github.com — network hiccup?"
      );
    }
    if (!res || typeof res.status !== "number") {
      throw new ReposError(
        "malformed",
        "GitHub replied with something that wasn't an HTTP response."
      );
    }
    if (res.status === 403 || res.status === 429) {
      throw new ReposError(
        "rate",
        "GitHub's rate limit kicked in (60 requests/hour per IP) — try again later.",
        res.status
      );
    }
    if (!res.ok || res.status >= 400) {
      throw new ReposError(
        "http",
        `GitHub answered with HTTP ${res.status}.`,
        res.status
      );
    }
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      throw new ReposError(
        "malformed",
        "GitHub replied, but the payload wasn't JSON."
      );
    }
    if (!Array.isArray(payload)) {
      throw new ReposError(
        "malformed",
        "GitHub replied, but the payload wasn't a repo list."
      );
    }
    const repos: RepoInfo[] = [];
    for (const raw of payload) {
      const repo = sanitizeRepo(raw);
      if (!repo) {
        throw new ReposError(
          "malformed",
          "GitHub replied, but an entry in the repo list wasn't a valid repo."
        );
      }
      repos.push(repo);
    }
    let added = 0;
    for (const repo of repos) {
      if (!seen.has(repo.id)) {
        seen.set(repo.id, repo);
        added++;
      }
    }
    if (payload.length < PER_PAGE) break;
    if (added === 0) {
      throw new ReposError(
        "malformed",
        "Repo pagination stopped yielding new repos — giving up instead of looping."
      );
    }
  }
  return sortRepos([...seen.values()]);
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface RepoCache {
  get(): RepoInfo[] | null;
  set(repos: RepoInfo[]): void;
}

function defaultStorage(): StorageLike | null {
  try {
    const s: unknown = globalThis.localStorage;
    if (typeof s !== "object" || s === null) return null;
    if (
      !("getItem" in s) ||
      typeof s.getItem !== "function" ||
      !("setItem" in s) ||
      typeof s.setItem !== "function" ||
      !("removeItem" in s) ||
      typeof s.removeItem !== "function"
    )
      return null;
    // Narrowed above; DOM Storage satisfies StorageLike structurally.
    const storage: StorageLike = s as StorageLike;
    return storage;
  } catch {
    return null;
  }
}

/**
 * Short-lived browser cache for COMPLETE validated results. One bad entry
 * or a future timestamp rejects the whole envelope (refetch instead), and
 * storage failures (disabled/private mode/quota) silently degrade to
 * no-cache — the caller still returns fresh network data.
 */
export function createRepoCache(
  opts: {
    now?: () => number;
    storage?: StorageLike | null;
    key?: string;
    ttlMs?: number;
  } = {}
): RepoCache {
  const now = opts.now ?? Date.now;
  const storage = opts.storage === undefined ? defaultStorage() : opts.storage;
  const key = opts.key ?? CACHE_KEY;
  const ttlMs = opts.ttlMs ?? CACHE_TTL_MS;
  return {
    get() {
      try {
        if (!storage) return null;
        const raw = storage.getItem(key);
        if (!raw) return null;
        let env: unknown;
        try {
          env = JSON.parse(raw);
        } catch {
          storage.removeItem(key);
          return null;
        }
        if (typeof env !== "object" || env === null) {
          storage.removeItem(key);
          return null;
        }
        if (
          !("fetchedAt" in env) ||
          typeof env.fetchedAt !== "number" ||
          !Number.isFinite(env.fetchedAt)
        ) {
          storage.removeItem(key);
          return null;
        }
        if (
          !("repos" in env) ||
          !Array.isArray(env.repos) ||
          env.repos.length > 50000
        ) {
          storage.removeItem(key);
          return null;
        }
        if (env.fetchedAt > now() || now() - env.fetchedAt >= ttlMs) {
          storage.removeItem(key);
          return null;
        }
        const repos: RepoInfo[] = [];
        for (const r of env.repos) {
          const repo = sanitizeCachedRepo(r);
          if (!repo) {
            storage.removeItem(key);
            return null;
          }
          repos.push(repo);
        }
        return repos;
      } catch {
        return null;
      }
    },
    set(repos) {
      try {
        storage?.setItem(key, JSON.stringify({ fetchedAt: now(), repos }));
      } catch {
        // Disabled or full storage: no cache, no breakage.
      }
    },
  };
}

const defaultCache = createRepoCache();
let inFlight: Promise<ReposResult> | null = null;

/**
 * Cached entry point. Concurrent calls share one in-flight request, so
 * double `repos` invocations never fire parallel paginations.
 */
export function loadRepos(
  opts: { fetchFn?: FetchLike; cache?: RepoCache } = {}
): Promise<ReposResult> {
  const cache = opts.cache ?? defaultCache;
  try {
    const hit = cache.get();
    if (hit) return Promise.resolve({ ok: true, repos: hit, fromCache: true });
  } catch {
    // A throwing cache must never break the network path.
  }
  if (inFlight) return inFlight;
  const fetchFn = opts.fetchFn ?? fetch;
  inFlight = (async (): Promise<ReposResult> => {
    try {
      const repos = await fetchAllRepos(fetchFn);
      cache.set(repos);
      return { ok: true, repos, fromCache: false };
    } catch (err) {
      if (err instanceof ReposError) {
        return {
          ok: false,
          kind: err.kind,
          message: err.message,
          fallback: FALLBACK_REPOS,
        };
      }
      return {
        ok: false,
        kind: "network",
        message: "Couldn't reach api.github.com — network hiccup?",
        fallback: FALLBACK_REPOS,
      };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

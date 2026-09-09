import { describe, expect, test } from "bun:test";
import {
  CACHE_TTL_MS,
  FALLBACK_REPOS,
  ReposError,
  createRepoCache,
  fetchAllRepos,
  isSafeRepoUrl,
  loadRepos,
  sanitizeRepo,
  sortRepos,
  type FetchLike,
  type RepoInfo,
  type StorageLike,
} from "./github";

function apiRepo(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    name: "aaa",
    html_url: "https://github.com/clssck/aaa",
    description: "d",
    language: "TypeScript",
    archived: false,
    fork: false,
    pushed_at: "2026-06-01T00:00:00Z",
    ...over,
  };
}

function cachedRepo(over: Partial<RepoInfo> = {}): RepoInfo {
  return {
    id: 1,
    name: "aaa",
    url: "https://github.com/clssck/aaa",
    description: null,
    language: null,
    archived: false,
    fork: false,
    pushedAt: "2026-06-01T00:00:00Z",
    ...over,
  };
}

function fetchOf(
  pages: unknown[][],
  opts: { status?: number; calls?: string[] } = {}
): FetchLike {
  return async (url: string) => {
    opts.calls?.push(url);
    const page = Number(new URL(url).searchParams.get("page"));
    const status = opts.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => pages[page - 1] ?? [],
    };
  };
}

function fakeStorage(): StorageLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (k) => store.get(k) ?? null,
    setItem: (k, v) => {
      store.set(k, v);
    },
    removeItem: (k) => {
      store.delete(k);
    },
  };
}

function clock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
}

function pagedRepo(id: number) {
  const name = `r${id}`;
  return apiRepo({
    id,
    name,
    html_url: `https://github.com/clssck/${name}`,
    pushed_at: new Date(Date.UTC(2026, 0, id)).toISOString(),
  });
}

describe("fetchAllRepos", () => {
  test("aggregates pages, dedupes, sorts recent-pushed-first, stops at short page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => pagedRepo(i + 1));
    const page2 = [pagedRepo(50), pagedRepo(101), pagedRepo(102)];
    const calls: string[] = [];
    const repos = await fetchAllRepos(fetchOf([page1, page2], { calls }));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("per_page=100");
    expect(repos).toHaveLength(102);
    expect(new Set(repos.map((r) => r.id)).size).toBe(102);
    expect(repos[0].id).toBe(102);
    expect(repos[repos.length - 1].id).toBe(1);
  });

  test("empty account is a successful empty list", async () => {
    expect(await fetchAllRepos(fetchOf([[]]))).toEqual([]);
  });

  test("one bad entry fails the whole fetch, never partial", async () => {
    const err = await fetchAllRepos(
      fetchOf([[apiRepo(), { id: "nope" }]])
    ).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(ReposError);
    expect((err as ReposError).kind).toBe("malformed");
  });

  test("full page with no new repos fails instead of looping", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => pagedRepo(i + 1));
    const err = await fetchAllRepos(fetchOf([page1, page1])).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(ReposError);
    expect((err as ReposError).kind).toBe("malformed");
  });

  test("403 and 429 are rate limits with repos-tab fallback", async () => {
    for (const status of [403, 429]) {
      const err = await fetchAllRepos(fetchOf([[]], { status })).then(
        () => null,
        (e) => e
      );
      expect(err).toBeInstanceOf(ReposError);
      expect((err as ReposError).kind).toBe("rate");
      expect((err as ReposError).status).toBe(status);
    }
    const res = await loadRepos({
      fetchFn: fetchOf([[]], { status: 429 }),
      cache: createRepoCache({ storage: fakeStorage() }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("rate");
      expect(res.fallback).toBe(FALLBACK_REPOS);
    }
  });

  test("other HTTP failures surface their status", async () => {
    const err = await fetchAllRepos(fetchOf([[]], { status: 500 })).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(ReposError);
    expect((err as ReposError).kind).toBe("http");
    expect((err as ReposError).status).toBe(500);
  });

  test("network failure is its own kind", async () => {
    const err = await fetchAllRepos(async () => {
      throw new Error("boom");
    }).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(ReposError);
    expect((err as ReposError).kind).toBe("network");
  });

  test("malformed shapes: bad JSON, non-list, non-response", async () => {
    const badJson: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("bad json");
      },
    });
    const nonList: FetchLike = async () => ({
      ok: true,
      status: 200,
      json: async () => ({ message: "oops" }),
    });
    const nonResponse = (async () => ({})) as FetchLike;
    for (const fn of [badJson, nonList, nonResponse]) {
      const err = await fetchAllRepos(fn).then(
        () => null,
        (e) => e
      );
      expect(err).toBeInstanceOf(ReposError);
      expect((err as ReposError).kind).toBe("malformed");
    }
  });

  test("rate limit mid-pagination caches nothing", async () => {
    const storage = fakeStorage();
    const cache = createRepoCache({ storage });
    const page1 = Array.from({ length: 100 }, (_, i) => pagedRepo(i + 1));
    const fn: FetchLike = async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page"));
      if (page > 1) return { ok: false, status: 429, json: async () => [] };
      return { ok: true, status: 200, json: async () => page1 };
    };
    const res = await loadRepos({ fetchFn: fn, cache });
    expect(res.ok).toBe(false);
    expect(cache.get()).toBeNull();
    expect(storage.store.size).toBe(0);
  });
});

describe("sanitizeRepo", () => {
  test("valid entry yields canonical reconstructed URL", () => {
    const repo = sanitizeRepo(apiRepo());
    expect(repo?.url).toBe("https://github.com/clssck/aaa");
  });

  test("hostile or off-shape URLs are rejected", () => {
    const bad = [
      "javascript:alert(1)",
      "https://evil.com/clssck/aaa",
      "https://github.com/other/aaa",
      "https://github.com/clssck/bbb", // name mismatch
      "https://u:p@github.com/clssck/aaa",
      "https://user@github.com/clssck/aaa",
      "https://github.com:8443/clssck/aaa",
      "http://github.com/clssck/aaa",
      "https://github.com/clssck/aaa?x=1",
      "https://github.com/clssck/aaa#y",
      "",
      42,
      null,
    ];
    for (const html_url of bad) {
      expect(sanitizeRepo(apiRepo({ html_url })), String(html_url)).toBeNull();
      expect(isSafeRepoUrl(html_url, "aaa"), String(html_url)).toBe(false);
    }
    expect(isSafeRepoUrl("https://github.com/clssck/aaa", "aaa")).toBe(true);
  });

  test("bad id or name is rejected", () => {
    expect(sanitizeRepo(apiRepo({ id: "1" }))).toBeNull();
    expect(sanitizeRepo(apiRepo({ name: "" }))).toBeNull();
    expect(sanitizeRepo(apiRepo({ name: "x".repeat(101) }))).toBeNull();
    expect(sanitizeRepo(null)).toBeNull();
    expect(sanitizeRepo("nope")).toBeNull();
  });

});

describe("sortRepos", () => {
  test("recent pushed first, unknown dates last", () => {
    const sorted = sortRepos([
      cachedRepo({ id: 1, pushedAt: "bad-date" }),
      cachedRepo({ id: 2, pushedAt: "2026-01-01T00:00:00Z" }),
      cachedRepo({ id: 3, pushedAt: "" }),
      cachedRepo({ id: 4, pushedAt: "2026-09-01T00:00:00Z" }),
    ]);
    expect(sorted.map((r) => r.id)).toEqual([4, 2, 1, 3]);
  });
});

describe("createRepoCache", () => {
  const KEY = "clssck:repos:v1";

  test("round-trips complete results within TTL", () => {
    const c = clock();
    const cache = createRepoCache({ storage: fakeStorage(), now: c.now });
    const repos = [cachedRepo({ id: 7 })];
    cache.set(repos);
    expect(cache.get()).toEqual(repos);
    c.advance(CACHE_TTL_MS - 1);
    expect(cache.get()).toEqual(repos);
  });

  test("expired entries are dropped and removed", () => {
    const c = clock();
    const storage = fakeStorage();
    const cache = createRepoCache({ storage, now: c.now });
    cache.set([cachedRepo()]);
    c.advance(CACHE_TTL_MS);
    expect(cache.get()).toBeNull();
    expect(storage.store.has(KEY)).toBe(false);
  });

  test("future timestamps are rejected and removed", () => {
    const c = clock();
    const storage = fakeStorage();
    storage.setItem(
      KEY,
      JSON.stringify({ fetchedAt: c.now() + 60_000, repos: [cachedRepo()] })
    );
    const cache = createRepoCache({ storage, now: c.now });
    expect(cache.get()).toBeNull();
    expect(storage.store.has(KEY)).toBe(false);
  });

  test("corrupt envelopes are rejected and removed", () => {
    const c = clock();
    const storage = fakeStorage();
    storage.setItem(KEY, "not json {{{");
    const cache = createRepoCache({ storage, now: c.now });
    expect(cache.get()).toBeNull();
    expect(storage.store.has(KEY)).toBe(false);
  });

  test("one bad cached entry rejects the whole cache", () => {
    const c = clock();
    const storage = fakeStorage();
    storage.setItem(
      KEY,
      JSON.stringify({
        fetchedAt: c.now(),
        repos: [cachedRepo(), { id: 2, name: "bbb" }], // missing url
      })
    );
    const cache = createRepoCache({ storage, now: c.now });
    expect(cache.get()).toBeNull();
    expect(storage.store.has(KEY)).toBe(false);
  });

  test("throwing storage degrades to no-cache", () => {
    const throwing: StorageLike = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    };
    const cache = createRepoCache({ storage: throwing });
    expect(cache.get()).toBeNull();
    expect(() => cache.set([cachedRepo()])).not.toThrow();
  });

  test("disabled storage degrades to no-cache", () => {
    const cache = createRepoCache({ storage: null });
    expect(cache.get()).toBeNull();
    expect(() => cache.set([cachedRepo()])).not.toThrow();
  });
});

describe("loadRepos", () => {
  test("cache hit never touches the network", async () => {
    const cache = createRepoCache({ storage: fakeStorage() });
    cache.set([cachedRepo({ id: 9 })]);
    let calls = 0;
    const res = await loadRepos({
      cache,
      fetchFn: async () => {
        calls++;
        throw new Error("must not fetch");
      },
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.fromCache).toBe(true);
      expect(res.repos.map((r) => r.id)).toEqual([9]);
    }
    expect(calls).toBe(0);
  });

  test("miss fetches once, then serves from cache", async () => {
    const cache = createRepoCache({ storage: fakeStorage() });
    const calls: string[] = [];
    const first = await loadRepos({
      cache,
      fetchFn: fetchOf([[apiRepo({ id: 3 })]], { calls }),
    });
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.fromCache).toBe(false);
    expect(calls).toHaveLength(1);
    expect(cache.get()).not.toBeNull();
    const second = await loadRepos({
      cache,
      fetchFn: fetchOf([[apiRepo({ id: 3 })]], { calls }),
    });
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.fromCache).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("concurrent calls share one request", async () => {
    const cache = createRepoCache({ storage: fakeStorage() });
    const calls: string[] = [];
    const [a, b] = await Promise.all([
      loadRepos({ cache, fetchFn: fetchOf([[apiRepo()]], { calls }) }),
      loadRepos({ cache, fetchFn: fetchOf([[apiRepo()]], { calls }) }),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(calls).toHaveLength(1);
  });

  test("failures return the fallback and cache nothing", async () => {
    const cache = createRepoCache({ storage: fakeStorage() });
    const res = await loadRepos({
      cache,
      fetchFn: fetchOf([[]], { status: 500 }),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.kind).toBe("http");
      expect(res.fallback).toBe(FALLBACK_REPOS);
    }
    expect(cache.get()).toBeNull();
  });
});

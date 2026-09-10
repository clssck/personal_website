/**
 * Real-browser terminal regression: drives the built site in system Chrome
 * via puppeteer-core. Self-contained — builds, serves dist/ from an
 * in-process static server on an ephemeral port, then exercises actual
 * DOM/keyboard/focus/network behavior.
 * Needs a Chrome/Chromium binary: CHROME_PATH or a well-known location.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import puppeteer, { type Browser, type Page } from "puppeteer-core";
import { FALLBACK_REPOS } from "../../src/lib/github";

let BASE = "";
const ROOT = new URL("../..", import.meta.url).pathname;

interface ApiCall {
  url: string;
  headers: Record<string, string>;
}

/** Deterministic API fixtures — the browser suite never touches the network. */
function fixtureRepo(id: number, over: Record<string, unknown> = {}): unknown {
  const name = `repo-${id}`;
  return {
    id,
    name,
    html_url: `https://github.com/clssck/${name}`,
    description: `Description for ${name}`,
    language: "TypeScript",
    archived: false,
    fork: false,
    pushed_at: new Date(Date.UTC(2026, 0, 1) + id * 3600_000).toISOString(),
    ...over,
  };
}

const FIXTURE_PAGE_1 = Array.from({ length: 100 }, (_, i) => fixtureRepo(i + 1));
const FIXTURE_PAGE_2 = [
  fixtureRepo(101, {
    name: "fork-label",
    html_url: "https://github.com/clssck/fork-label",
    fork: true,
    language: "Python",
    pushed_at: "2026-09-09T00:00:00Z",
  }),
  fixtureRepo(102, {
    name: "archived-label",
    html_url: "https://github.com/clssck/archived-label",
    archived: true,
    description: null,
    language: null,
    pushed_at: "2026-09-08T00:00:00Z",
  }),
  fixtureRepo(103, {
    name: "evil-desc",
    html_url: "https://github.com/clssck/evil-desc",
    description: "<img src=x onerror=alert(1)>watch out",
    pushed_at: "2026-09-07T00:00:00Z",
  }),
];

/** Answer API requests from fixtures by page number; records every call. */
async function serveFixture(
  page: Page,
  pages: Record<number, unknown[]>
): Promise<ApiCall[]> {
  const calls: ApiCall[] = [];
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (!req.url().startsWith("https://api.github.com/")) {
      void req.continue();
      return;
    }
    calls.push({ url: req.url(), headers: req.headers() });
    const n = Number(new URL(req.url()).searchParams.get("page"));
    void req.respond({
      status: 200,
      contentType: "application/json",
      headers: { "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify(pages[n] ?? []),
    });
  });
  return calls;
}

interface HeldApi {
  seen: Promise<void>;
  release: (payload: unknown[]) => void;
}

/**
 * Hold the API request behind a promise: tests arrange the race (clear or a
 * second command), then release a fixture and await the settled outcome —
 * no sleeps, no live network.
 */
async function holdApi(page: Page): Promise<HeldApi> {
  let markSeen!: () => void;
  const seen = new Promise<void>((res) => {
    markSeen = res;
  });
  let release!: (payload: unknown[]) => void;
  const gate = new Promise<unknown[]>((res) => {
    release = res;
  });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    if (!req.url().startsWith("https://api.github.com/")) {
      void req.continue();
      return;
    }
    markSeen();
    void (async () => {
      const payload = await gate;
      await req.respond({
        status: 200,
        contentType: "application/json",
        headers: { "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify(payload),
      });
    })();
  });
  return { seen, release };
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].filter((p): p is string => !!p);

interface StoppableServer {
  readonly url: URL;
  stop(): Promise<void>;
}

let browser: Browser;
let server: StoppableServer | null = null;

async function resolveChrome(): Promise<string> {
  for (const p of CHROME_CANDIDATES) {
    if (await Bun.file(p).exists()) return p;
  }
  throw new Error(
    `No Chrome/Chromium found (tried ${CHROME_CANDIDATES.join(", ")}). ` +
      "Set CHROME_PATH to a Chrome binary to run the browser tests."
  );
}

function serveDist(): StoppableServer {
  // In-process static server: ephemeral port, no child process to orphan,
  // no singleton lock to fight, always serves the just-built dist/.
  const dist = join(ROOT, "dist");
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const pathname = decodeURIComponent(new URL(req.url).pathname);
      if (pathname.includes("..")) return new Response("not found", { status: 404 });
      const file = Bun.file(
        join(dist, pathname.endsWith("/") ? `${pathname}index.html` : pathname)
      );
      return (await file.exists())
        ? new Response(file)
        : new Response("not found", { status: 404 });
    },
  });
}

beforeAll(async () => {
  const build = Bun.spawnSync(["bun", "run", "build"], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "pipe",
  });
  if (build.exitCode !== 0) {
    throw new Error(
      `fixture build failed:\n${build.stderr.toString().slice(0, 2000)}`
    );
  }
  server = serveDist();
  BASE = server.url.origin;
  browser = await puppeteer.launch({
    executablePath: await resolveChrome(),
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
}, 90000);

afterAll(async () => {
  await browser?.close();
  await server?.stop();
  server = null;
});

async function newPage(viewport = { width: 1365, height: 768 }): Promise<Page> {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  return page;
}

function outText(page: Page): Promise<string> {
  return page.$eval("#out", (el) => el.textContent ?? "");
}

async function inputValue(page: Page): Promise<string> {
  return page.$eval("#cmd", (el) => (el as HTMLInputElement).value);
}

async function runCmd(page: Page, text: string): Promise<void> {
  await page.focus("#cmd");
  await page.keyboard.type(text, { delay: 5 });
  await page.keyboard.press("Enter");
}

describe("first screen", () => {
  test("terminal starts empty: no intro, no shortcuts, nothing pre-run", async () => {
    const page = await newPage();
    try {
      // nothing to read or click until the visitor types: no output, no
      // intro block, no shortcut links, no disclosures in the live terminal
      expect(await outText(page)).toBe("");
      expect(await page.$(".term__intro")).toBeNull();
      expect(await page.$(".term__links")).toBeNull();
      expect(await page.$("#screen a")).toBeNull();
      expect(await page.$("#screen details")).toBeNull();
      // prompt is interactive: input + hint visible, JS gate open
      expect(
        await page.$eval("#cmd", (el) => getComputedStyle(el).display)
      ).not.toBe("none");
      const fontPx = parseFloat(
        await page.$eval("#cmd", (el) => getComputedStyle(el).fontSize)
      );
      expect(fontPx).toBeGreaterThanOrEqual(16);
      expect(
        await page.$eval("#terminal-hint", (el) => getComputedStyle(el).display)
      ).not.toBe("none");
      // and the empty screen answers: it is live, not dead
      await runCmd(page, "help");
      expect(await outText(page)).toContain("available commands");
    } finally {
      await page.close();
    }
  }, 30000);
});

describe("idle cursor", () => {
  test("cursor blinks at the empty prompt and hides while editing", async () => {
    const page = await newPage();
    try {
      // pin full motion: the host OS may itself prefer reduced motion
      await page.emulateMediaFeatures([
        { name: "prefers-reduced-motion", value: "no-preference" },
      ]);
      // idle: parked at the start of the empty line, ready to be typed over
      const cur = await page.$eval(".cursor", (el) => ({
        display: getComputedStyle(el).display,
        rect: (el as HTMLElement).getBoundingClientRect().toJSON(),
      }));
      expect(cur.display).not.toBe("none");
      const inputRect = await page.$eval("#cmd", (el) =>
        (el as HTMLElement).getBoundingClientRect().toJSON()
      );
      expect(Math.abs(cur.rect.x - inputRect.x)).toBeLessThan(3);
      // it flashes: drive its own timeline to 10% and 60% of the period —
      // visible in one phase, gone in the other (no wall clock, no period pin)
      const phases = await page.evaluate(() => {
        const el = document.querySelector(".cursor") as HTMLElement;
        const anim = el.getAnimations()[0];
        anim.pause();
        const dur = Number(
          (anim.effect as KeyframeEffect).getComputedTiming().duration
        );
        anim.currentTime = dur * 0.1;
        const on = parseFloat(getComputedStyle(el).opacity);
        anim.currentTime = dur * 0.6;
        const off = parseFloat(getComputedStyle(el).opacity);
        anim.play();
        return { on, off };
      });
      expect(phases.on).toBeGreaterThan(0);
      expect(phases.off).toBe(0);
      // it never intercepts: tapping where it sits focuses the native input
      const box = await page.$(".cursor").then((h) => h!.boundingBox());
      await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
      expect(
        await page.evaluate(
          () => (document.activeElement as HTMLElement | null)?.id ?? ""
        )
      ).toBe("cmd");
      // editing: the native caret owns the line, the block is gone
      await page.keyboard.type("help", { delay: 5 });
      expect(
        await page.$eval(".cursor", (el) => getComputedStyle(el).display)
      ).toBe("none");
      // native selection survives it: a keyboard select-all still spans
      // the real text (no fake caret eating the endpoints)
      await page.keyboard.press("Home");
      await page.keyboard.down("Shift");
      await page.keyboard.press("End");
      await page.keyboard.up("Shift");
      const sel = await page.$eval("#cmd", (el) => ({
        start: (el as HTMLInputElement).selectionStart,
        end: (el as HTMLInputElement).selectionEnd,
      }));
      expect(sel).toEqual({ start: 0, end: 4 });
      expect(
        await page.$eval(".cursor", (el) => getComputedStyle(el).display)
      ).toBe("none");
      // emptied and blurred: the affordance returns
      await page.keyboard.press("Enter");
      expect(await inputValue(page)).toBe("");
      await page.evaluate(() =>
        (document.activeElement as HTMLElement | null)?.blur?.()
      );
      expect(
        await page.$eval(".cursor", (el) => getComputedStyle(el).display)
      ).not.toBe("none");
    } finally {
      await page.close();
    }
  }, 30000);

  test("reduced motion keeps the cursor statically visible", async () => {
    const page = await newPage();
    try {
      await page.emulateMediaFeatures([
        { name: "prefers-reduced-motion", value: "reduce" },
      ]);
      // static: nothing animating on the block …
      expect(
        await page.$eval(".cursor", (el) => el.getAnimations().length)
      ).toBe(0);
      // … yet still visibly parked at the prompt
      const cur = await page.$eval(".cursor", (el) => ({
        display: getComputedStyle(el).display,
        opacity: parseFloat(getComputedStyle(el).opacity),
      }));
      expect(cur.display).not.toBe("none");
      expect(cur.opacity).toBeGreaterThan(0);
    } finally {
      await page.close();
    }
  }, 30000);
});

describe("commands", () => {
  test("unknown command errors and clears the input", async () => {
    const page = await newPage();
    try {
      await runCmd(page, "frobnicate");
      expect(await outText(page)).toContain("command not found: frobnicate");
      expect(await inputValue(page)).toBe("");
      await runCmd(page, "help");
      expect(await outText(page)).toContain("available commands");
    } finally {
      await page.close();
    }
  }, 30000);

  test("reserved/prototype names hit the ordinary error path", async () => {
    const page = await newPage();
    try {
      await runCmd(page, "constructor");
      await runCmd(page, "__proto__");
      await runCmd(page, "cat __proto__");
      await runCmd(page, "cat toString");
      const out = await outText(page);
      expect(out).toContain("command not found: constructor");
      expect(out).toContain("command not found: __proto__");
      expect(out).toContain("cat: __proto__: No such file or directory");
      expect(out).toContain("cat: toString: No such file or directory");
      // terminal still healthy afterwards
      await runCmd(page, "cat about.txt");
      expect(await outText(page)).toContain("János");
      expect(await inputValue(page)).toBe("");
    } finally {
      await page.close();
    }
  }, 30000);

  test("cat serves files, unknown files error", async () => {
    const page = await newPage();
    try {
      await runCmd(page, "cat skills.txt");
      expect(await outText(page)).toContain("Dataiku DSS");
      await runCmd(page, "cat nope.txt");
      expect(await outText(page)).toContain(
        "cat: nope.txt: No such file or directory"
      );
    } finally {
      await page.close();
    }
  }, 30000);
});

describe("keyboard", () => {
  test("Tab completes, exact input escapes focus natively", async () => {
    const page = await newPage();
    try {
      await page.focus("#cmd");
      await page.keyboard.type("he", { delay: 5 });
      expect(await page.$eval("#ghost", (el) => el.textContent)).toBe("lp");
      await page.keyboard.press("Tab");
      expect(await inputValue(page)).toBe("help");
      // exact input: Tab is native — focus must leave the prompt (headless
      // lands on body, headed browsers continue into chrome or wrap).
      await page.keyboard.press("Tab");
      const activeId = await page.evaluate(
        () => (document.activeElement as HTMLElement | null)?.id ?? ""
      );
      expect(activeId).not.toBe("cmd");
    } finally {
      await page.close();
    }
  }, 30000);

  test("Shift+Tab always moves focus back natively", async () => {
    const page = await newPage();
    try {
      await page.focus("#cmd");
      await page.keyboard.type("he", { delay: 5 });
      await page.keyboard.down("Shift");
      await page.keyboard.press("Tab");
      await page.keyboard.up("Shift");
      // focus leaves the prompt and the typed text is untouched — wherever
      // the browser orders next is its own business
      const activeId = await page.evaluate(
        () => (document.activeElement as HTMLElement | null)?.id ?? ""
      );
      expect(activeId).not.toBe("cmd");
      expect(await inputValue(page)).toBe("he");
    } finally {
      await page.close();
    }
  }, 30000);

  test("native caret and editing work in the prompt", async () => {
    const page = await newPage();
    try {
      await page.focus("#cmd");
      await page.keyboard.type("helo", { delay: 5 });
      await page.keyboard.press("ArrowLeft");
      expect(
        await page.$eval("#cmd", (el) => (el as HTMLInputElement).selectionStart)
      ).toBe(3);
      await page.keyboard.type("l", { delay: 5 });
      expect(await inputValue(page)).toBe("hello");
    } finally {
      await page.close();
    }
  }, 30000);

  test("ArrowRight accepts the ghost suggestion at end of input", async () => {
    const page = await newPage();
    try {
      await page.focus("#cmd");
      await page.keyboard.type("he", { delay: 5 });
      await page.keyboard.press("ArrowRight");
      expect(await inputValue(page)).toBe("help");
    } finally {
      await page.close();
    }
  }, 30000);

  test("history arrows navigate and restore the draft", async () => {
    const page = await newPage();
    try {
      await runCmd(page, "help");
      await runCmd(page, "about");
      await page.focus("#cmd");
      await page.keyboard.type("draft-", { delay: 5 });
      await page.keyboard.press("ArrowUp");
      expect(await inputValue(page)).toBe("about");
      await page.keyboard.press("ArrowUp");
      expect(await inputValue(page)).toBe("help");
      await page.keyboard.press("ArrowDown");
      expect(await inputValue(page)).toBe("about");
      await page.keyboard.press("ArrowDown");
      expect(await inputValue(page)).toBe("draft-");
    } finally {
      await page.close();
    }
  }, 30000);

  test("clicking the terminal focuses the prompt", async () => {
    const page = await newPage();
    try {
      await page.evaluate(
        () => (document.activeElement as HTMLElement)?.blur?.()
      );
      await page.click("#screen");
      const activeId = await page.evaluate(
        () => (document.activeElement as HTMLElement | null)?.id ?? ""
      );
      expect(activeId).toBe("cmd");
    } finally {
      await page.close();
    }
  }, 30000);

  

  test("IME Enter never submits; modified ArrowRight never accepts", async () => {
    const page = await newPage();
    try {
      await page.focus("#cmd");
      await page.keyboard.type("he", { delay: 5 });
      await page.evaluate(() => {
        document.getElementById("cmd")?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key: "Enter",
            isComposing: true,
            bubbles: true,
            cancelable: true,
          })
        );
      });
      expect(await outText(page)).toBe("");
      expect(await inputValue(page)).toBe("he");
      // Shift+ArrowRight extends a real selection instead of accepting
      await page.keyboard.press("ArrowLeft");
      await page.keyboard.down("Shift");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.up("Shift");
      expect(await inputValue(page)).toBe("he");
      const sel = await page.$eval("#cmd", (el) => ({
        start: (el as HTMLInputElement).selectionStart,
        end: (el as HTMLInputElement).selectionEnd,
      }));
      expect(sel).toEqual({ start: 1, end: 2 });
      // modified ArrowRight at end of input is native, not completion
      await page.keyboard.press("End");
      await page.keyboard.down("Control");
      await page.keyboard.press("ArrowRight");
      await page.keyboard.up("Control");
      expect(await inputValue(page)).toBe("he");
      expect(await page.$eval("#ghost", (el) => el.textContent)).toBe("lp");
    } finally {
      await page.close();
    }
  }, 30000);
});

describe("repos", () => {
  test("paginates fixtures and renders safe labeled links", async () => {
    const page = await newPage();
    try {
      await page.evaluate(() => localStorage.clear());
      const calls = await serveFixture(page, {
        1: FIXTURE_PAGE_1,
        2: FIXTURE_PAGE_2,
      });
      await runCmd(page, "repos");
      await page.waitForFunction(
        () => document.getElementById("out")?.textContent?.includes("evil-desc"),
        { timeout: 25000 }
      );
      // paginated, unauthenticated requests: full first page, then page two
      expect(calls).toHaveLength(2);
      expect(calls[0].url).toContain("/users/clssck/repos?per_page=100&page=1");
      expect(calls[1].url).toContain("page=2");
      for (const c of calls) expect(c.headers["authorization"]).toBeUndefined();
      const out = await outText(page);
      expect(out).toMatch(/103 public repos, most recently pushed first/);
      expect(out).not.toContain("fetching public repos");
      // flags, languages and recent-first order from fixture data
      expect(out).toContain("[fork]");
      expect(out).toContain("[archived]");
      expect(out).toContain("Python");
      const names = await page.$$eval("#out b", (els) =>
        els.map((el) => el.textContent)
      );
      expect(names).toHaveLength(103);
      expect(names.slice(0, 3)).toEqual([
        "fork-label",
        "archived-label",
        "evil-desc",
      ]);
      expect(names[names.length - 1]).toBe("repo-1");
      // hostile description stays inert text, never elements
      expect(await page.$("#out img")).toBeNull();
      expect(await page.$("#out script")).toBeNull();
      expect(out).toContain("<img src=x");
      // every rendered link is the safe fallback or a repo URL
      const hrefs = await page.$$eval("#out a", (els) =>
        els.map((a) => (a as HTMLAnchorElement).href)
      );
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) {
        const safe =
          href === FALLBACK_REPOS ||
          href.startsWith("https://github.com/clssck/");
        expect(safe).toBe(true);
      }
    } finally {
      await page.close();
    }
  }, 60000);

  test("clear while repos is pending drops the late result", async () => {
    const page = await newPage();
    try {
      await page.evaluate(() => localStorage.clear());
      const held = await holdApi(page);
      await page.focus("#cmd");
      await page.keyboard.type("repos", { delay: 5 });
      await page.keyboard.press("Enter");
      await held.seen;
      await page.keyboard.type("clear", { delay: 5 });
      await page.keyboard.press("Enter");
      held.release([
        fixtureRepo(1, {
          name: "late-result",
          html_url: "https://github.com/clssck/late-result",
        }),
      ]);
      // the held fetch settles (network idle) but the cleared command stays silent
      await page.waitForNetworkIdle({ timeout: 10000 });
      expect(await outText(page)).toBe("");
      // terminal still healthy afterwards
      await runCmd(page, "help");
      expect(await outText(page)).toContain("available commands");
    } finally {
      await page.close();
    }
  }, 60000);

  test("delayed repos result lands in place above later commands", async () => {
    const page = await newPage();
    try {
      await page.evaluate(() => localStorage.clear());
      const held = await holdApi(page);
      await page.focus("#cmd");
      await page.keyboard.type("repos", { delay: 5 });
      await page.keyboard.press("Enter");
      await held.seen;
      await page.keyboard.type("echo echomarker", { delay: 5 });
      await page.keyboard.press("Enter");
      held.release([
        fixtureRepo(1, {
          name: "held-result",
          html_url: "https://github.com/clssck/held-result",
        }),
      ]);
      await page.waitForFunction(
        () => document.getElementById("out")?.textContent?.includes("held-result"),
        { timeout: 25000 }
      );
      const out = await outText(page);
      expect(out).not.toContain("fetching public repos");
      expect(out.indexOf("held-result")).toBeLessThan(out.indexOf("echomarker"));
    } finally {
      await page.close();
    }
  }, 60000);

  
});

describe("no-JS", () => {
  test("identity, content and links survive without JavaScript", async () => {
    const page = await browser.newPage();
    try {
      await page.setViewport({ width: 1365, height: 768 });
      await page.setJavaScriptEnabled(false);
      await page.goto(BASE, { waitUntil: "domcontentloaded" });
      // the noscript fallback parses as real, visible DOM
      expect(await page.$eval(".term__name", (el) => el.textContent)).toContain(
        "János Földvárszki"
      );
      const tag = await page.$eval(".term__tag", (el) => el.textContent);
      expect(tag).toContain("Engineer");
      expect(tag).toContain("I make annoying things easier.");
      // native disclosures open without any script
      await page.click("#about summary");
      expect(await page.$eval("#about", (el) => (el as HTMLDetailsElement).open)).toBe(
        true
      );
      expect(await page.$eval("#about", (el) => el.textContent)).toContain(
        "Dataiku DSS"
      );
      await page.click("#projects summary");
      expect(
        await page.$eval(
          '#projects a[href="https://github.com/clssck/VeevaBro"]',
          (el) => el.textContent
        )
      ).toBe("VeevaBro");
      // no dead prompt or hint without JS
      expect(
        await page.$eval("#inputline", (el) => getComputedStyle(el).display)
      ).toBe("none");
      expect(
        await page.$eval("#terminal-hint", (el) => getComputedStyle(el).display)
      ).toBe("none");
    } finally {
      await page.close();
    }
  }, 30000);
});

describe("narrow viewport", () => {
  test("390px keeps input readable, cursor visible, no sideways scroll", async () => {
    const page = await newPage({ width: 390, height: 844 });
    try {
      const fontPx = parseFloat(
        await page.$eval("#cmd", (el) => getComputedStyle(el).fontSize)
      );
      expect(fontPx).toBeGreaterThanOrEqual(16);
      // the idle block still affords typing at small widths
      const cur = await page.$eval(".cursor", (el) => ({
        display: getComputedStyle(el).display,
        w: (el as HTMLElement).offsetWidth,
        h: (el as HTMLElement).offsetHeight,
      }));
      expect(cur.display).not.toBe("none");
      expect(cur.w).toBeGreaterThan(0);
      expect(cur.h).toBeGreaterThan(0);
      const overflow = await page.evaluate(
        () => document.scrollingElement!.scrollWidth <= window.innerWidth + 1
      );
      expect(overflow).toBe(true);
    } finally {
      await page.close();
    }
  }, 30000);
});

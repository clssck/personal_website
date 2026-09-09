# personal_website

The personal site of János Földvárszki — a single page: an animated backdrop
and a working terminal you can type into. Code stays tiny (~35 KB of
HTML + JS + CSS); the only image is one small cat illustration.

## What's new (terminal refresh)

- First screen is the terminal itself: name, Engineer role, tagline and
  shortcuts server-render inside the glass; about/projects live in native
  `<details>` so the page works with JS disabled.
- `projects` shows the curated five; `repos` lists every public repo live
  from the GitHub API (paginated, validated, short cache, safe links).
- Native visible prompt input (no fake caret), strict Tab rules, guarded
  command/file registries, async output tied to its command across `clear`.
- Truthful Engineer/Dataiku/Veeva copy; social card and metadata match.
- Regression tests: `bun test` (pure GitHub/terminal logic plus real-Chrome
  keyboard/focus/rendering checks against intercepted fixtures).

## Stack

- [Astro](https://astro.build) (static output, no client framework runtime)
- A "pop-up book" background diorama (`src/components/Scene.astro`): layered
  elements in a CSS 3D perspective stage that tilts toward the pointer
  (parallax), with canopy blobs, drifting +/dot/sparkle canvas particles,
  depth-of-field blurred leaves, and a focal Russian Blue cat batting a
  swinging yarn thread — the technique of the zustand demo, rebuilt with
  CSS/SVG/canvas. The cat is the one raster asset (`public/cat.webp`,
  AI-generated then background-removed).
- An interactive terminal REPL (`src/components/Terminal.astro`) — the
  centerpiece. Boots to a live native prompt. Supports `help`, `whoami`,
  `about`, `skills`, `projects`, `repos` (every public repo, live from the
  GitHub API), `github`, `neofetch`, `ls`/`cat`, `echo`, `date`, `fortune`,
  `clear`, with command history (↑/↓, draft kept) and fish-style inline
  autocomplete (ghost suggestion; Tab or → to accept, exact/empty input
  keeps native Tab).
- Graceful fallback: animation freezes (single frame) under
  `prefers-reduced-motion`, live-toggled without reload, and pauses while
  the tab is hidden. Visitor input and repo data are validated/escaped
  before rendering; the page stays readable with JS disabled.

## Develop

Requires [Bun](https://bun.sh) (package manager + script runner).

```sh
bun install

# dev server (run it in the background, then manage it)
bunx astro dev --background   # serves http://localhost:4321
bunx astro dev status         # is it running?
bunx astro dev logs           # tail its logs
bunx astro dev stop           # stop it (or `bunx astro dev --force` to replace a stale one)

bun run build                 # static site -> ./dist/
bun run preview               # preview the built site
bun test                      # pure + real-Chrome regression tests
```

Browser tests drive system Chrome via puppeteer-core (`CHROME_PATH` or a
well-known install) against intercepted API fixtures — no network, fully
deterministic; `bun test src/lib` runs the pure unit tests only. Live API
smoke (manual, not part of the suite): open the preview, run `repos`, and
expect every public repo, most recently pushed first, with fork/archived
labels and safe links.

## Structure

```text
src/
├── pages/index.astro        # the page (wires Scene + Terminal)
├── layouts/Base.astro       # <head>, meta/OG tags, favicon
├── components/Scene.astro    # diorama: parallax layers, particles, cat
├── components/Terminal.astro # interactive terminal + command registry
├── lib/profile.ts           # canonical identity/projects copy (SSR + terminal)
├── lib/github.ts            # public GitHub API: paginate, validate, cache
├── lib/terminal.ts          # pure completion/Tab/history/escape helpers
└── styles/global.css        # theme tokens, layout, terminal styling
tests/
└── browser/terminal.browser.test.ts  # real-Chrome terminal regression
public/
├── favicon.ico              # legacy browser fallback
├── favicon.svg              # JF monogram
├── robots.txt               # crawler policy + sitemap discovery
├── og.png                   # social card (1200x630)
└── cat.webp                 # focal Russian Blue cat (transparent)
```

`@astrojs/sitemap` generates `sitemap-index.xml` and the route sitemap during the production build.

## Deploy

Static site: `bun run build` writes plain files to `dist/`.

**Docker (EasyPanel / any Docker host):** the repo ships a `Dockerfile` that
builds with Bun and serves `dist/` via nginx on port 80 — EasyPanel builds it
straight from the repo, no config needed.

**Manual:** build and copy the static output anywhere:

```sh
bun install && bun run build      # -> dist/
# copy dist/ to the web root, e.g. nginx: root /var/www/janos; try_files $uri $uri/ =404;
```

Served at **ennivalo.com** and **kulcsly.uk**. Canonical / social-share URL is
`site` in `astro.config.mjs` (`https://ennivalo.com`); identity, GitHub and
project data live in `src/lib/profile.ts`.

## Later: a blog

The layout/components are already split for it. Add an Astro content collection
(`src/content/`) and a `src/pages/blog/[...slug].astro` route reusing
`Base.astro` — no rework of the current page needed. A `blog` command could
even list posts in the terminal.

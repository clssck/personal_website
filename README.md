# personal_website

The personal site of János Földvárszki — a single page: an animated backdrop
and a working shell you can type into. No client framework, no terminal
emulator library; the only image is one small cat illustration.

## Terminal

- First screen is an empty terminal: a blinking block at the bare prompt
  plus a one-line typing hint; visitors discover everything with commands
  (`help` first). No intro text, no shortcuts, nothing pre-run.
- It is a shell, not a command table: an in-memory filesystem with owners
  and permission bits (`/home/visitor` is writable for the visit, the rest
  is read-only, `/home/janos` is private), pipes, `&&`/`||`/`;`, `>`/`>>`/`<`
  redirects, `$VAR`, `$(…)`, globs, aliases, exit statuses, and more than
  fifty Unix-style commands with `man` pages. `fortune | cowsay > note.txt`
  works.
- Output is text with ANSI colours and OSC 8 links, rendered to escaped
  HTML; pipes and files receive plain text. Bare URLs become links.
- A foreground command owns the terminal until it finishes; Ctrl+C aborts
  it (or abandons the typed line), Ctrl+L clears, Ctrl+U kills to the
  start of the line. Keys typed meanwhile wait in the input.
- The window is a window: the red button (or `exit`) closes it, yellow
  minimises it to a launcher, green (or a double click on the title bar)
  zooms it; the title bar drags it and the edges and corners resize it.
  Minimising keeps the session, closing ends it, and the filesystem
  outlives both until the page reloads. Pointer-driven open and close fade
  with a slight scale; keyboard-driven ones are instant. At phone width the
  window stays put and only zoom applies. Without JS the three dots are
  decoration, not dead buttons.
- The block is a pure idle affordance — it disappears the moment the
  native input takes focus, so the real caret (and selection) owns all
  editing; under `prefers-reduced-motion` it stands still instead of
  flashing. Nothing ever autofocuses, so mobile gets no surprise keyboard.
- Identity, shortcuts and about/projects live in a `<noscript>` fallback:
  the page still reads (and links) with JS disabled; it is not shown
  when JS is enabled.
- Native visible prompt input and strict Tab rules (Tab is only taken when
  it completes or lists, so keyboard users can always leave the prompt);
  `projects` shows the curated set, `repos` lists every public repo live
  from the GitHub API (paginated, validated, short cache, safe links).
- `theme` switches the window between Catppuccin flavours (Mocha is the
  default) and the original night palette; the choice is remembered in
  `localStorage`.
- Regression tests: `bun test` (pure filesystem/interpreter/command/window
  geometry/GitHub logic plus real-Chrome keyboard/focus/rendering/window
  checks against intercepted fixtures, covering the empty start, the
  blink/static-reduced cursor and the no-JS page).

## Stack

- [Astro](https://astro.build) (static output, no client framework runtime)
- A "pop-up book" background diorama (`src/components/Scene.astro`): layered
  elements in a CSS 3D perspective stage that tilts toward the pointer
  (parallax), with canopy blobs, drifting +/dot/sparkle canvas particles,
  depth-of-field blurred leaves, and a focal Russian Blue cat batting a
  swinging yarn thread — the technique of the zustand demo, rebuilt with
  CSS/SVG/canvas. The yarn thread is clipped outside the terminal's
  bounds (rebuilt on resize/scaling), so it can never cross the prompt
  or output. The cat is the one raster asset (`public/cat.webp`,
  AI-generated then background-removed).
- A shell in the browser (`src/components/Terminal.astro` over
  `src/lib/shell/`) — the centerpiece. Boots to a live native prompt with
  command history (↑/↓, draft kept) and fish-style inline autocomplete for
  commands and paths (ghost suggestion; Tab or → to accept, exact/empty
  input keeps native Tab).
- Graceful fallback: animation freezes (single frame) under
  `prefers-reduced-motion`, live-toggled without reload, and pauses while
  the tab is hidden. Visitor input and repo data are validated/escaped
  before rendering; with JS disabled a `<noscript>` fallback carries the
  identity, links and about/projects content.

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
├── components/Terminal.astro # terminal window: prompt, keys, output, themes, window controls
├── lib/profile.ts           # canonical identity/projects copy (SSR + shell files)
├── lib/github.ts            # public GitHub API: paginate, validate, cache
├── lib/ansi.ts              # ANSI SGR / OSC 8 → escaped HTML
├── lib/terminal.ts          # pure Tab/escape helpers for the UI
├── lib/window.ts            # pure window geometry: clamp and resize
├── lib/shell/types.ts       # contracts: filesystem, commands, host, shell
├── lib/shell/vfs.ts         # in-memory filesystem with permissions
├── lib/shell/parse.ts       # tokenizer and parser
├── lib/shell/shell.ts       # interpreter: expansion, pipelines, completion
├── lib/shell/fs-image.ts    # the initial filesystem
├── lib/shell/commands/      # the commands, grouped by kind
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

# personal_website

The personal site of János Földvárszki — a single page: an animated backdrop
and a working terminal you can type into. Code stays tiny (~20 KB of
HTML + JS + CSS); the only image is one small cat illustration.

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
  centerpiece. Boots to a live blinking prompt. Supports `help`, `about`,
  `skills`, `github`, `neofetch`, `ls`/`cat`, `echo`, `date`, `fortune`,
  `clear`, with command history (↑/↓) and fish-style inline autocomplete
  (ghost suggestion; Tab or → to accept).
- Graceful fallback: animation freezes (single frame) under
  `prefers-reduced-motion`. Visitor input is HTML-escaped before rendering.

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
```

## Structure

```text
src/
├── pages/index.astro        # the page (wires Scene + Terminal)
├── layouts/Base.astro       # <head>, meta/OG tags, favicon
├── components/Scene.astro    # diorama: parallax layers, particles, cat
├── components/Terminal.astro # interactive terminal + command registry
└── styles/global.css        # theme tokens, layout, terminal styling
public/
├── favicon.svg              # JF monogram
├── og.png                   # social card (1200x630)
└── cat.webp                 # focal Russian Blue cat (transparent)
```

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
`site` in `astro.config.mjs` (`https://ennivalo.com`); the GitHub link is the
`github` const in `src/pages/index.astro`.

## Later: a blog

The layout/components are already split for it. Add an Astro content collection
(`src/content/`) and a `src/pages/blog/[...slug].astro` route reusing
`Base.astro` — no rework of the current page needed. A `blog` command could
even list posts in the terminal.

/**
 * Canonical profile data — the single source of truth for site identity,
 * server-rendered content and the files in the terminal's home directory.
 * Keep page copy here so static HTML and the shell never drift apart.
 */

export const SITE = {
  name: "János Földvárszki",
  role: "Engineer",
  tagline: "I make annoying things easier.",
  githubUser: "clssck",
  githubUrl: "https://github.com/clssck",
  reposUrl: "https://github.com/clssck?tab=repositories",
  apiReposUrl: "https://api.github.com/users/clssck/repos",
  title: "János Földvárszki — Engineer",
  description:
    "Personal site of János Földvárszki — Engineer. I make annoying things easier: Go and TypeScript tooling for obscure software, a working shell in the browser, and a cat.",
} as const;

export interface Project {
  /** GitHub repo slug; public repos only. */
  slug: string;
  name: string;
  description: string;
  /** Main language or runtime, as one short label. */
  stack: string;
}

/** Curated public projects (all live at github.com/clssck/<slug>). */
export const PROJECTS: Project[] = [
  {
    slug: "dataiku-sdk",
    name: "dataiku-sdk",
    description:
      "SDK and dss CLI for automating Dataiku DSS, built for coding agents to drive. Schema-first, validated at runtime.",
    stack: "TypeScript",
  },
  {
    slug: "SP_Catalog",
    name: "SP_Catalog",
    description:
      "Terminal UI that crawls SharePoint directories and catalogs them into SQLite.",
    stack: "Go",
  },
  {
    slug: "sqltoerdiagram",
    name: "sqltoerdiagram",
    description:
      "dbt-erd: point it at a dbt project and get one self-contained HTML file with interactive ER and lineage diagrams.",
    stack: "JavaScript",
  },
  {
    slug: "researcher-mcp",
    name: "researcher-mcp",
    description:
      "MCP server that gives a coding assistant a research desk: search, documentation lookup and API discovery.",
    stack: "JavaScript",
  },
  {
    slug: "md2pdf-cli",
    name: "md2pdf-cli",
    description:
      "Markdown to PDF from the command line. Mermaid diagrams survive the trip.",
    stack: "JavaScript",
  },
  {
    slug: "Veeva_RegiNoti",
    name: "Veeva_RegiNoti",
    description:
      "Vault record trigger that tells the responsible person when a registration changes state.",
    stack: "Java",
  },
];

/** Longer story for `about` and the #about section. */
export const ABOUT = [
  "Hi — I'm János, an engineer.",
  "I build tools for the parts of work that should not need this many clicks: SDKs, CLIs and browser extensions, mostly in Go and TypeScript, usually for software nobody else wants to touch.",
  "This site is a shell in a cat diorama. Type help to poke around.",
] as const;

/** Truthful skill/tooling lines for `skills` and neofetch. */
export const SKILLS = [
  "languages — Go · TypeScript · Python when cornered",
  "tooling — Bun · Astro · TypeBox · Bubble Tea · SQLite",
  "habitat — obscure enterprise software, documented or not",
] as const;

export function projectUrl(slug: string): string {
  return `${SITE.githubUrl}/${slug}`;
}

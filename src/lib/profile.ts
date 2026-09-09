/**
 * Canonical profile data — the single source of truth for site identity,
 * server-rendered content and terminal commands. Keep page copy here so
 * static HTML and the interactive terminal never drift apart.
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
    "Personal site of János Földvárszki — Engineer. I make annoying things easier: Dataiku DSS and Veeva Vault RIM tooling, an interactive terminal, and a cat.",
} as const;

export interface Project {
  /** GitHub repo slug; public repos only. */
  slug: string;
  name: string;
  description: string;
}

/** Curated public projects (all live at github.com/clssck/<slug>). */
export const PROJECTS: Project[] = [
  {
    slug: "dataiku-sdk",
    name: "dataiku-sdk",
    description:
      "Schema-first TypeScript SDK/CLI for Dataiku DSS — TypeBox schemas, runtime validation, Bun.",
  },
  {
    slug: "VeevaBro",
    name: "VeevaBro",
    description: "Browser extension for editing Vault RIM lifecycles.",
  },
  {
    slug: "VaultRIM_LC_CLI",
    name: "VaultRIM_LC_CLI",
    description: "Command-line tool for Vault RIM lifecycle changes.",
  },
  {
    slug: "Veeva_RegiNoti",
    name: "Veeva_RegiNoti",
    description:
      "Registration state-change notifications to the responsible person.",
  },
  {
    slug: "HelpdeskPOC",
    name: "HelpdeskPOC",
    description:
      "Proof of concept delivering helpdesk tasks directly into Vault RIM.",
  },
];

/** Short introduction shown on the first screen (below the name). */
export const INTRO = [
  "Engineer building SDKs, CLI tools and browser extensions around",
  "Dataiku DSS and Veeva Vault RIM — the boring, repetitive",
  "parts of work get scripted until they're one command.",
] as const;

/** Longer story for `about` and the #about section. */
export const ABOUT = [
  "Hi — I'm János, an engineer.",
  "Most of my work is tooling around Dataiku DSS and Veeva Vault RIM: an SDK and CLI for DSS, plus browser extensions and automations for Vault RIM lifecycles and registrations.",
  "This site is a terminal in a cat diorama. Type help to poke around.",
] as const;

/** Truthful skill/tooling lines for `skills` and neofetch. */
export const SKILLS = [
  "Dataiku DSS — SDKs · CLI · projects · automation",
  "Veeva Vault RIM — lifecycles · registrations · browser extensions",
  "tooling — TypeScript · Bun · Astro · TypeBox · Python",
] as const;

export function projectUrl(slug: string): string {
  return `${SITE.githubUrl}/${slug}`;
}

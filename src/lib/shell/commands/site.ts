import { PROJECTS, SITE, projectUrl } from "../../profile";
import { FsError, type CommandContext, type CommandSpec } from "../types";
import { fsFail, humanDuration, joinLines, parseArgs, splitLines, uptimeSeconds } from "./util";

const GROUP_ORDER = ["site", "files", "text", "shell", "system"] as const;

const help: CommandSpec = {
  name: "help",
  group: "site",
  summary: "list the available commands",
  usage: "help",
  run(ctx) {
    const visible = ctx.shell.specs().filter((spec) => !spec.hidden);
    const width = Math.max(...visible.map((spec) => spec.name.length)) + 2;
    let out = "";
    const groups: string[] = [...GROUP_ORDER, "other"];
    for (const group of groups) {
      const members = visible
        .filter((spec) => (spec.group ?? "other") === group)
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      if (members.length === 0) continue;
      out += `${out ? "\n" : ""}${ctx.c.bold(ctx.c.cyan(group))}\n`;
      for (const spec of members) {
        out += `  ${spec.name.padEnd(width)}${ctx.c.dim(spec.summary)}\n`;
      }
    }
    out += "\ntip: pipes and redirects work, e.g. ls | grep md > found.txt\n";
    out += "tip: Tab completes. man <command> explains one.\n";
    ctx.out(out);
  },
};

/** `about` and `skills` just print a file from the home directory. */
function printHomeFile(ctx: CommandContext, file: string): number {
  const typed = `~/${file}`;
  try {
    ctx.out(ctx.fs.readFile(ctx.path(typed)));
    return 0;
  } catch (error) {
    fsFail(ctx, typed, error);
    return 1;
  }
}

const about: CommandSpec = {
  name: "about",
  group: "site",
  summary: "who is behind this",
  usage: "about",
  run: (ctx) => printHomeFile(ctx, "about.txt"),
};

const skills: CommandSpec = {
  name: "skills",
  group: "site",
  summary: "languages, tooling and habitat",
  usage: "skills",
  run: (ctx) => printHomeFile(ctx, "skills.txt"),
};

const projects: CommandSpec = {
  name: "projects",
  group: "site",
  summary: "selected public projects",
  usage: "projects",
  man: "Prints each project with its stack and a one-line description; names link to GitHub. Piped, it prints tab-separated name, stack and url.",
  run(ctx) {
    if (!ctx.isTTY) {
      ctx.out(
        joinLines(PROJECTS.map((p) => `${p.name}\t${p.stack}\t${projectUrl(p.slug)}`))
      );
      return;
    }
    ctx.out(
      PROJECTS.map(
        (p) =>
          `${ctx.c.link(projectUrl(p.slug), ctx.c.bold(p.name))}  ${ctx.c.dim(p.stack)}\n  ${p.description}\n`
      ).join("\n")
    );
  },
};

const repos: CommandSpec = {
  name: "repos",
  group: "site",
  summary: "list public repositories on github",
  usage: "repos",
  man: "Fetches the public repositories of the site owner from GitHub, most recently pushed first. This is the one command that talks to the network. Piped, it prints tab-separated name, language and url.",
  async run(ctx) {
    const result = await ctx.host.loadRepos();
    if (ctx.signal.aborted) return 130;
    if (!result.ok) {
      ctx.err(`${result.message}\n${ctx.c.link(result.fallback)}\n`);
      return 1;
    }
    const { repos: list } = result;
    if (!ctx.isTTY) {
      ctx.out(joinLines(list.map((r) => `${r.name}\t${r.language ?? "-"}\t${r.url}`)));
      return 0;
    }
    if (list.length === 0) {
      ctx.out("no public repos right now. try projects for the curated list.\n");
      return 0;
    }
    let out = `${list.length} public ${list.length === 1 ? "repo" : "repos"}, most recently pushed first\n`;
    for (const r of list) {
      const parts = [ctx.c.link(r.url, ctx.c.bold(r.name))];
      if (r.archived) parts.push(ctx.c.yellow("[archived]"));
      if (r.fork) parts.push(ctx.c.yellow("[fork]"));
      if (r.language) parts.push(ctx.c.dim(r.language));
      out += `${parts.join("  ")}\n  ${r.description ?? ctx.c.dim("(no description)")}\n`;
    }
    out += `\nmore at ${ctx.c.link(SITE.reposUrl)}\n`;
    ctx.out(out);
    return 0;
  },
};

const github: CommandSpec = {
  name: "github",
  group: "site",
  summary: "open the github profile",
  usage: "github",
  run(ctx) {
    ctx.host.open(SITE.githubUrl);
    ctx.out(`opening ${ctx.c.link(SITE.githubUrl)}\n`);
  },
};

/** The URL if `text` is an http(s) URL, else null. Nothing else may reach `host.open`. */
function webUrl(text: string): string | null {
  try {
    const url = new URL(text.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

const open: CommandSpec = {
  name: "open",
  group: "site",
  summary: "open a url or a .url file in a new tab",
  usage: "open <url|file>",
  man: "A http(s) URL opens directly. A file whose first line is a http(s) URL (like the ones in ~/links) opens that URL.",
  run(ctx) {
    const target = ctx.args[0];
    if (target === undefined) {
      ctx.err("open: missing target\n");
      return 2;
    }
    let url: string | null = null;
    if (/^https?:\/\//i.test(target)) {
      url = webUrl(target);
    } else {
      try {
        url = webUrl(splitLines(ctx.fs.readFile(ctx.path(target)))[0] ?? "");
      } catch (error) {
        if (!(error instanceof FsError)) throw error;
      }
    }
    if (url === null) {
      ctx.err(`open: ${target}: nothing to open\n`);
      return 1;
    }
    ctx.host.open(url);
    ctx.out(`opening ${ctx.c.link(url)}\n`);
  },
};

const CAT_ART = [
  "      /\\_/\\    ",
  "     /     \\   ",
  "    ( o   o )  ",
  "    (  =^=  )  ",
  "     )     (   ",
  "    (  ) (  )  ",
  "   (__(___)__) ",
];

const neofetch: CommandSpec = {
  name: "neofetch",
  group: "site",
  summary: "show the system summary, with a cat",
  usage: "neofetch",
  run(ctx) {
    const label = (text: string) => ctx.c.bold(ctx.c.cyan(text.padEnd(7)));
    const rows = [
      ctx.c.bold(ctx.c.cyan("visitor@janos")),
      "-".repeat("visitor@janos".length),
      `${label("name")}${SITE.name}`,
      `${label("role")}${SITE.role}`,
      `${label("stack")}Go, TypeScript`,
      `${label("shell")}zsh`,
      `${label("uptime")}${humanDuration(uptimeSeconds(ctx))}`,
      `${label("theme")}${ctx.host.theme()}`,
      `${label("github")}${ctx.c.link(SITE.githubUrl)}`,
    ];
    if (ctx.host.cols() < 56) {
      ctx.out(joinLines(rows));
      return;
    }
    const artWidth = Math.max(...CAT_ART.map((line) => line.length));
    const lines: string[] = [];
    for (let i = 0; i < Math.max(rows.length, CAT_ART.length); i++) {
      const art = (CAT_ART[i] ?? "").padEnd(artWidth);
      lines.push(`${ctx.c.yellow(art)}  ${rows[i] ?? ""}`.trimEnd());
    }
    ctx.out(joinLines(lines));
  },
};

const fortune: CommandSpec = {
  name: "fortune",
  group: "site",
  summary: "print a random engineering aphorism",
  usage: "fortune",
  run(ctx) {
    let lines: string[];
    try {
      lines = splitLines(ctx.fs.readFile("/usr/share/fortunes"));
    } catch (error) {
      fsFail(ctx, "/usr/share/fortunes", error);
      return 1;
    }
    const pick = lines[Math.floor(ctx.host.random() * lines.length)];
    if (pick !== undefined) ctx.out(pick + "\n");
  },
};

const BUBBLE_WIDTH = 40;

/** Greedy word wrap that keeps paragraph breaks and splits words longer than the width. */
function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\s+$/, "").split("\n")) {
    const words = paragraph.split(/\s+/).filter(Boolean);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (let word of words) {
      while (word.length > width) {
        if (current) lines.push(current);
        lines.push(word.slice(0, width));
        current = "";
        word = word.slice(width);
      }
      if (current && current.length + 1 + word.length > width) {
        lines.push(current);
        current = word;
      } else {
        current = current ? `${current} ${word}` : word;
      }
    }
    if (current) lines.push(current);
  }
  return lines;
}

const cowsay: CommandSpec = {
  name: "cowsay",
  group: "site",
  summary: "a cat says things",
  usage: "cowsay [text…]",
  man: "The cat says the arguments, or standard input: fortune | cowsay. Lines wrap at 40 columns.",
  run(ctx) {
    const text = ctx.args.length ? ctx.args.join(" ") : ctx.hasStdin ? ctx.stdin : "";
    const lines = text.trim() === "" ? [] : wrapText(text, BUBBLE_WIDTH);
    if (lines.length === 0) {
      ctx.err("cowsay: nothing to say\n");
      return 1;
    }
    const width = Math.max(...lines.map((line) => line.length));
    const edges =
      lines.length === 1
        ? [["<", ">"]]
        : lines.map((_, i) => (i === 0 ? ["/", "\\"] : i === lines.length - 1 ? ["\\", "/"] : ["|", "|"]));
    const body = lines.map((line, i) => `${edges[i]![0]} ${line.padEnd(width)} ${edges[i]![1]}`);
    ctx.out(
      [
        ` ${"_".repeat(width + 2)}`,
        ...body,
        ` ${"-".repeat(width + 2)}`,
        "        \\",
        "         \\  /\\_/\\",
        "          \\( o.o )",
        "            > ^ <",
      ].join("\n") + "\n"
    );
  },
};

const theme: CommandSpec = {
  name: "theme",
  group: "site",
  summary: "list or switch colour themes",
  usage: "theme [name]",
  man: "With no argument lists the themes and marks the current one; with a name switches to it.",
  run(ctx) {
    const parsed = parseArgs(ctx, {});
    if (!parsed) return 2;
    const name = parsed.operands[0];
    if (name === undefined) {
      const current = ctx.host.theme();
      ctx.out(
        joinLines(ctx.host.themes().map((t) => (t === current ? `* ${ctx.c.bold(t)}` : `  ${t}`)))
      );
      return 0;
    }
    if (!ctx.host.setTheme(name)) {
      ctx.err(`theme: no such theme: ${name}\n`);
      return 1;
    }
    ctx.out(`theme: ${name}\n`);
    return 0;
  },
};

export const SITE_COMMANDS: CommandSpec[] = [
  help, about, skills, projects, repos, github, open, neofetch, fortune, cowsay, theme,
];

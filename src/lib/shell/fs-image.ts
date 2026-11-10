/**
 * The initial filesystem the shell boots with. Home-directory files are
 * generated from profile.ts so the shell and the static page never drift
 * apart; /bin is generated from the command registry.
 */
import { ABOUT, PROJECTS, SITE, SKILLS, projectUrl } from "../profile";
import type { CommandSpec } from "./types";
import { dir, file, type DirSpec, type FileSpec } from "./vfs";

export const DEFAULT_ENV: Record<string, string> = {
  USER: "visitor",
  HOME: "/home/visitor",
  PWD: "/home/visitor",
  SHELL: "/bin/zsh",
  PATH: "/bin",
  TERM: "xterm-256color",
  LANG: "en_US.UTF-8",
  HOSTNAME: "janos",
};

export const DEFAULT_ALIASES: Record<string, string> = {
  ll: "ls -la",
  la: "ls -a",
  l: "ls -1",
  "..": "cd ..",
  cls: "clear",
};

const FORTUNES = [
  "It works on my machine. Your machine is not my machine.",
  "There is no cloud, just other people's computers.",
  "The fastest code is the code that never runs.",
  "Every legacy system was somebody's greenfield project.",
  "A temporary fix is the most permanent thing in software.",
  "If it hurts, do it more often. If it still hurts, write a script.",
  "Naming things is hard. Renaming them is harder.",
  "The documentation is accurate as of a version nobody runs.",
  "Weeks of coding can save you hours of planning.",
  "The bug is always in the last place you look, because then you stop looking.",
  "Nothing is more permanent than a TODO comment.",
];

const README = `# visitor's home

this is a shell running in your browser. the filesystem lives in memory
and resets when you reload the page. nothing leaves the tab.

five things to try:

  ls -la                     list everything here, dotfiles included
  cat about.txt              read the short version
  cat projects/*.md | grep stack
  tree ~                     see the whole home directory
  theme                      list colour themes, then: theme <name>

help lists every command. man <command> explains one.
`;

const MOTD = `welcome to janos. everything here is in memory and gone on reload.
type help for commands. the cat does not take requests.
`;

const OS_RELEASE = `NAME="JanOS"
VERSION="1.0 (static)"
ID=janos
PRETTY_NAME="JanOS 1.0 (static)"
`;

const PASSWD = `root:x:0:0:root:/root:/bin/zsh
janos:x:1000:1000:${SITE.name}:/home/janos:/bin/zsh
visitor:x:1001:1001:visitor:/home/visitor:/bin/zsh
cat:x:1002:1002:the cat:/var/empty:/bin/false
`;

const CAT_LOG = `cat: woke up
cat: sat on the keyboard
cat: knocked a pen off the desk
cat: ignored SIGTERM
cat: went back to sleep
`;

/** Shell-quote a value with single quotes, as `alias` prints it. */
export function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function buildFsImage(
  commands: readonly CommandSpec[],
  opts: { startedAt: number; now: () => number }
): DirSpec {
  const { startedAt, now } = opts;

  const bin: Record<string, FileSpec> = {};
  for (const spec of commands) {
    if (spec.hidden) continue;
    bin[spec.name] = file(`#!/bin/zsh\n# ${spec.summary}\n`, { mode: 0o755 });
  }

  const projects: Record<string, FileSpec> = {};
  for (const p of PROJECTS) {
    projects[`${p.slug}.md`] = file(
      `# ${p.name}\n\n${p.description}\n\nstack: ${p.stack}\nurl: ${projectUrl(p.slug)}\n`
    );
  }

  const zshrc =
    "# ~/.zshrc\n# read once at boot. edits here do nothing until the page reloads, and then they are gone.\n" +
    Object.entries(DEFAULT_ALIASES)
      .map(([name, value]) => `alias ${name}=${singleQuote(value)}\n`)
      .join("");

  const uptime = () => {
    const seconds = Math.max(0, (now() - startedAt) / 1000).toFixed(2);
    return `${seconds} ${seconds}\n`;
  };

  return dir(
    {
      bin: dir(bin),
      dev: dir({ null: file("", { sink: true, mode: 0o666 }) }),
      etc: dir({
        hostname: file("janos\n"),
        motd: file(MOTD),
        "os-release": file(OS_RELEASE),
        passwd: file(PASSWD),
        shells: file("/bin/zsh\n"),
      }),
      home: dir({
        janos: dir(
          { "notes.txt": file("nothing to see here.\n") },
          { mode: 0o700, owner: "janos" }
        ),
        visitor: dir(
          {
            "README.md": file(README),
            "about.txt": file(ABOUT.join("\n\n") + "\n"),
            "skills.txt": file(SKILLS.join("\n") + "\n"),
            projects: dir(projects),
            links: dir({
              "github.url": file(SITE.githubUrl + "\n"),
              "repos.url": file(SITE.reposUrl + "\n"),
            }),
            ".zshrc": file(zshrc),
            secrets: dir({}, { mode: 0o700, owner: "root" }),
          },
          { owner: "visitor" }
        ),
      }),
      proc: dir({
        uptime: file(uptime, { mode: 0o444 }),
        version: file("JanOS version 1.0 (visitor@janos) (bun, astro) #1 SMP static\n", {
          mode: 0o444,
        }),
      }),
      tmp: dir({}, { mode: 0o777 }),
      usr: dir({ share: dir({ fortunes: file(FORTUNES.join("\n") + "\n") }) }),
      var: dir({ log: dir({ "cat.log": file(CAT_LOG) }) }),
    },
    { owner: "root" }
  );
}

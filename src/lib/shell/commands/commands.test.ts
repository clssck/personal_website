import { describe, expect, test } from "bun:test";
import type { RepoInfo, ReposResult } from "../../github";
import { PROJECTS } from "../../profile";
import { stripAnsi } from "../style";
import { COMMANDS } from "./index";
import { createSession, runCommand, type RunOptions, type RunResult, type Session } from "./testing";

const ESC = "\u001b";

/** Run several commands against one session; returns a runner bound to it. */
function shellSession(): {
  session: Session;
  run: (name: string, args: string[], opts?: RunOptions) => Promise<RunResult>;
} {
  const session = createSession();
  return { session, run: (name, args, opts) => runCommand(name, args, { ...opts, session }) };
}

const repo = (over: Partial<RepoInfo>): RepoInfo => ({
  id: 1,
  name: "thing",
  url: "https://github.com/clssck/thing",
  description: "does a thing",
  language: "Go",
  archived: false,
  fork: false,
  pushedAt: "2026-01-01T00:00:00Z",
  ...over,
});

describe("ls", () => {
  test("hides dotfiles unless -a, which also lists . and ..", async () => {
    const plain = await runCommand("ls", []);
    expect(plain.out.split("\n")).not.toContain(".zshrc");
    expect(plain.out.split("\n")).toContain("README.md");
    const all = await runCommand("ls", ["-a"]);
    const names = all.out.split("\n");
    expect(names).toContain(".zshrc");
    expect(names).toContain(".");
    expect(names).toContain("..");
  });

  test("-l shows mode, owner, size and name", async () => {
    const { out } = await runCommand("ls", ["-l"]);
    expect(out).toMatch(/^drwxr-xr-x visitor +4096 [A-Z][a-z]{2} [ \d]\d \d\d:\d\d projects$/m);
    expect(out).toMatch(/^-rw-r--r-- visitor +\d+ [A-Z][a-z]{2} [ \d]\d \d\d:\d\d README\.md$/m);
  });

  test("a terminal gets columns, colour and slashes; a pipe gets one name per line", async () => {
    const tty = await runCommand("ls", [], { isTTY: true });
    const piped = await runCommand("ls", []);
    expect(piped.out).not.toContain(ESC);
    expect(piped.out).not.toContain("projects/");
    const entries = piped.out.trimEnd().split("\n");
    expect(entries.length).toBeGreaterThan(3);
    expect(tty.out).toContain(ESC);
    const lines = stripAnsi(tty.out).trimEnd().split("\n");
    expect(lines.length).toBeLessThan(entries.length);
    expect(stripAnsi(tty.out)).toContain("projects/");
  });

  test("columns fit the terminal width", async () => {
    const { out } = await runCommand("ls", [], { isTTY: true, host: { cols: () => 24 } });
    for (const line of stripAnsi(out).split("\n")) expect(line.length).toBeLessThanOrEqual(24);
  });

  test("several operands list files first, then each directory under a header", async () => {
    const { out } = await runCommand("ls", ["about.txt", "links", "projects"]);
    expect(out.startsWith("about.txt\n\nlinks:\n")).toBe(true);
    expect(out).toContain("\nprojects:\n");
  });

  test("a missing or forbidden directory fails with status 1", async () => {
    const missing = await runCommand("ls", ["nope"]);
    expect(missing.err).toBe("ls: nope: No such file or directory\n");
    expect(missing.status).toBe(1);
    const denied = await runCommand("ls", ["/home/janos"]);
    expect(denied.err).toBe("ls: /home/janos: Permission denied\n");
    expect(denied.status).toBe(1);
  });
});

describe("cd and pwd", () => {
  test("cd into a directory, back with -, and home with no argument", async () => {
    const { run, session } = shellSession();
    expect((await run("cd", ["projects"])).status).toBe(0);
    expect(session.cwd).toBe("/home/visitor/projects");
    const back = await run("cd", ["-"]);
    expect(back.out).toBe("/home/visitor\n");
    expect(session.cwd).toBe("/home/visitor");
    await run("cd", ["/tmp"]);
    await run("cd", []);
    expect(session.cwd).toBe("/home/visitor");
    expect((await run("pwd", [])).out).toBe("/home/visitor\n");
  });

  test("a missing path, a file and a forbidden directory", async () => {
    const missing = await runCommand("cd", ["nope"]);
    expect(missing.err).toBe("cd: no such file or directory: nope\n");
    expect(missing.status).toBe(1);
    const file = await runCommand("cd", ["about.txt"]);
    expect(file.err).toBe("cd: not a directory: about.txt\n");
    expect(file.status).toBe(1);
    const denied = await runCommand("cd", ["/home/janos"]);
    expect(denied.err).toBe("cd: permission denied: /home/janos\n");
    expect(denied.status).toBe(1);
    expect(denied.cwd).toBe("/home/visitor");
  });

  test("cd - without a previous directory fails", async () => {
    const result = await runCommand("cd", ["-"]);
    expect(result.status).toBe(1);
  });
});

describe("cat", () => {
  test("a missing file is reported as typed and the status is 1", async () => {
    const result = await runCommand("cat", ["nope.txt"]);
    expect(result.err).toBe("cat: nope.txt: No such file or directory\n");
    expect(result.status).toBe(1);
  });

  test("prints stdin without operands and for -", async () => {
    expect((await runCommand("cat", [], { stdin: "hi\n" })).out).toBe("hi\n");
    expect((await runCommand("cat", ["-"], { stdin: "hi\n" })).out).toBe("hi\n");
  });

  test("keeps going past a failing operand", async () => {
    const result = await runCommand("cat", ["nope", "links/github.url"]);
    expect(result.out).toBe("https://github.com/clssck\n");
    expect(result.status).toBe(1);
  });

  test("-n numbers lines", async () => {
    const { out } = await runCommand("cat", ["-n"], { stdin: "a\nb\n" });
    expect(out).toBe("     1\ta\n     2\tb\n");
  });

  test("another user's home is permission denied", async () => {
    const result = await runCommand("cat", ["/home/janos/x"]);
    expect(result.err).toBe("cat: /home/janos/x: Permission denied\n");
    expect(result.status).toBe(1);
  });

  test("a directory cannot be read", async () => {
    const result = await runCommand("cat", ["projects"]);
    expect(result.err).toBe("cat: projects: Is a directory\n");
  });
});

describe("changing the filesystem", () => {
  test("mkdir, touch and rm", async () => {
    const { run, session } = shellSession();
    expect((await run("mkdir", ["a"])).status).toBe(0);
    await run("touch", ["a/f.txt"]);
    expect(session.fs.stat("/home/visitor/a/f.txt")?.type).toBe("file");
    expect((await run("ls", ["a"])).out).toBe("f.txt\n");
    const exists = await run("mkdir", ["a"]);
    expect(exists.err).toBe("mkdir: a: File exists\n");
    expect(exists.status).toBe(1);
    expect((await run("mkdir", ["-p", "a"])).status).toBe(0);
    expect((await run("mkdir", ["-p", "x/y/z"])).status).toBe(0);
    expect(session.fs.stat("/home/visitor/x/y/z")?.type).toBe("dir");
    await run("rm", ["a/f.txt"]);
    expect(session.fs.stat("/home/visitor/a/f.txt")).toBeNull();
  });

  test("touch keeps the content of an existing file", async () => {
    const { run, session } = shellSession();
    await run("touch", ["about.txt"]);
    expect(session.fs.readFile("/home/visitor/about.txt").length).toBeGreaterThan(10);
  });

  test("rm refuses a directory without -r, removes it with -r", async () => {
    const { run, session } = shellSession();
    const refused = await run("rm", ["projects"]);
    expect(refused.err).toBe("rm: projects: is a directory\n");
    expect(refused.status).toBe(1);
    expect(session.fs.stat("/home/visitor/projects")?.type).toBe("dir");
    expect((await run("rm", ["-r", "projects"])).status).toBe(0);
    expect(session.fs.stat("/home/visitor/projects")).toBeNull();
  });

  test("rm reports a missing operand unless -f", async () => {
    const loud = await runCommand("rm", ["nope"]);
    expect(loud.err).toBe("rm: nope: No such file or directory\n");
    expect(loud.status).toBe(1);
    const quiet = await runCommand("rm", ["-f", "nope"]);
    expect(quiet.err).toBe("");
    expect(quiet.status).toBe(0);
  });

  test("rmdir removes only empty directories", async () => {
    const { run } = shellSession();
    await run("mkdir", ["empty"]);
    expect((await run("rmdir", ["empty"])).status).toBe(0);
    const full = await run("rmdir", ["projects"]);
    expect(full.err).toBe("rmdir: projects: Directory not empty\n");
    expect((await run("rmdir", ["about.txt"])).err).toBe("rmdir: about.txt: Not a directory\n");
  });

  test("cp copies a file, into a directory, and directories with -r", async () => {
    const { run, session } = shellSession();
    await run("cp", ["about.txt", "copy.txt"]);
    expect(session.fs.readFile("/home/visitor/copy.txt")).toBe(
      session.fs.readFile("/home/visitor/about.txt")
    );
    await run("mkdir", ["box"]);
    await run("cp", ["about.txt", "skills.txt", "box"]);
    expect(session.fs.readdir("/home/visitor/box")).toEqual(["about.txt", "skills.txt"]);
    const plain = await run("cp", ["links", "links2"]);
    expect(plain.status).toBe(1);
    expect((await run("cp", ["-r", "links", "links2"])).status).toBe(0);
    expect(session.fs.readdir("/home/visitor/links2")).toEqual(["github.url", "repos.url"]);
  });

  test("cp with several sources needs a directory destination", async () => {
    const result = await runCommand("cp", ["about.txt", "skills.txt", "nope"]);
    expect(result.err).toBe("cp: target 'nope' is not a directory\n");
    expect(result.status).toBe(1);
  });

  test("mv renames and moves into directories", async () => {
    const { run, session } = shellSession();
    await run("mv", ["about.txt", "bio.txt"]);
    expect(session.fs.stat("/home/visitor/about.txt")).toBeNull();
    expect(session.fs.stat("/home/visitor/bio.txt")?.type).toBe("file");
    await run("mv", ["bio.txt", "links"]);
    expect(session.fs.stat("/home/visitor/links/bio.txt")?.type).toBe("file");
    const missing = await run("mv", ["nope", "x"]);
    expect(missing.err).toBe("mv: nope: No such file or directory\n");
  });

  test("writing outside home is denied", async () => {
    const touch = await runCommand("touch", ["/etc/x"]);
    expect(touch.err).toBe("touch: /etc/x: Permission denied\n");
    expect(touch.status).toBe(1);
    const mkdir = await runCommand("mkdir", ["/x"]);
    expect(mkdir.status).toBe(1);
    const rm = await runCommand("rm", ["/etc/hostname"]);
    expect(rm.err).toBe("rm: /etc/hostname: Permission denied\n");
    const tmp = await runCommand("touch", ["/tmp/ok"]);
    expect(tmp.status).toBe(0);
  });

  test("tee writes files and passes input through", async () => {
    const { run, session } = shellSession();
    const result = await run("tee", ["t.txt"], { stdin: "x\n" });
    expect(result.out).toBe("x\n");
    expect(session.fs.readFile("/home/visitor/t.txt")).toBe("x\n");
    await run("tee", ["-a", "t.txt"], { stdin: "y\n" });
    expect(session.fs.readFile("/home/visitor/t.txt")).toBe("x\ny\n");
  });
});

describe("tree and find", () => {
  test("tree counts directories and files", async () => {
    const { run } = shellSession();
    await run("mkdir", ["-p", "/tmp/t/a/b"]);
    await run("touch", ["/tmp/t/f", "/tmp/t/a/g", "/tmp/t/.hidden"]);
    const result = await run("tree", ["/tmp/t"]);
    expect(result.out).toBe(
      ["/tmp/t", "├── a", "│   ├── b", "│   └── g", "└── f", "", "2 directories, 2 files", ""].join("\n")
    );
    const all = await run("tree", ["-a", "/tmp/t"]);
    expect(all.out).toContain("3 files");
    const shallow = await run("tree", ["-L", "1", "/tmp/t"]);
    expect(shallow.out).toContain("1 directory, 1 file");
  });

  test("tree marks directories it may not read", async () => {
    const { out, status } = await runCommand("tree", ["~"]);
    expect(out).toMatch(/secrets \[permission denied\]/);
    expect(out).not.toContain(".zshrc");
    expect(status).toBe(0);
  });

  test("find -name and -type", async () => {
    const named = await runCommand("find", ["projects", "-name", "*.md"]);
    expect(named.out.trimEnd().split("\n")).toHaveLength(PROJECTS.length);
    expect(named.out).toContain(`projects/${PROJECTS[0]!.slug}.md\n`);
    const dirs = await runCommand("find", [".", "-type", "d", "-name", "p*"]);
    expect(dirs.out).toBe("./projects\n");
  });

  test("find reports unreadable directories and continues", async () => {
    const result = await runCommand("find", ["/home", "-name", "*.md"]);
    expect(result.err).toContain("find: /home/janos: Permission denied\n");
    expect(result.out).toContain("/home/visitor/README.md");
    expect(result.status).toBe(1);
  });

  test("find rejects an unknown predicate", async () => {
    expect((await runCommand("find", ["-bogus"])).status).toBe(2);
  });
});

describe("text filters", () => {
  const input = "banana\nApple\ncherry\napple\n";

  test("grep selects, inverts, counts and numbers", async () => {
    expect((await runCommand("grep", ["an"], { stdin: input })).out).toBe("banana\n");
    expect((await runCommand("grep", ["-i", "apple"], { stdin: input })).out).toBe("Apple\napple\n");
    expect((await runCommand("grep", ["-v", "a"], { stdin: input })).out).toBe("Apple\ncherry\n");
    expect((await runCommand("grep", ["-c", "a"], { stdin: input })).out).toBe("2\n");
    expect((await runCommand("grep", ["-n", "cherry"], { stdin: input })).out).toBe("3:cherry\n");
    expect((await runCommand("grep", ["-in", "^a"], { stdin: input })).out).toBe("2:Apple\n4:apple\n");
  });

  test("grep status is 1 without matches and 2 for a bad pattern", async () => {
    expect((await runCommand("grep", ["zzz"], { stdin: input })).status).toBe(1);
    const bad = await runCommand("grep", ["("], { stdin: input });
    expect(bad.status).toBe(2);
    expect(bad.err).toBe("grep: invalid regular expression\n");
  });

  test("grep prefixes file names when there are several and highlights on a terminal", async () => {
    const result = await runCommand("grep", ["stack", "projects/md2pdf-cli.md", "projects/SP_Catalog.md"]);
    expect(result.out).toBe(
      "projects/md2pdf-cli.md:stack: JavaScript\nprojects/SP_Catalog.md:stack: Go\n"
    );
    const tty = await runCommand("grep", ["an"], { stdin: input, isTTY: true });
    expect(tty.out).toContain(`${ESC}[31man${ESC}[39m`);
    expect((await runCommand("grep", ["an"], { stdin: input })).out).not.toContain(ESC);
  });

  test("grep keeps going past a missing file", async () => {
    const result = await runCommand("grep", ["github", "nope", "links/github.url"]);
    expect(result.out).toBe("links/github.url:https://github.com/clssck\n");
    expect(result.err).toBe("grep: nope: No such file or directory\n");
    expect(result.status).toBe(2);
  });

  test("head and tail", async () => {
    const lines = Array.from({ length: 15 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
    expect((await runCommand("head", [], { stdin: lines })).out.split("\n")).toHaveLength(11);
    expect((await runCommand("head", ["-n", "2"], { stdin: lines })).out).toBe("l1\nl2\n");
    expect((await runCommand("head", ["-3"], { stdin: lines })).out).toBe("l1\nl2\nl3\n");
    expect((await runCommand("tail", ["-n", "2"], { stdin: lines })).out).toBe("l14\nl15\n");
    expect((await runCommand("tail", ["-n", "+14"], { stdin: lines })).out).toBe("l14\nl15\n");
    expect((await runCommand("tail", [], { stdin: lines })).out.split("\n")[0]).toBe("l6");
    expect((await runCommand("head", ["-n", "x"], { stdin: lines })).status).toBe(2);
  });

  test("head with several files prints headers", async () => {
    const { out } = await runCommand("head", ["-n", "1", "links/github.url", "links/repos.url"]);
    expect(out).toBe(
      "==> links/github.url <==\nhttps://github.com/clssck\n\n==> links/repos.url <==\nhttps://github.com/clssck?tab=repositories\n"
    );
  });

  test("wc counts lines, words and bytes", async () => {
    expect((await runCommand("wc", [], { stdin: "a b\nc\n" })).out).toBe("2 3 6\n");
    expect((await runCommand("wc", ["-l"], { stdin: "a\nb\nc\n" })).out).toBe("3\n");
    expect((await runCommand("wc", ["-w"], { stdin: "a b c" })).out).toBe("3\n");
    expect((await runCommand("wc", ["-c"], { stdin: "héllo" })).out).toBe("6\n");
  });

  test("wc over several files ends with a total", async () => {
    const { out } = await runCommand("wc", ["-l", "links/github.url", "links/repos.url"]);
    expect(out).toBe("1 links/github.url\n1 links/repos.url\n2 total\n");
  });

  test("sort, sort -r, -n and -u", async () => {
    expect((await runCommand("sort", [], { stdin: "b\nc\na\n" })).out).toBe("a\nb\nc\n");
    expect((await runCommand("sort", ["-r"], { stdin: "b\nc\na\n" })).out).toBe("c\nb\na\n");
    expect((await runCommand("sort", ["-n"], { stdin: "10\n9\n100\n" })).out).toBe("9\n10\n100\n");
    expect((await runCommand("sort", ["-u"], { stdin: "b\na\nb\n" })).out).toBe("a\nb\n");
  });

  test("uniq merges adjacent duplicates and counts", async () => {
    expect((await runCommand("uniq", [], { stdin: "a\na\nb\na\n" })).out).toBe("a\nb\na\n");
    expect((await runCommand("uniq", ["-c"], { stdin: "a\na\nb\n" })).out).toBe("      2 a\n      1 b\n");
  });

  test("cut selects fields", async () => {
    const data = "a,b,c,d\n1,2,3,4\n";
    expect((await runCommand("cut", ["-d", ",", "-f", "1,3"], { stdin: data })).out).toBe("a,c\n1,3\n");
    expect((await runCommand("cut", ["-d,", "-f2-3"], { stdin: data })).out).toBe("b,c\n2,3\n");
    expect((await runCommand("cut", ["-d", ",", "-f", "3-"], { stdin: data })).out).toBe("c,d\n3,4\n");
    expect((await runCommand("cut", ["-d", ","], { stdin: data })).status).toBe(2);
  });

  test("rev, seq and echo", async () => {
    expect((await runCommand("rev", [], { stdin: "abc\n" })).out).toBe("cba\n");
    expect((await runCommand("seq", ["3"])).out).toBe("1\n2\n3\n");
    expect((await runCommand("seq", ["2", "4"])).out).toBe("2\n3\n4\n");
    expect((await runCommand("seq", ["x"])).status).toBe(2);
    expect((await runCommand("echo", ["a", "b"])).out).toBe("a b\n");
    expect((await runCommand("echo", ["-n", "a"])).out).toBe("a");
  });

  test("filters print nothing without operands and without stdin", async () => {
    for (const name of ["cat", "head", "tail", "wc", "sort", "uniq", "rev"]) {
      const result = await runCommand(name, []);
      expect(result.status).toBe(0);
      expect(result.out).toBe("");
    }
  });

  test("xargs runs a command once through exec with the items appended", async () => {
    const result = await runCommand("xargs", ["echo", "x"], { stdin: "a b\nc\n" });
    expect(result.out).toBe("x a b c\n");
    expect((await runCommand("xargs", [], { stdin: "a  b\n" })).out).toBe("a b\n");
    const missing = await runCommand("xargs", ["nosuch"], { stdin: "a\n" });
    expect(missing.status).toBe(127);
  });
});

describe("shell builtins", () => {
  test("export, env and unset", async () => {
    const { run, session } = shellSession();
    expect((await run("export", ["FOO=bar", "EMPTY="])).status).toBe(0);
    expect(session.env.FOO).toBe("bar");
    expect((await run("env", [])).out).toContain("FOO=bar\n");
    const listing = (await run("export", [])).out.trimEnd().split("\n");
    expect(listing).toEqual([...listing].sort());
    expect(listing).toContain("USER=visitor");
    await run("unset", ["FOO"]);
    expect(session.env.FOO).toBeUndefined();
    const bad = await run("export", ["1x=2"]);
    expect(bad.status).toBe(1);
  });

  test("export __proto__ stays an ordinary variable", async () => {
    const { run, session } = shellSession();
    await run("export", ["__proto__=x"]);
    expect(Object.getPrototypeOf(session.env)).toBe(Object.prototype);
  });

  test("alias, unalias and listing", async () => {
    const { run, session } = shellSession();
    expect((await run("alias", [])).out).toContain("ll='ls -la'\n");
    await run("alias", ["gs=git status"]);
    expect(session.aliases.gs).toBe("git status");
    expect((await run("alias", ["gs"])).out).toBe("gs='git status'\n");
    await run("unalias", ["gs"]);
    expect(session.aliases.gs).toBeUndefined();
    const missing = await run("unalias", ["gs"]);
    expect(missing.status).toBe(1);
    await run("unalias", ["-a"]);
    expect(Object.keys(session.aliases)).toHaveLength(0);
  });

  test("history numbers lines from 1", async () => {
    const { run, session } = shellSession();
    session.history.push("ls", "cat about.txt");
    expect((await run("history", [])).out).toBe("    1  ls\n    2  cat about.txt\n");
  });

  test("which finds commands and aliases, and fails for unknown names", async () => {
    expect((await runCommand("which", ["ls"])).out).toBe("/bin/ls\n");
    expect((await runCommand("which", ["ll"])).out).toBe("ll: aliased to ls -la\n");
    const unknown = await runCommand("which", ["nosuch"]);
    expect(unknown.err).toBe("nosuch not found\n");
    expect(unknown.status).toBe(1);
    expect((await runCommand("which", ["sudo"])).status).toBe(1);
  });

  test("man shows a page for known commands only", async () => {
    const page = await runCommand("man", ["grep"]);
    expect(page.status).toBe(0);
    expect(page.out).toContain("NAME\n    grep - ");
    expect(page.out).toContain("SYNOPSIS\n    grep [-ivnc] pattern [file…]");
    expect(page.out).toContain("DESCRIPTION");
    const unknown = await runCommand("man", ["nosuch"]);
    expect(unknown.err).toBe("No manual entry for nosuch\n");
    expect(unknown.status).toBe(1);
  });

  test("clear and exit call the host", async () => {
    const cleared = await runCommand("clear", []);
    expect(cleared.host.calls.clear).toBe(1);
    const exited = await runCommand("exit", []);
    expect(exited.host.calls.exit).toBe(1);
    expect(exited.out + exited.err).toBe("");
    expect(exited.status).toBe(0);
  });

  test("true and false", async () => {
    expect((await runCommand("true", [])).status).toBe(0);
    expect((await runCommand("false", [])).status).toBe(1);
  });

  test("sleep waits, and stops with 130 when interrupted", async () => {
    expect((await runCommand("sleep", ["0"])).status).toBe(0);
    const controller = new AbortController();
    // The abort listener is attached synchronously by runCommand, so aborting right away interrupts the wait.
    const pending = runCommand("sleep", ["30"], { signal: controller.signal });
    controller.abort();
    expect((await pending).status).toBe(130);
    expect((await runCommand("sleep", ["x"])).status).toBe(1);
  });
});

describe("site commands", () => {
  test("help lists visible commands, site first, and hides the easter eggs", async () => {
    const { out } = await runCommand("help", []);
    expect(out.startsWith("site\n")).toBe(true);
    for (const spec of COMMANDS) {
      const listed = new RegExp(`^  ${spec.name} `, "m").test(out);
      expect(listed).toBe(!spec.hidden);
    }
    expect(out).toContain("man <command>");
  });

  test("about and skills print the home files", async () => {
    const about = await runCommand("about", []);
    expect(about.out).toContain("an engineer");
    expect((await runCommand("skills", [])).out).toContain("languages");
  });

  test("about reports a deleted file", async () => {
    const { run } = shellSession();
    await run("rm", ["about.txt"]);
    const result = await run("about", []);
    expect(result.status).toBe(1);
    expect(result.err).toBe("about: ~/about.txt: No such file or directory\n");
  });

  test("projects: tab-separated when piped, linked names on a terminal", async () => {
    const piped = await runCommand("projects", []);
    const rows = piped.out.trimEnd().split("\n").map((line) => line.split("\t"));
    expect(rows).toHaveLength(PROJECTS.length);
    expect(rows[0]).toEqual([
      PROJECTS[0]!.name,
      PROJECTS[0]!.stack,
      `https://github.com/clssck/${PROJECTS[0]!.slug}`,
    ]);
    const tty = await runCommand("projects", [], { isTTY: true });
    expect(tty.out).toContain(`${ESC}]8;;https://github.com/clssck/${PROJECTS[0]!.slug}`);
    expect(stripAnsi(tty.out)).toContain(PROJECTS[0]!.description);
  });

  test("repos lists repositories", async () => {
    const repos = [
      repo({ name: "alpha", language: "Go", description: "first" }),
      repo({ name: "beta", language: null, description: null, archived: true, fork: true, url: "https://github.com/clssck/beta" }),
    ];
    const host = { loadRepos: async (): Promise<ReposResult> => ({ ok: true, repos, fromCache: false }) };
    const tty = await runCommand("repos", [], { isTTY: true, host });
    const text = stripAnsi(tty.out);
    expect(text).toContain("2 public repos, most recently pushed first\n");
    expect(text).toContain("alpha  Go\n  first\n");
    expect(text).toContain("beta  [archived]  [fork]\n  (no description)\n");
    expect(text).toContain("https://github.com/clssck?tab=repositories");
    const piped = await runCommand("repos", [], { host });
    expect(piped.out).toBe(
      "alpha\tGo\thttps://github.com/clssck/thing\nbeta\t-\thttps://github.com/clssck/beta\n"
    );
  });

  test("repos with no repositories points to projects", async () => {
    const result = await runCommand("repos", [], { isTTY: true });
    expect(result.out).toContain("no public repos");
    expect(result.out).toContain("projects");
    expect(result.status).toBe(0);
  });

  test("repos failure prints the message and the fallback link", async () => {
    const host = {
      loadRepos: async (): Promise<ReposResult> => ({
        ok: false,
        kind: "network",
        message: "could not reach GitHub",
        fallback: "https://github.com/clssck?tab=repositories",
      }),
    };
    const result = await runCommand("repos", [], { host });
    expect(result.status).toBe(1);
    expect(result.err).toContain("could not reach GitHub\n");
    expect(result.err).toContain("https://github.com/clssck?tab=repositories");
    expect(result.out).toBe("");
  });

  test("repos prints nothing and returns 130 when aborted meanwhile", async () => {
    const controller = new AbortController();
    const host = {
      loadRepos: async (): Promise<ReposResult> => {
        controller.abort();
        return { ok: true, repos: [repo({})], fromCache: false };
      },
    };
    const result = await runCommand("repos", [], { host, signal: controller.signal, isTTY: true });
    expect(result.status).toBe(130);
    expect(result.out + result.err).toBe("");
  });

  test("github opens the profile", async () => {
    const result = await runCommand("github", []);
    expect(result.host.calls.open).toEqual(["https://github.com/clssck"]);
    expect(result.out).toContain("https://github.com/clssck");
  });

  test("open refuses anything but http(s) and opens .url files", async () => {
    const js = await runCommand("open", ["javascript:alert(1)"]);
    expect(js.status).toBe(1);
    expect(js.err).toBe("open: javascript:alert(1): nothing to open\n");
    expect(js.host.calls.open).toEqual([]);
    const { run, session } = shellSession();
    session.fs.writeFile("/home/visitor/evil.url", "javascript:alert(1)\n");
    session.fs.writeFile("/home/visitor/file.url", "data:text/html,hi\n");
    expect((await run("open", ["evil.url"])).status).toBe(1);
    expect((await run("open", ["file.url"])).status).toBe(1);
    expect((await run("open", ["nope"])).status).toBe(1);
    expect(session.host.calls.open).toEqual([]);
    expect((await run("open", ["links/github.url"])).status).toBe(0);
    expect((await run("open", ["https://example.com/x"])).status).toBe(0);
    expect(session.host.calls.open).toEqual(["https://github.com/clssck", "https://example.com/x"]);
  });

  test("theme lists, sets and rejects", async () => {
    const list = await runCommand("theme", []);
    expect(list.out).toBe("* amber\n  green\n  ice\n");
    const { run, session } = shellSession();
    expect((await run("theme", ["green"])).status).toBe(0);
    expect(session.host.calls.setTheme).toEqual(["green"]);
    expect((await run("theme", [])).out).toBe("  amber\n* green\n  ice\n");
    const bad = await run("theme", ["x"]);
    expect(bad.err).toBe("theme: no such theme: x\n");
    expect(bad.status).toBe(1);
  });

  test("neofetch prints the cat only on wide terminals", async () => {
    const wide = await runCommand("neofetch", []);
    expect(wide.out).toContain("visitor@janos");
    expect(wide.out).toContain("uptime");
    expect(wide.out).toContain("1 min");
    expect(wide.out).toContain("amber");
    expect(wide.out).toContain("/\\_/\\");
    const narrow = await runCommand("neofetch", [], { host: { cols: () => 40 } });
    expect(narrow.out.startsWith("visitor@janos\n")).toBe(true);
    expect(narrow.out).not.toContain("/\\_/\\");
  });

  test("fortune prints one line of the fortunes file", async () => {
    const { out, fs } = await runCommand("fortune", []);
    const all = fs.readFile("/usr/share/fortunes").trimEnd().split("\n");
    expect(all).toContain(out.trimEnd());
  });

  test("cowsay wraps at 40 columns and reads stdin", async () => {
    const words = Array.from({ length: 20 }, () => "word").join(" ");
    const { out } = await runCommand("cowsay", [], { stdin: words + "\n" });
    const bubble = out.split("\n").filter((line) => /^[</|\\] .* [>\\|/]$/.test(line));
    expect(bubble.length).toBeGreaterThan(1);
    for (const line of bubble) expect(line.length).toBeLessThanOrEqual(44);
    const single = await runCommand("cowsay", ["hi"]);
    expect(single.out).toContain("< hi >");
    expect((await runCommand("cowsay", [])).status).toBe(1);
  });
});

describe("system commands", () => {
  test("identity", async () => {
    expect((await runCommand("whoami", [])).out).toBe("visitor\n");
    expect((await runCommand("hostname", [])).out).toBe("janos\n");
    expect((await runCommand("id", [])).out).toContain("(visitor)");
    expect((await runCommand("uname", [])).out).toBe("JanOS\n");
    expect((await runCommand("uname", ["-a"])).out).toContain("janos");
  });

  test("date and uptime follow the host clock", async () => {
    expect((await runCommand("date", [])).out).toContain("2026");
    expect((await runCommand("uptime", [])).out).toContain("up 1 min");
    expect((await runCommand("cat", ["/proc/uptime"])).out).toMatch(/^90\.00 /);
  });

  test("ps lists the shell and itself", async () => {
    const { out } = await runCommand("ps", []);
    expect(out).toContain("zsh");
    expect(out).toContain("ps");
  });
});

describe("easter eggs", () => {
  test("refuse with status 1, quietly on stdout", async () => {
    for (const [name, args] of [
      ["sudo", ["ls"]],
      ["vim", []],
      ["vi", []],
      ["nano", []],
      ["emacs", []],
      ["ssh", ["host"]],
      ["curl", ["x"]],
      ["wget", ["x"]],
      ["make", []],
      ["kill", ["1"]],
      ["pkill", ["cat"]],
      ["secrets", []],
    ] as const) {
      const result = await runCommand(name, [...args]);
      expect(result.status).toBe(1);
      expect(result.out).toBe("");
      expect(result.err.endsWith("\n")).toBe(true);
    }
  });

  test("sudo does not run the command", async () => {
    const { run, session } = shellSession();
    await run("sudo", ["touch", "/tmp/x"]);
    expect(session.fs.stat("/tmp/x")).toBeNull();
  });
});

describe("filesystem image", () => {
  test("/bin holds exactly the visible commands", async () => {
    const { fs } = await runCommand("true", []);
    const visible = COMMANDS.filter((spec) => !spec.hidden).map((spec) => spec.name).sort();
    expect(fs.readdir("/bin")).toEqual(visible);
    expect(fs.stat("/bin/ls")?.mode).toBe(0o755);
    expect(fs.readFile("/bin/ls")).toMatch(/^#!\/bin\/zsh\n# list directory contents\n$/);
  });

  test("home contents", async () => {
    const { fs } = await runCommand("true", []);
    expect(fs.readdir("/home/visitor")).toEqual(
      [".zshrc", "README.md", "about.txt", "links", "projects", "secrets", "skills.txt"].sort()
    );
    expect(fs.readdir("/home/visitor/projects")).toHaveLength(PROJECTS.length);
    expect(fs.readFile("/home/visitor/.zshrc")).toContain("alias ll='ls -la'\n");
    expect(fs.readFile("/etc/hostname")).toBe("janos\n");
    expect(() => fs.readdir("/home/janos")).toThrow();
    expect(fs.stat("/dev/null")?.mode).toBe(0o666);
  });
});

describe("every command", () => {
  test("visible commands have a summary and a usage line", () => {
    for (const spec of COMMANDS.filter((s) => !s.hidden)) {
      expect(spec.summary.length).toBeGreaterThan(0);
      expect(spec.summary).toBe(spec.summary.toLowerCase());
      expect(spec.summary.endsWith(".")).toBe(false);
      expect(spec.usage.startsWith(spec.name)).toBe(true);
      expect(spec.group).toBeDefined();
    }
  });

  test("command names are unique", () => {
    const names = COMMANDS.map((spec) => spec.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test("an unknown flag prints the option and returns 2", async () => {
    for (const name of ["ls", "cat", "grep", "head", "tail", "wc", "sort", "uniq", "cut", "rm", "cp", "mv", "mkdir", "touch", "tree", "tee", "uname"]) {
      const result = await runCommand(name, ["-Z", "x"]);
      expect(result.status).toBe(2);
      expect(result.err).toBe(`${name}: invalid option -- 'Z'\n`);
    }
  });

  test("-- ends flags", async () => {
    const result = await runCommand("cat", ["--", "-n"]);
    expect(result.err).toBe("cat: -n: No such file or directory\n");
  });

  test("combined short flags work", async () => {
    const { out } = await runCommand("ls", ["-la"]);
    expect(out).toContain(".zshrc");
    expect(out).toMatch(/^drwx/m);
  });
});

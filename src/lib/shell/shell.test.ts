import { describe, expect, test } from "bun:test";
import { createShell } from "./shell";
import { FsError, type CommandSpec, type Host } from "./types";
import { createVfs, dir, file } from "./vfs";

function spec(name: string, run: CommandSpec["run"], hidden = false): CommandSpec {
  return { name, summary: name, usage: name, hidden, run };
}

function setup(options: { aliases?: Record<string, string>; env?: Record<string, string> } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const controller = new AbortController();
  const progress = {
    started: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
    done: Promise.withResolvers<void>(),
  };

  const host: Host = {
    write: (text, stream) => void (stream === "out" ? out : err).push(text),
    clear: () => {},
    open: () => {},
    cols: () => 80,
    now: () => new Date(0),
    random: () => 0.5,
    loadRepos: () => Promise.reject(new Error("offline")),
    themes: () => ["dark"],
    theme: () => "dark",
    setTheme: () => true,
    exit: () => {},
  };

  const fs = createVfs(
    dir({
      home: dir(
        {
          visitor: dir(
            {
              "a.txt": file("alpha\n"),
              "b.txt": file("beta\n"),
              "My File.txt": file("spaced\n"),
              ".hidden": file("secret\n"),
              sub: dir({ "c.md": file("charlie\n"), ".dot": file("") }),
            },
            { owner: "visitor" }
          ),
        },
        { owner: "visitor" }
      ),
      etc: dir({ motd: file("welcome\n") }),
      bin: dir({
        echo: file("", { mode: 0o755 }),
        plain: file("", { mode: 0o644 }),
      }),
      secret: dir({ x: file("") }, { mode: 0o700 }),
      dev: dir({ null: file("", { mode: 0o666, sink: true }) }),
    }),
    { user: "visitor", now: () => 0 }
  );

  const commands: CommandSpec[] = [
    spec("echo", (ctx) => ctx.out(`${ctx.args.join(" ")}\n`)),
    spec("cat", (ctx) => {
      if (ctx.args.length === 0) ctx.out(ctx.stdin);
      for (const arg of ctx.args) ctx.out(ctx.fs.readFile(ctx.path(arg)));
    }),
    spec("upper", (ctx) => ctx.out(ctx.stdin.toUpperCase())),
    spec("fail", () => 3),
    spec("args", (ctx) => ctx.out(ctx.args.map((arg) => `${arg}\n`).join(""))),
    spec("boom", () => {
      throw new Error("kaboom");
    }),
    spec("hasstdin", (ctx) => ctx.out(`${ctx.hasStdin}:${JSON.stringify(ctx.stdin)}\n`)),
    spec("tty", (ctx) => ctx.out(`${ctx.stdin}${ctx.isTTY}\n`)),
    spec("bold", (ctx) => ctx.out(ctx.c.bold("x"))),
    spec("noisy", (ctx) => {
      ctx.err("oops\n");
      ctx.out("fine\n");
    }),
    spec("showenv", (ctx) => ctx.out(`${ctx.shell.env.FOO ?? "unset"}\n`)),
    spec("where", (ctx) => ctx.out(`${ctx.path(ctx.args[0] ?? "")}\n`)),
    spec("wrap", async (ctx) => {
      const status = await ctx.exec(["echo", "via"]);
      return status + (await ctx.exec(["upper"], "piped\n"));
    }),
    spec("wrapmissing", (ctx) => ctx.exec(["nosuch"])),
    spec("abort", () => controller.abort()),
    spec("sigstate", (ctx) => ctx.out(`${ctx.signal === controller.signal}:${ctx.signal.aborted}\n`)),
    spec("hang", () => {
      progress.started.resolve();
      return new Promise<void>(() => {});
    }),
    spec("slow", async (ctx) => {
      progress.started.resolve();
      await progress.release.promise;
      ctx.out("late\n");
      ctx.err("late-err\n");
      progress.done.resolve();
    }),
    spec("slowtouch", async (ctx) => {
      progress.started.resolve();
      await progress.release.promise;
      await ctx.exec(["touch"]);
      progress.done.resolve();
    }),
    spec("touch", (ctx) => ctx.fs.writeFile(ctx.path("ghost.txt"), "")),
    spec("lasthist", (ctx) => ctx.out(`${ctx.shell.history[ctx.shell.history.length - 1]}\n`)),
    spec("throwfs", () => {
      throw new FsError("EACCES", "/etc/shadow");
    }),
    spec("easter", (ctx) => ctx.out("egg\n"), true),
  ];

  const shell = createShell({
    fs,
    host,
    commands,
    env: { HOME: "/home/visitor", USER: "visitor", PWD: "/home/visitor", ...options.env },
    aliases: options.aliases,
  });

  async function run(line: string) {
    out.length = 0;
    err.length = 0;
    const status = await shell.run(line, { signal: controller.signal });
    return { status, out: out.join(""), err: err.join("") };
  }

  return { shell, fs, run, out, err, controller, progress };
}

describe("pipelines and lists", () => {
  test("a pipe hands stdout to the next stage as stdin", async () => {
    const { run } = setup();
    expect((await run("echo hello | upper")).out).toBe("HELLO\n");
    expect((await run("echo a | cat | upper")).out).toBe("A\n");
  });

  test("only piped stages report hasStdin", async () => {
    const { run } = setup();
    expect((await run("hasstdin")).out).toBe('false:""\n');
    expect((await run("echo x | hasstdin")).out).toBe('true:"x\\n"\n');
    expect((await run("noisy 2>/dev/null | hasstdin")).out).toBe('true:"fine\\n"\n');
  });

  test("&& runs the next pipeline only after success", async () => {
    const { run } = setup();
    expect(await run("echo a && echo b")).toMatchObject({ out: "a\nb\n", status: 0 });
    expect(await run("fail && echo no")).toMatchObject({ out: "", status: 3 });
  });

  test("|| runs the next pipeline only after failure", async () => {
    const { run } = setup();
    expect(await run("echo a || echo b")).toMatchObject({ out: "a\n", status: 0 });
    expect(await run("fail || echo yes")).toMatchObject({ out: "yes\n", status: 0 });
    expect((await run("fail || fail && echo x")).out).toBe("");
    expect((await run("echo a || echo b && echo c")).out).toBe("a\nc\n");
  });

  test("; always continues, and the status is the last pipeline's", async () => {
    const { run } = setup();
    expect(await run("fail; echo b")).toMatchObject({ out: "b\n", status: 0 });
    expect(await run("echo a; fail")).toMatchObject({ out: "a\n", status: 3 });
    expect((await run("echo a;")).out).toBe("a\n");
  });

  test("the status of a pipeline is the status of its last stage", async () => {
    const { run } = setup();
    expect((await run("fail | echo ok")).status).toBe(0);
    expect((await run("echo ok | fail")).status).toBe(3);
  });

  test("$? tracks the previous pipeline within a line and across lines", async () => {
    const { run, shell } = setup();
    expect((await run("fail; echo $?")).out).toBe("3\n");
    expect((await run("echo a && echo $?")).out).toBe("a\n0\n");
    expect((await run("fail")).status).toBe(3);
    expect(shell.lastStatus).toBe(3);
    expect((await run("echo $?")).out).toBe("3\n");
  });

  test("newlines separate commands", async () => {
    const { run } = setup();
    expect((await run("echo a\n\necho b\n")).out).toBe("a\nb\n");
  });
});

describe("quoting and expansion", () => {
  test("single quotes are literal, double quotes expand variables", async () => {
    const { run } = setup();
    const result = await run(`args '$HOME' "$HOME" "\${HOME}x" \\$HOME "a\\"b" 'a\\b'`);
    expect(result.out).toBe(["$HOME", "/home/visitor", "/home/visitorx", "$HOME", 'a"b', "a\\b"].join("\n") + "\n");
  });

  test("backslash escapes whitespace outside quotes", async () => {
    const { run } = setup();
    expect((await run("args a\\ b c")).out).toBe("a b\nc\n");
  });

  test("variables are not word-split; unset ones vanish; empty quotes stay", async () => {
    const { run } = setup({ env: { FOO: "a  b" } });
    expect((await run("args $FOO")).out).toBe("a  b\n");
    expect((await run("args a $UNSET b")).out).toBe("a\nb\n");
    expect((await run('args a "$UNSET" ""')).out).toBe("a\n\n\n");
    expect((await run("args x${FOO}y")).out).toBe("xa  by\n");
  });

  test("tilde expands only at the start of an unquoted word", async () => {
    const { run } = setup();
    expect((await run("args ~ ~/a.txt '~' x~ ~other")).out).toBe(
      "/home/visitor\n/home/visitor/a.txt\n~\nx~\n~other\n"
    );
  });

  test("$(...) splits on whitespace when unquoted and stays whole when quoted", async () => {
    const { run } = setup();
    expect((await run('args $(echo "x y  z")')).out).toBe("x\ny\nz\n");
    expect((await run('args "$(echo "x y  z")"')).out).toBe("x y  z\n");
    expect((await run("args a$(echo b c)d")).out).toBe("ab\ncd\n");
  });

  test("$(...) strips trailing newlines, nests, and sees the same shell", async () => {
    const { run } = setup();
    expect((await run('echo "[$(args q r)]"')).out).toBe("[q\nr]\n");
    expect((await run("echo $(echo $(echo deep))")).out).toBe("deep\n");
    expect((await run("FOO=1; echo $(showenv)")).out).toBe("1\n");
    expect((await run("echo $(fail) $?")).out).toBe("3\n");
  });

  test("an empty unquoted substitution produces no word", async () => {
    const { run } = setup();
    expect((await run("args a $(echo) b")).out).toBe("a\nb\n");
  });

  test("a # at the start of a word begins a comment", async () => {
    const { run } = setup();
    expect((await run("echo a # b")).out).toBe("a\n");
    expect((await run("echo a#b")).out).toBe("a#b\n");
    expect((await run("# nothing")).out).toBe("");
  });
});

describe("globbing", () => {
  test("matches are sorted and skip dotfiles", async () => {
    const { run } = setup();
    expect((await run("args *")).out).toBe("My File.txt\na.txt\nb.txt\nsub\n");
    expect((await run("args *.txt")).out).toBe("My File.txt\na.txt\nb.txt\n");
  });

  test("? and character classes", async () => {
    const { run } = setup();
    expect((await run("args ?.txt")).out).toBe("a.txt\nb.txt\n");
    expect((await run("args [a].txt")).out).toBe("a.txt\n");
    expect((await run("args [a-b].txt")).out).toBe("a.txt\nb.txt\n");
    expect((await run("args [!a].txt")).out).toBe("b.txt\n");
  });

  test("a word with no match is kept literally", async () => {
    const { run } = setup();
    expect((await run("args *.nomatch nope/*.x [z]")).out).toBe("*.nomatch\nnope/*.x\n[z]\n");
  });

  test("dotfiles match only when the pattern segment starts with a dot", async () => {
    const { run } = setup();
    expect((await run("args .*")).out).toBe(".hidden\n");
    expect((await run("args .h*")).out).toBe(".hidden\n");
    expect((await run("args sub/*")).out).toBe("sub/c.md\n");
    expect((await run("args sub/.*")).out).toBe("sub/.dot\n");
  });

  test("patterns span directories, absolute paths and trailing slashes", async () => {
    const { run } = setup();
    expect((await run("args */c.md")).out).toBe("sub/c.md\n");
    expect((await run("args /h*/v*")).out).toBe("/home/visitor\n");
    expect((await run("args s*/")).out).toBe("sub/\n");
    expect((await run("args ~/*.txt")).out).toBe(
      "/home/visitor/My File.txt\n/home/visitor/a.txt\n/home/visitor/b.txt\n"
    );
    expect((await run("args ../v*/a*")).out).toBe("../visitor/a.txt\n");
  });

  test("characters from quotes and variables are never wildcards", async () => {
    const { run } = setup({ env: { PATTERN: "*.txt" } });
    expect((await run("args '*.txt' \"*.txt\" \\*.txt")).out).toBe("*.txt\n*.txt\n*.txt\n");
    expect((await run("args $PATTERN")).out).toBe("*.txt\n");
    expect((await run('args "$(echo "*.txt")"')).out).toBe("*.txt\n");
    expect((await run("args $(echo '*.txt')")).out).toBe("*.txt\n");
    expect((await run("args '*'.txt")).out).toBe("*.txt\n");
  });

  test("relative patterns follow the working directory", async () => {
    const { run, shell } = setup();
    shell.chdir("/home/visitor/sub");
    expect((await run("args *")).out).toBe("c.md\n");
  });
});

describe("redirects", () => {
  test("> truncates and >> appends, keeping output off the host", async () => {
    const { run, fs } = setup();
    expect(await run("echo hi > out.txt")).toEqual({ status: 0, out: "", err: "" });
    expect(fs.readFile("/home/visitor/out.txt")).toBe("hi\n");
    await run("echo there >> out.txt");
    expect(fs.readFile("/home/visitor/out.txt")).toBe("hi\nthere\n");
    await run("echo fresh > out.txt");
    expect(fs.readFile("/home/visitor/out.txt")).toBe("fresh\n");
  });

  test("redirect targets resolve against cwd and HOME", async () => {
    const { run, fs } = setup();
    await run("echo a > sub/x.txt");
    await run("echo b > ~/y.txt");
    expect(fs.readFile("/home/visitor/sub/x.txt")).toBe("a\n");
    expect(fs.readFile("/home/visitor/y.txt")).toBe("b\n");
  });

  test("redirects may follow the arguments or come first", async () => {
    const { run, fs } = setup();
    await run("> z.txt echo first");
    expect(fs.readFile("/home/visitor/z.txt")).toBe("first\n");
    await run("echo a > z.txt b");
    expect(fs.readFile("/home/visitor/z.txt")).toBe("a b\n");
  });

  test("< supplies stdin", async () => {
    const { run } = setup();
    expect(await run("cat < a.txt")).toEqual({ status: 0, out: "alpha\n", err: "" });
    expect((await run("hasstdin < b.txt")).out).toBe('true:"beta\\n"\n');
    expect((await run("upper < a.txt | cat")).out).toBe("ALPHA\n");
  });

  test("2> sends stderr to a file and keeps it off the host", async () => {
    const { run, fs } = setup();
    expect(await run("noisy 2> err.txt")).toEqual({ status: 0, out: "fine\n", err: "" });
    expect(fs.readFile("/home/visitor/err.txt")).toBe("oops\n");
    await run("noisy 2>> err.txt");
    expect(fs.readFile("/home/visitor/err.txt")).toBe("oops\noops\n");
  });

  test("2>&1 merges stderr into stdout in order", async () => {
    const { run, fs } = setup();
    expect(await run("noisy > both.txt 2>&1")).toEqual({ status: 0, out: "", err: "" });
    expect(fs.readFile("/home/visitor/both.txt")).toBe("oops\nfine\n");
    expect(await run("noisy 2>&1 | upper")).toEqual({ status: 0, out: "OOPS\nFINE\n", err: "" });
  });

  test("redirects apply left to right", async () => {
    const { run, fs } = setup();
    const result = await run("noisy 2>&1 > only.txt");
    expect(result).toEqual({ status: 0, out: "oops\n", err: "" });
    expect(fs.readFile("/home/visitor/only.txt")).toBe("fine\n");
  });

  test("without a redirect, stderr reaches the host while stdout is piped on", async () => {
    const { run } = setup();
    expect(await run("noisy | upper")).toEqual({ status: 0, out: "FINE\n", err: "oops\n" });
  });

  test("a read-only location is refused and the command does not run", async () => {
    const { run, fs } = setup();
    expect(await run("echo x > /etc/motd")).toEqual({
      status: 1,
      out: "",
      err: "zsh: permission denied: /etc/motd\n",
    });
    expect(fs.readFile("/etc/motd")).toBe("welcome\n");
    expect((await run("echo x >> /etc/motd")).err).toBe("zsh: permission denied: /etc/motd\n");
    expect(fs.readFile("/etc/motd")).toBe("welcome\n");
  });

  test("a missing directory or input file is reported zsh-style", async () => {
    const { run } = setup();
    expect(await run("echo x > nope/x")).toEqual({
      status: 1,
      out: "",
      err: "zsh: no such file or directory: nope/x\n",
    });
    expect((await run("cat < missing.txt")).err).toBe("zsh: no such file or directory: missing.txt\n");
    expect((await run("echo x > sub")).err).toBe("zsh: is a directory: sub\n");
  });

  test("a redirect that expands to several words is ambiguous", async () => {
    const { run } = setup();
    expect(await run("echo x > *.txt")).toMatchObject({ status: 1, err: "zsh: ambiguous redirect\n" });
    expect((await run("echo x > $UNSET")).err).toBe("zsh: ambiguous redirect\n");
  });

  test("a redirect with no command still creates the file", async () => {
    const { run, fs } = setup();
    expect((await run("> empty.txt")).status).toBe(0);
    expect(fs.readFile("/home/visitor/empty.txt")).toBe("");
  });

  test("redirecting stderr hides command-not-found as well", async () => {
    const { run } = setup();
    expect(await run("nosuch 2> /dev/null")).toEqual({ status: 127, out: "", err: "" });
  });
});

describe("variables, aliases and lookup", () => {
  test("NAME=value alone sets the variable", async () => {
    const { run, shell } = setup();
    expect((await run("FOO=bar")).status).toBe(0);
    expect(shell.env.FOO).toBe("bar");
    expect((await run("showenv")).out).toBe("bar\n");
    await run("FOO=a$HOME");
    expect(shell.env.FOO).toBe("a/home/visitor");
    await run("FOO='x y'");
    expect(shell.env.FOO).toBe("x y");
  });

  test("NAME=value cmd applies only for that command", async () => {
    const { run, shell } = setup();
    expect((await run("FOO=bar showenv")).out).toBe("bar\n");
    expect(shell.env.FOO).toBeUndefined();
    expect((await run("showenv")).out).toBe("unset\n");
    await run("FOO=1");
    expect((await run("FOO=2 showenv; showenv")).out).toBe("2\n1\n");
    expect((await run("FOO=bar echo $FOO")).out).toBe("1\n");
  });

  test("an assignment-looking word after the command name is an argument", async () => {
    const { run } = setup();
    expect((await run("echo FOO=bar")).out).toBe("FOO=bar\n");
  });

  test("aliases expand the first unquoted word", async () => {
    const { run } = setup({ aliases: { ll: "args -l", say: "echo said" } });
    expect((await run("ll x")).out).toBe("-l\nx\n");
    expect((await run("say hi | upper")).out).toBe("SAID HI\n");
    expect((await run("echo say")).out).toBe("say\n");
    expect(await run("'ll'")).toMatchObject({ status: 127 });
    // $FOO is expanded before the prefix assignment takes effect.
    expect((await run("FOO=1 say $FOO")).out).toBe("said\n");
  });

  test("an alias for its own name or a cycle does not loop", async () => {
    const { run } = setup({ aliases: { echo: "echo pre", a: "b", b: "a" } });
    expect((await run("echo x")).out).toBe("pre x\n");
    expect(await run("a")).toMatchObject({ status: 127, err: "zsh: command not found: a\n" });
  });

  test("aliases defined on shell.aliases take effect on the next line", async () => {
    const { run, shell } = setup();
    shell.aliases.hi = "echo hello";
    expect((await run("hi")).out).toBe("hello\n");
  });

  test("an unknown command is 127 with a zsh message", async () => {
    const { run } = setup();
    expect(await run("nosuch arg")).toEqual({
      status: 127,
      out: "",
      err: "zsh: command not found: nosuch\n",
    });
    expect((await run("nosuch | echo after")).out).toBe("after\n");
  });

  test("names from Object.prototype do not resolve", async () => {
    const { run } = setup({ aliases: {} });
    for (const name of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) {
      expect(await run(name)).toEqual({
        status: 127,
        out: "",
        err: `zsh: command not found: ${name}\n`,
      });
    }
  });

  test("an unset variable named like a prototype member expands to nothing", async () => {
    const { run } = setup();
    expect((await run("args a $constructor b")).out).toBe("a\nb\n");
  });

  test("paths run executable files named after a command", async () => {
    const { run } = setup();
    expect(await run("/bin/echo hi")).toEqual({ status: 0, out: "hi\n", err: "" });
  });

  test("a path that exists but is not runnable is 126, a missing one 127", async () => {
    const { run } = setup();
    expect(await run("/bin/plain")).toEqual({
      status: 126,
      out: "",
      err: "zsh: permission denied: /bin/plain\n",
    });
    expect((await run("./a.txt")).err).toBe("zsh: permission denied: ./a.txt\n");
    expect(await run("/bin/ghost")).toEqual({
      status: 127,
      out: "",
      err: "zsh: no such file or directory: /bin/ghost\n",
    });
    expect((await run("./nope")).status).toBe(127);
    expect((await run("/etc")).status).toBe(126);
  });
});

describe("failures", () => {
  test("a throwing command yields status 1 and run() still resolves", async () => {
    const { run } = setup();
    expect(await run("boom")).toEqual({ status: 1, out: "", err: "boom: kaboom\n" });
    expect((await run("boom; echo after")).out).toBe("after\n");
  });

  test("an FsError prints the path stored on the error", async () => {
    const { run } = setup();
    expect(await run("throwfs")).toEqual({
      status: 1,
      out: "",
      err: "throwfs: /etc/shadow: Permission denied\n",
    });
    expect(await run("cat nope.txt")).toEqual({
      status: 1,
      out: "",
      err: "cat: /home/visitor/nope.txt: No such file or directory\n",
    });
  });

  test("syntax errors print to stderr, give status 1 and run nothing", async () => {
    const { run, shell } = setup();
    expect(await run('echo a; echo "x')).toEqual({ status: 1, out: "", err: 'zsh: unmatched "\n' });
    expect(await run("echo 'x")).toMatchObject({ status: 1, err: "zsh: unmatched '\n" });
    for (const line of ["echo a &&", "| echo", "echo a ||", "echo >", "echo a | | echo", "echo a & echo", "echo $(echo"]) {
      const result = await run(line);
      expect(result.status).toBe(1);
      expect(result.out).toBe("");
      expect(result.err).toMatch(/^zsh: /);
    }
    expect((await run("echo a &&")).err).toBe("zsh: parse error near `&&'\n");
    expect((await run("echo >")).err).toBe("zsh: parse error near `\\n'\n");
    expect((await run("| echo")).err).toBe("zsh: parse error near `|'\n");
    expect(shell.lastStatus).toBe(1);
  });

  test("an error inside $(...) stops the whole line before anything runs", async () => {
    const { run } = setup();
    expect(await run('echo a; echo $(echo "x)')).toMatchObject({ status: 1, out: "" });
  });
});

describe("tty and style", () => {
  test("isTTY is true only for a final stage whose stdout reaches the host", async () => {
    const { run, fs } = setup();
    expect((await run("tty")).out).toBe("true\n");
    expect((await run("tty | tty")).out).toBe("false\ntrue\n");
    expect((await run("tty > t.txt")).out).toBe("");
    expect(fs.readFile("/home/visitor/t.txt")).toBe("false\n");
    await run("tty | tty > t.txt");
    expect(fs.readFile("/home/visitor/t.txt")).toBe("false\nfalse\n");
    expect((await run("echo $(tty)")).out).toBe("false\n");
    expect((await run("tty 2>&1 | cat")).out).toBe("false\n");
  });

  test("style methods emit escape codes only on the terminal", async () => {
    const { run } = setup();
    expect((await run("bold")).out).toBe("\x1b[1mx\x1b[22m");
    expect((await run("bold | cat")).out).toBe("x");
    expect((await run("bold > b.txt; cat b.txt")).out).toBe("x");
  });
});

describe("history and the run contract", () => {
  test("run records the trimmed line, ignoring blank input", async () => {
    const { run, shell } = setup();
    await run("  echo a  ");
    await run("");
    await run("   \t ");
    await run("nosuch");
    await run("echo 'unterminated");
    expect(shell.history).toEqual(["echo a", "nosuch", "echo 'unterminated"]);
  });

  test("a blank line runs nothing and leaves $? alone", async () => {
    const { run, shell } = setup();
    await run("fail");
    expect(await run("  ")).toEqual({ status: 0, out: "", err: "" });
    expect(shell.lastStatus).toBe(3);
  });

  test("the running line is already in history while it executes", async () => {
    const { run } = setup();
    expect((await run("  lasthist ")).out).toBe("lasthist\n");
  });
});

describe("ctx helpers", () => {
  test("ctx.exec runs a registered command with the caller's stdout and stderr", async () => {
    const { run, fs } = setup();
    expect(await run("wrap")).toEqual({ status: 0, out: "via\nPIPED\n", err: "" });
    await run("wrap > w.txt");
    expect(fs.readFile("/home/visitor/w.txt")).toBe("via\nPIPED\n");
    expect((await run("wrap | upper")).out).toBe("VIA\nPIPED\n");
  });

  test("ctx.exec on an unknown name reports and returns 127", async () => {
    const { run } = setup();
    expect(await run("wrapmissing")).toEqual({
      status: 127,
      out: "",
      err: "nosuch: command not found\n",
    });
  });

  test("ctx.path resolves against cwd and HOME", async () => {
    const { run, shell } = setup();
    expect((await run("where a.txt")).out).toBe("/home/visitor/a.txt\n");
    expect((await run("where ~/x/../y")).out).toBe("/home/visitor/y\n");
    shell.chdir("/etc");
    expect((await run("where motd")).out).toBe("/etc/motd\n");
  });

  test("specs() lists every command, hidden ones included", async () => {
    const { shell } = setup();
    expect(shell.spec("easter")?.hidden).toBe(true);
    expect(shell.spec("constructor")).toBeUndefined();
    expect(shell.specs().map((s) => s.name)).toContain("easter");
    expect(await shell.run("easter")).toBe(0);
  });
});

describe("abort", () => {
  test("an aborted signal stops the line with 130 before anything runs", async () => {
    const { run, controller } = setup();
    controller.abort();
    expect(await run("echo a; echo b")).toEqual({ status: 130, out: "", err: "" });
  });

  test("commands receive the signal", async () => {
    const { run } = setup();
    expect((await run("sigstate")).out).toBe("true:false\n");
  });

  test("a command that aborts stops later stages and pipelines", async () => {
    const { run } = setup();
    expect(await run("abort; echo no")).toEqual({ status: 130, out: "", err: "" });
  });

  test("aborting mid-pipeline does not start the remaining stages", async () => {
    const { run, fs } = setup();
    expect(await run("abort | echo no > late.txt")).toMatchObject({ status: 130, out: "" });
    expect(fs.stat("/home/visitor/late.txt")).toBeNull();
  });

  test("a later && or || pipeline is not started either", async () => {
    const { run } = setup();
    expect((await run("abort && echo a || echo b")).out).toBe("");
  });

  test("aborting returns at once even when the command ignores the signal", async () => {
    const { run, controller, progress } = setup();
    const pending = run("hang; echo no");
    await progress.started.promise;
    controller.abort();
    expect(await pending).toEqual({ status: 130, out: "", err: "" });
  });

  test("output and file writes from an abandoned command are dropped", async () => {
    const { run, controller, out, err, fs, progress } = setup();
    const pending = run("slow > late.txt");
    await progress.started.promise;
    controller.abort();
    expect((await pending).status).toBe(130);
    progress.release.resolve();
    await progress.done.promise;
    expect(out).toEqual([]);
    expect(err).toEqual([]);
    expect(fs.readFile("/home/visitor/late.txt")).toBe("");
  });

  test("an abandoned command's late host output never appears", async () => {
    const { run, controller, out, err, progress } = setup();
    const pending = run("slow");
    await progress.started.promise;
    controller.abort();
    expect((await pending).status).toBe(130);
    progress.release.resolve();
    await progress.done.promise;
    expect(out).toEqual([]);
    expect(err).toEqual([]);
  });

  test("an abandoned command cannot start further commands through ctx.exec", async () => {
    const { run, controller, fs, progress } = setup();
    const pending = run("slowtouch");
    await progress.started.promise;
    controller.abort();
    expect((await pending).status).toBe(130);
    progress.release.resolve();
    await progress.done.promise;
    expect(fs.stat("/home/visitor/ghost.txt")).toBeNull();
  });

  test("$? is 130 after an aborted line", async () => {
    const { run, shell } = setup();
    await run("abort");
    expect(shell.lastStatus).toBe(130);
  });
});

describe("chdir and promptPath", () => {
  test("starts in PWD when it is a directory, else HOME", () => {
    expect(setup({ env: { PWD: "/etc" } }).shell.cwd).toBe("/etc");
    expect(setup({ env: { PWD: "/nowhere" } }).shell.cwd).toBe("/home/visitor");
    expect(setup({ env: { PWD: "/etc/motd" } }).shell.cwd).toBe("/home/visitor");
  });

  test("chdir updates cwd, PWD and OLDPWD", () => {
    const { shell } = setup();
    shell.chdir("/etc");
    expect(shell.cwd).toBe("/etc");
    expect(shell.env.PWD).toBe("/etc");
    expect(shell.env.OLDPWD).toBe("/home/visitor");
  });

  test("chdir fails with ENOENT, ENOTDIR and EACCES and keeps the old directory", () => {
    const { shell } = setup();
    const code = (path: string) => {
      try {
        shell.chdir(path);
      } catch (error) {
        return error instanceof FsError ? error.code : "other";
      }
      return "ok";
    };
    expect(code("/nowhere")).toBe("ENOENT");
    expect(code("/etc/motd")).toBe("ENOTDIR");
    expect(code("/secret")).toBe("EACCES");
    expect(shell.cwd).toBe("/home/visitor");
    expect(shell.env.OLDPWD).toBeUndefined();
  });

  test("promptPath abbreviates HOME", () => {
    const { shell } = setup();
    expect(shell.promptPath()).toBe("~");
    shell.chdir("/home/visitor/sub");
    expect(shell.promptPath()).toBe("~/sub");
    shell.chdir("/home");
    expect(shell.promptPath()).toBe("/home");
    shell.chdir("/etc");
    expect(shell.promptPath()).toBe("/etc");
  });
});

describe("complete", () => {
  test("command position offers visible commands and aliases, sorted and unique", () => {
    const { shell } = setup({ aliases: { eagle: "echo", echo: "echo" } });
    const result = shell.complete("e");
    expect(result).toEqual({ prefix: "", token: "e", matches: ["eagle", "echo"], candidate: "eagle" });
    expect(shell.complete("ec")).toEqual({ prefix: "", token: "ec", matches: ["echo"], candidate: "echo" });
  });

  test("hidden specs are not offered but still run", () => {
    const { shell } = setup();
    expect(shell.complete("ea")?.matches).toEqual([]);
  });

  test("an empty line or an empty command token gives null", () => {
    const { shell } = setup();
    expect(shell.complete("")).toBeNull();
    expect(shell.complete("echo hi | ")).toBeNull();
    expect(shell.complete("echo hi && ")).toBeNull();
    expect(shell.complete("echo hi;")).toBeNull();
  });

  test("a command after a pipe, && , || or ; completes as a command", () => {
    const { shell } = setup();
    for (const [line, prefix] of [
      ["echo hi | up", "echo hi | "],
      ["echo hi|up", "echo hi|"],
      ["echo hi && up", "echo hi && "],
      ["fail || up", "fail || "],
      ["fail; up", "fail; "],
    ] as const) {
      expect(shell.complete(line)).toEqual({ prefix, token: "up", matches: ["upper"], candidate: "upper" });
    }
  });

  test("a variable assignment before the command keeps command position", () => {
    const { shell } = setup();
    expect(shell.complete("FOO=1 up")?.matches).toEqual(["upper"]);
  });

  test("arguments complete as paths, case-insensitively", () => {
    const { shell } = setup();
    expect(shell.complete("cat a")).toEqual({ prefix: "cat ", token: "a", matches: ["a.txt"], candidate: "a.txt" });
    expect(shell.complete("cat A")).toEqual({ prefix: "cat ", token: "A", matches: ["a.txt"], candidate: "a.txt" });
    expect(shell.complete("cat s")).toEqual({ prefix: "cat ", token: "s", matches: ["sub/"], candidate: "sub/" });
  });

  test("an empty argument token lists the directory without a candidate", () => {
    const { shell } = setup();
    expect(shell.complete("cat ")).toEqual({
      prefix: "cat ",
      token: "",
      matches: ["My\\ File.txt", "a.txt", "b.txt", "sub/"],
      candidate: "",
    });
  });

  test("the directory part is kept as typed", () => {
    const { shell } = setup();
    expect(shell.complete("cat sub/c")).toEqual({
      prefix: "cat ",
      token: "sub/c",
      matches: ["sub/c.md"],
      candidate: "sub/c.md",
    });
    expect(shell.complete("cat ~/su")?.matches).toEqual(["~/sub/"]);
    expect(shell.complete("cat /et")?.matches).toEqual(["/etc/"]);
    expect(shell.complete("cat ../v")?.matches).toEqual(["../visitor/"]);
    expect(shell.complete("cat /etc/")?.matches).toEqual(["/etc/motd"]);
  });

  test("dotfiles are offered only when the base starts with a dot", () => {
    const { shell } = setup();
    expect(shell.complete("cat .")?.matches).toEqual([".hidden"]);
    expect(shell.complete("cat sub/")?.matches).toEqual(["sub/c.md"]);
    expect(shell.complete("cat sub/.")?.matches).toEqual(["sub/.dot"]);
  });

  test("spaces in names are escaped, and escaped input is understood", () => {
    const { shell } = setup();
    const result = shell.complete("cat My");
    expect(result?.matches).toEqual(["My\\ File.txt"]);
    expect(result?.candidate).toBe("My\\ File.txt");
    expect(shell.complete("cat My\\ F")).toEqual({
      prefix: "cat ",
      token: "My\\ F",
      matches: ["My\\ File.txt"],
      candidate: "My\\ File.txt",
    });
  });

  test("cd and rmdir offer directories only", () => {
    const { shell } = setup();
    expect(shell.complete("cd ")?.matches).toEqual(["sub/"]);
    expect(shell.complete("cd a")?.matches).toEqual([]);
    expect(shell.complete("rmdir s")?.matches).toEqual(["sub/"]);
    expect(shell.complete("cd /e")?.matches).toEqual(["/etc/"]);
    expect(shell.complete("cat ")?.matches).toContain("a.txt");
  });

  test("a redirect target completes as a path", () => {
    const { shell } = setup();
    expect(shell.complete("echo hi > a")).toEqual({
      prefix: "echo hi > ",
      token: "a",
      matches: ["a.txt"],
      candidate: "a.txt",
    });
    expect(shell.complete("cat <a")?.matches).toEqual(["a.txt"]);
    expect(shell.complete("noisy 2>a")?.matches).toEqual(["a.txt"]);
  });

  test("a command token containing a slash completes as a path", () => {
    const { shell } = setup();
    expect(shell.complete("/bin/e")).toEqual({
      prefix: "",
      token: "/bin/e",
      matches: ["/bin/echo"],
      candidate: "/bin/echo",
    });
  });

  test("a missing or unreadable directory gives no matches", () => {
    const { shell } = setup();
    expect(shell.complete("cat nosuch/x")).toEqual({ prefix: "cat ", token: "nosuch/x", matches: [], candidate: "" });
    expect(shell.complete("cat /secret/")?.matches).toEqual([]);
    expect(shell.complete("cat a.txt/")?.matches).toEqual([]);
  });

  test("a later command's arguments are not affected by an earlier cd", () => {
    const { shell } = setup();
    expect(shell.complete("cd sub | cat ")?.matches).toContain("a.txt");
  });
});

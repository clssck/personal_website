/**
 * The command interpreter: expands words, wires pipelines and redirects,
 * runs registered commands and offers Tab completion. It knows nothing about
 * the DOM; all terminal output goes through `Host.write`.
 */
import { parse, type Command, type ListEntry, type Pipeline, type RedirectOp, type Word } from "./parse";
import { ansiStyle, plainStyle } from "./style";
import {
  FsError,
  type CommandContext,
  type CommandSpec,
  type Completion,
  type Shell,
  type ShellOptions,
  type Stat,
} from "./types";
import { resolvePath } from "./vfs";

type Sink = (text: string) => void;

/** Everything a stage needs to know about where its input and output go. */
interface Stdio {
  out: Sink;
  err: Sink;
  stdin: string;
  hasStdin: boolean;
  isTTY: boolean;
}

/** Per-`run()` state shared by every stage, including nested `$(…)` lines. */
interface RunState {
  signal: AbortSignal;
  /** Settles when `signal` aborts, so pending commands can be abandoned. */
  aborted: Promise<typeof ABORTED>;
  /** Host stderr; silent once the run has been aborted. */
  err: Sink;
}

type ResolvedRedirect = { op: RedirectOp; target: string } | { op: "2>&1" };

interface Piece {
  text: string;
  /** False for characters that came from quotes, variables or substitutions. */
  glob: boolean;
}

interface Field {
  pieces: Piece[];
  /** A quoted piece makes the field a word even when it is empty. */
  forced: boolean;
}

interface GlobSegment {
  chars: string[];
  mask: boolean[];
}

const ABORTED = Symbol("aborted");
const ABORT_STATUS = 130;
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;

const regexEscape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** One path segment of a glob pattern as a regex; null when it has no wildcard. */
function compileSegment({ chars, mask }: GlobSegment): RegExp | null {
  let source = "^";
  let wild = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    if (!mask[i]) {
      source += regexEscape(c);
    } else if (c === "*") {
      source += "[^/]*";
      wild = true;
    } else if (c === "?") {
      source += "[^/]";
      wild = true;
    } else if (c === "[") {
      const negated = chars[i + 1] === "!" || chars[i + 1] === "^";
      const start = i + (negated ? 2 : 1);
      const close = chars.indexOf("]", start + 1);
      if (close < 0) {
        source += "\\[";
        continue;
      }
      const members = chars
        .slice(start, close)
        .map((member) => (member === "-" ? "-" : member.replace(/[\\\]^[]/g, "\\$&")))
        .join("");
      source += `[${negated ? "^" : ""}${members}]`;
      wild = true;
      i = close;
    } else source += regexEscape(c);
  }
  return wild ? new RegExp(`${source}$`) : null;
}

const ESCAPABLE = /\\(.)/g;

export function createShell(opts: ShellOptions): Shell {
  const { fs, host } = opts;
  const name = opts.name ?? "zsh";
  const commands = new Map<string, CommandSpec>();
  for (const spec of opts.commands) commands.set(spec.name, spec);
  const env: Record<string, string> = { ...opts.env };
  const aliases: Record<string, string> = { ...opts.aliases };
  const history: string[] = [];
  let lastStatus = 0;

  const statOf = (path: string): Stat | null => {
    try {
      return fs.stat(path);
    } catch {
      return null;
    }
  };
  const absolute = (input: string) => resolvePath(input, cwd, env.HOME);

  let cwd = env.HOME;
  if (env.PWD !== undefined && statOf(env.PWD)?.type === "dir") cwd = env.PWD;
  env.PWD = cwd;

  const aliasFor = (word: string) => (Object.hasOwn(aliases, word) ? aliases[word] : undefined);
  const variable = (key: string) =>
    key === "?" ? String(lastStatus) : Object.hasOwn(env, key) ? env[key] : "";

  // ---------------------------------------------------------------- expansion

  /** Expands every glob wildcard in `pieces` against the filesystem; [] when nothing matches. */
  function glob(pieces: Piece[]): string[] {
    const segments: GlobSegment[] = [{ chars: [], mask: [] }];
    for (const piece of pieces) {
      for (const char of piece.text) {
        if (char === "/") segments.push({ chars: [], mask: [] });
        else {
          const segment = segments[segments.length - 1];
          segment.chars.push(char);
          segment.mask.push(piece.glob);
        }
      }
    }
    const rooted = segments.length > 1 && segments[0].chars.length === 0;
    const wantDir = segments.length > 1 && segments[segments.length - 1].chars.length === 0;
    const named = segments.filter((segment) => segment.chars.length > 0);

    let bases = [rooted ? "/" : ""];
    for (const [index, segment] of named.entries()) {
      const last = index === named.length - 1;
      const pattern = compileSegment(segment);
      const next: string[] = [];
      for (const base of bases) {
        if (pattern === null) {
          const path = base + segment.chars.join("");
          if (statOf(absolute(path)) !== null) next.push(last ? path : `${path}/`);
          continue;
        }
        let entries: string[];
        try {
          entries = fs.readdir(absolute(base));
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (entry.startsWith(".") && segment.chars[0] !== ".") continue;
          if (!pattern.test(entry)) continue;
          const path = base + entry;
          if (last) next.push(path);
          else if (statOf(absolute(path))?.type === "dir") next.push(`${path}/`);
        }
      }
      bases = next;
    }
    if (!wantDir) return bases.sort();
    return bases
      .filter((path) => statOf(absolute(path))?.type === "dir")
      .map((path) => `${path}/`)
      .sort();
  }

  /** Runs `line` and returns what it wrote to stdout, minus trailing newlines. */
  async function substitute(line: string, state: RunState): Promise<string> {
    let captured = "";
    await runLine(line, state, (text) => (captured += text), false);
    return captured.replace(/\n+$/, "");
  }

  /**
   * Expands one word. With `split`, unquoted substitutions break into several
   * words and wildcards are matched against the filesystem; without it the
   * result is always exactly one string (assignments).
   */
  async function expandWord(word: Word, split: boolean, state: RunState): Promise<string[]> {
    const fields: Field[] = [{ pieces: [], forced: false }];
    const current = () => fields[fields.length - 1];
    for (const [index, part] of word.parts.entries()) {
      if (part.kind === "lit") {
        const tilde = !part.quoted && index === 0 && (part.text === "~" || part.text.startsWith("~/"));
        if (tilde) {
          current().pieces.push({ text: env.HOME, glob: false }, { text: part.text.slice(1), glob: true });
        } else current().pieces.push({ text: part.text, glob: !part.quoted });
        if (part.quoted) current().forced = true;
      } else if (part.kind === "var") {
        current().pieces.push({ text: variable(part.name), glob: false });
        if (part.quoted) current().forced = true;
      } else {
        const output = await substitute(part.line, state);
        if (part.quoted || !split) {
          current().pieces.push({ text: output, glob: false });
          if (part.quoted) current().forced = true;
        } else {
          for (const [n, piece] of output.split(/\s+/).entries()) {
            if (n > 0) fields.push({ pieces: [], forced: false });
            if (piece) current().pieces.push({ text: piece, glob: false });
          }
        }
      }
    }
    if (!split) return [fields[0].pieces.map((piece) => piece.text).join("")];

    const words: string[] = [];
    for (const field of fields) {
      const text = field.pieces.map((piece) => piece.text).join("");
      if (text === "" && !field.forced) continue;
      const wild = field.pieces.some((piece) => piece.glob && /[*?[]/.test(piece.text));
      const matches = wild ? glob(field.pieces) : [];
      if (matches.length > 0) words.push(...matches);
      else words.push(text);
    }
    return words;
  }

  // ---------------------------------------------------------------- execution

  type Lookup = { spec: CommandSpec } | { status: number; message: string };

  function lookup(argv0: string): Lookup {
    if (!argv0.includes("/")) {
      const spec = commands.get(argv0);
      return spec ? { spec } : { status: 127, message: "command not found" };
    }
    const path = absolute(argv0);
    let stat: Stat | null;
    try {
      stat = fs.stat(path);
    } catch (error) {
      if (error instanceof FsError && error.code === "EACCES") {
        return { status: 126, message: "permission denied" };
      }
      return { status: 127, message: "no such file or directory" };
    }
    if (stat === null) return { status: 127, message: "no such file or directory" };
    const spec = commands.get(path.slice(path.lastIndexOf("/") + 1));
    if (stat.type === "file" && spec && fs.access(path, "x")) return { spec };
    return { status: 126, message: "permission denied" };
  }

  /** Runs one command; races it against the abort signal so Ctrl+C always returns. */
  async function invoke(
    spec: CommandSpec,
    argv: string[],
    stdio: Stdio,
    state: RunState
  ): Promise<number> {
    const ctx: CommandContext = {
      name: argv[0],
      args: argv.slice(1),
      stdin: stdio.stdin,
      hasStdin: stdio.hasStdin,
      isTTY: stdio.isTTY,
      c: stdio.isTTY ? ansiStyle : plainStyle,
      fs,
      shell: api,
      host,
      signal: state.signal,
      path: absolute,
      out: stdio.out,
      err: stdio.err,
      async exec(inner, stdin) {
        if (state.signal.aborted) return ABORT_STATUS;
        const [innerName] = inner;
        const innerSpec = innerName === undefined ? undefined : commands.get(innerName);
        if (!innerSpec) {
          stdio.err(`${innerName ?? ""}: command not found\n`);
          return 127;
        }
        return invoke(
          innerSpec,
          inner,
          { ...stdio, stdin: stdin ?? "", hasStdin: stdin !== undefined },
          state
        );
      },
    };
    try {
      const result = await Promise.race([(async () => spec.run(ctx))(), state.aborted]);
      if (result === ABORTED) return ABORT_STATUS;
      return typeof result === "number" ? result : 0;
    } catch (error) {
      if (state.signal.aborted) return ABORT_STATUS;
      if (error instanceof FsError) stdio.err(`${argv[0]}: ${error.path}: ${error.message}\n`);
      else stdio.err(`${argv[0]}: ${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  async function runCommand(command: Command, stdio: Stdio, state: RunState): Promise<number> {
    const assigned: [string, string][] = [];
    for (const { name: key, value } of command.assignments) {
      assigned.push([key, (await expandWord(value, false, state))[0]]);
    }
    const argv: string[] = [];
    for (const word of command.words) argv.push(...(await expandWord(word, true, state)));
    const redirects: ResolvedRedirect[] = [];
    for (const redirect of command.redirects) {
      if (redirect.op === "2>&1") {
        redirects.push(redirect);
        continue;
      }
      const targets = await expandWord(redirect.target, true, state);
      if (targets.length !== 1) {
        state.err(`${name}: ambiguous redirect\n`);
        return 1;
      }
      redirects.push({ op: redirect.op, target: targets[0] });
    }

    // Redirects apply in order, so `> f 2>&1` and `2>&1 > f` differ as in a real shell.
    const io = { ...stdio };
    const files: { path: string; chunks: string[] }[] = [];
    for (const redirect of redirects) {
      if (redirect.op === "2>&1") {
        io.err = io.out;
        continue;
      }
      const path = absolute(redirect.target);
      try {
        if (redirect.op === "<") {
          io.stdin = fs.readFile(path);
          io.hasStdin = true;
          continue;
        }
        // Truncate (or create) up front: a bad target fails before the command runs.
        fs.writeFile(path, "", { append: redirect.op.endsWith(">>") });
      } catch (error) {
        if (!(error instanceof FsError)) throw error;
        state.err(`${name}: ${lowerFirst(error.message)}: ${redirect.target}\n`);
        return 1;
      }
      const chunks: string[] = [];
      files.push({ path, chunks });
      if (redirect.op === ">" || redirect.op === ">>") {
        io.out = (text) => void chunks.push(text);
        io.isTTY = false;
      } else io.err = (text) => void chunks.push(text);
    }

    const [argv0] = argv;
    if (argv0 === undefined) {
      for (const [key, value] of assigned) env[key] = value;
      return 0;
    }
    const found = lookup(argv0);
    if (!("spec" in found)) {
      io.err(`${name}: ${found.message}: ${argv0}\n`);
      return found.status;
    }

    const saved = assigned.map(([key]) => [key, Object.hasOwn(env, key) ? env[key] : undefined] as const);
    for (const [key, value] of assigned) env[key] = value;
    let status: number;
    try {
      status = await invoke(found.spec, argv, io, state);
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete env[key];
        else env[key] = value;
      }
    }
    if (state.signal.aborted) return ABORT_STATUS;
    for (const { path, chunks } of files) {
      if (chunks.length === 0) continue;
      try {
        fs.writeFile(path, chunks.join(""), { append: true });
      } catch (error) {
        if (!(error instanceof FsError)) throw error;
        state.err(`${name}: ${lowerFirst(error.message)}: ${path}\n`);
        status = 1;
      }
    }
    return status;
  }

  async function runPipeline(
    pipeline: Pipeline,
    state: RunState,
    out: Sink,
    isTTY: boolean
  ): Promise<number> {
    let stdin = "";
    let hasStdin = false;
    let status = 0;
    for (const [index, command] of pipeline.commands.entries()) {
      if (state.signal.aborted) return ABORT_STATUS;
      const last = index === pipeline.commands.length - 1;
      const chunks: string[] = [];
      status = await runCommand(
        command,
        {
          out: last ? out : (text) => void chunks.push(text),
          err: state.err,
          stdin,
          hasStdin,
          isTTY: last && isTTY,
        },
        state
      );
      if (state.signal.aborted) return ABORT_STATUS;
      stdin = chunks.join("");
      hasStdin = true;
    }
    lastStatus = status;
    return status;
  }

  async function runList(list: ListEntry[], state: RunState, out: Sink, isTTY: boolean) {
    let status = 0;
    for (const { connector, pipeline } of list) {
      if (state.signal.aborted) return ABORT_STATUS;
      if (connector === "&&" && status !== 0) continue;
      if (connector === "||" && status === 0) continue;
      status = await runPipeline(pipeline, state, out, isTTY);
    }
    return status;
  }

  async function runLine(line: string, state: RunState, out: Sink, isTTY: boolean) {
    const parsed = parse(line, aliasFor);
    if ("error" in parsed) {
      state.err(`${name}: ${parsed.error}\n`);
      lastStatus = 1;
      return 1;
    }
    return runList(parsed.list, state, out, isTTY);
  }

  // --------------------------------------------------------------- completion

  /** Completes a path token; the directory part is echoed back exactly as typed. */
  function completePath(token: string, dirsOnly: boolean): string[] {
    if (token === "~") return ["~/"];
    const cut = token.lastIndexOf("/") + 1;
    const dirPart = token.slice(0, cut);
    const base = token.slice(cut).replace(ESCAPABLE, "$1").toLowerCase();
    const dirPath = absolute(dirPart.replace(ESCAPABLE, "$1") || ".");
    let entries: string[];
    try {
      entries = fs.readdir(dirPath);
    } catch {
      return [];
    }
    const matches: string[] = [];
    for (const entry of entries) {
      if (entry.startsWith(".") && !base.startsWith(".")) continue;
      if (!entry.toLowerCase().startsWith(base)) continue;
      const isDir = statOf(`${dirPath === "/" ? "" : dirPath}/${entry}`)?.type === "dir";
      if (dirsOnly && !isDir) continue;
      matches.push(dirPart + entry.replace(/ /g, "\\ ") + (isDir ? "/" : ""));
    }
    return matches.sort();
  }

  function complete(line: string): Completion | null {
    // Find the token under the caret and what precedes it in its command.
    let tokenStart = 0;
    let raw = "";
    let quote = "";
    let words = 0;
    let commandName = "";
    let redirectPending = false;
    const endToken = () => {
      if (raw === "") return;
      if (redirectPending) redirectPending = false;
      else if (words === 0 && ASSIGNMENT_WORD.test(raw)) {
        // `VAR=value cmd`: still looking for the command name.
      } else {
        if (words === 0) commandName = raw;
        words++;
      }
      raw = "";
    };
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (quote) {
        raw += c;
        if (c === "\\" && quote === '"' && i + 1 < line.length) raw += line[++i];
        else if (c === quote) quote = "";
        continue;
      }
      if (c === "\\" && i + 1 < line.length) {
        raw += c + line[++i];
      } else if (c === "'" || c === '"') {
        quote = c;
        raw += c;
      } else if (c === " " || c === "\t") {
        endToken();
        tokenStart = i + 1;
      } else if (c === "|" || c === "&" || c === ";" || c === "<" || c === ">") {
        // `2>file`: the 2 names a descriptor, not an argument.
        if (c === ">" && raw === "2") raw = "";
        endToken();
        const two = line.slice(i, i + 2);
        const width = two === "&&" || two === "||" || two === ">>" ? 2 : 1;
        if (c === ">" && line[i + 1] === "&") i++;
        else i += width - 1;
        if (c === "|" || c === ";" || c === "&") {
          words = 0;
          commandName = "";
          redirectPending = false;
        } else redirectPending = true;
        tokenStart = i + 1;
      } else raw += c;
    }
    const token = line.slice(tokenStart);
    const prefix = line.slice(0, tokenStart);

    let matches: string[];
    if (words === 0 && !redirectPending && !token.includes("/")) {
      if (token === "") return null;
      const wanted = token.toLowerCase();
      const names = new Set<string>();
      for (const spec of commands.values()) if (!spec.hidden) names.add(spec.name);
      for (const alias of Object.keys(aliases)) names.add(alias);
      matches = [...names].filter((candidate) => candidate.toLowerCase().startsWith(wanted)).sort();
    } else {
      const dirsOnly = !redirectPending && (commandName === "cd" || commandName === "rmdir");
      matches = completePath(token, dirsOnly);
    }
    const lower = token.toLowerCase();
    const candidate =
      token === ""
        ? ""
        : (matches.find((match) => match.length > token.length && match.toLowerCase().startsWith(lower)) ?? "");
    return { prefix, token, matches, candidate };
  }

  // ----------------------------------------------------------------- the shell

  const api: Shell = {
    fs,
    env,
    aliases,
    history,
    get cwd() {
      return cwd;
    },
    get lastStatus() {
      return lastStatus;
    },
    chdir(path) {
      const stat = fs.stat(path);
      if (stat === null) throw new FsError("ENOENT", path);
      if (stat.type !== "dir") throw new FsError("ENOTDIR", path);
      if (!fs.access(path, "x")) throw new FsError("EACCES", path);
      env.OLDPWD = cwd;
      cwd = path;
      env.PWD = path;
    },
    specs: () => [...commands.values()],
    spec: (specName) => commands.get(specName),
    promptPath() {
      const home = env.HOME;
      if (cwd === home) return "~";
      return cwd.startsWith(`${home}/`) ? `~${cwd.slice(home.length)}` : cwd;
    },
    complete,
    async run(line, runOpts) {
      const trimmed = line.trim();
      if (trimmed === "") return 0;
      history.push(trimmed);
      const signal = runOpts?.signal ?? new AbortController().signal;
      // Built with the constructor: Promise.withResolvers is missing in
      // browsers from before 2024, which this page still has to run in.
      let fire = () => {};
      const aborted = new Promise<typeof ABORTED>((resolve) => {
        fire = () => resolve(ABORTED);
      });
      if (signal.aborted) fire();
      else signal.addEventListener("abort", fire, { once: true });
      // Once aborted, whatever an abandoned command still writes is dropped.
      const state: RunState = {
        signal,
        aborted,
        err: (text) => {
          if (!signal.aborted) host.write(text, "err");
        },
      };
      const out: Sink = (text) => {
        if (!signal.aborted) host.write(text, "out");
      };
      try {
        const status = await runLine(trimmed, state, out, true);
        if (status === ABORT_STATUS) lastStatus = ABORT_STATUS;
        return status;
      } catch (error) {
        state.err(`${name}: ${error instanceof Error ? error.message : String(error)}\n`);
        lastStatus = 1;
        return 1;
      } finally {
        signal.removeEventListener("abort", fire);
      }
    },
  };
  return api;
}

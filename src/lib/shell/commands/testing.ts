/**
 * Test harness: runs one command spec directly with a hand-built
 * CommandContext, without the interpreter. A `Session` holds the
 * filesystem, environment and aliases, so several commands can be run
 * against the same state.
 */
import { buildFsImage, DEFAULT_ALIASES, DEFAULT_ENV } from "../fs-image";
import { ansiStyle, plainStyle } from "../style";
import { FsError, type CommandContext, type Host, type ShellApi, type Vfs } from "../types";
import { createVfs, resolvePath } from "../vfs";
import { COMMANDS } from "./index";

export const FIXED_NOW = Date.UTC(2026, 10, 10, 12, 0, 0);
const UPTIME_MS = 90_000;
const HOME = "/home/visitor";
const THEMES = ["amber", "green", "ice"];

export interface FakeHost extends Host {
  calls: { clear: number; exit: number; open: string[]; setTheme: string[] };
}

export interface Session {
  fs: Vfs;
  env: Record<string, string>;
  aliases: Record<string, string>;
  history: string[];
  cwd: string;
  host: FakeHost;
  api: ShellApi;
}

/** Deterministic uniform values in [0, 1). */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createHost(overrides: Partial<Host> = {}): FakeHost {
  let theme = THEMES[0]!;
  const random = seededRandom(1);
  const host: FakeHost = {
    calls: { clear: 0, exit: 0, open: [], setTheme: [] },
    write() {},
    clear() {
      host.calls.clear++;
    },
    exit() {
      host.calls.exit++;
    },
    open(url) {
      host.calls.open.push(url);
    },
    cols: () => 80,
    now: () => new Date(FIXED_NOW),
    random,
    loadRepos: async () => ({ ok: true, repos: [], fromCache: false }),
    themes: () => [...THEMES],
    theme: () => theme,
    setTheme(name) {
      host.calls.setTheme.push(name);
      if (!THEMES.includes(name)) return false;
      theme = name;
      return true;
    },
    ...overrides,
  };
  return host;
}

export function createSession(opts: { host?: Partial<Host>; cwd?: string } = {}): Session {
  const fs = createVfs(
    buildFsImage(COMMANDS, { startedAt: FIXED_NOW - UPTIME_MS, now: () => FIXED_NOW }),
    { user: "visitor", now: () => FIXED_NOW }
  );
  const session: Session = {
    fs,
    env: { ...DEFAULT_ENV },
    aliases: { ...DEFAULT_ALIASES },
    history: [],
    cwd: opts.cwd ?? HOME,
    host: createHost(opts.host),
    api: {
      get env() {
        return session.env;
      },
      get aliases() {
        return session.aliases;
      },
      get history() {
        return session.history;
      },
      get cwd() {
        return session.cwd;
      },
      chdir(path) {
        const stat = fs.stat(path);
        if (!stat) throw new FsError("ENOENT", path);
        if (stat.type !== "dir") throw new FsError("ENOTDIR", path);
        if (!fs.access(path, "x")) throw new FsError("EACCES", path);
        session.env.OLDPWD = session.cwd;
        session.env.PWD = path;
        session.cwd = path;
      },
      specs: () => COMMANDS,
      spec: (name) => COMMANDS.find((spec) => spec.name === name),
      lastStatus: 0,
    },
  };
  session.env.PWD = session.cwd;
  return session;
}

interface Io {
  out(text: string): void;
  err(text: string): void;
  stdin: string;
  hasStdin: boolean;
  isTTY: boolean;
  signal: AbortSignal;
}

async function execute(session: Session, argv: string[], io: Io): Promise<number> {
  const [name = "", ...args] = argv;
  const spec = session.api.spec(name);
  if (!spec) {
    io.err(`zsh: command not found: ${name}\n`);
    return 127;
  }
  const ctx: CommandContext = {
    name,
    args,
    stdin: io.stdin,
    hasStdin: io.hasStdin,
    isTTY: io.isTTY,
    c: io.isTTY ? ansiStyle : plainStyle,
    fs: session.fs,
    shell: session.api,
    host: session.host,
    signal: io.signal,
    path: (input) => resolvePath(input, session.cwd, session.env.HOME ?? HOME),
    out: io.out,
    err: io.err,
    exec: (inner, stdin) =>
      execute(session, inner, { ...io, stdin: stdin ?? "", hasStdin: stdin !== undefined }),
  };
  return (await spec.run(ctx)) ?? 0;
}

export interface RunOptions {
  /** Piped input; its presence makes `hasStdin` true. */
  stdin?: string;
  isTTY?: boolean;
  cwd?: string;
  host?: Partial<Host>;
  signal?: AbortSignal;
  /** Reuse a previous run's session so commands see each other's changes. */
  session?: Session;
}

export interface RunResult {
  status: number;
  out: string;
  err: string;
  fs: Vfs;
  cwd: string;
  env: Record<string, string>;
  host: FakeHost;
  session: Session;
}

export async function runCommand(
  name: string,
  args: string[],
  opts: RunOptions = {}
): Promise<RunResult> {
  const session = opts.session ?? createSession({ host: opts.host, cwd: opts.cwd });
  if (opts.session && opts.cwd) session.cwd = opts.cwd;
  let out = "";
  let err = "";
  const status = await execute(session, [name, ...args], {
    out: (text) => void (out += text),
    err: (text) => void (err += text),
    stdin: opts.stdin ?? "",
    hasStdin: opts.stdin !== undefined,
    isTTY: opts.isTTY ?? false,
    signal: opts.signal ?? new AbortController().signal,
  });
  return {
    status,
    out,
    err,
    fs: session.fs,
    cwd: session.cwd,
    env: session.env,
    host: session.host,
    session,
  };
}

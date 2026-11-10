/**
 * Contracts shared by the virtual filesystem, the interpreter, the command
 * set and the terminal UI. Everything under src/lib/shell is DOM-free so it
 * runs unchanged in unit tests.
 */
import type { ReposResult } from "../github";

export type FsErrorCode =
  | "ENOENT"
  | "EACCES"
  | "EISDIR"
  | "ENOTDIR"
  | "EEXIST"
  | "ENOTEMPTY"
  | "EINVAL";

const STRERROR: Record<FsErrorCode, string> = {
  ENOENT: "No such file or directory",
  EACCES: "Permission denied",
  EISDIR: "Is a directory",
  ENOTDIR: "Not a directory",
  EEXIST: "File exists",
  ENOTEMPTY: "Directory not empty",
  EINVAL: "Invalid argument",
};

/** `message` is the bare strerror text, so callers print `cmd: path: message`. */
export class FsError extends Error {
  readonly code: FsErrorCode;
  readonly path: string;
  constructor(code: FsErrorCode, path: string) {
    super(STRERROR[code]);
    this.name = "FsError";
    this.code = code;
    this.path = path;
  }
}

export interface Stat {
  type: "file" | "dir";
  /** Permission bits only, e.g. 0o644. */
  mode: number;
  owner: string;
  /** Characters for files, 4096 for directories. */
  size: number;
  /** Milliseconds since the epoch. */
  mtime: number;
}

/**
 * In-memory filesystem. Every method takes an absolute, normalised path
 * (see `resolvePath` in vfs.ts) and enforces owner/other permission bits
 * for the session user. Failures throw `FsError`.
 */
export interface Vfs {
  /** null when the path does not exist; throws EACCES when a parent is not searchable. */
  stat(path: string): Stat | null;
  readFile(path: string): string;
  /** Creates or replaces the file; the parent directory must exist. */
  writeFile(path: string, data: string, opts?: { append?: boolean }): void;
  /** Entry names, sorted, dotfiles included. */
  readdir(path: string): string[];
  mkdir(path: string, opts?: { recursive?: boolean }): void;
  /** Removes a file or an empty directory; a non-empty one needs `recursive` (else ENOTEMPTY). */
  remove(path: string, opts?: { recursive?: boolean }): void;
  /** Replaces an existing file at `to`; EISDIR when `to` is a directory. */
  rename(from: string, to: string): void;
  copy(from: string, to: string, opts?: { recursive?: boolean }): void;
  /**
   * Whether the session user may read (`r`), write (`w`) or search/execute
   * (`x`) the node. False when it does not exist or cannot be reached.
   */
  access(path: string, mode: "r" | "w" | "x"): boolean;
}

/**
 * Text styling for command output. On a terminal these emit ANSI SGR and
 * OSC 8 sequences; when stdout is a pipe or a file every method returns its
 * text unchanged, so commands never branch on `isTTY` for colour.
 */
export interface Style {
  bold(text: string): string;
  dim(text: string): string;
  underline(text: string): string;
  red(text: string): string;
  green(text: string): string;
  yellow(text: string): string;
  blue(text: string): string;
  magenta(text: string): string;
  cyan(text: string): string;
  /** Hyperlink; `text` defaults to the URL. Plain `text` when not a terminal. */
  link(url: string, text?: string): string;
}

/** Side effects the shell cannot perform itself; the UI (or a test fake) provides them. */
export interface Host {
  /** Terminal output. `text` may contain ANSI sequences and partial lines. */
  write(text: string, stream: "out" | "err"): void;
  /** Wipe the screen (the `clear` command, Ctrl+L). */
  clear(): void;
  /** End the session and close the terminal window (the `exit` command). */
  exit(): void;
  /** Open a URL in a new tab. */
  open(url: string): void;
  /** Width of the terminal in character cells. */
  cols(): number;
  now(): Date;
  /** Uniform in [0, 1). */
  random(): number;
  loadRepos(): Promise<ReposResult>;
  /** Available colour themes, current one, and a setter that reports success. */
  themes(): string[];
  theme(): string;
  setTheme(name: string): boolean;
}

/** What a running command may ask of the shell that launched it. */
export interface ShellApi {
  /** Exported variables; mutations are visible to later commands. */
  readonly env: Record<string, string>;
  readonly aliases: Record<string, string>;
  /** Submitted lines, oldest first, including the one currently running. */
  readonly history: readonly string[];
  readonly cwd: string;
  /** Change directory to an absolute path; updates PWD and OLDPWD. Throws FsError. */
  chdir(path: string): void;
  /** Registered commands, hidden ones included. */
  specs(): readonly CommandSpec[];
  spec(name: string): CommandSpec | undefined;
  /** Status of the previous pipeline (`$?`). */
  readonly lastStatus: number;
}

export interface CommandContext {
  /** argv[0] as typed (after alias expansion). */
  name: string;
  /** argv[1..], already expanded (variables, globs, quotes). */
  args: string[];
  /** Everything piped or redirected in; "" when stdin is the terminal. */
  stdin: string;
  /** True when stdin came from a pipe or `<`, even if it is empty. */
  hasStdin: boolean;
  /** True when stdout reaches the terminal (last stage, no `>` redirect). */
  isTTY: boolean;
  c: Style;
  fs: Vfs;
  shell: ShellApi;
  host: Host;
  /** Aborted by Ctrl+C; long-running commands must stop when it fires. */
  signal: AbortSignal;
  /** Resolve a user-supplied path against cwd and HOME to an absolute path. */
  path(input: string): string;
  /** Write to stdout / stderr. No newline is added. */
  out(text: string): void;
  err(text: string): void;
  /**
   * Run another command with this command's stdout and stderr (for `sudo`,
   * `xargs`, `time`, …). Resolves to its exit status; 127 when not found.
   */
  exec(argv: string[], stdin?: string): Promise<number>;
}

/** Returns the exit status; `undefined` means 0. */
export type CommandRun = (
  ctx: CommandContext
) => number | void | Promise<number | void>;

export interface CommandSpec {
  name: string;
  /** One line, lower case, no trailing period: shown by `help`, `man`, `whatis`. */
  summary: string;
  /** Synopsis without the command name repeated twice, e.g. "ls [-la1] [path…]". */
  usage: string;
  /** Extra paragraphs for `man`. */
  man?: string;
  /** Easter eggs: runnable, but absent from `help`, /bin and Tab completion. */
  hidden?: boolean;
  /** Site-specific commands are grouped first in `help`. */
  group?: "site" | "files" | "text" | "shell" | "system";
  run: CommandRun;
}

/** Same shape the prompt ghost and Tab handling have always consumed. */
export interface Completion {
  /** Text before the token being completed; `prefix + match` is the new line. */
  prefix: string;
  token: string;
  /** Replacement tokens, sorted; directories end with "/". */
  matches: string[];
  /** First match that extends the token, "" when none does. */
  candidate: string;
}

export interface Shell extends ShellApi {
  readonly fs: Vfs;
  /**
   * Run one input line (pipelines, `&&`, `||`, `;`, redirects). Never
   * rejects: errors are written to the host and reflected in the status.
   * An aborted `signal` stops the line with status 130.
   */
  run(line: string, opts?: { signal?: AbortSignal }): Promise<number>;
  /**
   * Completion for a line with the caret at its end. null when there is
   * nothing to complete (empty line, or an empty token in command position).
   */
  complete(line: string): Completion | null;
  /** cwd for the prompt: "~" for HOME, "~/sub" below it, absolute elsewhere. */
  promptPath(): string;
}

export interface ShellOptions {
  fs: Vfs;
  host: Host;
  commands: readonly CommandSpec[];
  /** Initial exported variables; must include HOME and USER. */
  env: Record<string, string>;
  aliases?: Record<string, string>;
  /** Shell name used in error messages ("zsh: command not found: x"). */
  name?: string;
}

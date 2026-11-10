/**
 * Helpers shared by the command modules: flag parsing, stdin/file input,
 * filesystem error reporting and small formatters.
 */
import { FsError, type CommandContext, type Stat, type Vfs } from "../types";

export interface FlagSpec {
  /** Letters of flags without a value (`-a`). */
  bool?: string;
  /** Letters of flags that take a value (`-n 5` or `-n5`). */
  value?: string;
  /** Alternative letters, mapped to the canonical one (`R` → `r`). */
  alias?: Record<string, string>;
}

export interface ParsedArgs {
  flags: Set<string>;
  values: Map<string, string>;
  operands: string[];
}

/**
 * GNU-style parsing: clustered short flags, flags may follow operands,
 * `--` ends flags and a lone `-` is an operand. Prints the error and
 * returns null on a bad flag; the caller returns 2.
 */
export function parseArgs(
  ctx: CommandContext,
  spec: FlagSpec,
  args: readonly string[] = ctx.args
): ParsedArgs | null {
  const bool = spec.bool ?? "";
  const valued = spec.value ?? "";
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const operands: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      operands.push(...args.slice(i + 1));
      break;
    }
    if (arg.length < 2 || !arg.startsWith("-")) {
      operands.push(arg);
      continue;
    }
    if (arg.startsWith("--")) {
      ctx.err(`${ctx.name}: unrecognized option '${arg}'\n`);
      return null;
    }
    for (let j = 1; j < arg.length; j++) {
      const letter = spec.alias?.[arg[j]!] ?? arg[j]!;
      if (bool.includes(letter)) {
        flags.add(letter);
      } else if (valued.includes(letter)) {
        const attached = arg.slice(j + 1);
        const value = attached || args[++i];
        if (value === undefined) {
          ctx.err(`${ctx.name}: option requires an argument -- '${letter}'\n`);
          return null;
        }
        values.set(letter, value);
        break;
      } else {
        ctx.err(`${ctx.name}: invalid option -- '${arg[j]}'\n`);
        return null;
      }
    }
  }
  return { flags, values, operands };
}

/** `cmd: <path as typed>: <strerror>`; anything that is not an FsError is a bug and propagates. */
export function fsFail(ctx: CommandContext, typed: string, error: unknown): void {
  if (!(error instanceof FsError)) throw error;
  ctx.err(`${ctx.name}: ${typed}: ${error.message}\n`);
}

export function noEntry(ctx: CommandContext, typed: string): void {
  fsFail(ctx, typed, new FsError("ENOENT", typed));
}

export function safeStat(fs: Vfs, path: string): Stat | null {
  try {
    return fs.stat(path);
  } catch (error) {
    if (error instanceof FsError) return null;
    throw error;
  }
}

export interface Input {
  /** The operand as typed; "-" for standard input. */
  name: string;
  text: string;
}

/**
 * Text filters read their files, or stdin when there are no operands (and
 * stdin is a pipe). Unreadable operands are reported and skipped.
 */
export function readInputs(
  ctx: CommandContext,
  operands: readonly string[]
): { inputs: Input[]; failed: boolean } {
  const inputs: Input[] = [];
  let failed = false;
  if (operands.length === 0) {
    if (ctx.hasStdin) inputs.push({ name: "-", text: ctx.stdin });
    return { inputs, failed };
  }
  for (const operand of operands) {
    if (operand === "-") {
      inputs.push({ name: "-", text: ctx.stdin });
      continue;
    }
    try {
      inputs.push({ name: operand, text: ctx.fs.readFile(ctx.path(operand)) });
    } catch (error) {
      fsFail(ctx, operand, error);
      failed = true;
    }
  }
  return { inputs, failed };
}

/** Lines without terminators; a trailing newline does not create an empty last line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Every line, including the last, ends with a newline. */
export function joinLines(lines: readonly string[]): string {
  return lines.map((line) => line + "\n").join("");
}

export function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

export function parentPath(abs: string): string {
  const cut = abs.lastIndexOf("/");
  return cut <= 0 ? "/" : abs.slice(0, cut);
}

export function baseName(abs: string): string {
  return abs.slice(abs.lastIndexOf("/") + 1);
}

/** Set a key without ever touching the prototype (`__proto__` is just a name). */
export function setEntry(record: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(record, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

export function getEntry(record: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export const two = (n: number): string => String(n).padStart(2, "0");

/** `Nov 10 12:34` in the visitor's local time, as `ls -l` shows it. */
export function shortTime(ms: number): string {
  const d = new Date(ms);
  return `${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** `2026-11-10 12:34:56` in local time. */
export function isoLocal(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** `Tue Nov 10 12:34:56 CET 2026`, the default output of date(1). */
export function dateLine(d: Date): string {
  const zone =
    new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
      .formatToParts(d)
      .find((part) => part.type === "timeZoneName")?.value ?? "UTC";
  return `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, " ")} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${zone} ${d.getFullYear()}`;
}

/** `drwxr-xr-x` for directories, `-rw-r--r--` for files. */
export function modeString(stat: Pick<Stat, "type" | "mode">): string {
  let out = stat.type === "dir" ? "d" : "-";
  for (let shift = 6; shift >= 0; shift -= 3) {
    const bits = (stat.mode >> shift) & 7;
    out += (bits & 4 ? "r" : "-") + (bits & 2 ? "w" : "-") + (bits & 1 ? "x" : "-");
  }
  return out;
}

/** Seconds since the shell started, read from /proc/uptime. */
export function uptimeSeconds(ctx: CommandContext): number {
  try {
    const seconds = Number.parseFloat(ctx.fs.readFile("/proc/uptime"));
    return Number.isFinite(seconds) ? seconds : 0;
  } catch (error) {
    if (error instanceof FsError) return 0;
    throw error;
  }
}

/** `3 mins`, `1 hour, 5 mins`, `12 secs`. */
export function humanDuration(totalSeconds: number): string {
  const secs = Math.floor(totalSeconds);
  if (secs < 60) return plural(secs, "sec", "secs");
  const mins = Math.floor(secs / 60);
  if (mins < 60) return plural(mins, "min", "mins");
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  const h = plural(hours, "hour", "hours");
  return rest === 0 ? h : `${h}, ${plural(rest, "min", "mins")}`;
}

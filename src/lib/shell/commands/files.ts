import { FsError, type CommandContext, type CommandSpec, type Stat } from "../types";
import {
  baseName,
  fsFail,
  getEntry,
  isoLocal,
  joinLines,
  joinPath,
  modeString,
  noEntry,
  parentPath,
  parseArgs,
  plural,
  readInputs,
  safeStat,
  shortTime,
  splitLines,
} from "./util";

interface Entry {
  name: string;
  stat: Stat | null;
}

interface ListOptions {
  long: boolean;
  one: boolean;
  /** Mark executables with `*` (only `-F`). */
  star: boolean;
  /** Append `/` to directory names (`-F` or a terminal). */
  slash: boolean;
}

function decorate(ctx: CommandContext, entry: Entry, o: ListOptions): { plain: string; styled: string } {
  const isDir = entry.stat?.type === "dir";
  const exec = entry.stat?.type === "file" && (entry.stat.mode & 0o111) !== 0;
  const plain = entry.name + (isDir && o.slash ? "/" : "") + (exec && o.star ? "*" : "");
  const styled = isDir ? ctx.c.blue(ctx.c.bold(plain)) : exec ? ctx.c.green(plain) : plain;
  return { plain, styled };
}

/** Column-major layout like ls(1): fill each column top to bottom, as many columns as fit. */
function columns(names: { plain: string; styled: string }[], width: number): string {
  const widest = Math.max(...names.map((n) => n.plain.length));
  const cell = widest + 2;
  const fit = Math.max(1, Math.floor(width / cell));
  const rows = Math.ceil(names.length / fit);
  const count = Math.ceil(names.length / rows);
  let out = "";
  for (let row = 0; row < rows; row++) {
    let line = "";
    for (let col = 0; col < count; col++) {
      const item = names[col * rows + row];
      if (!item) continue;
      const isLast = (col + 1) * rows + row >= names.length;
      line += isLast ? item.styled : item.styled + " ".repeat(cell - item.plain.length);
    }
    out += line + "\n";
  }
  return out;
}

function renderEntries(ctx: CommandContext, entries: Entry[], o: ListOptions): string {
  if (entries.length === 0) return "";
  const names = entries.map((entry) => decorate(ctx, entry, o));
  if (o.long) {
    const ownerWidth = Math.max(...entries.map((e) => (e.stat?.owner ?? "?").length));
    const sizeWidth = Math.max(...entries.map((e) => String(e.stat?.size ?? "?").length));
    return entries
      .map((entry, i) => {
        const { stat } = entry;
        const mode = stat ? modeString(stat) : "??????????";
        const owner = (stat?.owner ?? "?").padEnd(ownerWidth);
        const size = String(stat?.size ?? "?").padStart(sizeWidth);
        const time = stat ? shortTime(stat.mtime) : "??? ?? ??:??";
        return `${mode} ${owner} ${size} ${time} ${names[i]!.styled}\n`;
      })
      .join("");
  }
  if (ctx.isTTY && !o.one) return columns(names, ctx.host.cols());
  return joinLines(names.map((n) => n.styled));
}

function readEntries(ctx: CommandContext, abs: string, all: boolean): Entry[] {
  const names = ctx.fs.readdir(abs);
  const entries: Entry[] = [];
  if (all) {
    entries.push({ name: ".", stat: safeStat(ctx.fs, abs) });
    entries.push({ name: "..", stat: safeStat(ctx.fs, parentPath(abs)) });
  }
  for (const name of names) {
    if (all || !name.startsWith(".")) {
      entries.push({ name, stat: safeStat(ctx.fs, joinPath(abs, name)) });
    }
  }
  return entries;
}

const ls: CommandSpec = {
  name: "ls",
  group: "files",
  summary: "list directory contents",
  usage: "ls [-al1F] [path…]",
  man: "Lists the entries of each directory, or the named files. Dotfiles are hidden unless -a is given (which also shows . and ..).\n\n-l  long format: mode, owner, size, modification time\n-1  one entry per line\n-F  mark directories with / and executables with *\n\nOn the terminal the names are laid out in columns and directories are blue; piped, one name per line.",
  run(ctx) {
    const parsed = parseArgs(ctx, { bool: "al1F" });
    if (!parsed) return 2;
    const { flags } = parsed;
    const options: ListOptions = {
      long: flags.has("l"),
      one: flags.has("1"),
      star: flags.has("F"),
      slash: flags.has("F") || ctx.isTTY,
    };
    const operands = parsed.operands.length ? parsed.operands : ["."];
    let status = 0;
    const files: Entry[] = [];
    const dirs: { typed: string; abs: string }[] = [];
    for (const typed of operands) {
      const abs = ctx.path(typed);
      try {
        const stat = ctx.fs.stat(abs);
        if (!stat) {
          noEntry(ctx, typed);
          status = 1;
        } else if (stat.type === "dir") {
          dirs.push({ typed, abs });
        } else {
          files.push({ name: typed, stat });
        }
      } catch (error) {
        fsFail(ctx, typed, error);
        status = 1;
      }
    }

    const sections: string[] = [];
    if (files.length) sections.push(renderEntries(ctx, files, options));
    for (const { typed, abs } of dirs) {
      try {
        const body = renderEntries(ctx, readEntries(ctx, abs, flags.has("a")), options);
        sections.push(operands.length > 1 ? `${typed}:\n${body}` : body);
      } catch (error) {
        fsFail(ctx, typed, error);
        status = 1;
      }
    }
    ctx.out(sections.join("\n"));
    return status;
  },
};

const cd: CommandSpec = {
  name: "cd",
  group: "files",
  summary: "change the working directory",
  usage: "cd [dir|-]",
  man: "With no argument goes to your home directory; `cd -` goes back to the previous directory and prints it.",
  run(ctx) {
    if (ctx.args.length > 1) {
      ctx.err("cd: too many arguments\n");
      return 1;
    }
    const arg = ctx.args[0];
    let target: string;
    if (arg === undefined) {
      const home = getEntry(ctx.shell.env, "HOME");
      if (!home) {
        ctx.err("cd: HOME not set\n");
        return 1;
      }
      target = home;
    } else if (arg === "-") {
      const previous = getEntry(ctx.shell.env, "OLDPWD");
      if (!previous) {
        ctx.err("cd: OLDPWD not set\n");
        return 1;
      }
      target = previous;
    } else {
      target = arg;
    }

    const abs = ctx.path(target);
    const typed = arg === undefined || arg === "-" ? target : arg;
    let stat: Stat | null = null;
    try {
      stat = ctx.fs.stat(abs);
    } catch (error) {
      if (!(error instanceof FsError)) throw error;
      ctx.err(`cd: permission denied: ${typed}\n`);
      return 1;
    }
    if (!stat) {
      ctx.err(`cd: no such file or directory: ${typed}\n`);
      return 1;
    }
    if (stat.type !== "dir") {
      ctx.err(`cd: not a directory: ${typed}\n`);
      return 1;
    }
    if (!ctx.fs.access(abs, "x")) {
      ctx.err(`cd: permission denied: ${typed}\n`);
      return 1;
    }
    ctx.shell.chdir(abs);
    if (arg === "-") ctx.out(abs + "\n");
  },
};

const pwd: CommandSpec = {
  name: "pwd",
  group: "files",
  summary: "print the working directory",
  usage: "pwd",
  run(ctx) {
    ctx.out(ctx.shell.cwd + "\n");
  },
};

const cat: CommandSpec = {
  name: "cat",
  group: "files",
  summary: "print files, or standard input",
  usage: "cat [-n] [file…]",
  man: "Prints each file in order; with no files, or a file named -, prints standard input.\n\n-n  number every output line",
  run(ctx) {
    const parsed = parseArgs(ctx, { bool: "n" });
    if (!parsed) return 2;
    const { inputs, failed } = readInputs(ctx, parsed.operands);
    let number = 1;
    for (const { text } of inputs) {
      if (!parsed.flags.has("n")) {
        ctx.out(text);
        continue;
      }
      for (const line of splitLines(text)) {
        ctx.out(`${String(number++).padStart(6)}\t${line}\n`);
      }
    }
    return failed ? 1 : 0;
  },
};

const tree: CommandSpec = {
  name: "tree",
  group: "files",
  summary: "show a directory as a tree",
  usage: "tree [-a] [-L depth] [dir]",
  man: "Draws the directory and everything below it with box-drawing branches, then counts the directories and files shown.\n\n-a  include dotfiles\n-L  descend at most this many levels\n\nDirectories you may not read are marked [permission denied].",
  run(ctx) {
    const parsed = parseArgs(ctx, { bool: "a", value: "L" });
    if (!parsed) return 2;
    const showAll = parsed.flags.has("a");
    const levelText = parsed.values.get("L");
    let maxLevel = Infinity;
    if (levelText !== undefined) {
      maxLevel = Number(levelText);
      if (!Number.isInteger(maxLevel) || maxLevel < 1) {
        ctx.err(`tree: invalid level: ${levelText}\n`);
        return 2;
      }
    }
    const typed = parsed.operands[0] ?? ".";
    const rootAbs = ctx.path(typed);
    let rootStat: Stat | null;
    try {
      rootStat = ctx.fs.stat(rootAbs);
    } catch (error) {
      fsFail(ctx, typed, error);
      return 1;
    }
    if (!rootStat) {
      noEntry(ctx, typed);
      return 1;
    }
    if (rootStat.type !== "dir") {
      ctx.err(`tree: ${typed}: Not a directory\n`);
      return 1;
    }

    let dirs = 0;
    let files = 0;
    let status = 0;
    const lines: string[] = [];
    const denied = " [permission denied]";

    function children(abs: string): string[] {
      const names = ctx.fs.readdir(abs);
      return showAll ? names : names.filter((name) => !name.startsWith("."));
    }

    function visit(abs: string, name: string, prefix: string, last: boolean, level: number): void {
      const stat = safeStat(ctx.fs, abs);
      let kids: string[] | null = null;
      let unreadable = false;
      if (stat?.type === "dir") {
        dirs++;
        if (level < maxLevel) {
          try {
            kids = children(abs);
          } catch (error) {
            if (!(error instanceof FsError)) throw error;
            unreadable = true;
          }
        }
      } else {
        files++;
      }
      const label = stat?.type === "dir" ? ctx.c.blue(ctx.c.bold(name)) : name;
      lines.push(`${prefix}${last ? "└── " : "├── "}${label}${unreadable ? denied : ""}`);
      if (kids) {
        const next = prefix + (last ? "    " : "│   ");
        kids.forEach((kid, i) =>
          visit(joinPath(abs, kid), kid, next, i === kids.length - 1, level + 1)
        );
      }
    }

    let top: string[] = [];
    let rootNote = "";
    try {
      top = children(rootAbs);
    } catch (error) {
      if (!(error instanceof FsError)) throw error;
      rootNote = denied;
      status = 1;
    }
    lines.push(ctx.c.blue(ctx.c.bold(typed)) + rootNote);
    top.forEach((name, i) =>
      visit(joinPath(rootAbs, name), name, "", i === top.length - 1, 1)
    );
    ctx.out(
      joinLines(lines) +
        `\n${plural(dirs, "directory", "directories")}, ${plural(files, "file", "files")}\n`
    );
    return status;
  },
};

const touch: CommandSpec = {
  name: "touch",
  group: "files",
  summary: "create empty files",
  usage: "touch file…",
  man: "Creates each file if it does not exist. Existing files keep their content.",
  run(ctx) {
    const parsed = parseArgs(ctx, {});
    if (!parsed) return 2;
    if (parsed.operands.length === 0) {
      ctx.err("touch: missing file operand\n");
      return 1;
    }
    let status = 0;
    for (const typed of parsed.operands) {
      const abs = ctx.path(typed);
      try {
        const stat = ctx.fs.stat(abs);
        if (stat?.type !== "dir") ctx.fs.writeFile(abs, "", { append: true });
      } catch (error) {
        fsFail(ctx, typed, error);
        status = 1;
      }
    }
    return status;
  },
};

const mkdir: CommandSpec = {
  name: "mkdir",
  group: "files",
  summary: "make directories",
  usage: "mkdir [-p] dir…",
  man: "-p  create missing parent directories, and do not complain when the directory already exists",
  run(ctx) {
    const parsed = parseArgs(ctx, { bool: "p" });
    if (!parsed) return 2;
    if (parsed.operands.length === 0) {
      ctx.err("mkdir: missing operand\n");
      return 1;
    }
    let status = 0;
    for (const typed of parsed.operands) {
      try {
        ctx.fs.mkdir(ctx.path(typed), { recursive: parsed.flags.has("p") });
      } catch (error) {
        fsFail(ctx, typed, error);
        status = 1;
      }
    }
    return status;
  },
};

const rmdir: CommandSpec = {
  name: "rmdir",
  group: "files",
  summary: "remove empty directories",
  usage: "rmdir dir…",
  run(ctx) {
    const parsed = parseArgs(ctx, {});
    if (!parsed) return 2;
    if (parsed.operands.length === 0) {
      ctx.err("rmdir: missing operand\n");
      return 1;
    }
    let status = 0;
    for (const typed of parsed.operands) {
      const abs = ctx.path(typed);
      try {
        const stat = ctx.fs.stat(abs);
        if (!stat) throw new FsError("ENOENT", abs);
        if (stat.type !== "dir") throw new FsError("ENOTDIR", abs);
        ctx.fs.remove(abs);
      } catch (error) {
        fsFail(ctx, typed, error);
        status = 1;
      }
    }
    return status;
  },
};

const rm: CommandSpec = {
  name: "rm",
  group: "files",
  summary: "remove files or directories",
  usage: "rm [-rf] path…",
  man: "-r  remove directories and everything in them\n-f  ignore missing operands and never complain about them\n\nThere is no trash: removed files stay removed until the page reloads.",
  run(ctx) {
    const parsed = parseArgs(ctx, { bool: "rf", alias: { R: "r" } });
    if (!parsed) return 2;
    const recursive = parsed.flags.has("r");
    const force = parsed.flags.has("f");
    if (parsed.operands.length === 0) {
      if (force) return 0;
      ctx.err("rm: missing operand\n");
      return 1;
    }
    let status = 0;
    for (const typed of parsed.operands) {
      const abs = ctx.path(typed);
      try {
        const stat = ctx.fs.stat(abs);
        if (!stat) {
          if (!force) {
            noEntry(ctx, typed);
            status = 1;
          }
          continue;
        }
        if (stat.type === "dir" && !recursive) {
          ctx.err(`rm: ${typed}: is a directory\n`);
          status = 1;
          continue;
        }
        ctx.fs.remove(abs, { recursive });
      } catch (error) {
        fsFail(ctx, typed, error);
        status = 1;
      }
    }
    return status;
  },
};

/**
 * Shared destination handling of cp and mv: with several sources the
 * destination must be a directory; a directory destination receives each
 * source under its own name. `act` gets absolute paths plus the names to
 * use when reporting an error.
 */
function transfer(
  ctx: CommandContext,
  operands: string[],
  act: (from: string, to: string) => void
): number {
  const cmd = ctx.name;
  if (operands.length < 2) {
    ctx.err(
      operands.length === 0
        ? `${cmd}: missing file operand\n`
        : `${cmd}: missing destination file operand after '${operands[0]}'\n`
    );
    return 1;
  }
  const sources = operands.slice(0, -1);
  const destTyped = operands[operands.length - 1]!;
  const destAbs = ctx.path(destTyped);
  let destIsDir = false;
  try {
    destIsDir = ctx.fs.stat(destAbs)?.type === "dir";
  } catch (error) {
    fsFail(ctx, destTyped, error);
    return 1;
  }
  if (sources.length > 1 && !destIsDir) {
    ctx.err(`${cmd}: target '${destTyped}' is not a directory\n`);
    return 1;
  }

  let status = 0;
  for (const typed of sources) {
    const from = ctx.path(typed);
    const name = baseName(from);
    const to = destIsDir ? joinPath(destAbs, name) : destAbs;
    const toTyped = destIsDir ? joinPath(destTyped.replace(/\/+$/, ""), name) : destTyped;
    try {
      act(from, to);
    } catch (error) {
      if (!(error instanceof FsError)) throw error;
      fsFail(ctx, error.path === from ? typed : toTyped, error);
      status = 1;
    }
  }
  return status;
}

const cp: CommandSpec = {
  name: "cp",
  group: "files",
  summary: "copy files and directories",
  usage: "cp [-r] source… dest",
  man: "Copies one file to dest, or several sources into the directory dest. Directories need -r. Copies belong to you, so anything readable can be copied into your own space.",
  run(ctx) {
    const parsed = parseArgs(ctx, { bool: "r", alias: { R: "r" } });
    if (!parsed) return 2;
    const recursive = parsed.flags.has("r");
    return transfer(ctx, parsed.operands, (from, to) => {
      if (!recursive && ctx.fs.stat(from)?.type === "dir") {
        throw new FsError("EISDIR", from);
      }
      ctx.fs.copy(from, to, { recursive });
    });
  },
};

const mv: CommandSpec = {
  name: "mv",
  group: "files",
  summary: "move or rename files",
  usage: "mv source… dest",
  man: "Renames source to dest, or moves several sources into the directory dest. An existing file at dest is replaced.",
  run(ctx) {
    const parsed = parseArgs(ctx, {});
    if (!parsed) return 2;
    return transfer(ctx, parsed.operands, (from, to) => ctx.fs.rename(from, to));
  },
};

/** `*`, `?` and `[set]` as in the shell; everything else is literal. */
function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") source += ".*";
    else if (ch === "?") source += ".";
    else if (ch === "[") {
      const end = glob.indexOf("]", i + 2);
      if (end === -1) {
        source += "\\[";
      } else {
        let set = glob.slice(i + 1, end);
        if (set.startsWith("!")) set = "^" + set.slice(1);
        source += `[${set.replace(/\\/g, "\\\\")}]`;
        i = end;
      }
    } else source += ch.replace(/[.+^${}()|\\/\]-]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "s");
}

const find: CommandSpec = {
  name: "find",
  group: "files",
  summary: "search for files in a directory tree",
  usage: "find [path…] [-name glob] [-type f|d]",
  man: "Walks each path and prints everything below it (the path itself included), written the way you typed the start path.\n\n-name glob  keep entries whose name matches the glob (* ? [set])\n-type f|d   keep only files or only directories",
  run(ctx) {
    const paths: string[] = [];
    let pattern: RegExp | null = null;
    let type: "f" | "d" | null = null;
    const { args } = ctx;
    let i = 0;
    while (i < args.length && !args[i]!.startsWith("-")) paths.push(args[i++]!);
    while (i < args.length) {
      const option = args[i++]!;
      if (option !== "-name" && option !== "-type") {
        ctx.err(`find: unknown predicate '${option}'\n`);
        return 2;
      }
      const value = args[i++];
      if (value === undefined) {
        ctx.err(`find: missing argument to '${option}'\n`);
        return 2;
      }
      if (option === "-name") {
        pattern = globToRegExp(value);
      } else if (value === "f" || value === "d") {
        type = value;
      } else {
        ctx.err(`find: unknown argument to -type: ${value}\n`);
        return 2;
      }
    }

    let status = 0;
    const matched: string[] = [];

    function walk(abs: string, shown: string, name: string): void {
      const stat = safeStat(ctx.fs, abs);
      if (!stat) return;
      const typeOk = type === null || (type === "d") === (stat.type === "dir");
      if (typeOk && (pattern === null || pattern.test(name))) matched.push(shown);
      if (stat.type !== "dir") return;
      let names: string[];
      try {
        names = ctx.fs.readdir(abs);
      } catch (error) {
        fsFail(ctx, shown, error);
        status = 1;
        return;
      }
      const base = shown.endsWith("/") ? shown : shown + "/";
      for (const child of names) walk(joinPath(abs, child), base + child, child);
    }

    for (const typed of paths.length ? paths : ["."]) {
      const abs = ctx.path(typed);
      try {
        if (!ctx.fs.stat(abs)) {
          noEntry(ctx, typed);
          status = 1;
          continue;
        }
      } catch (error) {
        fsFail(ctx, typed, error);
        status = 1;
        continue;
      }
      walk(abs, typed, baseName(abs) || "/");
    }
    ctx.out(joinLines(matched));
    return status;
  },
};

const stat: CommandSpec = {
  name: "stat",
  group: "files",
  summary: "show type, size, mode and owner of files",
  usage: "stat file…",
  run(ctx) {
    const parsed = parseArgs(ctx, {});
    if (!parsed) return 2;
    if (parsed.operands.length === 0) {
      ctx.err("stat: missing operand\n");
      return 1;
    }
    let status = 0;
    for (const typed of parsed.operands) {
      try {
        const info = ctx.fs.stat(ctx.path(typed));
        if (!info) {
          noEntry(ctx, typed);
          status = 1;
          continue;
        }
        const octal = info.mode.toString(8).padStart(4, "0");
        ctx.out(
          `  File: ${typed}\n` +
            `  Size: ${info.size}\tType: ${info.type === "dir" ? "directory" : "regular file"}\n` +
            `  Mode: (${octal}/${modeString(info)})\tOwner: ${info.owner}\n` +
            `Modify: ${isoLocal(info.mtime)}\n`
        );
      } catch (error) {
        fsFail(ctx, typed, error);
        status = 1;
      }
    }
    return status;
  },
};

export const FILES_COMMANDS: CommandSpec[] = [
  ls, cd, pwd, cat, tree, touch, mkdir, rmdir, rm, cp, mv, find, stat,
];

import type { CommandContext, CommandSpec } from "../types";
import { fsFail, joinLines, parseArgs, readInputs, splitLines } from "./util";

const echo: CommandSpec = {
  name: "echo",
  group: "text",
  summary: "print its arguments",
  usage: "echo [-n] [text…]",
  man: "Prints the arguments separated by single spaces, followed by a newline. -n leaves the newline off.",
  run(ctx) {
    let start = 0;
    while (ctx.args[start] === "-n") start++;
    const text = ctx.args.slice(start).join(" ");
    ctx.out(start > 0 ? text : text + "\n");
  },
};

/** Shared by head and tail: counts, `-5` shorthand, and the `==> name <==` headers. */
function lineWindow(
  name: "head" | "tail",
  select: (lines: string[], count: number, fromLine: boolean) => string[]
): (ctx: CommandContext) => number {
  return (ctx) => {
    const args = ctx.args.map((arg) => (/^-\d+$/.test(arg) ? `-n${arg.slice(1)}` : arg));
    const parsed = parseArgs(ctx, { value: "n" }, args);
    if (!parsed) return 2;
    const raw = parsed.values.get("n") ?? "10";
    const fromLine = name === "tail" && raw.startsWith("+");
    const digits = fromLine ? raw.slice(1) : raw;
    if (!/^\d+$/.test(digits)) {
      ctx.err(`${name}: invalid number of lines: '${raw}'\n`);
      return 2;
    }
    const { inputs, failed } = readInputs(ctx, parsed.operands);
    inputs.forEach(({ name: file, text }, index) => {
      if (inputs.length > 1) {
        ctx.out(`${index ? "\n" : ""}==> ${file === "-" ? "standard input" : file} <==\n`);
      }
      ctx.out(joinLines(select(splitLines(text), Number(digits), fromLine)));
    });
    return failed ? 1 : 0;
  };
}

const head: CommandSpec = {
  name: "head",
  group: "text",
  summary: "print the first lines",
  usage: "head [-n N] [file…]",
  man: "Prints the first 10 lines of each file, or of standard input. With several files each is introduced by a ==> name <== line.",
  run: lineWindow("head", (lines, count) => lines.slice(0, count)),
};

const tail: CommandSpec = {
  name: "tail",
  group: "text",
  summary: "print the last lines",
  usage: "tail [-n N] [file…]",
  man: "Prints the last 10 lines of each file, or of standard input. `-n +N` starts at line N instead.",
  run: lineWindow("tail", (lines, count, fromLine) =>
    fromLine ? lines.slice(Math.max(count - 1, 0)) : count === 0 ? [] : lines.slice(-count)
  ),
};

const wc: CommandSpec = {
  name: "wc",
  group: "text",
  summary: "count lines, words and bytes",
  usage: "wc [-lwc] [file…]",
  man: "Prints the line, word and byte counts of each file or of standard input; several files add a total line. With flags, only the selected counts.",
  run(ctx) {
    const parsed = parseArgs(ctx, { bool: "lwc" });
    if (!parsed) return 2;
    const { flags } = parsed;
    const all = !flags.has("l") && !flags.has("w") && !flags.has("c");
    const { inputs, failed } = readInputs(ctx, parsed.operands);
    const encoder = new TextEncoder();
    const rows = inputs.map(({ name, text }) => {
      const counts: number[] = [];
      if (all || flags.has("l")) counts.push(text.split("\n").length - 1);
      if (all || flags.has("w")) counts.push(text.split(/\s+/).filter(Boolean).length);
      if (all || flags.has("c")) counts.push(encoder.encode(text).length);
      return { name, counts };
    });
    if (rows.length > 1) {
      const sums = rows[0]!.counts.map((_, i) => rows.reduce((sum, row) => sum + row.counts[i]!, 0));
      rows.push({ name: "total", counts: sums });
    }
    const width = String(Math.max(0, ...rows.flatMap((row) => row.counts))).length;
    for (const { name, counts } of rows) {
      const numbers = counts.map((n) => String(n).padStart(width)).join(" ");
      ctx.out(name === "-" ? `${numbers}\n` : `${numbers} ${name}\n`);
    }
    return failed ? 1 : 0;
  },
};

const grep: CommandSpec = {
  name: "grep",
  group: "text",
  summary: "print lines that match a pattern",
  usage: "grep [-ivnc] pattern [file…]",
  man: "The pattern is a JavaScript regular expression. Exit status is 0 when a line matched, 1 when none did and 2 on errors.\n\n-i  ignore case\n-v  select lines that do not match\n-n  prefix each line with its line number\n-c  print only the number of matching lines\n\nWith several files each line is prefixed with the file name. Matches are red on the terminal.",
  run(ctx) {
    const parsed = parseArgs(ctx, { bool: "ivnc" });
    if (!parsed) return 2;
    const [pattern, ...files] = parsed.operands;
    if (pattern === undefined) {
      ctx.err("grep: missing pattern\n");
      return 2;
    }
    const { flags } = parsed;
    let matcher: RegExp;
    let highlighter: RegExp;
    try {
      const mode = flags.has("i") ? "i" : "";
      matcher = new RegExp(pattern, mode);
      highlighter = new RegExp(pattern, mode + "g");
    } catch {
      ctx.err("grep: invalid regular expression\n");
      return 2;
    }

    const { inputs, failed } = readInputs(ctx, files);
    const prefixed = files.length > 1;
    const invert = flags.has("v");
    let matches = 0;
    for (const { name, text } of inputs) {
      const label = name === "-" ? "(standard input)" : name;
      let count = 0;
      splitLines(text).forEach((line, index) => {
        if (matcher.test(line) === invert) return;
        count++;
        if (flags.has("c")) return;
        const shown = invert || !ctx.isTTY ? line : line.replace(highlighter, (m) => ctx.c.red(m));
        const where = flags.has("n") ? `${ctx.c.green(String(index + 1))}:` : "";
        const file = prefixed ? `${ctx.c.magenta(label)}:` : "";
        ctx.out(`${file}${where}${shown}\n`);
      });
      matches += count;
      if (flags.has("c")) ctx.out(`${prefixed ? `${ctx.c.magenta(label)}:` : ""}${count}\n`);
    }
    if (failed) return 2;
    return matches > 0 ? 0 : 1;
  },
};

const sort: CommandSpec = {
  name: "sort",
  group: "text",
  summary: "sort lines",
  usage: "sort [-rnu] [file…]",
  man: "-r  reverse the order\n-n  compare by leading number\n-u  drop lines that compare equal to the previous one",
  run(ctx) {
    const parsed = parseArgs(ctx, { bool: "rnu" });
    if (!parsed) return 2;
    const { flags } = parsed;
    const { inputs, failed } = readInputs(ctx, parsed.operands);
    const lines = inputs.flatMap(({ text }) => splitLines(text));
    const numeric = flags.has("n");
    const number = (line: string) => Number.parseFloat(line.trimStart()) || 0;
    const byKey = (a: string, b: string) =>
      numeric ? number(a) - number(b) : a < b ? -1 : a > b ? 1 : 0;
    const full = (a: string, b: string) => byKey(a, b) || (a < b ? -1 : a > b ? 1 : 0);
    lines.sort(flags.has("r") ? (a, b) => full(b, a) : full);
    const out = flags.has("u") ? lines.filter((line, i) => i === 0 || byKey(lines[i - 1]!, line) !== 0) : lines;
    ctx.out(joinLines(out));
    return failed ? 1 : 0;
  },
};

const uniq: CommandSpec = {
  name: "uniq",
  group: "text",
  summary: "collapse adjacent duplicate lines",
  usage: "uniq [-c] [file…]",
  man: "Only adjacent duplicates are merged, so sort first. -c prefixes each line with how many times it occurred.",
  run(ctx) {
    const parsed = parseArgs(ctx, { bool: "c" });
    if (!parsed) return 2;
    const { inputs, failed } = readInputs(ctx, parsed.operands);
    const groups: { line: string; count: number }[] = [];
    for (const line of inputs.flatMap(({ text }) => splitLines(text))) {
      const last = groups[groups.length - 1];
      if (last && last.line === line) last.count++;
      else groups.push({ line, count: 1 });
    }
    ctx.out(
      joinLines(
        groups.map(({ line, count }) =>
          parsed.flags.has("c") ? `${String(count).padStart(7)} ${line}` : line
        )
      )
    );
    return failed ? 1 : 0;
  },
};

/** `1,3`, `2-4`, `3-`, `-2` as inclusive 1-based ranges; null when malformed. */
function parseFieldList(list: string): [number, number][] | null {
  const ranges: [number, number][] = [];
  for (const part of list.split(",")) {
    const match = /^(\d*)(-?)(\d*)$/.exec(part);
    if (!match || (match[1] === "" && match[3] === "")) return null;
    const start = match[1] === "" ? 1 : Number(match[1]);
    const end = match[2] === "" ? start : match[3] === "" ? Infinity : Number(match[3]);
    if (start < 1 || end < start) return null;
    ranges.push([start, end]);
  }
  return ranges;
}

const cut: CommandSpec = {
  name: "cut",
  group: "text",
  summary: "select fields from each line",
  usage: "cut -d delim -f list [file…]",
  man: "Splits every line at the single-character delimiter (tab by default) and prints the chosen fields. The list is numbers and ranges: 1,3 or 2-4 or 3-. Lines without the delimiter are printed whole.",
  run(ctx) {
    const parsed = parseArgs(ctx, { value: "df" });
    if (!parsed) return 2;
    const list = parsed.values.get("f");
    if (list === undefined) {
      ctx.err("cut: you must specify a list of fields\n");
      return 2;
    }
    const delimiter = parsed.values.get("d") ?? "\t";
    if (delimiter.length !== 1) {
      ctx.err("cut: the delimiter must be a single character\n");
      return 2;
    }
    const ranges = parseFieldList(list);
    if (!ranges) {
      ctx.err(`cut: invalid field list: '${list}'\n`);
      return 2;
    }
    const { inputs, failed } = readInputs(ctx, parsed.operands);
    const out: string[] = [];
    for (const line of inputs.flatMap(({ text }) => splitLines(text))) {
      if (!line.includes(delimiter)) {
        out.push(line);
        continue;
      }
      const fields = line.split(delimiter);
      out.push(
        fields
          .filter((_, i) => ranges.some(([from, to]) => i + 1 >= from && i + 1 <= to))
          .join(delimiter)
      );
    }
    ctx.out(joinLines(out));
    return failed ? 1 : 0;
  },
};

const rev: CommandSpec = {
  name: "rev",
  group: "text",
  summary: "reverse each line",
  usage: "rev [file…]",
  run(ctx) {
    const parsed = parseArgs(ctx, {});
    if (!parsed) return 2;
    const { inputs, failed } = readInputs(ctx, parsed.operands);
    ctx.out(
      joinLines(
        inputs.flatMap(({ text }) => splitLines(text)).map((line) => Array.from(line).reverse().join(""))
      )
    );
    return failed ? 1 : 0;
  },
};

const MAX_SEQ = 1_000_000;

const seq: CommandSpec = {
  name: "seq",
  group: "text",
  summary: "print a sequence of integers",
  usage: "seq [first] last",
  man: "Prints the integers from first (default 1) to last, one per line. Nothing is printed when first is greater than last.",
  run(ctx) {
    if (ctx.args.length === 0) {
      ctx.err("seq: missing operand\n");
      return 2;
    }
    if (ctx.args.length > 2) {
      ctx.err(`seq: extra operand '${ctx.args[2]}'\n`);
      return 2;
    }
    const numbers = ctx.args.map(Number);
    const bad = numbers.findIndex((n) => !Number.isInteger(n));
    if (bad !== -1) {
      ctx.err(`seq: invalid integer argument: '${ctx.args[bad]}'\n`);
      return 2;
    }
    const last = numbers[numbers.length - 1]!;
    const first = numbers.length === 2 ? numbers[0]! : 1;
    if (last - first >= MAX_SEQ) {
      ctx.err("seq: range too large\n");
      return 1;
    }
    const out: string[] = [];
    for (let n = first; n <= last; n++) out.push(String(n));
    ctx.out(joinLines(out));
  },
};

const tee: CommandSpec = {
  name: "tee",
  group: "text",
  summary: "copy standard input to files and to the output",
  usage: "tee [-a] file…",
  man: "Writes standard input to each file and also passes it through. -a appends instead of replacing.",
  run(ctx) {
    const parsed = parseArgs(ctx, { bool: "a" });
    if (!parsed) return 2;
    const text = ctx.hasStdin ? ctx.stdin : "";
    ctx.out(text);
    let status = 0;
    for (const typed of parsed.operands) {
      try {
        ctx.fs.writeFile(ctx.path(typed), text, { append: parsed.flags.has("a") });
      } catch (error) {
        fsFail(ctx, typed, error);
        status = 1;
      }
    }
    return status;
  },
};

const xargs: CommandSpec = {
  name: "xargs",
  group: "text",
  summary: "run a command with standard input as arguments",
  usage: "xargs [command [args…]]",
  man: "Splits standard input at whitespace and runs the command once with those words appended to its arguments. The default command is echo. There is no quote handling: items are plain words.",
  run(ctx) {
    const command = ctx.args.length ? ctx.args : ["echo"];
    const items = ctx.stdin.split(/\s+/).filter(Boolean);
    return ctx.exec([...command, ...items]);
  },
};

export const TEXT_COMMANDS: CommandSpec[] = [
  echo, head, tail, wc, grep, sort, uniq, cut, rev, seq, tee, xargs,
];

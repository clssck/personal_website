import type { CommandSpec } from "../types";
import { getEntry, parseArgs, setEntry } from "./util";
import { singleQuote } from "../fs-image";

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_SLEEP_SECONDS = 60;

const byName = ([a]: [string, string], [b]: [string, string]) => (a < b ? -1 : a > b ? 1 : 0);

const exportCmd: CommandSpec = {
  name: "export",
  group: "shell",
  summary: "set environment variables",
  usage: "export [NAME=value…]",
  man: "Sets each NAME=value for this and later commands. With no arguments lists every variable, sorted. Changes last until the page reloads.",
  run(ctx) {
    if (ctx.args.length === 0) {
      ctx.out(
        Object.entries(ctx.shell.env)
          .sort(byName)
          .map(([name, value]) => `${name}=${value}\n`)
          .join("")
      );
      return;
    }
    let status = 0;
    for (const arg of ctx.args) {
      const eq = arg.indexOf("=");
      const name = eq === -1 ? arg : arg.slice(0, eq);
      if (!IDENTIFIER.test(name)) {
        ctx.err(`export: not an identifier: ${name}\n`);
        status = 1;
        continue;
      }
      if (eq !== -1) setEntry(ctx.shell.env, name, arg.slice(eq + 1));
      else if (getEntry(ctx.shell.env, name) === undefined) setEntry(ctx.shell.env, name, "");
    }
    return status;
  },
};

const unset: CommandSpec = {
  name: "unset",
  group: "shell",
  summary: "remove environment variables",
  usage: "unset NAME…",
  run(ctx) {
    for (const name of ctx.args) delete ctx.shell.env[name];
  },
};

const env: CommandSpec = {
  name: "env",
  group: "shell",
  summary: "print the environment",
  usage: "env",
  run(ctx) {
    const parsed = parseArgs(ctx, {});
    if (!parsed) return 2;
    if (parsed.operands.length > 0) {
      ctx.err(`env: ${parsed.operands[0]}: running commands is not supported\n`);
      return 127;
    }
    ctx.out(
      Object.entries(ctx.shell.env)
        .map(([name, value]) => `${name}=${value}\n`)
        .join("")
    );
  },
};

const alias: CommandSpec = {
  name: "alias",
  group: "shell",
  summary: "define or list aliases",
  usage: "alias [name=value…]",
  man: "With name=value defines an alias for this session; with a bare name prints that alias; with no arguments lists them all. Aliases are expanded in command position only.",
  run(ctx) {
    const { aliases } = ctx.shell;
    if (ctx.args.length === 0) {
      ctx.out(
        Object.entries(aliases)
          .sort(byName)
          .map(([name, value]) => `${name}=${singleQuote(value)}\n`)
          .join("")
      );
      return;
    }
    let status = 0;
    for (const arg of ctx.args) {
      const eq = arg.indexOf("=");
      if (eq === 0) {
        ctx.err(`alias: invalid name: ${arg}\n`);
        status = 1;
      } else if (eq > 0) {
        setEntry(aliases, arg.slice(0, eq), arg.slice(eq + 1));
      } else {
        const value = getEntry(aliases, arg);
        if (value === undefined) {
          ctx.err(`alias: ${arg}: not found\n`);
          status = 1;
        } else {
          ctx.out(`${arg}=${singleQuote(value)}\n`);
        }
      }
    }
    return status;
  },
};

const unalias: CommandSpec = {
  name: "unalias",
  group: "shell",
  summary: "remove aliases",
  usage: "unalias [-a] name…",
  man: "-a  remove every alias",
  run(ctx) {
    const parsed = parseArgs(ctx, { bool: "a" });
    if (!parsed) return 2;
    if (parsed.flags.has("a")) {
      for (const name of Object.keys(ctx.shell.aliases)) delete ctx.shell.aliases[name];
      return;
    }
    let status = 0;
    for (const name of parsed.operands) {
      if (getEntry(ctx.shell.aliases, name) === undefined) {
        ctx.err(`unalias: no such alias: ${name}\n`);
        status = 1;
      } else {
        delete ctx.shell.aliases[name];
      }
    }
    return status;
  },
};

const history: CommandSpec = {
  name: "history",
  group: "shell",
  summary: "list the commands typed so far",
  usage: "history",
  run(ctx) {
    ctx.out(ctx.shell.history.map((line, i) => `${String(i + 1).padStart(5)}  ${line}\n`).join(""));
  },
};

const which: CommandSpec = {
  name: "which",
  group: "shell",
  summary: "show what a name runs",
  usage: "which name…",
  run(ctx) {
    let status = ctx.args.length === 0 ? 1 : 0;
    for (const name of ctx.args) {
      const aliased = getEntry(ctx.shell.aliases, name);
      const spec = ctx.shell.spec(name);
      if (aliased !== undefined) ctx.out(`${name}: aliased to ${aliased}\n`);
      else if (spec && !spec.hidden) ctx.out(`/bin/${name}\n`);
      else {
        ctx.err(`${name} not found\n`);
        status = 1;
      }
    }
    return status;
  },
};

const man: CommandSpec = {
  name: "man",
  group: "shell",
  summary: "show the manual page of a command",
  usage: "man command",
  run(ctx) {
    const name = ctx.args[0];
    if (name === undefined) {
      ctx.err("What manual page do you want?\n");
      return 1;
    }
    const spec = ctx.shell.spec(name);
    if (!spec || spec.hidden) {
      ctx.err(`No manual entry for ${name}\n`);
      return 1;
    }
    const indent = (text: string) =>
      text
        .split("\n")
        .map((line) => (line ? `    ${line}` : line))
        .join("\n");
    const { bold } = ctx.c;
    let page = `${bold("NAME")}\n    ${spec.name} - ${spec.summary}\n\n${bold("SYNOPSIS")}\n    ${spec.usage}\n`;
    if (spec.man) page += `\n${bold("DESCRIPTION")}\n${indent(spec.man)}\n`;
    ctx.out(page);
  },
};

const clear: CommandSpec = {
  name: "clear",
  group: "shell",
  summary: "clear the screen",
  usage: "clear",
  run(ctx) {
    ctx.host.clear();
  },
};

const trueCmd: CommandSpec = {
  name: "true",
  group: "shell",
  summary: "do nothing, successfully",
  usage: "true",
  run: () => 0,
};

const falseCmd: CommandSpec = {
  name: "false",
  group: "shell",
  summary: "do nothing, unsuccessfully",
  usage: "false",
  run: () => 1,
};

const sleep: CommandSpec = {
  name: "sleep",
  group: "shell",
  summary: "wait for a number of seconds",
  usage: "sleep seconds",
  man: "Waits up to 60 seconds; longer requests are clamped. Ctrl+C ends it early.",
  run(ctx) {
    const arg = ctx.args[0];
    if (arg === undefined) {
      ctx.err("sleep: missing operand\n");
      return 1;
    }
    const seconds = Number(arg);
    if (!Number.isFinite(seconds) || seconds < 0) {
      ctx.err(`sleep: invalid time interval '${arg}'\n`);
      return 1;
    }
    if (ctx.signal.aborted) return 130;
    const ms = Math.min(seconds, MAX_SLEEP_SECONDS) * 1000;
    return new Promise<number>((resolve) => {
      const interrupted = () => {
        clearTimeout(timer);
        resolve(130);
      };
      const timer = setTimeout(() => {
        ctx.signal.removeEventListener("abort", interrupted);
        resolve(0);
      }, ms);
      ctx.signal.addEventListener("abort", interrupted, { once: true });
    });
  },
};

const exit: CommandSpec = {
  name: "exit",
  group: "shell",
  summary: "close this terminal window",
  usage: "exit",
  run(ctx) {
    ctx.host.exit();
  },
};

export const SHELL_COMMANDS: CommandSpec[] = [
  exportCmd, unset, env, alias, unalias, history, which, man, clear, trueCmd, falseCmd, sleep, exit,
];

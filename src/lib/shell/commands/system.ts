import type { CommandSpec } from "../types";
import { dateLine, humanDuration, parseArgs, two, uptimeSeconds } from "./util";

const whoami: CommandSpec = {
  name: "whoami",
  group: "system",
  summary: "print the current user",
  usage: "whoami",
  run(ctx) {
    ctx.out("visitor\n");
  },
};

const id: CommandSpec = {
  name: "id",
  group: "system",
  summary: "print user and group ids",
  usage: "id",
  run(ctx) {
    ctx.out("uid=1001(visitor) gid=1001(visitor) groups=1001(visitor)\n");
  },
};

const hostname: CommandSpec = {
  name: "hostname",
  group: "system",
  summary: "print the machine name",
  usage: "hostname",
  run(ctx) {
    ctx.out("janos\n");
  },
};

const uname: CommandSpec = {
  name: "uname",
  group: "system",
  summary: "print system information",
  usage: "uname [-a]",
  man: "Prints the system name; -a adds host name, release and build.",
  run(ctx) {
    const parsed = parseArgs(ctx, { bool: "a" });
    if (!parsed) return 2;
    ctx.out(parsed.flags.has("a") ? "JanOS janos 1.0 #1 SMP static browser\n" : "JanOS\n");
  },
};

const date: CommandSpec = {
  name: "date",
  group: "system",
  summary: "print the current date and time",
  usage: "date",
  run(ctx) {
    ctx.out(dateLine(ctx.host.now()) + "\n");
  },
};

const uptime: CommandSpec = {
  name: "uptime",
  group: "system",
  summary: "show how long the shell has been running",
  usage: "uptime",
  man: "Time since this page was opened. Reloading starts the clock again.",
  run(ctx) {
    const now = ctx.host.now();
    const clock = `${two(now.getHours())}:${two(now.getMinutes())}:${two(now.getSeconds())}`;
    ctx.out(` ${clock} up ${humanDuration(uptimeSeconds(ctx))}, 1 user, load average: 0.00, 0.00, 0.00\n`);
  },
};

const ps: CommandSpec = {
  name: "ps",
  group: "system",
  summary: "list processes",
  usage: "ps",
  run(ctx) {
    ctx.out(
      "  PID TTY          TIME CMD\n" +
        "    1 pts/0    00:00:00 zsh\n" +
        "   42 pts/0    00:00:00 cat\n" +
        "   43 pts/0    00:00:00 yarn\n" +
        "   44 pts/0    00:00:00 ps\n"
    );
  },
};

export const SYSTEM_COMMANDS: CommandSpec[] = [whoami, id, hostname, uname, date, uptime, ps];

import type { CommandSpec } from "../types";

/** A hidden command that prints one line to stderr and fails. */
function refusal(name: string, usage: string, summary: string, message: string): CommandSpec {
  return {
    name,
    summary,
    usage,
    hidden: true,
    run(ctx) {
      ctx.err(message + "\n");
      return 1;
    },
  };
}

const EDITOR_HINT = "there are no editors here. try: echo text > file";
const NETWORK_HINT = "no network tools here. repos is the only thing that phones out.";

const sudo: CommandSpec = {
  name: "sudo",
  summary: "run a command as another user",
  usage: "sudo command [args…]",
  hidden: true,
  run(ctx) {
    if (ctx.args.length === 0) {
      ctx.err("usage: sudo command [args…]\n");
      return 1;
    }
    ctx.err("visitor is not in the sudoers file. this incident will be reported to the cat.\n");
    return 1;
  },
};

const secrets: CommandSpec = {
  name: "secrets",
  summary: "reveal the secrets",
  usage: "secrets",
  hidden: true,
  run(ctx) {
    ctx.err("secrets: permission denied. the directory is called secrets for a reason.\n");
    return 1;
  },
};

export const EGG_COMMANDS: CommandSpec[] = [
  sudo,
  refusal("vim", "vim [file]", "edit text", `vim: ${EDITOR_HINT}`),
  refusal("vi", "vi [file]", "edit text", `vi: ${EDITOR_HINT}`),
  refusal("nano", "nano [file]", "edit text", `nano: ${EDITOR_HINT}`),
  refusal("emacs", "emacs [file]", "edit text", `emacs: ${EDITOR_HINT}`),
  refusal("ssh", "ssh host", "log in to another machine", `ssh: ${NETWORK_HINT}`),
  refusal("curl", "curl url", "fetch a url", `curl: ${NETWORK_HINT}`),
  refusal("wget", "wget url", "fetch a url", `wget: ${NETWORK_HINT}`),
  refusal("make", "make [target]", "build things", "make: no makefile. the site is already built, and the cat is not impressed."),
  refusal("kill", "kill pid", "send a signal", "kill: the cat ignores signals."),
  refusal("pkill", "pkill name", "send a signal", "pkill: the cat ignores signals."),
  secrets,
];

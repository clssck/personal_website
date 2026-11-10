import type { CommandSpec } from "../types";
import { EGG_COMMANDS } from "./eggs";
import { FILES_COMMANDS } from "./files";
import { SHELL_COMMANDS } from "./shellcmds";
import { SITE_COMMANDS } from "./site";
import { SYSTEM_COMMANDS } from "./system";
import { TEXT_COMMANDS } from "./text";

/** Every command, hidden easter eggs included. */
export const COMMANDS: CommandSpec[] = [
  ...SITE_COMMANDS,
  ...FILES_COMMANDS,
  ...TEXT_COMMANDS,
  ...SHELL_COMMANDS,
  ...SYSTEM_COMMANDS,
  ...EGG_COMMANDS,
];

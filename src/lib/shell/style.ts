/**
 * ANSI styling for command output. The escape codes written here are the
 * exact subset src/lib/ansi.ts renders: SGR 1/2/4 with their specific
 * resets, the eight standard foreground colours, and OSC 8 hyperlinks.
 */
import type { Style } from "./types";

export const ESC = "\x1b";
const sgr = (on: number, off: number) => (text: string) =>
  text ? `${ESC}[${on}m${text}${ESC}[${off}m` : text;

export const ansiStyle: Style = {
  bold: sgr(1, 22),
  dim: sgr(2, 22),
  underline: sgr(4, 24),
  red: sgr(31, 39),
  green: sgr(32, 39),
  yellow: sgr(33, 39),
  blue: sgr(34, 39),
  magenta: sgr(35, 39),
  cyan: sgr(36, 39),
  link: (url, text = url) => `${ESC}]8;;${url}${ESC}\\${text}${ESC}]8;;${ESC}\\`,
};

const same = (text: string) => text;

/** For pipes and files: no escape codes ever reach `grep` or a redirect. */
export const plainStyle: Style = {
  bold: same,
  dim: same,
  underline: same,
  red: same,
  green: same,
  yellow: same,
  blue: same,
  magenta: same,
  cyan: same,
  link: (url, text = url) => text,
};

// Built from ESC so no raw control character sits in a regex literal.
const ANSI_SEQUENCE = new RegExp(
  `${ESC}\\[[0-9;]*m|${ESC}\\]8;;[^${ESC}]*${ESC}\\\\`,
  "g"
);

/** Remove every sequence `ansiStyle` can emit; used to measure visible width. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_SEQUENCE, "");
}

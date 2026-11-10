/**
 * Pure helpers for the terminal UI — Tab interception and escaping.
 * Terminal.astro wires these to the DOM; everything here is testable
 * without a browser.
 */
import type { Completion } from "./shell/types";

export interface KeyModifiers {
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}

/**
 * Tab is only worth intercepting when it actually completes or lists
 * matches, so keyboard users can still Tab out of the prompt. Shift+Tab
 * always escapes (native focus order), as do modified keys, IME
 * composition, and input with nothing left to complete.
 */
export function shouldInterceptTab(
  e: KeyModifiers,
  completion: Completion | null
): boolean {
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.isComposing) return false;
  if (!completion || completion.matches.length === 0) return false;
  const [only] = completion.matches;
  return !(
    completion.matches.length === 1 &&
    only!.toLowerCase() === completion.token.toLowerCase()
  );
}

/** Escape untrusted/echoed text before it reaches innerHTML. */
const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

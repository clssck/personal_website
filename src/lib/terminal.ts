/**
 * Pure terminal helpers — completion, Tab interception, guarded lookups,
 * history and escaping. The Terminal.astro script wires these to the DOM;
 * everything here is testable without a browser.
 */

export interface Completion {
  prefix: string;
  token: string;
  candidate: string;
  matches: string[];
}

/**
 * fish-style completion: bare input completes command names, `cat …`
 * completes file names. Case-insensitive; `candidate` is the first match
 * that actually extends the token ("" when the token is already exact).
 */
export function completionFor(
  value: string,
  commandNames: string[],
  fileNames: string[]
): Completion | null {
  let prefix = "";
  let token = value;
  let candidates: string[] | null = null;

  if (!value.includes(" ")) {
    candidates = commandNames;
  } else {
    const m = value.match(/^(cat)\s+(\S*)$/);
    if (m) {
      token = m[2];
      prefix = value.slice(0, value.length - token.length);
      candidates = fileNames;
    }
  }

  if (!candidates || !token) return null;

  const lower = token.toLowerCase();
  const matches = candidates.filter((c) => c.toLowerCase().startsWith(lower));
  const candidate = matches.find((c) => c.toLowerCase() !== lower) || "";
  return { prefix, token, candidate, matches };
}

export interface KeyModifiers {
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
}

/**
 * Tab is only worth intercepting when it actually completes or lists
 * matches. Shift+Tab always escapes (native focus order), as do modified
 * keys, IME composition, empty/unmatched/exact input.
 */
export function shouldInterceptTab(
  e: KeyModifiers,
  value: string,
  commandNames: string[],
  fileNames: string[]
): boolean {
  if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.isComposing) return false;
  const c = completionFor(value, commandNames, fileNames);
  if (!c || c.matches.length === 0) return false;
  if (
    c.matches.length === 1 &&
    c.matches[0].toLowerCase() === c.token.toLowerCase()
  )
    return false;
  return true;
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


/**
 * Own-property lookup for command/file registries, so reserved or
 * prototype names ("constructor", "__proto__", "toString") never resolve
 * to inherited members — they hit the ordinary "not found" path.
 */
export function own<T>(
  record: Record<string, T>,
  key: string
): T | undefined {
  return Object.prototype.hasOwnProperty.call(record, key)
    ? record[key]
    : undefined;
}

export interface History {
  push(value: string): void;
  at(index: number): string;
  step(index: number, dir: -1 | 1): number;
  readonly length: number;
}

/**
 * Command history: plain append, arrow navigation clamps
 * (past-the-end = fresh draft). No truncation — original semantics.
 */
export function createHistory(): History {
  const items: string[] = [];
  return {
    push(value: string) {
      items.push(value);
    },
    at(index: number) {
      return items[index] ?? "";
    },
    step(index: number, dir: -1 | 1) {
      return Math.min(items.length, Math.max(0, index + dir));
    },
    get length() {
      return items.length;
    },
  };
}

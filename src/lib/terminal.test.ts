import { describe, expect, test } from "bun:test";
import type { Completion } from "./shell/types";
import { escapeHtml, shouldInterceptTab } from "./terminal";

function completion(token: string, matches: string[]): Completion {
  const candidate =
    matches.find((m) => m.toLowerCase() !== token.toLowerCase()) ?? "";
  return { prefix: "", token, matches, candidate };
}

describe("shouldInterceptTab", () => {
  test("intercepts only when it completes or lists", () => {
    expect(shouldInterceptTab({}, completion("he", ["help"]))).toBe(true);
    expect(shouldInterceptTab({}, completion("h", ["help", "history"]))).toBe(true);
    expect(shouldInterceptTab({}, completion("", ["a.txt", "b.txt"]))).toBe(true);
    // nothing left to complete: Tab moves focus natively
    expect(shouldInterceptTab({}, completion("help", ["help"]))).toBe(false);
    expect(shouldInterceptTab({}, completion("HELP", ["help"]))).toBe(false);
    expect(shouldInterceptTab({}, completion("z", []))).toBe(false);
    expect(shouldInterceptTab({}, null)).toBe(false);
  });

  test("modifiers and IME composition always escape", () => {
    const c = completion("he", ["help"]);
    expect(shouldInterceptTab({ shiftKey: true }, c)).toBe(false);
    expect(shouldInterceptTab({ ctrlKey: true }, c)).toBe(false);
    expect(shouldInterceptTab({ metaKey: true }, c)).toBe(false);
    expect(shouldInterceptTab({ altKey: true }, c)).toBe(false);
    expect(shouldInterceptTab({ isComposing: true }, c)).toBe(false);
  });
});

describe("escapeHtml", () => {
  test("escapes every HTML-significant character", () => {
    expect(escapeHtml(`<a href="x">&'/\``)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;/`"
    );
  });
});

import { describe, expect, test } from "bun:test";
import {
  completionFor,
  createHistory,
  escapeHtml,
  own,
  shouldInterceptTab,
} from "./terminal";

const CMDS = ["help", "history", "github", "about", "projects", "repos"];
const FILES = ["about.txt", "skills.txt", "projects.url", "github.url"];

describe("completionFor", () => {
  test("prefix completes to the first extending command", () => {
    const c = completionFor("h", CMDS, FILES);
    expect(c?.matches).toEqual(["help", "history"]);
    expect(c?.candidate).toBe("help");
    expect(c?.prefix).toBe("");
  });

  test("single match extends the token", () => {
    const c = completionFor("he", CMDS, FILES);
    expect(c?.matches).toEqual(["help"]);
    expect(c?.candidate).toBe("help");
  });

  test("matching is case-insensitive but preserves the real name", () => {
    const c = completionFor("HE", CMDS, FILES);
    expect(c?.matches).toEqual(["help"]);
    expect(c?.candidate).toBe("help");
  });

  test("exact command has matches but no candidate", () => {
    const c = completionFor("help", CMDS, FILES);
    expect(c?.matches).toEqual(["help"]);
    expect(c?.candidate).toBe("");
  });

  test("cat completes file names with the typed prefix", () => {
    const c = completionFor("cat ab", CMDS, FILES);
    expect(c?.prefix).toBe("cat ");
    expect(c?.token).toBe("ab");
    expect(c?.matches).toEqual(["about.txt"]);
    expect(c?.candidate).toBe("about.txt");
  });

  test("empty and non-cat input complete nothing", () => {
    expect(completionFor("", CMDS, FILES)).toBeNull();
    expect(completionFor("cat ", CMDS, FILES)).toBeNull();
    expect(completionFor("echo hi", CMDS, FILES)).toBeNull();
  });

  test("unmatched input yields an empty match list", () => {
    const c = completionFor("z", CMDS, FILES);
    expect(c?.matches).toEqual([]);
    expect(c?.candidate).toBe("");
  });
});

describe("shouldInterceptTab", () => {
  test("intercepts only when it completes or lists", () => {
    expect(shouldInterceptTab({}, "he", CMDS, FILES)).toBe(true);
    expect(shouldInterceptTab({}, "h", CMDS, FILES)).toBe(true);
    expect(shouldInterceptTab({}, "cat sk", CMDS, FILES)).toBe(true);
    expect(shouldInterceptTab({}, "help", CMDS, FILES)).toBe(false);
    expect(shouldInterceptTab({}, "cat about.txt", CMDS, FILES)).toBe(false);
    expect(shouldInterceptTab({}, "z", CMDS, FILES)).toBe(false);
    expect(shouldInterceptTab({}, "", CMDS, FILES)).toBe(false);
  });

  test("modifiers and IME composition always escape", () => {
    expect(shouldInterceptTab({ shiftKey: true }, "he", CMDS, FILES)).toBe(
      false
    );
    expect(shouldInterceptTab({ ctrlKey: true }, "he", CMDS, FILES)).toBe(
      false
    );
    expect(shouldInterceptTab({ metaKey: true }, "he", CMDS, FILES)).toBe(
      false
    );
    expect(shouldInterceptTab({ altKey: true }, "he", CMDS, FILES)).toBe(false);
    expect(shouldInterceptTab({ isComposing: true }, "he", CMDS, FILES)).toBe(
      false
    );
  });
});

describe("own", () => {
  test("resolves own keys, never inherited ones", () => {
    const registry: Record<string, string> = { help: "fn" };
    expect(own(registry, "help")).toBe("fn");
    expect(own(registry, "nope")).toBeUndefined();
    for (const key of [
      "constructor",
      "__proto__",
      "prototype",
      "toString",
      "valueOf",
      "hasOwnProperty",
    ]) {
      expect(own(registry, key), key).toBeUndefined();
    }
  });
});

describe("escapeHtml", () => {
  test("escapes every HTML-significant character", () => {
    expect(escapeHtml(`<a href="x">&'/\``)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;/`"
    );
  });
});

describe("createHistory", () => {
  test("appends, reads, and clamps navigation", () => {
    const h = createHistory();
    h.push("help");
    h.push("about");
    expect(h.length).toBe(2);
    expect(h.at(0)).toBe("help");
    expect(h.at(1)).toBe("about");
    expect(h.at(99)).toBe("");
    expect(h.step(1, -1)).toBe(0);
    expect(h.step(0, -1)).toBe(0);
    expect(h.step(1, 1)).toBe(2); // past-the-end draft
    expect(h.step(2, 1)).toBe(2);
  });

  test("history is never truncated", () => {
    const h = createHistory();
    for (let i = 0; i < 300; i++) h.push(`cmd${i}`);
    expect(h.length).toBe(300);
    expect(h.at(0)).toBe("cmd0");
  });
});

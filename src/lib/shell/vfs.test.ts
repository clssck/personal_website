import { describe, expect, test } from "bun:test";
import { FsError, type FsErrorCode, type Vfs } from "./types";
import { createVfs, dir, file, resolvePath } from "./vfs";

function makeFs(): Vfs {
  let ticks = 0;
  return createVfs(
    dir({
      etc: dir({ motd: file("hello\n") }),
      dev: dir({ null: file("", { sink: true, mode: 0o666 }) }),
      proc: dir({ counter: file(() => `${++ticks}\n`) }),
      tmp: dir({}, { mode: 0o777 }),
      home: dir({
        owner: dir({ "diary.txt": file("private\n") }, { mode: 0o700, owner: "owner" }),
        guest: dir(
          {
            "notes.txt": file("one\n"),
            docs: dir({ "a.md": file("a"), ".hidden": file("h") }),
          },
          { owner: "guest" }
        ),
      }),
    }),
    { user: "guest", now: () => 1_000 }
  );
}

function codeOf(fn: () => unknown): FsErrorCode | "no error" {
  try {
    fn();
  } catch (err) {
    if (err instanceof FsError) return err.code;
    throw err;
  }
  return "no error";
}

describe("resolvePath", () => {
  test("relative, home and dot segments normalise to absolute paths", () => {
    const at = (input: string) => resolvePath(input, "/home/guest/docs", "/home/guest");
    expect(at("a.md")).toBe("/home/guest/docs/a.md");
    expect(at("../notes.txt")).toBe("/home/guest/notes.txt");
    expect(at("~")).toBe("/home/guest");
    expect(at("~/docs/./x//y/")).toBe("/home/guest/docs/x/y");
    expect(at("/etc/../etc/motd")).toBe("/etc/motd");
    expect(at("../../../../..")).toBe("/");
    expect(at("")).toBe("/home/guest/docs");
    expect(at("~user")).toBe("/home/guest/docs/~user");
  });
});

describe("reading", () => {
  test("files, directories and missing paths", () => {
    const fs = makeFs();
    expect(fs.readFile("/etc/motd")).toBe("hello\n");
    expect(fs.readdir("/home/guest/docs")).toEqual([".hidden", "a.md"]);
    expect(fs.stat("/nope")).toBeNull();
    expect(fs.stat("/etc/motd")).toEqual({
      type: "file",
      mode: 0o644,
      owner: "root",
      size: 6,
      mtime: 1_000,
    });
    expect(codeOf(() => fs.readFile("/nope"))).toBe("ENOENT");
    expect(codeOf(() => fs.readFile("/etc"))).toBe("EISDIR");
    expect(codeOf(() => fs.readdir("/etc/motd"))).toBe("ENOTDIR");
    expect(codeOf(() => fs.stat("/etc/motd/x"))).toBe("ENOTDIR");
  });

  test("function content is evaluated on every read", () => {
    const fs = makeFs();
    expect(fs.readFile("/proc/counter")).toBe("1\n");
    expect(fs.readFile("/proc/counter")).toBe("2\n");
  });
});

describe("permissions", () => {
  test("another user's private directory cannot be listed or entered", () => {
    const fs = makeFs();
    expect(fs.stat("/home/owner")?.type).toBe("dir");
    expect(codeOf(() => fs.readdir("/home/owner"))).toBe("EACCES");
    expect(codeOf(() => fs.stat("/home/owner/diary.txt"))).toBe("EACCES");
    expect(codeOf(() => fs.readFile("/home/owner/diary.txt"))).toBe("EACCES");
    expect(fs.access("/home/owner", "x")).toBe(false);
    expect(fs.access("/home/owner/diary.txt", "r")).toBe(false);
  });

  test("system files are readable but not writable or removable", () => {
    const fs = makeFs();
    expect(fs.access("/etc/motd", "r")).toBe(true);
    expect(fs.access("/etc/motd", "w")).toBe(false);
    expect(codeOf(() => fs.writeFile("/etc/motd", "x"))).toBe("EACCES");
    expect(codeOf(() => fs.writeFile("/etc/new", "x"))).toBe("EACCES");
    expect(codeOf(() => fs.remove("/etc/motd"))).toBe("EACCES");
    expect(codeOf(() => fs.remove("/etc", { recursive: true }))).toBe("EACCES");
    expect(codeOf(() => fs.remove("/", { recursive: true }))).toBe("EACCES");
    expect(codeOf(() => fs.mkdir("/etc/x"))).toBe("EACCES");
    expect(codeOf(() => fs.rename("/etc/motd", "/tmp/motd"))).toBe("EACCES");
    expect(fs.readFile("/etc/motd")).toBe("hello\n");
  });

  test("a recursive remove that hits a protected subtree removes nothing", () => {
    const fs = makeFs();
    expect(codeOf(() => fs.remove("/home", { recursive: true }))).toBe("EACCES");
    expect(fs.readFile("/home/guest/notes.txt")).toBe("one\n");
  });
});

describe("writing", () => {
  test("create, replace, append", () => {
    const fs = makeFs();
    fs.writeFile("/home/guest/new.txt", "a");
    fs.writeFile("/home/guest/new.txt", "b", { append: true });
    expect(fs.readFile("/home/guest/new.txt")).toBe("ab");
    fs.writeFile("/home/guest/new.txt", "c");
    expect(fs.readFile("/home/guest/new.txt")).toBe("c");
    expect(fs.stat("/home/guest/new.txt")?.owner).toBe("guest");
    expect(codeOf(() => fs.writeFile("/home/guest/missing/x", "a"))).toBe("ENOENT");
    expect(codeOf(() => fs.writeFile("/home/guest/docs", "a"))).toBe("EISDIR");
  });

  test("world-writable directories accept files; the sink swallows writes", () => {
    const fs = makeFs();
    fs.writeFile("/tmp/scratch", "x");
    expect(fs.readFile("/tmp/scratch")).toBe("x");
    fs.writeFile("/dev/null", "gone");
    expect(fs.readFile("/dev/null")).toBe("");
  });

  test("mkdir, with and without parents", () => {
    const fs = makeFs();
    fs.mkdir("/home/guest/a");
    expect(codeOf(() => fs.mkdir("/home/guest/a"))).toBe("EEXIST");
    expect(codeOf(() => fs.mkdir("/home/guest/x/y/z"))).toBe("ENOENT");
    fs.mkdir("/home/guest/x/y/z", { recursive: true });
    fs.mkdir("/home/guest/x/y/z", { recursive: true });
    expect(fs.stat("/home/guest/x/y/z")?.type).toBe("dir");
    expect(codeOf(() => fs.mkdir("/home/guest/notes.txt", { recursive: true }))).toBe(
      "EEXIST"
    );
  });

  test("remove needs recursive only for non-empty directories", () => {
    const fs = makeFs();
    expect(codeOf(() => fs.remove("/home/guest/docs"))).toBe("ENOTEMPTY");
    fs.remove("/home/guest/docs", { recursive: true });
    expect(fs.stat("/home/guest/docs")).toBeNull();
    fs.mkdir("/home/guest/empty");
    fs.remove("/home/guest/empty");
    expect(fs.stat("/home/guest/empty")).toBeNull();
    expect(codeOf(() => fs.remove("/home/guest/nope"))).toBe("ENOENT");
  });

  test("rename moves and replaces files, never into itself or onto a directory", () => {
    const fs = makeFs();
    fs.rename("/home/guest/notes.txt", "/home/guest/docs/a.md");
    expect(fs.readFile("/home/guest/docs/a.md")).toBe("one\n");
    expect(fs.stat("/home/guest/notes.txt")).toBeNull();
    expect(codeOf(() => fs.rename("/home/guest/docs", "/home/guest/docs/sub"))).toBe(
      "EINVAL"
    );
    expect(codeOf(() => fs.rename("/home/guest/docs/a.md", "/tmp"))).toBe("EISDIR");
  });

  test("copy duplicates content, directories only recursively, owned by the copier", () => {
    const fs = makeFs();
    fs.copy("/etc/motd", "/home/guest/motd");
    fs.writeFile("/home/guest/motd", "changed");
    expect(fs.readFile("/etc/motd")).toBe("hello\n");
    expect(fs.stat("/home/guest/motd")?.owner).toBe("guest");
    expect(codeOf(() => fs.copy("/home/guest/docs", "/tmp/docs"))).toBe("EISDIR");
    fs.copy("/home/guest/docs", "/tmp/docs", { recursive: true });
    expect(fs.readdir("/tmp/docs")).toEqual([".hidden", "a.md"]);
    expect(codeOf(() => fs.copy("/home/owner/diary.txt", "/tmp/d"))).toBe("EACCES");
    expect(codeOf(() => fs.copy("/etc/motd", "/etc/motd2"))).toBe("EACCES");
  });
});

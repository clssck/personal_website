/**
 * In-memory filesystem with Unix-style owner/other permission bits. The
 * tree is built once from a spec (see fs-image.ts) and lives for the page
 * session; nothing is persisted.
 */
import { FsError, type Stat, type Vfs } from "./types";

type Content = string | (() => string);

export interface FileSpec {
  kind: "file";
  /** A function is evaluated on every read (for /proc-style files). */
  content: Content;
  mode?: number;
  owner?: string;
  /** Writes are discarded and reads are empty, like /dev/null. */
  sink?: boolean;
}

export interface DirSpec {
  kind: "dir";
  children: Record<string, FileSpec | DirSpec>;
  mode?: number;
  owner?: string;
}

type NodeOptions = { mode?: number; owner?: string };

export function file(
  content: Content,
  opts: NodeOptions & { sink?: boolean } = {}
): FileSpec {
  return { kind: "file", content, ...opts };
}

export function dir(
  children: Record<string, FileSpec | DirSpec>,
  opts: NodeOptions = {}
): DirSpec {
  return { kind: "dir", children, ...opts };
}

interface FileNode {
  type: "file";
  mode: number;
  owner: string;
  mtime: number;
  content: Content;
  sink: boolean;
}

interface DirNode {
  type: "dir";
  mode: number;
  owner: string;
  mtime: number;
  children: Map<string, FsNode>;
}

type FsNode = FileNode | DirNode;

const READ = 4;
const WRITE = 2;
const SEARCH = 1;
const DIR_SIZE = 4096;

/**
 * Absolute, normalised form of a user-supplied path: `~` and `~/x` expand
 * to `home`, relative paths hang off `cwd`, and `.`/`..`/empty segments
 * collapse. Purely lexical: nothing is checked against the filesystem.
 */
export function resolvePath(input: string, cwd: string, home: string): string {
  let raw = input;
  if (raw === "~" || raw.startsWith("~/")) raw = home + raw.slice(1);
  else if (!raw.startsWith("/")) raw = `${cwd}/${raw}`;
  const parts: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return "/" + parts.join("/");
}

function splitPath(path: string): { parent: string; name: string } {
  const cut = path.lastIndexOf("/");
  return { parent: cut <= 0 ? "/" : path.slice(0, cut), name: path.slice(cut + 1) };
}

export function createVfs(
  root: DirSpec,
  opts: { user: string; now?: () => number }
): Vfs {
  const { user } = opts;
  const now = opts.now ?? Date.now;

  function build(spec: FileSpec | DirSpec, inheritedOwner: string): FsNode {
    const owner = spec.owner ?? inheritedOwner;
    if (spec.kind === "file") {
      return {
        type: "file",
        mode: spec.mode ?? 0o644,
        owner,
        mtime: now(),
        content: spec.content,
        sink: spec.sink ?? false,
      };
    }
    const children = new Map<string, FsNode>();
    for (const [name, child] of Object.entries(spec.children)) {
      children.set(name, build(child, owner));
    }
    return { type: "dir", mode: spec.mode ?? 0o755, owner, mtime: now(), children };
  }

  const tree = build(root, "root") as DirNode;

  function allowed(node: FsNode, bit: number): boolean {
    const bits = node.owner === user ? node.mode >> 6 : node.mode;
    return (bits & bit) !== 0;
  }

  /** null when missing; EACCES/ENOTDIR are reported against `path`. */
  function lookup(path: string): FsNode | null {
    let node: FsNode = tree;
    for (const segment of path.split("/")) {
      if (segment === "") continue;
      if (node.type !== "dir") throw new FsError("ENOTDIR", path);
      if (!allowed(node, SEARCH)) throw new FsError("EACCES", path);
      const next = node.children.get(segment);
      if (!next) return null;
      node = next;
    }
    return node;
  }

  function need(path: string): FsNode {
    const node = lookup(path);
    if (!node) throw new FsError("ENOENT", path);
    return node;
  }

  function needDir(path: string): DirNode {
    const node = need(path);
    if (node.type !== "dir") throw new FsError("ENOTDIR", path);
    return node;
  }

  /** The directory that holds `path`, checked for permission to change its entries. */
  function writableParent(path: string): { parent: DirNode; name: string } {
    const { parent: parentPath, name } = splitPath(path);
    if (!name) throw new FsError("EACCES", path);
    const parent = needDir(parentPath);
    if (!allowed(parent, WRITE) || !allowed(parent, SEARCH)) {
      throw new FsError("EACCES", path);
    }
    return { parent, name };
  }

  function read(node: FileNode): string {
    if (node.sink) return "";
    return typeof node.content === "function" ? node.content() : node.content;
  }

  /** Every directory in the subtree must be writable before any entry is dropped. */
  function assertRemovable(node: FsNode, path: string): void {
    if (node.type !== "dir") return;
    if (node.children.size > 0 && !allowed(node, WRITE)) {
      throw new FsError("EACCES", path);
    }
    for (const [name, child] of node.children) {
      assertRemovable(child, `${path}/${name}`);
    }
  }

  function clone(node: FsNode, path: string): FsNode {
    if (!allowed(node, READ)) throw new FsError("EACCES", path);
    if (node.type === "file") {
      return {
        type: "file",
        mode: node.mode,
        owner: user,
        mtime: now(),
        content: read(node),
        sink: false,
      };
    }
    const children = new Map<string, FsNode>();
    for (const [name, child] of node.children) {
      children.set(name, clone(child, `${path}/${name}`));
    }
    return { type: "dir", mode: node.mode, owner: user, mtime: now(), children };
  }

  return {
    stat(path): Stat | null {
      const node = lookup(path);
      if (!node) return null;
      return {
        type: node.type,
        mode: node.mode,
        owner: node.owner,
        size: node.type === "dir" ? DIR_SIZE : read(node).length,
        mtime: node.mtime,
      };
    },

    readFile(path) {
      const node = need(path);
      if (node.type === "dir") throw new FsError("EISDIR", path);
      if (!allowed(node, READ)) throw new FsError("EACCES", path);
      return read(node);
    },

    writeFile(path, data, { append = false } = {}) {
      const existing = lookup(path);
      if (existing) {
        if (existing.type === "dir") throw new FsError("EISDIR", path);
        if (!allowed(existing, WRITE)) throw new FsError("EACCES", path);
        if (existing.sink) return;
        existing.content = append ? read(existing) + data : data;
        existing.mtime = now();
        return;
      }
      const { parent, name } = writableParent(path);
      parent.children.set(name, {
        type: "file",
        mode: 0o644,
        owner: user,
        mtime: now(),
        content: data,
        sink: false,
      });
      parent.mtime = now();
    },

    readdir(path) {
      const node = needDir(path);
      if (!allowed(node, READ)) throw new FsError("EACCES", path);
      return [...node.children.keys()].sort();
    },

    mkdir(path, { recursive = false } = {}) {
      const existing = lookup(path);
      if (existing) {
        if (recursive && existing.type === "dir") return;
        throw new FsError("EEXIST", path);
      }
      const { parent: parentPath } = splitPath(path);
      if (recursive && !lookup(parentPath)) this.mkdir(parentPath, { recursive });
      const { parent, name } = writableParent(path);
      parent.children.set(name, {
        type: "dir",
        mode: 0o755,
        owner: user,
        mtime: now(),
        children: new Map(),
      });
      parent.mtime = now();
    },

    remove(path, { recursive = false } = {}) {
      const node = need(path);
      if (node.type === "dir" && node.children.size > 0 && !recursive) {
        throw new FsError("ENOTEMPTY", path);
      }
      const { parent, name } = writableParent(path);
      assertRemovable(node, path);
      parent.children.delete(name);
      parent.mtime = now();
    },

    rename(from, to) {
      const node = need(from);
      if (to === from) return;
      if (node.type === "dir" && to.startsWith(from + "/")) {
        throw new FsError("EINVAL", to);
      }
      const target = lookup(to);
      if (target?.type === "dir") throw new FsError("EISDIR", to);
      const source = writableParent(from);
      const dest = writableParent(to);
      source.parent.children.delete(source.name);
      dest.parent.children.set(dest.name, node);
      source.parent.mtime = dest.parent.mtime = now();
    },

    copy(from, to, { recursive = false } = {}) {
      const node = need(from);
      if (node.type === "dir") {
        if (!recursive) throw new FsError("EISDIR", from);
        if (to === from || to.startsWith(from + "/")) throw new FsError("EINVAL", to);
      }
      const target = lookup(to);
      if (target?.type === "dir") throw new FsError("EISDIR", to);
      if (target && !allowed(target, WRITE)) throw new FsError("EACCES", to);
      const dest = writableParent(to);
      dest.parent.children.set(dest.name, clone(node, from));
      dest.parent.mtime = now();
    },

    access(path, mode) {
      let node: FsNode | null;
      try {
        node = lookup(path);
      } catch {
        return false;
      }
      const bit = mode === "r" ? READ : mode === "w" ? WRITE : SEARCH;
      return node !== null && allowed(node, bit);
    },
  };
}

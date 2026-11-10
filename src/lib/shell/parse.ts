/**
 * Tokenizer and parser for the shell's command language:
 *
 *   list     := pipeline ( ("&&" | "||" | ";") pipeline )* [";"]
 *   pipeline := command ( "|" command )*
 *   command  := assignment* word* redirect*   (redirects anywhere after that)
 *
 * Words keep the provenance of every piece (literal, quoted, variable,
 * command substitution) because expansion treats them differently: only
 * unquoted literals are subject to tilde and glob expansion, and only
 * unquoted substitutions are split into several words.
 *
 * Syntax errors are reported without the shell-name prefix so the caller
 * can print them as `<shell>: <error>`.
 */

export type Part =
  | { kind: "lit"; text: string; quoted: boolean }
  | { kind: "var"; name: string; quoted: boolean }
  | { kind: "sub"; line: string; quoted: boolean };

export interface Word {
  parts: Part[];
}

export type RedirectOp = ">" | ">>" | "<" | "2>" | "2>>";

export type Redirect = { op: RedirectOp; target: Word } | { op: "2>&1" };

export interface Assignment {
  name: string;
  value: Word;
}

export interface Command {
  assignments: Assignment[];
  words: Word[];
  redirects: Redirect[];
}

export interface Pipeline {
  commands: Command[];
}

export type Connector = "&&" | "||" | ";";

/** `connector` decides whether the pipeline runs, based on the previous status. */
export interface ListEntry {
  connector: Connector;
  pipeline: Pipeline;
}

export type ParseResult = { list: ListEntry[] } | { error: string };

type Operator = Connector | "|" | RedirectOp | "2>&1";

type Token = { type: "word"; word: Word } | { type: "op"; op: Operator };

class ParseError extends Error {}

const parseErrorNear = (token: string) =>
  new ParseError(`parse error near \`${token}'`);

/** Longest operators first so `>>` wins over `>` and `2>&1` over `2>`. */
const OPERATORS: readonly Operator[] = [
  "2>&1",
  "2>>",
  "2>",
  "&&",
  "||",
  ">>",
  "|",
  ";",
  ">",
  "<",
];

const WORD_END = " \t\n|&;<>";
const NAME_START = /[A-Za-z_]/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const VAR_NAME = /^(?:[A-Za-z_][A-Za-z0-9_]*|\?)$/;
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;

/** Index just past the `)` closing a `$(` whose body starts at `from`; -1 when unclosed. */
function substitutionEnd(s: string, from: number): number {
  let depth = 1;
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === "\\") i++;
    else if (c === "'") {
      i = s.indexOf("'", i + 1);
      if (i < 0) return -1;
    } else if (c === '"') {
      for (i++; i < s.length && s[i] !== '"'; i++) if (s[i] === "\\") i++;
      if (i >= s.length) return -1;
    } else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i + 1;
  }
  return -1;
}

function tokenize(s: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;

  function pushPart(parts: Part[], part: Part): void {
    const prev = parts[parts.length - 1];
    if (part.kind === "lit" && prev?.kind === "lit" && prev.quoted === part.quoted) {
      prev.text += part.text;
    } else parts.push(part);
  }

  /** Reads a `$…` expansion at `i` (pointing at `$`) and advances past it. */
  function readDollar(parts: Part[], quoted: boolean): void {
    const next = s[i + 1];
    if (next === "(") {
      const end = substitutionEnd(s, i + 2);
      if (end < 0) throw parseErrorNear("$(");
      const line = s.slice(i + 2, end - 1);
      // Validate now so a broken substitution fails the whole line up front.
      const inner = parse(line);
      if ("error" in inner) throw new ParseError(inner.error);
      parts.push({ kind: "sub", line, quoted });
      i = end;
    } else if (next === "{") {
      const close = s.indexOf("}", i + 2);
      if (close < 0) throw new ParseError("closing brace expected");
      const name = s.slice(i + 2, close);
      if (!VAR_NAME.test(name)) throw new ParseError("bad substitution");
      parts.push({ kind: "var", name, quoted });
      i = close + 1;
    } else if (next === "?") {
      parts.push({ kind: "var", name: "?", quoted });
      i += 2;
    } else if (next !== undefined && NAME_START.test(next)) {
      let end = i + 2;
      while (end < s.length && NAME_CHAR.test(s[end])) end++;
      parts.push({ kind: "var", name: s.slice(i + 1, end), quoted });
      i = end;
    } else {
      pushPart(parts, { kind: "lit", text: "$", quoted });
      i++;
    }
  }

  function readDoubleQuoted(parts: Part[]): void {
    // An empty quoted piece guarantees `""` still yields a word.
    pushPart(parts, { kind: "lit", text: "", quoted: true });
    i++;
    while (i < s.length && s[i] !== '"') {
      const c = s[i];
      if (c === "\\" && (s[i + 1] === '"' || s[i + 1] === "\\" || s[i + 1] === "$")) {
        pushPart(parts, { kind: "lit", text: s[i + 1], quoted: true });
        i += 2;
      } else if (c === "$") readDollar(parts, true);
      else {
        pushPart(parts, { kind: "lit", text: c, quoted: true });
        i++;
      }
    }
    if (i >= s.length) throw new ParseError('unmatched "');
    i++;
  }

  function readWord(): Word {
    const parts: Part[] = [];
    while (i < s.length && !WORD_END.includes(s[i])) {
      const c = s[i];
      if (c === "\\") {
        if (i + 1 < s.length) {
          pushPart(parts, { kind: "lit", text: s[i + 1], quoted: true });
          i += 2;
        } else {
          pushPart(parts, { kind: "lit", text: "\\", quoted: false });
          i++;
        }
      } else if (c === "'") {
        const close = s.indexOf("'", i + 1);
        if (close < 0) throw new ParseError("unmatched '");
        pushPart(parts, { kind: "lit", text: s.slice(i + 1, close), quoted: true });
        i = close + 1;
      } else if (c === '"') readDoubleQuoted(parts);
      else if (c === "$") readDollar(parts, false);
      else {
        pushPart(parts, { kind: "lit", text: c, quoted: false });
        i++;
      }
    }
    return { parts };
  }

  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t") {
      i++;
      continue;
    }
    if (c === "\n") {
      // A newline separates commands, but blank lines and a newline after an
      // operator (line continuation) add nothing.
      if (tokens[tokens.length - 1]?.type === "word") tokens.push({ type: "op", op: ";" });
      i++;
      continue;
    }
    if (c === "#") {
      const newline = s.indexOf("\n", i);
      i = newline < 0 ? s.length : newline;
      continue;
    }
    const op = OPERATORS.find((candidate) => s.startsWith(candidate, i));
    if (op) {
      tokens.push({ type: "op", op });
      i += op.length;
      continue;
    }
    if (c === "&") throw parseErrorNear("&");
    tokens.push({ type: "word", word: readWord() });
  }
  return tokens;
}

/** The text of a word that is one unquoted literal, else null. */
function plainText(word: Word): string | null {
  const [only, ...rest] = word.parts;
  return rest.length === 0 && only?.kind === "lit" && !only.quoted ? only.text : null;
}

/**
 * Parses one input line. `alias` returns the replacement text for a command
 * name; it is consulted for the first unquoted word of every command, and a
 * name is not expanded again within the same command, which stops
 * `alias ls='ls -F'` and alias cycles from recursing.
 */
export function parse(
  line: string,
  alias: (name: string) => string | undefined = () => undefined
): ParseResult {
  let tokens: Token[];
  try {
    tokens = tokenize(line);
  } catch (error) {
    if (error instanceof ParseError) return { error: error.message };
    throw error;
  }
  let pos = 0;

  const describe = (token: Token | undefined) =>
    token?.type === "op" ? token.op : "\\n";

  function parseCommand(): Command {
    const command: Command = { assignments: [], words: [], redirects: [] };
    const expanded = new Set<string>();
    while (pos < tokens.length) {
      const token = tokens[pos];
      if (token.type === "op") {
        if (token.op === "2>&1") {
          command.redirects.push({ op: "2>&1" });
          pos++;
          continue;
        }
        if (token.op === "|" || token.op === "&&" || token.op === "||" || token.op === ";") {
          break;
        }
        const target = tokens[pos + 1];
        if (target?.type !== "word") throw parseErrorNear(describe(target));
        command.redirects.push({ op: token.op, target: target.word });
        pos += 2;
        continue;
      }
      if (command.words.length === 0) {
        const first = token.word.parts[0];
        const assignment =
          first?.kind === "lit" && !first.quoted ? ASSIGNMENT.exec(first.text) : null;
        if (assignment && first?.kind === "lit") {
          const rest = first.text.slice(assignment[0].length);
          const parts: Part[] = rest ? [{ kind: "lit", text: rest, quoted: false }] : [];
          parts.push(...token.word.parts.slice(1));
          command.assignments.push({ name: assignment[1], value: { parts } });
          pos++;
          continue;
        }
        const name = plainText(token.word);
        const replacement = name === null || expanded.has(name) ? undefined : alias(name);
        if (name !== null && replacement !== undefined) {
          expanded.add(name);
          tokens.splice(pos, 1, ...tokenize(replacement));
          continue;
        }
      }
      command.words.push(token.word);
      pos++;
    }
    const empty =
      command.words.length === 0 &&
      command.assignments.length === 0 &&
      command.redirects.length === 0;
    if (empty) throw parseErrorNear(describe(tokens[pos]));
    return command;
  }

  function parsePipeline(): Pipeline {
    const commands = [parseCommand()];
    while (pos < tokens.length) {
      const token = tokens[pos];
      if (token.type !== "op" || token.op !== "|") break;
      pos++;
      if (pos >= tokens.length) throw parseErrorNear("|");
      commands.push(parseCommand());
    }
    return { commands };
  }

  try {
    const list: ListEntry[] = [];
    let connector: Connector = ";";
    while (pos < tokens.length) {
      list.push({ connector, pipeline: parsePipeline() });
      const token = tokens[pos];
      if (token === undefined) break;
      if (token.type !== "op" || (token.op !== "&&" && token.op !== "||" && token.op !== ";")) {
        throw parseErrorNear(describe(token));
      }
      pos++;
      if (pos >= tokens.length && token.op !== ";") throw parseErrorNear(token.op);
      connector = token.op;
    }
    return { list };
  } catch (error) {
    if (error instanceof ParseError) return { error: error.message };
    throw error;
  }
}

/**
 * Renders the ANSI subset commands emit (see shell/style.ts) to HTML that is
 * safe for innerHTML: SGR bold/dim/underline and the standard foreground
 * colours become classed spans, OSC 8 hyperlinks and bare http(s) URLs
 * become anchors, every other escape sequence is dropped, and all text is
 * escaped.
 */
import { escapeHtml } from "./terminal";

export interface AnsiRenderer {
  /** One line of output. Styles left open carry over to the next call. */
  render(text: string): string;
  /** Forget open styles, so one command's output cannot tint the next. */
  reset(): void;
}

const ESC = "\x1b";
const BEL = "\x07";
const COLORS = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const BARE_URL = /https?:\/\/[^\s<>"'`]+/g;
const TRAILING_PUNCTUATION = /[.,;:!?)\]]+$/;

/** The normalised URL when it is plain http(s), otherwise null. */
function httpUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function anchor(href: string, html: string): string {
  return `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${html}</a>`;
}

/** Escape text, turning bare URLs into links (sentence punctuation stays outside). */
function autolink(text: string): string {
  let html = "";
  let last = 0;
  for (const match of text.matchAll(BARE_URL)) {
    const raw = match[0].replace(TRAILING_PUNCTUATION, "");
    const href = httpUrl(raw);
    if (!href) continue;
    html += escapeHtml(text.slice(last, match.index)) + anchor(href, escapeHtml(raw));
    last = match.index + raw.length;
  }
  return html + escapeHtml(text.slice(last));
}

export function createAnsiRenderer(): AnsiRenderer {
  let bold = false;
  let dim = false;
  let underline = false;
  let color = "";
  let link = "";

  function applySgr(params: string): void {
    for (const part of params === "" ? ["0"] : params.split(";")) {
      const code = Number(part);
      if (code === 0) {
        bold = dim = underline = false;
        color = "";
      } else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 22) bold = dim = false;
      else if (code === 4) underline = true;
      else if (code === 24) underline = false;
      else if (code === 39) color = "";
      else if (code >= 30 && code <= 37) color = COLORS[code - 30]!;
      else if (code >= 90 && code <= 97) color = COLORS[code - 90]!;
    }
  }

  function styled(text: string): string {
    if (!text) return "";
    let html = link ? escapeHtml(text) : autolink(text);
    const classes: string[] = [];
    if (bold) classes.push("sgr-bold");
    if (dim) classes.push("sgr-dim");
    if (underline) classes.push("sgr-underline");
    if (color) classes.push(`fg-${color}`);
    if (classes.length) html = `<span class="${classes.join(" ")}">${html}</span>`;
    return link ? anchor(link, html) : html;
  }

  return {
    render(text) {
      let html = "";
      let at = 0;
      while (at < text.length) {
        const esc = text.indexOf(ESC, at);
        if (esc === -1) {
          html += styled(text.slice(at));
          break;
        }
        html += styled(text.slice(at, esc));
        const kind = text[esc + 1];
        if (kind === "[") {
          // CSI: parameters, then one final byte in @..~
          let end = esc + 2;
          while (end < text.length && (text[end]! < "@" || text[end]! > "~")) end++;
          if (text[end] === "m") applySgr(text.slice(esc + 2, end));
          at = end + 1;
        } else if (kind === "]") {
          // OSC: terminated by ESC \ or BEL; only "8;params;uri" is honoured
          const st = text.indexOf(ESC + "\\", esc + 2);
          const bel = text.indexOf(BEL, esc + 2);
          const end = st === -1 ? bel : bel === -1 ? st : Math.min(st, bel);
          if (end === -1) break;
          const body = text.slice(esc + 2, end);
          if (body.startsWith("8;")) {
            const uri = body.slice(body.indexOf(";", 2) + 1);
            link = uri ? (httpUrl(uri) ?? "") : "";
          }
          at = end + (end === st ? 2 : 1);
        } else {
          at = esc + 1;
        }
      }
      return html;
    },
    reset() {
      bold = dim = underline = false;
      color = "";
      link = "";
    },
  };
}

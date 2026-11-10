import { describe, expect, test } from "bun:test";
import { createAnsiRenderer } from "./ansi";
import { ansiStyle } from "./shell/style";

const render = (text: string) => createAnsiRenderer().render(text);

describe("text", () => {
  test("HTML in output is escaped, never interpreted", () => {
    expect(render(`<img src=x onerror="alert(1)">`)).toBe(
      "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"
    );
  });

  test("unknown and unterminated escape sequences are dropped", () => {
    expect(render("a\x1b[2Kb\x1b[10;20Hc")).toBe("abc");
    expect(render("a\x1bXb")).toBe("aXb");
    expect(render("a\x1b]0;window title\x07b")).toBe("ab");
    expect(render("a\x1b]8;;https://example.com")).toBe("a");
  });
});

describe("styles", () => {
  test("bold, dim, underline and colours become classed spans", () => {
    expect(render(ansiStyle.bold("x"))).toBe('<span class="sgr-bold">x</span>');
    expect(render(ansiStyle.dim("x"))).toBe('<span class="sgr-dim">x</span>');
    expect(render(ansiStyle.underline("x"))).toBe(
      '<span class="sgr-underline">x</span>'
    );
    expect(render(ansiStyle.red("x"))).toBe('<span class="fg-red">x</span>');
    expect(render(ansiStyle.bold(ansiStyle.blue("x")))).toBe(
      '<span class="sgr-bold fg-blue">x</span>'
    );
  });

  test("a style ends where its reset is, the rest stays plain", () => {
    expect(render(`a${ansiStyle.green("b")}c`)).toBe(
      'a<span class="fg-green">b</span>c'
    );
    expect(render("\x1b[1;31mx\x1b[0my")).toBe(
      '<span class="sgr-bold fg-red">x</span>y'
    );
    expect(render("\x1b[91mx\x1b[my")).toBe('<span class="fg-red">x</span>y');
  });

  test("an open style carries to the next line until reset()", () => {
    const ansi = createAnsiRenderer();
    expect(ansi.render("\x1b[31mone")).toBe('<span class="fg-red">one</span>');
    expect(ansi.render("two")).toBe('<span class="fg-red">two</span>');
    ansi.reset();
    expect(ansi.render("three")).toBe("three");
  });
});

describe("links", () => {
  test("OSC 8 hyperlinks become safe anchors around the styled text", () => {
    expect(render(ansiStyle.link("https://github.com/clssck", "gh"))).toBe(
      '<a href="https://github.com/clssck" target="_blank" rel="noopener noreferrer">gh</a>'
    );
    expect(
      render(ansiStyle.link("https://example.com/", ansiStyle.bold("<b>")))
    ).toBe(
      '<a href="https://example.com/" target="_blank" rel="noopener noreferrer"><span class="sgr-bold">&lt;b&gt;</span></a>'
    );
  });

  test("non-http link targets are rendered as plain text", () => {
    for (const url of ["javascript:alert(1)", "data:text/html,x", "not a url"]) {
      expect(render(ansiStyle.link(url, "click")), url).toBe("click");
    }
  });

  test("bare URLs are linked, sentence punctuation stays outside", () => {
    expect(render("see https://ennivalo.com/a?b=1.")).toBe(
      'see <a href="https://ennivalo.com/a?b=1" target="_blank" rel="noopener noreferrer">https://ennivalo.com/a?b=1</a>.'
    );
    expect(render("ftp://example.com and javascript:alert(1)")).toBe(
      "ftp://example.com and javascript:alert(1)"
    );
  });

  test("a URL inside an explicit link is not linked twice", () => {
    const html = render(ansiStyle.link("https://a.example/", "https://b.example/"));
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).toContain('href="https://a.example/"');
  });
});

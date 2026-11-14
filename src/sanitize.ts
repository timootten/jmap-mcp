import { Parser } from "htmlparser2";

// Every regex in this file is a single character class or a fixed literal, so none of
// them can backtrack polynomially. Anything that needs lookahead is a hand-written scan
// that advances monotonically.

export interface Cleaned {
  text: string;
  /** Characters dropped because they were hidden, invisible or tracking-related. */
  removed: number;
  /** Characters cut off by the length limit. */
  truncated: number;
}

/** Zero-width, bidi, soft hyphen, word joiner, BOM, Unicode tag and variation-selector-supplement characters. */
const INVISIBLE =
  // oxlint-disable-next-line no-misleading-character-class -- tag and variation-selector ranges are removed one by one
  /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
// oxlint-disable-next-line no-control-regex -- strips control characters on purpose
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

/** Replaces control characters and line separators with spaces. For header values. */
export function headerSafe(raw: string): string {
  return (
    stripInvisible(raw)
      // oxlint-disable-next-line no-control-regex -- strips control characters on purpose
      .text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
      .trim()
  );
}

export function stripInvisible(text: string): { text: string; removed: number } {
  let removed = 0;
  const count = () => {
    removed++;
    return "";
  };
  const out = text
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2028\u2029]/g, "\n")
    .replace(INVISIBLE, count)
    .replace(CONTROL, count);
  return { text: out, removed };
}

const HIDDEN_TAGS = new Set([
  "script",
  "style",
  "template",
  "noscript",
  "head",
  "title",
  "iframe",
  "object",
  "embed",
]);
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "br",
  "li",
  "tr",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "pre",
  "table",
  "ul",
  "ol",
  "hr",
  "section",
  "article",
  "header",
  "footer",
  "dt",
  "dd",
]);

function stripCssComments(css: string): string {
  let out = "";
  let i = 0;
  while (i < css.length) {
    const start = css.indexOf("/*", i);
    if (start === -1) return out + css.slice(i);
    out += css.slice(i, start);
    const end = css.indexOf("*/", start + 2);
    if (end === -1) return out;
    i = end + 2;
  }
  return out;
}

function isTinyLength(value: string): boolean {
  const n = Number.parseFloat(value);
  if (!Number.isFinite(n)) return false;
  if (n === 0) return true;
  return (value.endsWith("px") || value.endsWith("pt")) && n <= 1;
}

export function isHiddenStyle(style: string | undefined): boolean {
  if (!style) return false;
  const props = new Map<string, string>();
  for (const decl of stripCssComments(style).split(";")) {
    const i = decl.indexOf(":");
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    const value = decl
      .slice(i + 1)
      .replace(/!important/gi, "")
      .trim()
      .toLowerCase();
    props.set(prop, value);
  }
  const get = (p: string) => props.get(p) ?? "";
  if (get("display").startsWith("none")) return true;
  if (get("visibility") === "hidden" || get("visibility") === "collapse") return true;
  if (get("opacity") !== "" && Number.parseFloat(get("opacity")) === 0) return true;
  if (get("font-size") !== "" && isTinyLength(get("font-size"))) return true;
  if (get("mso-hide") === "all") return true;
  if (get("color") === "transparent") return true;
  const overflowHidden = get("overflow") === "hidden";
  if (overflowHidden && (isTinyLength(get("max-height")) || isTinyLength(get("height"))))
    return true;
  return false;
}

function isTrackingPixel(attribs: Record<string, string>): boolean {
  const small = (v: string | undefined) => v !== undefined && /^[0-2](px)?$/.test(v.trim());
  return small(attribs.width) || small(attribs.height);
}

function isHidden(name: string, attribs: Record<string, string>): boolean {
  if (HIDDEN_TAGS.has(name)) return true;
  if (Object.hasOwn(attribs, "hidden")) return true;
  if (name === "input" && attribs.type?.toLowerCase() === "hidden") return true;
  return isHiddenStyle(attribs.style);
}

function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined;
  const h = href.trim();
  if (!/^(https?:|mailto:)/i.test(h)) return undefined;
  return h.length > 200 ? `${h.slice(0, 200)}…` : h;
}

export function htmlToText(html: string): { text: string; removed: number } {
  let removed = 0;
  const out: string[] = [];
  const stack: { name: string; hidden: boolean; href?: string }[] = [];
  let hiddenDepth = 0;
  let preDepth = 0;

  const parser = new Parser(
    {
      onopentag(name, attribs) {
        const hidden = isHidden(name, attribs);
        stack.push({ name, hidden, href: name === "a" ? safeHref(attribs.href) : undefined });
        if (hidden) hiddenDepth++;
        if (hiddenDepth > 0) {
          if (name === "img") removed += attribs.src?.length ?? 0;
          return;
        }
        if (name === "pre") preDepth++;
        if (name === "img") {
          if (isTrackingPixel(attribs)) removed += attribs.src?.length ?? 0;
          else if (attribs.alt) out.push(`[image: ${attribs.alt.slice(0, 100)}]`);
        } else if (name === "li") out.push("\n- ");
        else if (BLOCK_TAGS.has(name)) out.push("\n");
      },
      onclosetag(name) {
        const top = stack.pop();
        if (!top) return;
        if (top.hidden) {
          hiddenDepth--;
          return;
        }
        if (hiddenDepth > 0) return;
        if (top.name === "pre") preDepth--;
        if (top.name === "a" && top.href) out.push(` <${top.href}>`);
        if (BLOCK_TAGS.has(name)) out.push("\n");
      },
      ontext(data) {
        if (hiddenDepth > 0) removed += data.length;
        else out.push(preDepth > 0 ? data : data.replace(/\s+/g, " "));
      },
      oncomment(data) {
        removed += data.length;
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return { text: out.join(""), removed };
}

/** Replaces `![alt](url)`, `![alt][ref]` and `![alt]` with `[image: alt]`. Single pass, linear. */
export function neutralizeMarkdownImages(text: string): { text: string; removed: number } {
  const MAX_ALT = 300;
  const MAX_URL = 2000;
  const n = text.length;
  let out = "";
  let removed = 0;
  let literalFrom = 0;
  let i = 0;

  while (i < n) {
    if (text[i] !== "!" || text[i + 1] !== "[") {
      i++;
      continue;
    }
    let j = i + 2;
    let resume = -1;
    while (j < n && j - i <= MAX_ALT && text[j] !== "]" && text[j] !== "\n") {
      if (text[j] === "!" && text[j + 1] === "[") {
        resume = j;
        break;
      }
      j++;
    }
    if (resume >= 0) {
      i = resume;
      continue;
    }
    if (text[j] !== "]") {
      i += 2;
      continue;
    }
    const alt = text.slice(i + 2, j);
    let end = j + 1;
    const open = text[end];
    if (open === "(" || open === "[") {
      const close = open === "(" ? ")" : "]";
      let k = end + 1;
      while (k < n && k - end <= MAX_URL && text[k] !== close && text[k] !== "\n") {
        if (text[k] === "!" && text[k + 1] === "[") {
          resume = k;
          break;
        }
        k++;
      }
      if (resume >= 0) {
        i = resume;
        continue;
      }
      if (text[k] !== close) {
        i += 2;
        continue;
      }
      removed += k - end - 1;
      end = k + 1;
    }
    out += text.slice(literalFrom, i);
    out += `[image: ${alt.replace(/[[\]]/g, "").slice(0, 100)}]`;
    literalFrom = end;
    i = end;
  }
  return { text: out + text.slice(literalFrom), removed };
}

/** Removes anything that looks like our untrusted-content markers. */
export function defangMarkers(text: string): string {
  return text
    .replace(/\[\/?UNTRUSTED/gi, "[marker-removed")
    .replace(/UNTRUSTED_[0-9a-f]*/gi, "marker-removed");
}

function truncate(text: string, max: number): { text: string; truncated: number } {
  if (text.length <= max) return { text, truncated: 0 };
  let cut = max;
  const code = text.charCodeAt(cut - 1);
  if (code >= 0xd800 && code <= 0xdbff) cut--;
  return { text: text.slice(0, cut), truncated: text.length - cut };
}

export interface CleanOptions {
  html?: boolean;
  maxChars?: number;
  /** Characters of the cleaned text to skip, for pagination. */
  offset?: number;
  /** Collapse to a single line (names, subjects). */
  inline?: boolean;
}

export function sanitize(raw: string, opts: CleanOptions = {}): Cleaned {
  let removed = 0;
  let text = raw;
  if (opts.html) {
    const h = htmlToText(text);
    text = h.text;
    removed += h.removed;
  }
  const inv = stripInvisible(text);
  text = inv.text;
  removed += inv.removed;

  const img = neutralizeMarkdownImages(text);
  text = img.text.replace(/<img/gi, "[image-tag-removed");
  removed += img.removed;
  text = defangMarkers(text);

  if (opts.inline) {
    text = text.split(/\s+/).filter(Boolean).join(" ");
  } else {
    const lines: string[] = [];
    let blank = 0;
    for (const line of text.split("\n")) {
      const t = line.trimEnd();
      blank = t === "" ? blank + 1 : 0;
      if (blank <= 2) lines.push(t);
    }
    text = lines.join("\n").trim();
  }
  if (opts.offset) text = text.slice(opts.offset);
  const cut = truncate(text, opts.maxChars ?? 20_000);
  return { text: cut.text, removed, truncated: cut.truncated };
}

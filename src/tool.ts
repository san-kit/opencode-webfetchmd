import { Plugin } from "@opencode/plugin";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { registerZyteIntegration, resolveZyteApiKey } from "./credentials";

const ZYTE_ENDPOINT = "https://api.zyte.com/v1/extract";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 60_000;
const GOAL_TAIL_BUDGET = 1800;
const TOOL_VERSION = 1;

type TextNode = { kind: "text"; value: string };
type ElementNode = {
  kind: "element";
  tag: string;
  attrs: Record<string, string>;
  children: ParsedNode[];
};
type ParsedNode = TextNode | ElementNode;

/* ------------------------------------------------------------------ */
/* entity decoding                                                     */
/* ------------------------------------------------------------------ */

const NAMED_ENTITIES: Record<string, string> = {
  AElig: "Æ",
  AMP: "&",
  Aacute: "Á",
  Acirc: "Â",
  Agrave: "À",
  Aring: "Å",
  Atilde: "Ã",
  Auml: "Ä",
  COPY: "©",
  Ccedil: "Ç",
  ETH: "Ð",
  Eacute: "É",
  Ecirc: "Ê",
  Egrave: "È",
  Euml: "Ë",
  GT: ">",
  Iacute: "Í",
  Icirc: "Î",
  Igrave: "Ì",
  Iuml: "Ï",
  LT: "<",
  Ntilde: "Ñ",
  Oacute: "Ó",
  Ocirc: "Ô",
  Ograve: "Ò",
  Oslash: "Ø",
  Otilde: "Õ",
  Ouml: "Ö",
  REG: "®",
  THORN: "Þ",
  Uacute: "Ú",
  Ucirc: "Û",
  Ugrave: "Ù",
  Uuml: "Ü",
  Yacute: "Ý",
  aacute: "á",
  acirc: "â",
  acute: "´",
  aelig: "æ",
  agrave: "à",
  amp: "&",
  aring: "å",
  atilde: "ã",
  auml: "ä",
  breve: "˘",
  bull: "•",
  ccedil: "ç",
  cedil: "¸",
  cent: "¢",
  circ: "ˆ",
  copy: "©",
  ddagger: "‡",
  dagger: "†",
  deg: "°",
  divide: "÷",
  eacute: "é",
  ecirc: "ê",
  egrave: "è",
  emsp: " ",
  ensp: " ",
  euml: "ë",
  euro: "€",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
  gt: ">",
  hArr: "⇔",
  harr: "↔",
  hellip: "…",
  iacute: "í",
  icirc: "î",
  iexcl: "¡",
  igrave: "ì",
  iquest: "¿",
  iuml: "ï",
  lArr: "⇐",
  laquo: "«",
  larr: "←",
  ldquo: "“",
  le: "≤",
  lsaquo: "‹",
  lsquo: "‘",
  lt: "<",
  macr: "¯",
  mdash: "—",
  micro: "µ",
  middot: "·",
  nbsp: " ",
  ndash: "–",
  not: "¬",
  nsub: "⊄",
  oacute: "ó",
  ocirc: "ô",
  ograve: "ò",
  omega: "ω",
  ordf: "ª",
  ordm: "º",
  oslash: "ø",
  otilde: "õ",
  ouml: "ö",
  para: "¶",
  permil: "‰",
  plusmn: "±",
  pound: "£",
  prime: "′",
  Prime: "″",
  quot: '"',
  rArr: "⇒",
  raquo: "»",
  rarr: "→",
  rdquo: "”",
  reg: "®",
  rlm: "‏",
  rsaquo: "›",
  rsquo: "’",
  sbquo: "‚",
  sect: "§",
  shy: "­",
  times: "×",
  trade: "™",
  uArr: "⇑",
  uacute: "ú",
  uarr: "↑",
  ucirc: "û",
  ugrave: "ù",
  uml: "¨",
  uuml: "ü",
  yen: "¥",
  yuml: "ÿ",
};

const ENTITY_RE = /&(#x[0-9a-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]{0,31});?/g;

function decodeEntities(input: string): string {
  return input.replace(ENTITY_RE, (match, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[body] ?? NAMED_ENTITIES[body.toLowerCase()];
    return named ?? match;
  });
}

/* ------------------------------------------------------------------ */
/* tokenizer + tree builder (lenient, HTML5-flavored)                  */
/* ------------------------------------------------------------------ */

const VOID_TAGS = new Set([
  "area",
  "base",
  "basefont",
  "br",
  "col",
  "embed",
  "frame",
  "hr",
  "img",
  "input",
  "keygen",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const RAW_TEXT_TAGS = new Set([
  "script",
  "style",
  "xmp",
  "iframe",
  "noembed",
  "noframes",
  "noscript",
  "plaintext",
]);
const ESCAPABLE_RAW_TAGS = new Set(["textarea", "title"]);
const P_CLOSERS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "search",
  "section",
  "summary",
  "table",
  "ul",
]);

function parseHtml(html: string): ElementNode {
  const root: ElementNode = {
    kind: "element",
    tag: "html",
    attrs: {},
    children: [],
  };
  const stack: ElementNode[] = [root];
  const src = html.replace(/\r\n?/g, "\n");
  const length = src.length;
  let pos = 0;

  const current = () => stack[stack.length - 1];
  const appendText = (text: string) => {
    if (!text) return;
    const parent = current();
    const last = parent.children[parent.children.length - 1];
    if (last && last.kind === "text") last.value += text;
    else parent.children.push({ kind: "text", value: text });
  };
  const popMatching = (tag: string) => {
    for (let index = stack.length - 1; index > 0; index--) {
      if (stack[index].tag === tag) {
        stack.length = index;
        return;
      }
    }
  };
  const closeIfTop = (tags: Set<string>) => {
    if (stack.length > 1 && tags.has(current().tag)) stack.pop();
  };
  const closeP = () => {
    while (stack.length > 1 && current().tag === "p") stack.pop();
  };

  const readRawText = (tag: string): string => {
    let index = pos;
    while (index < length) {
      const lt = src.indexOf("</", index);
      if (lt === -1) break;
      let nameEnd = lt + 2;
      while (nameEnd < length && /[A-Za-z]/.test(src[nameEnd])) nameEnd++;
      if (
        src.slice(lt + 2, nameEnd).toLowerCase() === tag &&
        (/[\s/>]/.test(src[nameEnd] ?? ">") || nameEnd >= length)
      ) {
        const text = src.slice(pos, lt);
        const gt = src.indexOf(">", nameEnd);
        pos = gt === -1 ? length : gt + 1;
        return text;
      }
      index = nameEnd;
    }
    const text = src.slice(pos);
    pos = length;
    return text;
  };

  while (pos < length) {
    const lt = src.indexOf("<", pos);
    if (lt === -1) {
      appendText(decodeEntities(src.slice(pos)));
      break;
    }
    if (lt > pos) appendText(decodeEntities(src.slice(pos, lt)));
    pos = lt;

    if (src.startsWith("<!--", pos)) {
      const end = src.indexOf("-->", pos + 4);
      pos = end === -1 ? length : end + 3;
      continue;
    }
    if (src.startsWith("<!", pos) || src.startsWith("<?", pos)) {
      const end = src.indexOf(">", pos);
      pos = end === -1 ? length : end + 1;
      continue;
    }
    if (src.startsWith("</", pos)) {
      let nameEnd = pos + 2;
      while (nameEnd < length && /[A-Za-z0-9-]/.test(src[nameEnd])) nameEnd++;
      const tag = src.slice(pos + 2, nameEnd).toLowerCase();
      const gt = src.indexOf(">", nameEnd);
      pos = gt === -1 ? length : gt + 1;
      if (tag) popMatching(tag);
      continue;
    }

    let nameEnd = pos + 1;
    while (nameEnd < length && /[A-Za-z0-9-]/.test(src[nameEnd])) nameEnd++;
    const tag = src.slice(pos + 1, nameEnd).toLowerCase();
    if (!tag) {
      appendText("<");
      pos += 1;
      continue;
    }

    const attrs: Record<string, string> = {};
    let cursor = nameEnd;
    let selfClosing = false;
    while (cursor < length) {
      while (cursor < length && /\s/.test(src[cursor])) cursor++;
      if (cursor >= length) break;
      const ch = src[cursor];
      if (ch === ">") {
        cursor++;
        break;
      }
      if (ch === "/" && src[cursor + 1] === ">") {
        selfClosing = true;
        cursor += 2;
        break;
      }
      if (ch === "/") {
        cursor++;
        continue;
      }
      const keyStart = cursor;
      while (cursor < length && !/[\s/>=]/.test(src[cursor])) cursor++;
      const key = src.slice(keyStart, cursor).toLowerCase();
      if (!key) {
        cursor++;
        continue;
      }
      while (cursor < length && /\s/.test(src[cursor])) cursor++;
      let value = "";
      if (src[cursor] === "=") {
        cursor++;
        while (cursor < length && /\s/.test(src[cursor])) cursor++;
        const quote = src[cursor];
        if (quote === '"' || quote === "'") {
          const valueStart = cursor + 1;
          const close = src.indexOf(quote, valueStart);
          const valueEnd = close === -1 ? length : close;
          value = decodeEntities(src.slice(valueStart, valueEnd));
          cursor = valueEnd + 1;
        } else {
          const valueStart = cursor;
          while (cursor < length && !/[\s>]/.test(src[cursor])) cursor++;
          value = decodeEntities(src.slice(valueStart, cursor));
        }
      }
      if (!(key in attrs)) attrs[key] = value;
    }
    pos = cursor;

    if (P_CLOSERS.has(tag) && tag !== "p") closeP();
    if (tag === "p") closeP();
    if (tag === "li") closeIfTop(new Set(["li"]));
    if (tag === "dt" || tag === "dd") closeIfTop(new Set(["dt", "dd"]));
    if (tag === "tr") closeIfTop(new Set(["tr"]));
    if (tag === "td" || tag === "th") {
      while (stack.length > 1 && ["td", "th"].includes(current().tag))
        stack.pop();
    }
    if (tag === "a") popMatching("a");

    const node: ElementNode = { kind: "element", tag, attrs, children: [] };
    current().children.push(node);
    if (VOID_TAGS.has(tag) || selfClosing) continue;
    if (RAW_TEXT_TAGS.has(tag)) {
      node.children.push({ kind: "text", value: readRawText(tag) });
      continue;
    }
    if (ESCAPABLE_RAW_TAGS.has(tag)) {
      node.children.push({
        kind: "text",
        value: decodeEntities(readRawText(tag)),
      });
      continue;
    }
    stack.push(node);
  }

  return root;
}

/* ------------------------------------------------------------------ */
/* tree utilities                                                      */
/* ------------------------------------------------------------------ */

function attr(node: ElementNode, name: string): string {
  return node.attrs[name] ?? "";
}

function identityText(node: ElementNode): string {
  return `${attr(node, "id")} ${attr(node, "class")} ${attr(node, "role")}`.toLowerCase();
}

function walkElements(
  node: ParsedNode,
  visit: (node: ElementNode, parents: ElementNode[]) => void,
  parents: ElementNode[] = [],
): void {
  if (node.kind === "text") return;
  visit(node, parents);
  for (const child of node.children)
    walkElements(child, visit, [...parents, node]);
}

function findFirst(
  root: ParsedNode,
  predicate: (node: ElementNode) => boolean,
): ElementNode | undefined {
  let found: ElementNode | undefined;
  walkElements(root, (node) => {
    if (!found && predicate(node)) found = node;
  });
  return found;
}

function textOf(node: ParsedNode): string {
  if (node.kind === "text") return node.value;
  return node.children.map(textOf).join("");
}

/* ------------------------------------------------------------------ */
/* junk / structural pruning                                           */
/* ------------------------------------------------------------------ */

const JUNK_RE =
  /(^|[^a-z0-9])(cookie|consent|gdpr|ccpa|newsletter|subscribe|sign-?up|signup|popup|pop-?up|modal|overlay|lightbox|paywall|premium|advert|banner|sponsor|promo|campaign|webinar|survey|age-?gate|app-?promo|download-?app|social|share|breadcrumb|skip-?link|skiplink|nav|navbar|menu|toolbar|sidebar|side-?bar|footer|comments?|replies|respond|related|recommended|read-?next|up-?next|more-|pagination|searchbox|search-form|locale|language-switcher|back-?to-?top|scroll-?top|sticky|fixed-|floating|cta|register|registration|login|signin|account|cart|basket|wishlist|terms|privacy|sitemap|site-?map|utility|disclaimer|toolbox|portlet|editlinks|edit-this|contributions|discussion|talkpage|userbox|navigation|masthead|lede-rail|topic-list|trending|most-popular|you-?tube|tiktok|instagram|facebook|twitter|linkedin|pinterest|reddit)([^a-z0-9]|$)/;

// Some JUNK_RE tokens are only positioning / generic labels that honest content
// containers carry for styling — a `sticky` rail, a closing `cta` band. They are
// an unreliable chrome signal, so a low-density block bearing ONLY these soft
// tokens is still treated as content. Every other token is "hard" chrome (a
// comment feed, a subscribe wall, a login gate, a cookie banner) and is always
// dropped unless it is the dominant text carrier.
const JUNK_HARD_RE =
  /(^|[^a-z0-9])(cookie|consent|gdpr|ccpa|newsletter|subscribe|sign-?up|signup|popup|pop-?up|modal|overlay|lightbox|paywall|premium|advert|banner|sponsor|campaign|webinar|survey|age-?gate|app-?promo|download-?app|social|share|breadcrumb|skip-?link|skiplink|nav|navbar|menu|toolbar|sidebar|side-?bar|footer|comments?|replies|respond|related|recommended|read-?next|up-?next|more-|pagination|searchbox|search-form|locale|language-switcher|back-?to-?top|scroll-?top|register|registration|login|signin|account|cart|basket|wishlist|terms|privacy|sitemap|site-?map|utility|disclaimer|toolbox|portlet|editlinks|edit-this|contributions|discussion|talkpage|userbox|navigation|masthead|lede-rail|topic-list|trending|most-popular|you-?tube|tiktok|instagram|facebook|twitter|linkedin|pinterest|reddit)([^a-z0-9]|$)/;

function junkIsSoftOnly(identity: string): boolean {
  return JUNK_RE.test(identity) && !JUNK_HARD_RE.test(identity);
}

const IGNORED_TAGS = new Set([
  "style",
  "script",
  "noscript",
  "template",
  "svg",
  "math",
  "canvas",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "video",
  "audio",
  "picture",
  "source",
  "track",
  "map",
  "area",
  "form",
  "input",
  "button",
  "select",
  "option",
  "optgroup",
  "textarea",
  "datalist",
  "label",
  "legend",
  "fieldset",
  "dialog",
  "search",
  "nav",
  "aside",
  "link",
  "meta",
  "title",
  "head",
  "slot",
  "portal",
  "noframes",
  "noembed",
  "base",
  "basefont",
  "blink",
  "marquee",
]);

const STRUCTURAL_DROP = new Set([...IGNORED_TAGS, "header", "footer"]);

function isJunkElement(node: ElementNode): boolean {
  return JUNK_RE.test(identityText(node));
}

function insideSemantic(parents: ElementNode[]): boolean {
  return parents.some(
    (parent) =>
      parent.tag === "article" ||
      parent.tag === "main" ||
      parent.tag === "section",
  );
}

function collectJsonLd(root: ParsedNode): string[] {
  const blocks: string[] = [];
  walkElements(root, (node) => {
    if (
      node.tag === "script" &&
      attr(node, "type").toLowerCase().includes("ld+json")
    ) {
      const text = textOf(node).trim();
      if (text) blocks.push(text);
    }
  });
  return blocks;
}

/* ------------------------------------------------------------------ */
/* main content extraction                                             */
/* ------------------------------------------------------------------ */

function visibleTextLength(node: ParsedNode): number {
  if (node.kind === "text") return node.value.replace(/\s+/g, "").length;
  if (STRUCTURAL_DROP.has(node.tag) || node.tag === "img") return 0;
  let total = 0;
  for (const child of node.children) total += visibleTextLength(child);
  return total;
}

function linkTextLength(node: ParsedNode): number {
  if (node.kind === "text") return 0;
  if (node.tag === "a") return visibleTextLength(node);
  if (STRUCTURAL_DROP.has(node.tag)) return 0;
  let total = 0;
  for (const child of node.children) total += linkTextLength(child);
  return total;
}

function countTags(node: ElementNode, tags: Set<string>): number {
  let total = 0;
  walkElements(node, (child) => {
    if (tags.has(child.tag)) total++;
  });
  return total;
}

function depthOf(target: ElementNode, node: ParsedNode, depth: number): number {
  if (node === target) return depth;
  if (node.kind === "text") return -1;
  for (const child of node.children) {
    const found = depthOf(target, child, depth + 1);
    if (found >= 0) return found;
  }
  return -1;
}

function scoreCandidate(node: ElementNode): number {
  if (STRUCTURAL_DROP.has(node.tag)) return 0;
  const text = visibleTextLength(node);
  if (text < 150) return 0;
  const linked = linkTextLength(node);
  const own = text - linked;
  const linkDensity = linked / Math.max(text, 1);
  const paragraphs = countTags(node, new Set(["p"]));
  const headings = countTags(
    node,
    new Set(["h1", "h2", "h3", "h4", "h5", "h6"]),
  );
  const listItems = countTags(node, new Set(["li"]));
  const rows = countTags(node, new Set(["tr"]));
  let score = Math.sqrt(own) * (1 - Math.min(0.9, linkDensity));
  score *= 1 + 0.35 * Math.log2(1 + paragraphs);
  score *= 1 + 0.25 * Math.log2(1 + headings);
  score *= 1 + 0.15 * Math.log2(1 + listItems);
  score *= 1 + 0.15 * Math.log2(1 + rows);
  const identity = identityText(node);
  if (
    /(^|[^a-z0-9])(article|post|entry|story|content|main|body|prose|markdown|documentation|guide|tutorial|recipe|instructions|method|description)([^a-z0-9]|$)/.test(
      identity,
    )
  )
    score *= 2;
  if (
    /(^|[^a-z0-9])(comment|footer|sidebar|nav|menu|related|promo|modal|popup|cookie|banner|teaser|masthead|breadcrumb|pagination|social|share)([^a-z0-9]|$)/.test(
      identity,
    )
  )
    score *= 0.1;
  if (node.tag === "article") score *= 2.2;
  if (node.tag === "main") score *= 2;
  const itemtype = node.attrs["itemtype"] ?? "";
  if (/Article|Posting|WebPage|Recipe|HowTo/.test(itemtype)) score *= 1.6;
  return score;
}

type MainContent = { main: ElementNode; spine: Set<ElementNode>; why: string };

function findMainContent(body: ElementNode): MainContent {
  const parents = new Map<ElementNode, ElementNode | null>();
  const candidates: Array<{ node: ElementNode; score: number }> = [];
  walkElements(body, (node, chain) => {
    parents.set(node, chain.length ? chain[chain.length - 1] : null);
    if (node === body) return;
    if (STRUCTURAL_DROP.has(node.tag)) return;
    if (chain.some((parent) => IGNORED_TAGS.has(parent.tag))) return;
    if (isJunkElement(node) && !insideSemantic(chain)) return;
    const score = scoreCandidate(node);
    if (score > 0) candidates.push({ node, score });
  });
  if (candidates.length === 0)
    return { main: body, spine: new Set([body]), why: "fallback:body" };
  candidates.sort((a, b) => b.score - a.score);
  const core = candidates[0].node;

  // Build a protected spine: the core plus its ancestor wrappers up to body,
  // growing upward while the next ancestor is still clearly "the same article".
  const spine = new Set<ElementNode>([core]);
  let current: ElementNode | undefined = core;
  while (current) {
    const parent: ElementNode | undefined = parents.get(current) ?? undefined;
    if (!parent || parent === body || IGNORED_TAGS.has(parent.tag)) break;
    if (visibleTextLength(parent) > visibleTextLength(core) * 2.5) break;
    spine.add(parent);
    current = parent;
  }
  const top = spine.has(body) ? body : [...spine][spine.size - 1];

  const depth = depthOf(core, body, 0);
  const bodyText = visibleTextLength(body);
  const topText = visibleTextLength(top);
  if (depth <= 1 && top !== body && bodyText > topText * 3 && bodyText > 2000)
    return {
      main: body,
      spine: new Set([body]),
      why: "fallback:body(shallow)",
    };
  const label =
    attr(top, "id") || attr(top, "class").trim().split(/\s+/)[0] || top.tag;
  return { main: top, spine, why: `auto:${top.tag}#${label}` };
}

/* ------------------------------------------------------------------ */
/* markdown rendering                                                  */
/* ------------------------------------------------------------------ */

const BLOCK_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "main",
  "menu",
  "nav",
  "ol",
  "output",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const CONTENT_BLOCK_TAGS = new Set(["p", "li"]);
const FORMAT_CHARS_RE = /[\u200b-\u200f\u2060\ufeff]/g;
const ITALIC_TAGS = new Set(["em", "i", "cite", "var", "dfn"]);
const BOLD_TAGS = new Set(["strong", "b"]);
const DELETE_TAGS = new Set(["del", "s", "strike"]);
const CODE_TAGS = new Set(["code", "kbd", "samp", "tt"]);

type InlinePiece =
  | { t: "text"; value: string }
  | { t: "code"; value: string }
  | { t: "link"; href: string; children: InlinePiece[] }
  | { t: "em"; children: InlinePiece[] }
  | { t: "strong"; children: InlinePiece[] }
  | { t: "del"; children: InlinePiece[] }
  | { t: "br" };

type RenderState = {
  blocks: MarkdownBlock[];
  buffer: InlinePiece[];
  pendingSpace: boolean;
  pre: { lines: string[]; lang: string } | null;
};

type MarkdownBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] }
  | { kind: "code"; lang: string; code: string }
  | { kind: "quote"; text: string }
  | { kind: "table"; header: string[]; rows: string[][] }
  | { kind: "rule" };

function freshState(): RenderState {
  return { blocks: [], buffer: [], pendingSpace: false, pre: null };
}

function cleanInline(text: string): string {
  return text
    .replace(FORMAT_CHARS_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function wrapInline(inner: string, marker: string): string {
  const pad = marker.length;
  const alreadyWrapped =
    inner.length > pad * 2 &&
    inner.startsWith(marker) &&
    inner.endsWith(marker) &&
    !inner.slice(pad, -pad).startsWith(marker) &&
    !inner.slice(pad, -pad).endsWith(marker);
  return alreadyWrapped ? inner : `${marker}${inner}${marker}`;
}

function renderPieces(pieces: InlinePiece[]): string {
  let out = "";
  for (const piece of pieces) {
    if (piece.t === "text") out += piece.value;
    else if (piece.t === "code") {
      const value = piece.value.replace(/\s+/g, " ").trim();
      if (value)
        out += value.includes("`") ? "`` " + value + " ``" : "`" + value + "`";
    } else if (piece.t === "br") out += "  \n";
    else if (piece.t === "em") {
      const inner = cleanInline(renderPieces(piece.children));
      if (inner) out += wrapInline(inner, "*");
    } else if (piece.t === "strong") {
      const inner = cleanInline(renderPieces(piece.children));
      if (inner) out += wrapInline(inner, "**");
    } else if (piece.t === "del") {
      const inner = cleanInline(renderPieces(piece.children));
      if (inner) out += wrapInline(inner, "~~");
    } else if (piece.t === "link") {
      const inner = cleanInline(renderPieces(piece.children)).replace(
        /[[\]]/g,
        "",
      );
      if (inner) out += `[${inner}](${piece.href})`;
    }
  }
  return out;
}

function mergePieces(pieces: InlinePiece[]): InlinePiece[] {
  const out: InlinePiece[] = [];
  for (const piece of pieces) {
    const last = out[out.length - 1];
    if (!last) {
      out.push(piece);
      continue;
    }
    if (last.t === "text" && piece.t === "text") last.value += piece.value;
    else if (
      last.t === "link" &&
      piece.t === "link" &&
      last.href === piece.href
    )
      last.children = mergePieces([...last.children, ...piece.children]);
    else if (last.t === "strong" && piece.t === "strong")
      last.children = mergePieces([...last.children, ...piece.children]);
    else if (last.t === "em" && piece.t === "em")
      last.children = mergePieces([...last.children, ...piece.children]);
    else out.push(piece);
  }
  return out;
}

const TRACKING_PARAMS = new Set([
  "fbclid",
  "gclid",
  "msclkid",
  "_ga",
  "ref",
  "ref_src",
  "mc_cid",
  "mc_eid",
  "srsltid",
  "igshid",
  "yclid",
  "twclid",
  "ttclid",
  "epik",
  "cmpid",
]);

function cleanHref(raw: string, baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(raw, baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const remove: string[] = [];
  url.searchParams.forEach((_value, key) => {
    const lower = key.toLowerCase();
    if (lower.startsWith("utm") || TRACKING_PARAMS.has(lower)) remove.push(key);
  });
  for (const key of remove) url.searchParams.delete(key);
  if (url.protocol === "https:" && url.port === "443") url.port = "";
  if (url.protocol === "http:" && url.port === "80") url.port = "";
  let out = url.toString();
  if (out.endsWith("?")) out = out.slice(0, -1);
  return out;
}

function isUsableHref(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith("#")) return false;
  return !/^(javascript|mailto|tel|data|blob|vbscript):/i.test(trimmed);
}

function detectCodeLang(node: ElementNode): string {
  const parts = [
    attr(node, "class"),
    attr(node, "data-language"),
    attr(node, "data-lang"),
  ];
  for (const child of node.children) {
    if (child.kind === "element")
      parts.push(
        attr(child, "class"),
        attr(child, "data-language"),
        attr(child, "data-lang"),
      );
  }
  const joined = parts.join(" ").toLowerCase();
  const match = joined.match(
    /(?:language|lang|brush|highlight)[-_:\s/]*([a-z0-9+#]{1,14})/,
  );
  const candidate = match?.[1] ?? "";
  const aliases: Record<string, string> = {
    sh: "bash",
    zsh: "bash",
    console: "bash",
    shell: "bash",
    shellsession: "bash",
    javascript: "js",
    typescript: "ts",
    python: "py",
    "c++": "cpp",
    "c#": "cs",
    golang: "go",
    markdown: "md",
    dockerfile: "docker",
    yml: "yaml",
    jsonc: "json",
    "objective-c": "objc",
    text: "text",
    plaintext: "text",
    raw: "text",
  };
  const known = new Set([
    "bash",
    "js",
    "ts",
    "tsx",
    "jsx",
    "py",
    "go",
    "rs",
    "java",
    "kt",
    "rb",
    "php",
    "sql",
    "html",
    "css",
    "scss",
    "json",
    "yaml",
    "toml",
    "xml",
    "md",
    "diff",
    "docker",
    "nginx",
    "http",
    "ini",
    "conf",
    "text",
    "c",
    "cpp",
    "cs",
    "swift",
    "lua",
    "pl",
    "r",
    "dart",
    "vue",
    "svelte",
    "ps1",
    "makefile",
    "graphql",
  ]);
  const mapped = aliases[candidate] ?? candidate;
  return known.has(mapped) ? mapped : "";
}

function codeFence(code: string): string {
  let longest = 0;
  for (const match of code.matchAll(/`+/g))
    longest = Math.max(longest, match[0].length);
  return "`".repeat(Math.max(3, longest + 1));
}

function dedupeHeader(cells: string[]): string[] {
  const seen = new Map<string, number>();
  return cells.map((cell, index) => {
    const key = cell.trim() || `col${index + 1}`;
    const count = (seen.get(key) ?? 0) + 1;
    seen.set(key, count);
    return count === 1 ? key : `${key}_${count}`;
  });
}

function normalizeCell(text: string): string {
  return cleanInline(text.replace(/\|/g, "\\|").replace(/\n+/g, " "));
}

class Renderer {
  baseUrl: string;
  droppedLinks = 0;
  private state: RenderState = freshState();
  private skip: Set<ElementNode> = new Set();

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl;
  }

  render(main: ElementNode, skip: Set<ElementNode>): MarkdownBlock[] {
    this.state = freshState();
    this.skip = skip;
    this.walk(main);
    this.closePre();
    this.flushParagraph();
    return this.state.blocks;
  }

  private pushText(value: string): void {
    const state = this.state;
    if (state.pre) {
      const lines = value.split("\n");
      const tail = state.pre.lines.length - 1;
      state.pre.lines[tail] += lines[0];
      for (let index = 1; index < lines.length; index++)
        state.pre.lines.push(lines[index]);
      return;
    }
    const collapsed = value.replace(/[ \t\r\n\f]+/g, " ");
    if (!collapsed.trim()) {
      if (state.buffer.length > 0) state.pendingSpace = true;
      return;
    }
    if (/^\s/.test(value) && state.buffer.length > 0) state.pendingSpace = true;
    if (/\s$/.test(value)) state.pendingSpace = true;
    else state.pendingSpace = false;
    state.buffer.push({ t: "text", value: collapsed });
  }

  private pushPiece(piece: InlinePiece): void {
    const state = this.state;
    if (state.buffer.length > 0 && state.pendingSpace)
      state.buffer.push({ t: "text", value: " " });
    state.pendingSpace = false;
    state.buffer.push(piece);
  }

  private flushParagraph(): void {
    const state = this.state;
    if (state.buffer.length > 0 && state.pendingSpace)
      state.buffer.push({ t: "text", value: " " });
    const text = cleanInline(renderPieces(mergePieces(state.buffer)));
    state.buffer = [];
    state.pendingSpace = false;
    if (text) state.blocks.push({ kind: "paragraph", text });
  }

  private addBlock(block: MarkdownBlock): void {
    this.flushParagraph();
    this.state.blocks.push(block);
  }

  private openPre(node: ElementNode): void {
    this.flushParagraph();
    const codeChild = node.children.find(
      (child): child is ElementNode =>
        child.kind === "element" && child.tag === "code",
    );
    this.state.pre = {
      lines: [""],
      lang: detectCodeLang(codeChild ?? node) || detectCodeLang(node),
    };
    this.walkChildren(node);
    this.closePre();
  }

  private closePre(): void {
    const state = this.state;
    if (!state.pre) return;
    const raw = state.pre.lines.join("\n").replace(/^\n+|\n+$/g, "");
    const lang = state.pre.lang;
    state.pre = null;
    if (!raw.trim()) return;
    const indents = raw
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => line.length - line.trimStart().length);
    const common = indents.length ? Math.min(...indents) : 0;
    const code =
      common > 0
        ? raw
            .split("\n")
            .map((line) => line.slice(common))
            .join("\n")
        : raw;
    state.blocks.push({ kind: "code", lang, code });
  }

  private walk(node: ParsedNode): void {
    if (node.kind === "text") {
      this.pushText(node.value);
      return;
    }
    if (this.skip.has(node)) return;
    const tag = node.tag;
    if (IGNORED_TAGS.has(tag)) return;
    if (tag === "img" || tag === "image" || tag === "wbr") return;

    if (this.state.pre) {
      if (
        ["code", "span", "font", "a", "b", "i", "strong", "em"].includes(tag)
      ) {
        if (tag === "a" && !isUsableHref(attr(node, "href")))
          this.droppedLinks++;
        this.walkChildren(node);
        return;
      }
      if (tag === "br") {
        this.state.pre.lines[this.state.pre.lines.length - 1] += "\n";
        return;
      }
      this.closePre();
    }

    switch (tag) {
      case "pre":
        this.openPre(node);
        return;
      case "hr":
        this.addBlock({ kind: "rule" });
        return;
      case "br":
        this.pushPiece({ t: "br" });
        return;
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        this.addBlock({
          kind: "heading",
          level: Number(tag[1]),
          text: cleanInline(
            renderPieces(mergePieces(this.collectInline(node))),
          ).replace(/\n+/g, " "),
        });
        return;
      }
      case "p":
        this.flushParagraph();
        this.walkChildren(node);
        this.flushParagraph();
        return;
      case "ul":
      case "ol":
        this.emitList(node, tag === "ol");
        return;
      case "dl":
        this.emitDefinitionList(node);
        return;
      case "table":
        this.emitTable(node);
        return;
      case "blockquote":
        this.emitQuote(node);
        return;
      case "a":
        this.emitLink(node);
        return;
      case "code":
      case "kbd":
      case "samp":
      case "tt": {
        const text = textOf(node).trim();
        if (text) this.pushPiece({ t: "code", value: text });
        return;
      }
      case "strong":
      case "b":
        this.pushPiece({ t: "strong", children: this.collectInline(node) });
        return;
      case "em":
      case "i":
      case "cite":
      case "var":
      case "dfn":
        this.pushPiece({ t: "em", children: this.collectInline(node) });
        return;
      case "del":
      case "s":
      case "strike":
        this.pushPiece({ t: "del", children: this.collectInline(node) });
        return;
      default: {
        if (BLOCK_TAGS.has(tag)) {
          this.flushParagraph();
          this.walkChildren(node);
          this.flushParagraph();
          return;
        }
        this.walkChildren(node);
        return;
      }
    }
  }

  private walkChildren(node: ElementNode): void {
    for (const child of node.children) this.walk(child);
  }

  private collectInline(node: ParsedNode): InlinePiece[] {
    if (node.kind === "text")
      return [{ t: "text", value: node.value.replace(/[ \t\r\n\f]+/g, " ") }];
    const tag = node.tag;
    if (
      this.skip.has(node) ||
      IGNORED_TAGS.has(tag) ||
      tag === "img" ||
      tag === "image"
    )
      return [];
    if (tag === "br") return [{ t: "br" }];
    if (CODE_TAGS.has(tag)) {
      const text = textOf(node).trim();
      return text ? [{ t: "code", value: text }] : [];
    }
    if (tag === "a") {
      const children = this.collectInlineChildren(node);
      const raw = attr(node, "href");
      if (isUsableHref(raw)) {
        const href = cleanHref(raw, this.baseUrl);
        if (href) return [{ t: "link", href, children }];
      }
      this.droppedLinks++;
      return children;
    }
    const children = this.collectInlineChildren(node);
    if (BOLD_TAGS.has(tag)) return [{ t: "strong", children }];
    if (ITALIC_TAGS.has(tag)) return [{ t: "em", children }];
    if (DELETE_TAGS.has(tag)) return [{ t: "del", children }];
    return children;
  }

  private collectInlineChildren(node: ElementNode): InlinePiece[] {
    const pieces: InlinePiece[] = [];
    for (const child of node.children)
      pieces.push(...this.collectInline(child));
    return mergePieces(pieces);
  }

  private emitLink(node: ElementNode): void {
    const children = this.collectInlineChildren(node);
    const text = cleanInline(renderPieces(children));
    const raw = attr(node, "href");
    const href = isUsableHref(raw) ? cleanHref(raw, this.baseUrl) : null;
    if (!href) {
      this.droppedLinks++;
      if (text) this.pushPiece({ t: "text", value: text });
      return;
    }
    if (!text) return;
    this.pushPiece({ t: "link", href, children });
  }

  private renderSubtree(node: ElementNode): MarkdownBlock[] {
    const saved = this.state;
    this.state = freshState();
    for (const child of node.children) this.walk(child);
    this.closePre();
    this.flushParagraph();
    const blocks = this.state.blocks;
    this.state = saved;
    return blocks;
  }

  private emitList(node: ElementNode, ordered: boolean): void {
    this.flushParagraph();
    const items = node.children.filter(
      (child): child is ElementNode =>
        child.kind === "element" && child.tag === "li",
    );
    if (items.length === 0) {
      const fallback = node.children.filter(
        (child): child is ElementNode =>
          child.kind === "element" &&
          !IGNORED_TAGS.has(child.tag) &&
          !this.skip.has(child),
      );
      if (fallback.length >= 2) {
        this.emitItems(
          ordered,
          fallback.map((item) =>
            this.blocksToItemText(this.renderSubtree(item)),
          ),
        );
        return;
      }
      this.walkChildren(node);
      return;
    }
    this.emitItems(
      ordered,
      items.map((item) => this.blocksToItemText(this.renderSubtree(item))),
    );
  }

  private emitItems(ordered: boolean, texts: string[]): void {
    const items = texts
      .filter((text) => !emptyRendered(text))
      .map((text) => text.replace(/\n/g, "\n    "));
    if (items.length) this.state.blocks.push({ kind: "list", ordered, items });
  }

  private blocksToItemText(blocks: MarkdownBlock[]): string {
    const lines: string[] = [];
    for (const block of blocks) {
      if (block.kind === "paragraph") {
        lines.push(lines.length ? `\n${block.text}` : block.text);
      } else if (block.kind === "list") {
        for (const [index, item] of block.items.entries())
          lines.push(`\n    ${block.ordered ? `${index + 1}.` : "-"} ${item}`);
      } else if (block.kind === "code") {
        const fence = codeFence(block.code);
        lines.push(
          `\n\n    ${fence}${block.lang}\n${block.code
            .split("\n")
            .map((l) => `    ${l}`)
            .join("\n")}\n    ${fence}`,
        );
      } else {
        const rendered = blocksToMarkdown([block]);
        if (rendered) lines.push(`\n${rendered}`);
      }
    }
    return lines.join("").trim();
  }

  private emitDefinitionList(node: ElementNode): void {
    this.flushParagraph();
    const items: string[] = [];
    let pendingTerm = "";
    for (const child of node.children) {
      if (child.kind !== "element" || IGNORED_TAGS.has(child.tag)) continue;
      const text = cleanInline(
        renderPieces(mergePieces(this.collectInline(child))),
      );
      if (!text) continue;
      if (child.tag === "dt") {
        if (pendingTerm) items.push(pendingTerm);
        pendingTerm = `**${text}**`;
      } else if (child.tag === "dd") {
        items.push(pendingTerm ? `${pendingTerm}\n    ${text}` : text);
        pendingTerm = "";
      }
    }
    if (pendingTerm) items.push(pendingTerm);
    if (items.length)
      this.state.blocks.push({ kind: "list", ordered: false, items });
  }

  private emitQuote(node: ElementNode): void {
    this.flushParagraph();
    const blocks = this.renderSubtree(node);
    const text = blocksToMarkdown(blocks).trim();
    if (text) this.state.blocks.push({ kind: "quote", text });
  }

  private emitTable(node: ElementNode): void {
    this.flushParagraph();
    let headerCells: string[] | null = null;
    const rows: string[][] = [];
    let caption = "";
    const readRow = (row: ElementNode, inHead: boolean) => {
      const cells = row.children.filter(
        (child): child is ElementNode =>
          child.kind === "element" &&
          (child.tag === "td" || child.tag === "th"),
      );
      if (cells.length === 0) return;
      const texts = cells.map((cell) =>
        normalizeCell(
          cleanInline(renderPieces(mergePieces(this.collectInline(cell)))),
        ),
      );
      if (inHead && headerCells === null) headerCells = texts;
      else rows.push(texts);
    };
    const visitRowParent = (child: ElementNode) => {
      for (const row of child.children)
        if (row.kind === "element" && row.tag === "tr")
          readRow(row, child.tag === "thead");
    };
    for (const child of node.children) {
      if (child.kind !== "element") continue;
      if (child.tag === "caption")
        caption = cleanInline(
          renderPieces(mergePieces(this.collectInline(child))),
        );
      else if (child.tag === "tr") readRow(child, false);
      else if (
        child.tag === "thead" ||
        child.tag === "tbody" ||
        child.tag === "tfoot"
      )
        visitRowParent(child);
      else if (child.tag === "colgroup") continue;
    }
    if (headerCells === null && rows.length > 0) {
      const widest = Math.max(...rows.map((row) => row.length));
      const first = rows[0];
      if (first.length >= Math.max(1, widest - 1)) {
        headerCells = first;
        rows.shift();
      } else {
        headerCells = Array.from(
          { length: widest },
          (_u, index) => `col${index + 1}`,
        );
      }
    }
    if (headerCells === null) return;
    let header = dedupeHeader(headerCells);
    const columnCount = header.length;
    const normalizedRows = rows
      .filter((row) => row.some((cell) => cell.length > 0) || row.length === 0)
      .map((row) => {
        const fixed = row.slice(0, columnCount);
        while (fixed.length < columnCount) fixed.push("");
        return fixed;
      });
    if (normalizedRows.length === 0 && !header.some((cell) => cell)) return;
    if (caption)
      this.state.blocks.push({ kind: "paragraph", text: `**${caption}**` });
    this.state.blocks.push({ kind: "table", header, rows: normalizedRows });
  }
}

function emptyRendered(text: string): boolean {
  return text.replace(FORMAT_CHARS_RE, "").trim() === "";
}

function blocksToMarkdown(blocks: MarkdownBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.kind === "heading") {
      if (!emptyRendered(block.text))
        parts.push(`${"#".repeat(block.level)} ${block.text}`);
    } else if (block.kind === "paragraph") {
      if (!emptyRendered(block.text)) parts.push(block.text);
    } else if (block.kind === "rule") parts.push("---");
    else if (block.kind === "list") {
      const items = block.items.filter((item) => !emptyRendered(item));
      if (items.length)
        parts.push(
          items
            .map((item, index) =>
              block.ordered ? `${index + 1}. ${item}` : `- ${item}`,
            )
            .join("\n"),
        );
    } else if (block.kind === "code") {
      const fence = codeFence(block.code);
      parts.push(`${fence}${block.lang}\n${block.code}\n${fence}`);
    } else if (block.kind === "quote") {
      parts.push(
        block.text
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n"),
      );
    } else if (block.kind === "table") {
      const widths = block.header.map((cell, index) =>
        Math.max(
          cell.length,
          ...block.rows.map((row) => (row[index] ?? "").length),
          3,
        ),
      );
      const line = (cells: string[]) =>
        `| ${cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join(" | ")} |`;
      const divider = `| ${widths.map((width) => "-".repeat(Math.max(3, width))).join(" | ")} |`;
      parts.push(
        [line(block.header), divider, ...block.rows.map(line)].join("\n"),
      );
    }
  }
  return parts.join("\n\n");
}

/* ------------------------------------------------------------------ */
/* JSON-LD pruning                                                     */
/* ------------------------------------------------------------------ */

const USEFUL_TYPES = new Set([
  "article",
  "blogposting",
  "newsarticle",
  "techarticle",
  "reportagearticle",
  "scholarlyarticle",
  "medicalarticle",
  "question",
  "answer",
  "faqpage",
  "howto",
  "recipe",
  "product",
  "service",
  "webpage",
  "imageobject",
  "person",
  "organization",
  "review",
  "aggregaterating",
  "rating",
  "videoobject",
  "audioobject",
  "breadcrumblist",
  "listitem",
  "definedterm",
  "definition",
  "quotation",
  "creativework",
  "book",
  "softwareapplication",
  "webapplication",
  "jobposting",
  "event",
  "medicalcondition",
  "clinicaltrial",
  "dataset",
  "lecture",
  "acquisitionoffering",
  "educationaloccupationalcredential",
]);

const DROP_KEYS = new Set([
  "@context",
  "@id",
  "image",
  "thumbnail",
  "thumbnailurl",
  "logo",
  "url",
  "mainentityofpage",
  "sameas",
  "inlanguage",
  "date modified",
  "ispartof",
  "haspart",
  "potentialaction",
  "target",
  "entrypoint",
  "additionaltype",
  "profilepage",
  "paymentaccepted",
  "availabledeliverymethod",
  "areaserved",
  "servicearea",
  "currenciesaccepted",
  "hoursaccepted",
  "publishingprinciples",
  "ethicspolicy",
  "parentorganization",
  "suborganization",
  "department",
  "employee",
  "member",
  "attendee",
  "sponsor",
  "funder",
  "contentlocation",
  "illustration",
  "annotator",
  "highlight",
  "encoding",
  "encodedvideourl",
  "embedurl",
  "contenturl",
  "downloadurl",
  "browserrequirements",
  "interactioncount",
  "userinteractioncount",
  "accessmode",
  "accessibilityfeature",
  "accessibilityapi",
  "accessibilitycontrol",
  "accesscode",
  "relatedlink",
  "lastreviewed",
  "reviewedby",
  "copyrightyear",
  "copyrightholder",
  "license",
  "maintainer",
  "endorsee",
  "endorser",
  "temporalcoverage",
  "spatialcoverage",
  "measureunit",
  "valueaddedtax",
  "pricevaliduntil",
  "availabilitystarts",
  "ships_to",
  "acceptedoffer",
  "addinteractioncount",
  "aggregatevote",
]);

function typeNamesOf(node: any): string[] {
  const value = node?.["@type"];
  if (typeof value === "string") return [value.toLowerCase()];
  if (Array.isArray(value))
    return value
      .filter((item) => typeof item === "string")
      .map((item: string) => item.toLowerCase());
  return [];
}

function normalizeJsonLd(parsed: unknown): unknown[] {
  const out: unknown[] = [];
  const seen = new Set<any>();
  const visit = (node: any) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (Array.isArray(node["@graph"])) {
      for (const child of node["@graph"]) visit(child);
      return;
    }
    const cleaned = pruneLd(node, new Set());
    if (cleaned) out.push(cleaned);
  };
  visit(parsed);
  return out;
}

function pruneLd(node: any, seen: Set<any>): any {
  if (!node || typeof node !== "object" || seen.has(node)) return null;
  seen.add(node);
  if (Array.isArray(node)) {
    const items = node.map((child) => pruneLd(child, seen)).filter(Boolean);
    return items.length ? items : null;
  }
  if (typeof node["@value"] !== "undefined" && Object.keys(node).length <= 3) {
    const value = node["@value"];
    return typeof value === "string" || typeof value === "number"
      ? value
      : null;
  }
  const types = typeNamesOf(node);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === "@type") {
      out["@type"] = node["@type"];
      continue;
    }
    const lowerKey = key.toLowerCase();
    if (DROP_KEYS.has(lowerKey) || lowerKey.startsWith("@")) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "string") {
      const trimmed = decodeEntities(value.trim());
      if (!trimmed || /^(https?|data):/i.test(trimmed)) continue;
      out[key] = trimmed.length > 300 ? trimmed.slice(0, 300) + "…" : trimmed;
    } else if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    } else if (Array.isArray(value)) {
      const items = value
        .map((child) => {
          if (typeof child === "string") {
            const trimmed = decodeEntities(child.trim());
            if (!trimmed || /^(https?|data):/i.test(trimmed)) return null;
            return trimmed.length > 300 ? trimmed.slice(0, 300) + "…" : trimmed;
          }
          if (typeof child === "number" || typeof child === "boolean")
            return child;
          return child ? pruneLd(child, seen) : null;
        })
        .filter(
          (child) => child !== null && child !== undefined && child !== "",
        );
      if (items.length) out[key] = items;
    } else if (typeof value === "object") {
      const nested = pruneLd(value, seen);
      if (nested) out[key] = nested;
    }
  }
  const kept = Object.keys(out).filter((key) => key !== "@type");
  const useful = types.some((type) => USEFUL_TYPES.has(type));
  if (!useful && kept.length < 2) return null;
  if (kept.length === 0) return null;
  if (!useful) out["@type"] = node["@type"] ?? "thing";
  return out;
}

/* ------------------------------------------------------------------ */
/* meta extraction                                                     */
/* ------------------------------------------------------------------ */

function metaContent(root: ParsedNode, keys: Array<[string, string]>): string {
  let best = "";
  walkElements(root, (node) => {
    if (best || node.tag !== "meta") return;
    for (const [attrName, wanted] of keys) {
      const actual = attr(node, attrName).toLowerCase();
      if (actual === wanted) {
        const content = (
          node.attrs["content"] ??
          node.attrs["value"] ??
          ""
        ).trim();
        if (content) best = content;
      }
    }
  });
  return best;
}

/* ------------------------------------------------------------------ */
/* truncation with goal bias                                           */
/* ------------------------------------------------------------------ */

function goalTokens(goal: string): string[] {
  return goal
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((token) => token.length >= 3);
}

function cutAtBoundary(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const window = text.slice(0, limit + 1);
  let cut = window.lastIndexOf("\n\n");
  if (cut < limit * 0.5) cut = window.lastIndexOf("\n");
  if (cut < limit * 0.5)
    cut = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\n"));
  if (cut <= 0) cut = limit;
  return text.slice(0, cut).trimEnd();
}

function applyTruncation(
  blocks: MarkdownBlock[],
  fullMarkdown: string,
  goal?: string,
): { markdown: string; truncated: boolean } {
  if (fullMarkdown.length <= MAX_OUTPUT_CHARS)
    return { markdown: fullMarkdown, truncated: false };
  const tokens = goal ? goalTokens(goal) : [];
  const tailBudget =
    tokens.length > 0 && blocks.length > 0 ? GOAL_TAIL_BUDGET : 0;
  const top = cutAtBoundary(
    fullMarkdown,
    MAX_OUTPUT_CHARS - 60 - (tailBudget ? tailBudget + 120 : 0),
  );
  const marker = "[…truncated — full text archived, see notes…]";
  if (tokens.length === 0 || tailBudget === 0)
    return { markdown: `${top}\n\n${marker}`, truncated: true };

  let tail = "";
  for (const block of blocks) {
    const rendered = blocksToMarkdown([block]);
    if (rendered.length < 3) continue;
    const position = fullMarkdown.indexOf(rendered);
    if (position >= 0 && position < top.length) continue;
    const lower = rendered.toLowerCase();
    if (!tokens.some((token) => lower.includes(token))) continue;
    const candidate = tail ? `${tail}\n\n${rendered}` : rendered;
    if (candidate.length > GOAL_TAIL_BUDGET) continue;
    tail = candidate;
  }
  if (tail)
    return {
      markdown: `${top}\n\n… goal-relevant excerpt from further down …\n\n${tail}\n\n${marker}`,
      truncated: true,
    };
  return { markdown: `${top}\n\n${marker}`, truncated: true };
}

/* ------------------------------------------------------------------ */
/* conversion pipeline (pure)                                          */
/* ------------------------------------------------------------------ */

type ConvertOptions = { baseUrl: string; goal?: string };

type ConvertResult = {
  title: string;
  description: string;
  schema: unknown[];
  full_markdown: string;
  markdown: string;
  truncated: boolean;
  notes: string[];
};

function convert(html: string, options: ConvertOptions): ConvertResult {
  const notes: string[] = [];
  const doc = parseHtml(html);
  const body =
    findFirst(doc, (node) => node.tag === "body") ??
    ({
      kind: "element",
      tag: "body",
      attrs: {},
      children: doc.children,
    } as ElementNode);

  const schema: unknown[] = [];
  let ldFailures = 0;
  for (const block of collectJsonLd(doc)) {
    try {
      for (const node of normalizeJsonLd(JSON.parse(block))) schema.push(node);
    } catch {
      ldFailures++;
    }
  }
  if (ldFailures > 0)
    notes.push(`${ldFailures} JSON-LD block(s) were malformed and skipped.`);

  const titleTag = findFirst(doc, (node) => node.tag === "title");
  let title = titleTag ? cleanInline(decodeEntities(textOf(titleTag))) : "";
  let description =
    metaContent(doc, [["name", "description"]]) ||
    metaContent(doc, [
      ["property", "og:description"],
      ["name", "og:description"],
      ["name", "twitter:description"],
      ["property", "twitter:description"],
    ]);
  if (!title)
    title =
      metaContent(doc, [
        ["property", "og:title"],
        ["name", "og:title"],
        ["name", "twitter:title"],
      ]) || "";
  else {
    const ogTitle = metaContent(doc, [
      ["property", "og:title"],
      ["name", "og:title"],
    ]);
    if (title.length <= 10 && ogTitle.length > title.length + 8)
      title = ogTitle;
  }
  if (!title) {
    const h1 = findFirst(body, (node) => HEADINGS.has(node.tag));
    if (h1) title = cleanInline(textOf(h1));
  }
  if (!description) {
    const fromSchema = schema
      .flatMap((node) => (Array.isArray(node) ? node : [node]))
      .map((node: any) =>
        typeof node?.description === "string" ? node.description : "",
      )
      .find((text: string) => text.length > 20);
    if (fromSchema) description = fromSchema;
  }
  title = decodeEntities(title).slice(0, 300);
  description = decodeEntities(description).slice(0, 500);

  const { main, spine, why: extractWhy } = findMainContent(body);
  let why = extractWhy;
  const skip = new Set<ElementNode>();
  const mainText = visibleTextLength(main);
  const dominant = (node: ElementNode): boolean =>
    visibleTextLength(node) > mainText * 0.5;
  // A real, readable block: enough own (non-link) text, low link density, and
  // at least one heading / paragraph / list item. Used to rescue genuine
  // content from an over-eager junk-class label.
  const contentCarrier = (node: ElementNode): boolean => {
    const text = visibleTextLength(node);
    if (text < 120) return false;
    const density = linkTextLength(node) / Math.max(text, 1);
    if (density > 0.45) return false;
    return countTags(node, HEADINGS) + countTags(node, CONTENT_BLOCK_TAGS) > 0;
  };
  walkElements(main, (node) => {
    if (node === main || spine.has(node)) return;
    if (IGNORED_TAGS.has(node.tag) || STRUCTURAL_DROP.has(node.tag)) {
      // keep an <article>/<main>/<header> wrapper if it holds the whole text
      if (dominant(node)) return;
      skip.add(node);
      return;
    }
    // A junk-looking class is dropped unless the node is the dominant carrier or
    // is a low-density content block whose junk label is merely a soft
    // positioning word (sticky/cta). Multi-section pages split their body across
    // sibling <section>s so no single block is "dominant"; this keeps them.
    if (isJunkElement(node) && !dominant(node)) {
      const rescued =
        contentCarrier(node) && junkIsSoftOnly(identityText(node));
      if (!rescued) skip.add(node);
    }
  });

  const renderer = new Renderer(options.baseUrl);
  let blocks = renderer.render(main, skip);
  blocks = dedupeBlocks(blocks);
  blocks = pruneLeadingLinkBlocks(blocks);
  if (renderer.droppedLinks > 30)
    notes.push(
      `${renderer.droppedLinks} unusable links (javascript/anchor-only/invalid) were unwrapped to plain text.`,
    );

  let fullMarkdown = blocksToMarkdown(blocks)
    .replace(/[ \t]+$/gm, "")
    .replace(/\u00a0/g, " ")
    .replace(FORMAT_CHARS_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (html.includes("self.__next_f.push")) {
    const flight = cleanRawMarkdown(extractNextFlight(html), options.baseUrl);
    if (flight.length > fullMarkdown.length + 1500 && flight.length > 700) {
      fullMarkdown = flight;
      blocks = markdownToSegments(flight);
      why = "next-rsc-stream";
      notes.push(
        "DOM body was a client-rendered shell; article text recovered from the page's embedded Next.js RSC stream.",
      );
    }
  }

  fullMarkdown = fullMarkdown.replace(FORMAT_CHARS_RE, "");

  const challenge =
    /(cookies must be enabled|enable cookies .* reload|_\/pow\/|\/_pow\/solve|proof of (work|access))/i.test(
      html,
    );
  if (fullMarkdown.length < 40) {
    if (challenge)
      notes.push(
        "The site served a JavaScript cookie/proof-of-work challenge instead of content (Zyte fetched without executing JS), so no article text could be extracted. Do not retry this URL expecting more.",
      );
    else
      notes.push("No readable main content could be extracted from this page.");
    if (!fullMarkdown) fullMarkdown = "(no readable text content extracted)";
  }

  const { markdown, truncated } = applyTruncation(
    blocks,
    fullMarkdown,
    options.goal,
  );
  if (truncated)
    notes.push(
      `Inline markdown truncated to ${MAX_OUTPUT_CHARS} chars of ${fullMarkdown.length} (extraction: ${why}).`,
    );
  else if (why.startsWith("fallback") || why === "next-rsc-stream")
    notes.push(`Extraction: ${why}.`);

  return {
    title,
    description,
    schema,
    full_markdown: fullMarkdown,
    markdown,
    truncated,
    notes,
  };
}

function dedupeBlocks(blocks: MarkdownBlock[]): MarkdownBlock[] {
  const out: MarkdownBlock[] = [];
  const seen = new Set<string>();
  for (const block of blocks) {
    const key = blocksToMarkdown([block]);
    if (key.length > 12 && key.length < 500) {
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(block);
  }
  return out;
}

// Split raw markdown (e.g. an RSC flight chunk) into blank-line-separated
// segments while keeping fenced code blocks intact, so goal-biased truncation
// can still select later sections by keyword.
function markdownToSegments(markdown: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let current: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = current.join("\n").trim();
    current = [];
    if (text) blocks.push({ kind: "paragraph", text });
  };
  for (const line of markdown.split("\n")) {
    if (/^(`{3,}|~{3,})/.test(line.trim())) inFence = !inFence;
    if (!inFence && line.trim() === "") {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();
  return blocks;
}

function linkDensity(text: string): number {
  const noCode = text.replace(/`[^`]*`/g, "");
  let linkChars = 0;
  const visible = noCode.replace(
    /\[([^\]]*)\]\([^)]*\)/g,
    (_whole, label: string) => {
      linkChars += label.replace(/\s/g, "").length;
      return label;
    },
  );
  const visibleChars = visible.replace(/\s/g, "").length;
  return visibleChars === 0 ? 0 : linkChars / visibleChars;
}

// Leading link-dense paragraphs/lists are usually site nav / topic hubs.
// Only prune a *run* (>=2 blocks) or a multi-item link list, and never when it
// would gut the page (docs indexes are legitimately mostly links).
function visibleLength(text: string): number {
  return text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s/g, "").length;
}

function pruneLeadingLinkBlocks(blocks: MarkdownBlock[]): MarkdownBlock[] {
  const isLinkBlock = (block: MarkdownBlock): boolean => {
    if (block.kind !== "paragraph" && block.kind !== "list") return false;
    const rendered = blocksToMarkdown([block]);
    const visible = visibleLength(rendered);
    if (visible > 220 || visible < 3 || linkDensity(rendered) < 0.65)
      return false;
    if (block.kind === "list") return block.items.length >= 3;
    return true;
  };
  let cut = 0;
  let cutChars = 0;
  for (const block of blocks) {
    if (!isLinkBlock(block)) break;
    cut++;
    cutChars += visibleLength(blocksToMarkdown([block]));
  }
  if (cut < 2) {
    const only = blocks[0];
    const isBigLinkList =
      only &&
      only.kind === "list" &&
      only.items.length >= 4 &&
      linkDensity(blocksToMarkdown([only])) > 0.75;
    if (!isBigLinkList) return blocks;
  }
  const total = blocks.reduce(
    (sum, block) => sum + visibleLength(blocksToMarkdown([block])),
    0,
  );
  if (cutChars > total * 0.5) return blocks;
  return blocks.slice(cut);
}

/* ------------------------------------------------------------------ */
/* Next.js RSC flight-stream fallback (client-rendered shells)         */
/* ------------------------------------------------------------------ */

function extractNextFlight(html: string): string {
  const pushRe =
    /self\.__next_f\.push\(\s*\[1\s*,\s*("(?:[^"\\]|\\.)*")\s*\]\s*\)/g;
  let stream = "";
  for (const match of html.matchAll(pushRe)) {
    try {
      stream += JSON.parse(match[1]) as string;
    } catch {}
  }
  if (!stream) return "";
  const chunks: string[] = [];
  const chunkRe = /:T([0-9a-f]+),/g;
  let match: RegExpExecArray | null;
  while ((match = chunkRe.exec(stream))) {
    const byteLength = parseInt(match[1], 16);
    if (!Number.isFinite(byteLength) || byteLength <= 0) continue;
    const start = match.index + match[0].length;
    let bytes = 0;
    let cursor = start;
    for (const char of stream.slice(start)) {
      const width = Buffer.byteLength(char, "utf8");
      if (bytes + width > byteLength) break;
      bytes += width;
      cursor += char.length;
      if (bytes >= byteLength) break;
    }
    const text = stream.slice(start, cursor).trim();
    if (text.length > 300 && !isJsonLdChunk(text)) chunks.push(text);
    chunkRe.lastIndex =
      cursor > match.index + match[0].length ? cursor : start + 1;
  }
  return chunks.join("\n\n");
}

// A Next.js RSC stream embeds every <script type="application/ld+json"> block
// as a text chunk. Those belong ONLY in the `schema` field and must never leak
// into `markdown`, so JSON-LD payloads are dropped during flight extraction.
function isJsonLdChunk(text: string): boolean {
  const head = text.charCodeAt(0);
  if (head !== 123 && head !== 91) return false; // not '{' or '['
  return text.includes('"@context"') || text.includes('"@type"');
}

function cleanRawMarkdown(text: string, baseUrl: string): string {
  let out = text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/```\\[ns]*```/g, "```")
    .replace(/\\([`~])/g, "$1");
  out = out.replace(
    /\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g,
    (_whole, label: string, href: string) => {
      const cleaned = isUsableHref(href) ? cleanHref(href, baseUrl) : null;
      return cleaned ? `[${label}](${cleaned})` : label;
    },
  );
  return out
    .replace(/[ \t]+$/gm, "")
    .replace(/\u00a0/g, " ")
    .replace(FORMAT_CHARS_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ------------------------------------------------------------------ */
/* history (rule §6, adapted for per-call billing)                     */
/* ------------------------------------------------------------------ */

type HistoryRecord = {
  id: string;
  timestamp: string;
  tool_version: number;
  session_id: string;
  message_id: string;
  agent: string;
  directory: string;
  request: { url: string; goal?: string };
  http_status: number | null;
  status: string;
  error: string | null;
  html_bytes: number | null;
  markdown_chars: number | null;
  normalized: {
    meta: Record<string, unknown>;
    schema: unknown[];
    full_markdown: string;
  };
  raw_http_headers?: { content_type?: string; content_length?: string };
};

type LedgerEntry = {
  timestamp: string;
  url: string;
  status: string;
  http_status: number | null;
  markdown_chars: number | null;
};

function historyConfig(
  options: Readonly<Record<string, any>>,
  locationDirectory: string,
): { enabled: boolean; dir: string } {
  const flag = process.env.WEBFETCHMD_HISTORY?.trim().toLowerCase();
  const enabled =
    !(flag === "0" || flag === "false" || flag === "off" || flag === "no") &&
    options.history !== false;

  const configured =
    (typeof options.historyPath === "string" && options.historyPath.trim()) ||
    process.env.WEBFETCHMD_HISTORY_PATH?.trim();

  const dir = configured
    ? isAbsolute(configured)
      ? configured
      : resolve(locationDirectory, configured)
    : join(
        process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local", "share"),
        "opencode",
        "plugin-data",
        "webfetchmd",
      );

  return { enabled, dir };
}

function localDateStamp(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function writeHistory(record: HistoryRecord, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${localDateStamp(new Date())}.jsonl`);
  await appendFile(file, jsonString(record) + "\n", "utf8");
}

async function updateLedger(entry: LedgerEntry, dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const file = join(dir, "fetch-log.json");

  let log: {
    total_fetches: number;
    total_ok: number;
    total_error: number;
    updated_at: string;
    entries: LedgerEntry[];
  } = {
    total_fetches: 0,
    total_ok: 0,
    total_error: 0,
    updated_at: "",
    entries: [],
  };
  let corrupted = false;
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (parsed && Array.isArray(parsed.entries)) {
      log = {
        total_fetches: Number(parsed.total_fetches) || parsed.entries.length,
        total_ok: Number(parsed.total_ok) || 0,
        total_error: Number(parsed.total_error) || 0,
        updated_at:
          typeof parsed.updated_at === "string" ? parsed.updated_at : "",
        entries: parsed.entries as LedgerEntry[],
      };
    } else {
      corrupted = true;
    }
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code !== "ENOENT") corrupted = true;
  }
  if (corrupted) {
    try {
      await rename(file, `${file}.corrupt`);
    } catch {}
  }

  log.entries = [entry, ...log.entries];
  log.total_fetches = log.entries.length;
  log.total_ok = log.entries.filter((item) => item.status === "ok").length;
  log.total_error = log.entries.filter((item) => item.status !== "ok").length;
  log.updated_at = new Date().toISOString();

  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(log, null, 2) + "\n", "utf8");
  await rename(tmp, file);
}

async function recordHistory(
  record: HistoryRecord,
  ledgerEntry: LedgerEntry,
  history: { enabled: boolean; dir: string },
): Promise<string | null> {
  if (!history.enabled) return null;
  try {
    await writeHistory(record, history.dir);
    await updateLedger(ledgerEntry, history.dir);
    return join(history.dir, `${localDateStamp(new Date())}.jsonl`);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* zyte call (rule §4: timeout, never auto-retry)                      */
/* ------------------------------------------------------------------ */

type ZyteSuccess = {
  ok: true;
  finalUrl: string;
  statusCode: number;
  body: string;
  contentType: string;
  contentLength: string;
};
type ZyteFailure = { ok: false; message: string; httpStatus?: number };
type ZyteResponse = ZyteSuccess | ZyteFailure;

function jsonString(value: unknown): string {
  return JSON.stringify(value);
}

function errorResult(message: string): { content: string } {
  return { content: jsonString({ error: message }) };
}

// Terse, plain message for any failed fetch (Zyte/target unreachable, blocked,
// timeout, non-2xx error envelope). Keeps the model from dumping long
// explanations to the user; the separate http_status field still carries code.
const GENERIC_FETCH_ERROR =
  "Could not fetch this page (blocked or unreachable). No content. Do not retry (billed).";

function buildSignal(external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  if (external && typeof AbortSignal.any === "function")
    return AbortSignal.any([timeout, external]);
  return timeout;
}

function decodeBody(base64: string, contentType: string): string {
  const bytes = Buffer.from(base64, "base64");
  const declared = /charset\s*=\s*"?([\w-]+)"?/i.exec(contentType)?.[1];
  const head = bytes.subarray(0, 4096).toString("latin1");
  const meta = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  const charset = (declared ?? meta ?? "utf-8")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  if (!charset || charset === "utf8") return bytes.toString("utf8");
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return bytes.toString("utf8");
  }
}

function mapZyteError(json: any, httpLayer: number): string {
  const type = typeof json?.type === "string" ? json.type : "";
  const status = typeof json?.status === "number" ? json.status : httpLayer;
  const title = typeof json?.title === "string" ? json.title : "";
  const detail = typeof json?.detail === "string" ? json.detail : "";
  const kind = type ? (type.split("/").pop() ?? "") : "";
  if (status === 401 || /unauthorized|api.?key/i.test(kind + title))
    return `Zyte rejected the API key (HTTP ${status}). Run /connect and choose Zyte, or set ZYTE_API_KEY. Do not retry until fixed.`;
  if (status === 402)
    return "Zyte is out of credits (HTTP 402). Tell the user to top up at hub.zyte.com. Do not retry.";
  if (
    /unexpected|unsupported|invalid/i.test(kind + title + detail) &&
    status === 400
  )
    return "Zyte could not parse the request (HTTP 400). Check that url is a public absolute http(s) URL. No content.";
  return GENERIC_FETCH_ERROR;
}

async function callZyte(
  url: string,
  apiKey: string,
  externalAbort?: AbortSignal,
): Promise<ZyteResponse> {
  let response: Response;
  try {
    response = await fetch(ZYTE_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${apiKey}:`, "utf8").toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: jsonString({
        url,
        httpResponseBody: true,
        followRedirect: true,
        httpResponseHeaders: true,
      }),
      signal: buildSignal(externalAbort),
    });
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    if (name === "AbortError" && externalAbort?.aborted)
      return {
        ok: false,
        message: "Fetch was cancelled before it finished. No content.",
      };
    return { ok: false, message: GENERIC_FETCH_ERROR };
  }

  const text = await response.text();
  let json: any;
  try {
    json = JSON.parse(text);
  } catch {
    if (response.status === 401 || response.status === 403)
      return {
        ok: false,
        httpStatus: response.status,
        message: `Zyte rejected the API key (HTTP ${response.status}). Run /connect and choose Zyte, or set ZYTE_API_KEY. Do not retry.`,
      };
    if (response.status === 402)
      return {
        ok: false,
        httpStatus: 402,
        message:
          "Zyte is out of credits (HTTP 402). Tell the user to top up at hub.zyte.com. Do not retry.",
      };
    return {
      ok: false,
      httpStatus: response.status,
      message: GENERIC_FETCH_ERROR,
    };
  }

  if (!response.ok)
    return {
      ok: false,
      httpStatus: response.status,
      message: mapZyteError(json, response.status),
    };

  if (typeof json?.httpResponseBody === "string" && json.httpResponseBody) {
    const statusCode =
      typeof json.statusCode === "number" ? json.statusCode : 200;
    const headers: Array<{ name?: string; value?: string }> = Array.isArray(
      json.httpResponseHeaders,
    )
      ? json.httpResponseHeaders
      : [];
    const contentType =
      headers.find((h) => h.name?.toLowerCase() === "content-type")?.value ??
      "";
    const contentLength =
      headers.find((h) => h.name?.toLowerCase() === "content-length")?.value ??
      String(Buffer.from(json.httpResponseBody, "base64").length);
    return {
      ok: true,
      finalUrl: typeof json.url === "string" && json.url ? json.url : url,
      statusCode,
      body: decodeBody(json.httpResponseBody, contentType),
      contentType,
      contentLength,
    };
  }
  return {
    ok: false,
    httpStatus: response.status,
    message: mapZyteError(json, response.status),
  };
}

function looksLikeBlocked(statusCode: number, text: string): boolean {
  if (statusCode === 403 || statusCode === 429 || statusCode === 503)
    return true;
  if (text.length < 8000)
    return /access denied|captcha|are you a robot|request blocked|perimeterx|datadome|please enable javascript and refresh|cookies must be enabled|\/_pow\/solve|proof of (work|access)/i.test(
      text,
    );
  return false;
}

/* ------------------------------------------------------------------ */
/* tool                                                                */
/* ------------------------------------------------------------------ */

export default Plugin.define({
  id: "opencode-webfetchmd",
  async setup(ctx) {
    await registerZyteIntegration(ctx);
    const locationDirectory = ctx.location.directory;
    const history = historyConfig(ctx.options, locationDirectory);
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "webfetchmd",
        description:
          "Fetch a web page by URL and return its content as readable Markdown, along with the page title, description, and any structured data. Use this whenever you need to read what is on a web page.",

        input: {
          type: "object",
          properties: {
            url: {
              type: "string",
              minLength: 1,
              maxLength: 4000,
              description: "The URL of the web page to read.",
            },
            goal: {
              type: "string",
              maxLength: 300,
              description:
                "Optional note about what you are trying to find on the page; helps keep the most relevant parts on long pages.",
            },
          },
          required: ["url"],
          additionalProperties: false,
        },
        options: { codemode: false },

        async execute(rawArgs, context) {
          const args = rawArgs as { url?: string; goal?: string };
          const requested = String(args.url ?? "").trim();
          let parsedTarget: URL;
          try {
            parsedTarget = new URL(requested);
          } catch {
            return errorResult(
              `url must be an absolute http(s) URL such as "https://example.com/docs". Received: ${jsonString(requested)}.`,
            );
          }
          if (
            parsedTarget.protocol !== "http:" &&
            parsedTarget.protocol !== "https:"
          )
            return errorResult(
              `Only http(s) URLs are supported (got ${parsedTarget.protocol}). Pass e.g. "https://example.com/page".`,
            );

          let apiKey: string;
          try {
            apiKey = await resolveZyteApiKey(ctx);
          } catch (error) {
            return errorResult(
              error instanceof Error ? error.message : String(error),
            );
          }

          const goal =
            typeof args.goal === "string" && args.goal.trim()
              ? args.goal.trim()
              : undefined;
          const response = await callZyte(requested, apiKey, context.signal);
          const timestamp = new Date().toISOString();
          const historyId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
          const historyBase = {
            id: historyId,
            timestamp,
            tool_version: TOOL_VERSION,
            session_id: String(context.sessionID ?? ""),
            message_id: String(context.messageID ?? ""),
            agent: String(context.agent ?? ""),
            directory: locationDirectory,
          };

          if (!response.ok) {
            await recordHistory(
              {
                ...historyBase,
                request: { url: requested, ...(goal ? { goal } : {}) },
                http_status: response.httpStatus ?? null,
                status: "error",
                error: response.message,
                html_bytes: null,
                markdown_chars: null,
                normalized: { meta: {}, schema: [], full_markdown: "" },
              },
              {
                timestamp,
                url: requested,
                status: "error",
                http_status: response.httpStatus ?? null,
                markdown_chars: null,
              },
              history,
            );
            return {
              content: jsonString({
                url: requested,
                status: "error",
                http_status: response.httpStatus ?? null,
                meta: {},
                schema: [],
                markdown: "",
                error: response.message,
              }),
            };
          }

          const converted = convert(response.body, {
            baseUrl: response.finalUrl,
            goal,
          });
          const isErrorPage =
            response.statusCode < 200 || response.statusCode >= 300;
          const blocked = looksLikeBlocked(response.statusCode, response.body);
          const status: "ok" | "error_page" | "blocked" = isErrorPage
            ? blocked
              ? "blocked"
              : "error_page"
            : blocked
              ? "blocked"
              : "ok";

          const notes = [...converted.notes];
          if (status === "blocked")
            notes.push(
              `The site served a block/captcha/error interstitial (HTTP ${response.statusCode}). Do not retry the same URL — tell the user.`,
            );
          else if (status === "error_page")
            notes.push(
              `Target site returned HTTP ${response.statusCode}; the markdown below is the error page itself. Do not retry — tell the user.`,
            );
          if (
            response.finalUrl !== requested &&
            !notes.some((n) => n.startsWith("Final URL"))
          )
            notes.push(`Final URL after redirects: ${response.finalUrl}`);

          const fullLength = converted.full_markdown.length;
          if (history.enabled) {
            await recordHistory(
              {
                ...historyBase,
                request: { url: requested, ...(goal ? { goal } : {}) },
                http_status: response.statusCode,
                status,
                error: null,
                html_bytes: Buffer.byteLength(response.body, "utf8"),
                markdown_chars: fullLength,
                normalized: {
                  meta: {
                    title: converted.title,
                    description: converted.description,
                    final_url: response.finalUrl,
                    content_type: response.contentType,
                  },
                  schema: converted.schema,
                  full_markdown: converted.full_markdown,
                },
                raw_http_headers: {
                  content_type: response.contentType,
                  content_length: response.contentLength,
                },
              },
              {
                timestamp,
                url: requested,
                status,
                http_status: response.statusCode,
                markdown_chars: fullLength,
              },
              history,
            );
            if (converted.truncated)
              notes.push(
                `Output truncated at ${MAX_OUTPUT_CHARS} chars; the full text is archived to the local history log — do not re-fetch (billed).`,
              );
          } else if (converted.truncated)
            notes.push(
              "History disabled (WEBFETCHMD_HISTORY=0): full markdown beyond the cap was not archived.",
            );

          return {
            content: jsonString({
              url: requested,
              status,
              http_status: response.statusCode,
              ...(response.finalUrl !== requested
                ? { final_url: response.finalUrl }
                : {}),
              meta: {
                ...(converted.title ? { title: converted.title } : {}),
                ...(converted.description
                  ? { description: converted.description }
                  : {}),
              },
              schema: converted.schema,
              markdown: converted.markdown,
              ...(notes.length > 0 ? { notes } : {}),
            }),
          };
        },
      });
    });
  },
});

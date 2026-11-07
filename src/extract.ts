/**
 * HTML -> plain text helpers.
 *
 * The whole point of this plugin is to hand the model *readable content*
 * instead of a list of links, so text extraction and excerpt selection
 * matter more than the search request itself.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  shy: "",
  ensp: " ",
  emsp: " ",
  thinsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  laquo: "«",
  raquo: "»",
  ldquo: "“",
  rdquo: "”",
  lsquo: "‘",
  rsquo: "’",
  copy: "©",
  reg: "®",
  trade: "™",
  deg: "°",
  plusmn: "±",
  times: "×",
  divide: "÷",
  middot: "·",
  bull: "•",
  euro: "€",
  pound: "£",
  yen: "¥",
  sect: "§",
  para: "¶",
  frac12: "½",
  frac14: "¼",
  rarr: "→",
  larr: "←",
  uarr: "↑",
  darr: "↓",
};

/** Decode the HTML entities that actually show up in search results and pages. */
export function decodeEntities(input: string): string {
  if (!input.includes("&")) return input;
  return input.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const hex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return whole;
      try {
        return String.fromCodePoint(code);
      } catch {
        return whole;
      }
    }
    const named = NAMED_ENTITIES[body.toLowerCase()];
    return named === undefined ? whole : named;
  });
}

/** Strip tags from a fragment and collapse whitespace (used for titles/snippets). */
export function stripTags(input: string): string {
  return decodeEntities(input.replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

const CONTAINER_TAGS = new Set(["article", "main", "section", "div", "td", "table", "body"]);

const SKIP_SUBTREES = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "canvas",
  "iframe",
  "object",
  "embed",
  "select",
  "button",
  "form",
  "nav",
  "header",
  "footer",
  "aside",
  "head",
]);

const VOID_TAGS = new Set(["br", "img", "hr", "input", "meta", "link", "source", "col", "wbr"]);

interface ElementNode {
  tag: string;
  textLength: number;
  linkLength: number;
  parts: string[];
  parent: number | null;
  children: number[];
}

interface StackEntry {
  tag: string;
  nodeIndex: number | null;
  skip: boolean;
}

/**
 * Walk the HTML once, keeping a stack of open elements and measuring how much
 * text each one holds and how much of that text sits inside links.
 *
 * Selection is readability-style: start from the block with the best
 * "text minus links" score, then walk *down* into children that still hold
 * almost all of that content. That lands on the article body instead of the
 * whole page with its menus and teaser lists.
 */
function findMainContent(html: string): string | null {
  const nodes: ElementNode[] = [];
  const stack: StackEntry[] = [];
  let skipDepth = 0;

  const pushText = (raw: string) => {
    const text = raw.replace(/\s+/g, " ");
    if (!text.trim()) return;
    const decoded = decodeEntities(text);
    let insideLink = false;
    for (const entry of stack) {
      if (entry.tag === "a") insideLink = true;
      if (entry.skip || entry.nodeIndex === null) continue;
      const node = nodes[entry.nodeIndex];
      node.textLength += decoded.length;
      node.parts.push(decoded);
    }
    if (insideLink) {
      for (const entry of stack) {
        if (entry.nodeIndex === null) continue;
        nodes[entry.nodeIndex].linkLength += decoded.length;
      }
    }
  };

  const tagRe = /<[^>]*>/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRe.exec(html)) !== null) {
    if (match.index > cursor) pushText(html.slice(cursor, match.index));
    cursor = tagRe.lastIndex;

    const raw = match[0];
    if (raw.startsWith("<!--") || raw.startsWith("<!")) continue;

    const nameMatch = raw.match(/^<\s*\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/);
    if (!nameMatch) continue;
    const tag = nameMatch[1].toLowerCase();

    if (/^<\s*\//.test(raw)) {
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].tag === tag) {
          if (stack[i].skip) skipDepth -= 1;
          stack.length = i;
          break;
        }
      }
      continue;
    }

    if (raw.endsWith("/>") || VOID_TAGS.has(tag)) {
      if (tag === "br" || tag === "hr") pushText("\n");
      continue;
    }

    const skip = skipDepth > 0 || SKIP_SUBTREES.has(tag);
    if (skip) skipDepth += 1;

    let nodeIndex: number | null = null;
    if (!skip && CONTAINER_TAGS.has(tag)) {
      let parent: number | null = null;
      for (let i = stack.length - 1; i >= 0; i -= 1) {
        if (stack[i].nodeIndex !== null) {
          parent = stack[i].nodeIndex;
          break;
        }
      }
      nodeIndex = nodes.length;
      nodes.push({ tag, textLength: 0, linkLength: 0, parts: [], parent, children: [] });
      if (parent !== null) nodes[parent].children.push(nodeIndex);
    }
    stack.push({ tag, nodeIndex, skip });
  }

  const scores = nodes.map((node) => node.textLength - 1.6 * node.linkLength);
  let bestIndex = -1;
  for (let i = 0; i < nodes.length; i += 1) {
    if (nodes[i].textLength < 200 || !Number.isFinite(scores[i])) continue;
    if (bestIndex === -1 || scores[i] > scores[bestIndex]) bestIndex = i;
  }
  if (bestIndex === -1) return null;

  const bestScore = scores[bestIndex];
  let chosen = bestIndex;
  for (;;) {
    let next = -1;
    for (const child of nodes[chosen].children) {
      if (nodes[child].textLength < 200) continue;
      if (scores[child] < bestScore * 0.85) continue;
      if (next === -1 || nodes[child].textLength > nodes[next].textLength) next = child;
    }
    if (next === -1) break;
    chosen = next;
  }

  const text = nodes[chosen].parts.join(" ").trim();
  return text.length > 0 ? text : null;
}

/** Fallback: join all paragraphs, which is where article text usually lives. */
function paragraphsText(html: string): string {
  const parts: string[] = [];
  const re = /<(p|h[1-3]|blockquote|pre)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const text = stripTags(match[2]);
    if (text.length >= 40) parts.push(text);
  }
  return parts.join("\n\n");
}

/** Turn a full HTML document into reasonably clean readable text. */
export function htmlToText(html: string): string {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|template|svg|canvas|iframe|object|embed|select|button|form)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");

  let text = findMainContent(cleaned) ?? "";
  if (text.length < 400) {
    const paragraphs = paragraphsText(cleaned);
    if (paragraphs.length > text.length) text = paragraphs;
  }
  if (text.length < 200) {
    text = cleaned
      .replace(/<(br|hr)\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|main|h[1-6]|li|tr|td|th|blockquote|pre)>/gi, "\n")
      .replace(/<[^>]+>/g, " ");
    text = decodeEntities(text);
  }

  return text
    .replace(/[ \t\u00a0\u200b]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function extractTitle(html: string): string {
  const og = html.match(/<meta[^>]+property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']*)["']/i);
  if (og) return stripTags(og[1]);
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return title ? stripTags(title[1]) : "";
}

export function extractDescription(html: string): string {
  const patterns = [
    /<meta[^>]+property\s*=\s*["']og:description["'][^>]*content\s*=\s*["']([^"']*)["']/i,
    /<meta[^>]+name\s*=\s*["']description["'][^>]*content\s*=\s*["']([^"']*)["']/i,
    /<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]*name\s*=\s*["']description["']/i,
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match && match[1].trim().length > 0) return stripTags(match[1]);
  }
  return "";
}

export function extractPublishedDate(html: string): string {
  const patterns = [
    /<meta[^>]+property\s*=\s*["']article:published_time["'][^>]*content\s*=\s*["']([^"']+)["']/i,
    /<meta[^>]+name\s*=\s*["'](?:date|pubdate|publish_date)["'][^>]*content\s*=\s*["']([^"']+)["']/i,
    /"datePublished"\s*:\s*"([^"]+)"/i,
  ];
  for (const re of patterns) {
    const match = html.match(re);
    if (match && match[1].trim().length > 0) return match[1].trim().slice(0, 40);
  }
  return "";
}

const STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can", "had", "her", "was", "one", "our",
  "out", "day", "get", "has", "him", "his", "how", "its", "may", "new", "now", "old", "see", "two", "way",
  "who", "boy", "did", "she", "use", "what", "when", "where", "which", "while", "with", "this", "that",
  "from", "have", "will", "your", "they", "them", "then", "than", "into", "about", "there", "their", "would",
  "could", "should", "does", "doing", "been", "being", "such", "some", "more", "most", "also", "just", "only",
  "как", "что", "это", "для", "или", "все", "его", "она", "они", "был", "была", "были", "быть", "если", "уже",
  "где", "когда", "почему", "зачем", "какой", "какая", "какие", "сколько", "мне", "меня", "тебя", "вас",
  "чем", "без", "при", "про", "над", "под", "так", "там", "тут", "ещё", "еще", "очень", "можно", "нужно",
  // conversational filler that small models like to put into the query
  "кто", "такая", "такой", "такие", "посмотри", "поищи", "найди", "ищи", "интернете", "интернет", "сети",
  "подскажи", "расскажи", "информация", "информацию", "инфо", "имя", "зовут", "пожалуйста", "дай",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function splitSentences(text: string): string[] {
  const raw = text
    .split(/(?<=[.!?…])\s+(?=[«"'„(\p{Lu}])/u)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  // "released Oct. 7, 2025" has to stay one sentence: glue short abbreviations back.
  const merged: string[] = [];
  for (const part of raw) {
    const previous = merged[merged.length - 1];
    const endsWithAbbreviation =
      previous !== undefined &&
      /(?:^|\s)(?:[A-ZА-ЯЁ][a-zа-яё]{0,3}|г|ул|им|др|т|рис|табл|стр|ок|англ|рус|нем)\.$/u.test(previous);
    if (endsWithAbbreviation) merged[merged.length - 1] = `${previous} ${part}`;
    else merged.push(part);
  }
  return merged;
}

/**
 * Pick the sentences that best match the query, keeping their original order.
 * Facts (numbers, dates, prices, temperatures) get a small bonus so that
 * "what is the price / forecast" style questions return real values.
 */
export function pickRelevant(text: string, query: string, maxChars: number): string {
  const clean = text.replace(/[ \t]+/g, " ").replace(/\n{2,}/g, "\n").trim();
  if (clean.length <= maxChars) return clean;

  const sentences = splitSentences(clean.replace(/\n+/g, " "));
  const queryTokens = tokenize(query);
  const scored = sentences.map((sentence, index) => {
    const tokens = tokenize(sentence);
    let score = 0;
    for (const token of tokens) {
      if (queryTokens.includes(token)) score += 3;
      else if (queryTokens.some((q) => token.startsWith(q) || q.startsWith(token))) score += 1;
    }
    if (/\d/.test(sentence)) score += 1;
    if (/\d\s*(%|°|₽|\$|€|руб|долл|градус)/i.test(sentence)) score += 2;
    // Slight preference for earlier sentences: intros usually carry the answer.
    score += Math.max(0, 1 - index / Math.max(20, sentences.length));
    return { sentence, index, score };
  });

  const picked: { sentence: string; index: number }[] = [];
  let used = 0;
  for (const item of [...scored].sort((a, b) => b.score - a.score)) {
    if (item.score <= 0 && picked.length >= 4) break;
    if (used + item.sentence.length > maxChars) continue;
    picked.push(item);
    used += item.sentence.length + 1;
    if (used >= maxChars * 0.95) break;
  }

  if (picked.length === 0) return `${clean.slice(0, maxChars).trim()}…`;

  return picked
    .sort((a, b) => a.index - b.index)
    .map((item) => item.sentence)
    .join(" ");
}

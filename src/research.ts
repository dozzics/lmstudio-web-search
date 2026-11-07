import { searchWeb, type SearchHit } from "./search";
import { extractDescription, extractPublishedDate, extractTitle, htmlToText, pickRelevant, tokenize } from "./extract";

export const DEFAULT_PAGES = 3;
export const MAX_PAGES = 5;

const PAGE_EXCERPT_CHARS = 1800;
const TOTAL_TEXT_BUDGET = 11000;
const PAGE_TIMEOUT_MS = 15000;
const SEARCH_LIMIT = 10;
const CACHE_TTL_MS = 10 * 60 * 1000;
const MIN_READABLE_TEXT = 350;

const PAGE_HEADERS: Record<string, string> = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
  "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
};

export interface PageData {
  title: string;
  description: string;
  published: string;
  text: string;
}

export type StatusReporter = (message: string) => void;

const pageCache = new Map<string, { at: number; data: PageData | null }>();

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** `https://cyberpunk.fandom.com/wiki/Capri` -> `Capri` (null for other hosts). */
function fandomPageName(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)fandom\.com$/i.test(parsed.hostname)) return null;
    const match = parsed.pathname.match(/\/wiki\/(.+)$/);
    if (!match) return null;
    return decodeURIComponent(match[1].replace(/\/$/, ""));
  } catch {
    return null;
  }
}

/**
 * Fandom sits behind a Cloudflare JS challenge that plain fetch cannot pass,
 * but its MediaWiki API answers normally. Used as a fallback.
 */
async function loadFandomViaApi(url: string, signal: AbortSignal | undefined): Promise<PageData | null> {
  const pageName = fandomPageName(url);
  if (!pageName) return null;

  try {
    const api = new URL(`https://${new URL(url).hostname}/api.php`);
    api.searchParams.set("action", "parse");
    api.searchParams.set("page", pageName);
    api.searchParams.set("prop", "text");
    api.searchParams.set("format", "json");
    api.searchParams.set("formatversion", "2");
    api.searchParams.set("redirects", "1");

    const response = await fetch(api.toString(), {
      headers: PAGE_HEADERS,
      redirect: "follow",
      signal: withTimeout(signal, PAGE_TIMEOUT_MS),
    });
    if (!response.ok) return null;

    const payload = (await response.json()) as { parse?: { title?: string; text?: string } };
    const html = payload.parse?.text;
    if (typeof html !== "string" || html.length < 100) return null;

    return {
      title: payload.parse?.title ?? pageName.replace(/_/g, " "),
      description: "",
      published: "",
      text: htmlToText(html),
    };
  } catch {
    return null;
  }
}

export function normalizeUrl(raw: string): string {
  const trimmed = raw.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed}`;
}

export function clampPages(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_PAGES;
  return Math.min(MAX_PAGES, Math.max(0, Math.round(value)));
}

export async function loadPage(url: string, signal: AbortSignal | undefined): Promise<PageData | null> {
  const cached = pageCache.get(url);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.data;

  let data: PageData | null = null;
  try {
    const response = await fetch(url, {
      headers: PAGE_HEADERS,
      redirect: "follow",
      signal: withTimeout(signal, PAGE_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const binary =
      contentType.includes("application/pdf") ||
      contentType.includes("image/") ||
      contentType.includes("video/") ||
      contentType.includes("audio/") ||
      contentType.includes("application/zip");

    if (!binary) {
      const raw = (await response.text()).slice(0, 3_000_000);
      if (contentType.includes("text/html") || contentType.includes("application/xhtml") || raw.includes("<html")) {
        data = {
          title: extractTitle(raw),
          description: extractDescription(raw),
          published: extractPublishedDate(raw),
          text: htmlToText(raw),
        };
      } else {
        data = { title: "", description: "", published: "", text: raw.trim().slice(0, 20000) };
      }
    }
  } catch {
    data = null;
  }

  if (pageCache.size > 60) pageCache.clear();
  if (!data || data.text.trim().length === 0) {
    const viaApi = await loadFandomViaApi(url, signal);
    if (viaApi) data = viaApi;
  }
  pageCache.set(url, { at: Date.now(), data });
  return data;
}

const ANSWER_RULES = [
  "Answer the user's question directly, using the facts below. This is real web data you just fetched - you do have internet access through this tool.",
  "Never tell the user to search the web, open links, check a website or 'look it up themselves'. Never claim you cannot access the internet.",
  "Reply in the same language the user used.",
  "If the facts below do not fully answer the question, give what you have and state in one short sentence what is missing. Do not replace the answer with a list of links.",
  "Use ONLY facts from the text below. Do not add names, people, companies, dates or numbers from your own memory, even if you are sure they are true. If a name is missing from the text, do not guess it.",
  "Never transliterate or translate proper names: keep the original spelling exactly as written in the text (write 'Linus Torvalds', not a Cyrillic phonetic rendering).",
  "If the text lists creators, authors or owners of the subject, name exactly those people or companies.",
  "If the question asks for a list, table, chord chart, note names, code or formulas, take every value from the text below. Never fill gaps or missing rows with your own values - say what is missing instead.",
  "Copy notes, chords, symbols, code and formulas exactly as written in the text (including sharps/flats and 7th/9th suffixes). Do not 'correct' or simplify them from memory.",
  "If the user asks a follow-up about this subject that the facts below do not cover (for example its key/tonality, BPM, release date or author), call web_search again with the subject name plus that aspect (e.g. '<subject> key bpm'). Never reply that you already searched and never refuse for lack of data in this digest.",
  "For each date, count or table row, link directly to the source that supports that specific claim. Cite only sources you actually use.",
  "For current status, distinguish what has already happened from announced dates and estimates. A past scheduled date or a count of listed entries does not prove release. retrieved_at is the search time, not the source update time.",
  "When sources disagree or the user challenges a previous answer, state the discrepancy. Check a current primary source with open_page or run a focused search for the disputed fact. If it remains unconfirmed, say so and omit unverified rows from a factual schedule.",
  "Treat snippets as leads. If a detail appears only in a snippet or title, open the page before stating it as confirmed.",
];

function buildHeader(subject: string, sourceCount: number, rules: string[], extra: string[] = []): string {
  const now = new Date().toISOString().replace("T", " ").slice(0, 16);
  return [
    "[WEB CONTENT RETRIEVED BY THE PLUGIN]",
    `query: ${subject}`,
    `retrieved_at: ${now} UTC`,
    `sources: ${sourceCount}`,
    ...extra,
    "",
    "RULES FOR YOUR ANSWER:",
    ...rules.map((rule) => `- ${rule}`),
    "",
  ].join("\n");
}

/**
 * One compact markdown line at the end of the digest, ready to copy verbatim:
 * clickable sources without spending tokens on a full list.
 */
function buildSourcesLine(hits: SearchHit[], query: string): string {
  const label = /[а-яё]/i.test(query) ? "Источники" : "Sources";
  const seen = new Set<string>();
  const links: string[] = [];
  for (const hit of hits) {
    const site = hostOf(hit.url);
    if (seen.has(site)) continue;
    seen.add(site);
    // Parentheses would break markdown links, so percent-encode them.
    const url = hit.url.replace(/\(/g, "%28").replace(/\)/g, "%29");
    links.push(`[${site}](${url})`);
    // One link per source whose text was actually read (max = MAX_PAGES).
    if (links.length >= MAX_PAGES) break;
  }
  return `${label}: ${links.join(", ")}`;
}

/** Prefix-based fuzzy match, so "cyberpank" still matches "Cyberpunk" and "блюза" matches "блюзовая". */
function fuzzyMatch(token: string, haystack: string): boolean {
  if (haystack.includes(token)) return true;
  if (token.length < 5) return false;
  const prefix = token.slice(0, 4);
  return haystack
    .split(/[^\p{L}\p{N}]+/u)
    .some((word) => word.length >= 5 && (word.startsWith(prefix) || token.startsWith(word.slice(0, 4))));
}

/** Sites that actually publish song key/BPM data, and sites that do not. */
const MUSIC_SOURCE_WEIGHTS: [RegExp, number][] = [
  [/(^|\.)songbpm\.com$/i, 8],
  [/(^|\.)12notez\.in$/i, 8],
  [/(^|\.)songdata\.io$/i, 7],
  [/(^|\.)tunebat\.com$/i, 6],
  [/(^|\.)getsongbpm\.com$/i, 6],
  [/(^|\.)getsongkey\.com$/i, 5],
  [/(^|\.)musicstax\.com$/i, 5],
  [/(^|\.)hooktheory\.com$/i, 4],
  [/(^|\.)chordify\.net$/i, 3],
  [/(^|\.)songsterr\.com$/i, -3],
  [/(^|\.)onlinesequencer\.net$/i, -3],
];

function isMusicDataQuery(query: string): boolean {
  // "тональность" / "tonality" is unambiguous on its own.
  if (/(тональн|tonality)/i.test(query)) return true;
  const aboutMusic = /(трек|песн|song|track|soundtrack|альбом|album|artist|исполн|композитор|music|музык)/i.test(query);
  const aboutKey = /(\bkey\b|bpm|темп)/i.test(query);
  const aboutNotes = /(нот[ыаеу]?\b|note|аккорд|chord|гамм|scale)/i.test(query);
  return aboutMusic && (aboutKey || aboutNotes);
}

/** Niche facts like "what key is this song in" need an explicit hint for search engines. */
function augmentQuery(query: string): string {
  if (!isMusicDataQuery(query)) return query;
  if (/(тональн|tonality|\bkey\b|bpm|темп)/i.test(query) && !/\b(bpm|key)\b/i.test(query)) {
    return `${query} key bpm`;
  }
  if (/(нот[ыаеу]?\b|note|аккорд|chord|гамм|scale)/i.test(query) && !/\b(notes?|chords?)\b/i.test(query)) {
    return `${query} notes chords`;
  }
  return query;
}

/** How well a result matches the query: title matches weigh more than snippets. */
function rankHits(hits: SearchHit[], query: string): SearchHit[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return hits;
  const musicQuery = isMusicDataQuery(query);

  return hits
    .map((hit, index) => {
      const title = hit.title.toLowerCase();
      const snippet = hit.snippet.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (fuzzyMatch(token, title)) score += 3;
        else if (fuzzyMatch(token, snippet)) score += 1;
      }
      if (musicQuery) {
        const host = hostOf(hit.url);
        for (const [pattern, weight] of MUSIC_SOURCE_WEIGHTS) {
          if (pattern.test(host)) {
            score += weight;
            break;
          }
        }
      }
      return { hit, index, score };
    })
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.hit);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function formatHit(index: number, hit: SearchHit, page: PageData | null, query: string, budgetLeft: number): string {
  const lines: string[] = [];
  lines.push(`--- SOURCE ${index} | ${hostOf(hit.url)} ---`);
  lines.push(`title: ${hit.title}`);
  lines.push(`url: ${hit.url}`);
  if (page?.published) lines.push(`published: ${page.published}`);
  if (hit.snippet) lines.push(`search_snippet: ${hit.snippet}`);

  const pageText = page?.text ?? "";
  if (pageText.length > MIN_READABLE_TEXT) {
    lines.push("page_text:");
    lines.push(pickRelevant(pageText, query, Math.min(PAGE_EXCERPT_CHARS, budgetLeft)));
  } else if (page?.description) {
    lines.push("page_text: (this page is rendered by JavaScript, only its description is available)");
    lines.push(page.description);
  } else {
    lines.push("page_text: (page body could not be read - use search_snippet above)");
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Tokens that describe the *type* of data asked for rather than the subject.
 * They should not decide whether a search result is relevant.
 */
const GENERIC_QUERY_TOKENS = new Set([
  "key", "bpm", "notes", "note", "chords", "chord", "scale", "scales", "music", "song", "track",
  "темп", "гамм", "аккорд", "нот", "трек", "песн", "музык", "написан", "написана", "написано",
]);

function coreQueryTokens(query: string): string[] {
  return tokenize(query).filter((token) => {
    if (GENERIC_QUERY_TOKENS.has(token)) return false;
    if (token.startsWith("тональн")) return false;
    return true;
  });
}

/**
 * Fallback engines sometimes serve anti-bot pages with completely unrelated
 * results (e.g. "VK" pages for a music question). Feeding those to the model is
 * worse than admitting failure, so require at least one distinctive query token
 * to appear in the results.
 */
function resultsMatchQuery(hits: SearchHit[], query: string): boolean {
  const core = coreQueryTokens(query);
  if (core.length === 0) return true;

  const distinctive = core.filter((token) => token.length >= 5);
  const required = distinctive.length > 0 ? distinctive : core;
  const need = Math.min(2, required.length);

  return hits.some((hit) => {
    const hay = `${hit.title} ${hit.snippet} ${hit.url}`.toLowerCase();
    let matches = 0;
    for (const token of required) {
      if (fuzzyMatch(token, hay)) matches += 1;
      if (matches >= need) return true;
    }
    return false;
  });
}

const MUSIC_SUBJECT = /(трек|песн|song|track|soundtrack|музык|music|album|альбом)/i;
const MUSIC_ASPECT = /(\bkey\b|тональн|tonality|\bbpm\b|темп)/i;

/**
 * "Tell me about this track" questions usually miss the key/BPM, because music
 * databases don't rank for such generic wording. Run a second, focused search
 * so the model gets those facts up front instead of asking the user to retry.
 */
function musicSourceWeight(url: string): number {
  const host = hostOf(url);
  for (const [pattern, weight] of MUSIC_SOURCE_WEIGHTS) {
    if (pattern.test(host)) return weight;
  }
  return 0;
}

async function musicKeySupplement(query: string, signal: AbortSignal | undefined): Promise<string> {
  if (!MUSIC_SUBJECT.test(query) || MUSIC_ASPECT.test(query)) return "";
  const extra = await searchWeb(`${query} key bpm`, 6, signal);
  if (extra.hits.length === 0) return "";
  // The subject words ("Terraria Calamity Mod") match YouTube and shops better
  // than music databases, so sort by source type first for this section.
  const hits = [...extra.hits].sort((a, b) => musicSourceWeight(b.url) - musicSourceWeight(a.url)).slice(0, 3);

  const lines = [
    "--- MUSIC DATABASE FACTS (authoritative for key/BPM; prefer these over sheet-music arrangements) ---",
  ];
  const pages = await Promise.allSettled(hits.map((hit) => loadPage(hit.url, signal)));
  hits.forEach((hit, index) => {
    lines.push(`- ${hit.title}`);
    lines.push(`  ${hit.url}`);
    const loaded = pages[index];
    const page = loaded.status === "fulfilled" ? loaded.value : null;
    const excerpt =
      page && page.text.length > 200 ? pickRelevant(page.text, "key bpm tonality", 500).replace(/\s+/g, " ").trim() : "";
    if (excerpt) lines.push(`  ${excerpt}`);
    else if (hit.snippet) lines.push(`  ${hit.snippet}`);
  });
  return lines.join("\n");
}

/** Search DuckDuckGo, read the best pages and return a model-ready digest. */
export async function researchWeb(
  query: string,
  pageCount: number,
  signal: AbortSignal | undefined,
  status: StatusReporter = () => {},
): Promise<string> {
  const cleanQuery = query.trim();
  status(`DuckDuckGo: ${cleanQuery}`);

  const searchQuery = augmentQuery(cleanQuery);
  const outcome = await searchWeb(searchQuery, SEARCH_LIMIT, signal);
  const hits = outcome.hits;
  if (hits.length === 0) {
    return [
      "[WEB SEARCH FAILED - TECHNICAL PROBLEM]",
      `query: ${cleanQuery}`,
      outcome.notes.length > 0 ? `details: ${outcome.notes.join("; ")}` : "",
      "",
      "Search engines are temporarily unavailable or rate-limited. This is NOT proof that the subject does not exist.",
      "Tell the user in one short sentence that the search failed for technical reasons and offer to retry in a minute.",
      "Never conclude that the information does not exist, and never ask the user to search manually.",
      "Do not recommend other websites, databases or forums instead - just offer to retry.",
      "Do not supply an answer from memory as a substitute for verification.",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (!resultsMatchQuery(hits, cleanQuery)) {
    return [
      "[WEB SEARCH FAILED - TECHNICAL PROBLEM]",
      `query: ${cleanQuery}`,
      `details: ${outcome.engine || "no engine"} returned unrelated results${outcome.notes.length > 0 ? `; ${outcome.notes.join("; ")}` : ""}`,
      "",
      "The results were unrelated to the question, so they were discarded. This is NOT proof that the subject does not exist.",
      "Tell the user in one short sentence that the search failed for technical reasons and offer to retry in a minute.",
      "Never answer from unrelated pages, never guess, and never ask the user to search manually.",
      "Do not recommend other websites, databases or forums instead - just offer to retry.",
    ].join("\n");
  }

  const extra: string[] = [`engine: ${outcome.engine}`];
  if (outcome.engine === "Bing" || outcome.engine === "Wikipedia") {
    extra.push("note: DuckDuckGo was rate-limited, these results come from the fallback engine - they are still real web results.");
  }

  const ranked = rankHits(hits, cleanQuery);

  if (pageCount === 0) {
    const parts = [buildHeader(cleanQuery, ranked.length, ANSWER_RULES, extra)];
    parts.push("--- SEARCH RESULTS ---");
    for (const hit of ranked) {
      parts.push(`- ${hit.title}`);
      parts.push(`  ${hit.url}`);
      if (hit.snippet) parts.push(`  ${hit.snippet}`);
    }
    const supplement = await musicKeySupplement(cleanQuery, signal);
    if (supplement) parts.push("", supplement);
    return parts.join("\n");
  }

  // Read a couple more results than needed: some sites render everything with
  // JavaScript and return almost no text, so the next result is tried instead.
  const pool = ranked.slice(0, Math.min(ranked.length, pageCount + 3));
  status(`Reading ${pool.length} page(s)...`);
  const loaded = await Promise.allSettled(pool.map((hit) => loadPage(hit.url, signal)));
  const items = pool.map((hit, index) => ({
    hit,
    page: loaded[index].status === "fulfilled" ? loaded[index].value : null,
  }));

  const readable = items.filter((item) => (item.page?.text.length ?? 0) > MIN_READABLE_TEXT).slice(0, pageCount);
  const chosen = readable.length >= pageCount ? readable : items.slice(0, Math.max(1, pageCount));

  const parts: string[] = [buildHeader(cleanQuery, chosen.length, ANSWER_RULES, extra)];
  let budget = TOTAL_TEXT_BUDGET;
  chosen.forEach((item, index) => {
    const block = formatHit(index + 1, item.hit, item.page, cleanQuery, Math.max(600, budget));
    budget -= block.length;
    parts.push(block);
  });

  const chosenUrls = new Set(chosen.map((item) => item.hit.url));
  const rest = ranked.filter((hit) => !chosenUrls.has(hit.url));
  if (rest.length > 0) {
    parts.push("--- OTHER SEARCH RESULTS (titles only) ---");
    for (const hit of rest) parts.push(`- ${hit.title} | ${hit.url}`);
    parts.push("");
  }

  const supplement = await musicKeySupplement(cleanQuery, signal);
  if (supplement) parts.push("", supplement);

  return parts.join("\n");
}

/** Fetch one URL and return a model-ready digest of its text. */
export async function readUrl(
  url: string,
  signal: AbortSignal | undefined,
  status: StatusReporter = () => {},
): Promise<string> {
  const target = normalizeUrl(url);
  try {
    new URL(target);
  } catch {
    return `Invalid URL: ${url}`;
  }

  status(`Opening ${target}`);
  const page = await loadPage(target, signal);
  if (!page) {
    return [
      `[PAGE NOT READABLE] ${target}`,
      "The page did not return readable text (blocked, binary or offline).",
      "Tell the user briefly that this page could not be opened. Use web_search if another source can verify the claim.",
    ].join("\n");
  }

  const body = page.text.length > 0 ? page.text.slice(0, 12000) : page.description;
  if (body.trim().length === 0) {
    return [
      `[PAGE IS EMPTY] ${target}`,
      "The page returned no readable text - it is probably rendered entirely by JavaScript.",
      "Tell the user this page could not be read and suggest running a web_search on the topic instead.",
    ].join("\n");
  }

  return [
    buildHeader(target, 1, [
      "Answer the user's question directly from this page. If it does not verify the requested fact, say so.",
      "Distinguish confirmed events from forecasts. A page description alone is not verification.",
      "Never tell the user to open the link themselves.",
      "Reply in the same language the user used.",
      "End your answer with the single source line from the tool output, copied verbatim as the last line, without the header above it.",
    ]),
    `title: ${page.title || "(no title)"}`,
    page.published ? `published: ${page.published}` : "",
    "page_text:",
    body,
    "",
    "--- COPY THE NEXT LINE AS THE LAST LINE OF YOUR ANSWER (do not repeat this header) ---",
    buildSourcesLine([{ title: page.title || target, url: target, snippet: "", engine: "" }], target),
  ]
    .filter(Boolean)
    .join("\n");
}

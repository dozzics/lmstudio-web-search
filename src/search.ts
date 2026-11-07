/**
 * Web search without an API key.
 *
 * Primary engine is DuckDuckGo (html.duckduckgo.com, with lite.duckduckgo.com
 * as a lighter twin). DuckDuckGo starts answering with an HTTP 202 captcha
 * page ("anomaly.js") when it sees too many requests, so the module also has
 * fallback engines: Bing and, for encyclopedic topics, Wikipedia.
 *
 * Requests are sent as POST with a form body for DuckDuckGo because it tends
 * to answer plain GET requests with an empty/anti-bot page.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { decodeEntities, stripTags } from "./extract";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
  engine: string;
}

export interface SearchOutcome {
  hits: SearchHit[];
  engine: string;
  /** DuckDuckGo answered with its captcha page at least once. */
  captcha: boolean;
  notes: string[];
}

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const DDG_HTML = "https://html.duckduckgo.com/html/";
const DDG_LITE = "https://lite.duckduckgo.com/lite/";

/** After a captcha, skip DuckDuckGo for a while instead of waiting on it again. */
const DDG_COOLDOWN_MS = 90_000;
let ddgBlockedUntil = 0;

const searchCache = new Map<string, { at: number; outcome: SearchOutcome }>();
const SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;

interface Chunk {
  start: number;
  end: number;
  attrs: string;
  inner: string;
}

function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

interface RawResponse {
  status: number;
  text: string;
}

async function request(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
  ms: number,
): Promise<RawResponse> {
  const response = await fetch(url, {
    ...init,
    signal: withTimeout(signal, ms),
    redirect: "follow",
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  return { status: response.status, text: await response.text() };
}

/** DuckDuckGo captcha / anti-bot page. */
function isCaptcha(status: number, html: string): boolean {
  if (status === 202 || status === 429) return true;
  return /anomaly\.js|challenge-form|id="img-form"|unusual traffic/i.test(html);
}

function collectTags(html: string, tag: string): Chunk[] {
  const re = new RegExp(`<${tag}\\b([^>]*)>([\\s\\S]*?)<\\/${tag}>`, "gi");
  const chunks: Chunk[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    chunks.push({
      start: match.index,
      end: match.index + match[0].length,
      attrs: match[1] ?? "",
      inner: match[2] ?? "",
    });
  }
  return chunks;
}

function getAttr(attrs: string, name: string): string | undefined {
  const match = attrs.match(new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i"));
  return match ? match[1] : undefined;
}

/** `//duckduckgo.com/l/?uddg=https%3A%2F%2F...` -> `https://...` */
function unwrapUrl(href: string): string {
  let url = href.replace(/&amp;/g, "&").trim();
  if (url.startsWith("//")) url = `https:${url}`;
  if (url.includes("duckduckgo.com/l/")) {
    const match = url.match(/[?&]uddg=([^&]+)/);
    if (match) {
      try {
        return decodeURIComponent(match[1]);
      } catch {
        return url;
      }
    }
  }
  return url;
}

function isUsefulUrl(url: string, blockHosts: string[] = []): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  const lower = url.toLowerCase();
  if (lower.includes("duckduckgo.com/y.js")) return false;
  if (lower.startsWith("https://duckduckgo.com/")) return false;
  if (lower.includes("duckduckgo.com/l/")) return false;
  return !blockHosts.some((host) => lower.includes(host));
}

function normalizeKey(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.hostname.replace(/^www\./, "")}${parsed.pathname.replace(/\/$/, "")}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

/** Pair each title anchor with the snippet that follows it, before the next title. */
function parsePairs(
  html: string,
  titleClass: string,
  snippetTags: string[],
  snippetClass: string,
  engine: string,
): SearchHit[] {
  const anchors = collectTags(html, "a").filter((chunk) => (getAttr(chunk.attrs, "class") ?? "").includes(titleClass));
  const snippets = snippetTags
    .flatMap((tag) => collectTags(html, tag))
    .filter((chunk) => (getAttr(chunk.attrs, "class") ?? "").includes(snippetClass))
    .sort((a, b) => a.start - b.start);

  const hits: SearchHit[] = [];
  for (let i = 0; i < anchors.length; i += 1) {
    const anchor = anchors[i];
    const href = getAttr(anchor.attrs, "href");
    if (!href) continue;

    const url = unwrapUrl(href);
    if (!isUsefulUrl(url)) continue;

    const title = stripTags(anchor.inner);
    if (title.length < 2) continue;

    const limit = anchors[i + 1]?.start ?? Number.MAX_SAFE_INTEGER;
    const snippetChunk = snippets.find((chunk) => chunk.start > anchor.end && chunk.start < limit);
    hits.push({ title, url, snippet: snippetChunk ? stripTags(snippetChunk.inner) : "", engine });
  }
  return hits;
}

/** Last resort for DuckDuckGo: every external link with decent anchor text. */
function parseFallbackLinks(html: string, engine: string): SearchHit[] {
  const hits: SearchHit[] = [];
  for (const anchor of collectTags(html, "a")) {
    const href = getAttr(anchor.attrs, "href");
    if (!href) continue;
    const url = unwrapUrl(href);
    if (!isUsefulUrl(url)) continue;
    const title = stripTags(anchor.inner);
    if (title.length < 12 || title.length > 200) continue;
    hits.push({ title, url, snippet: "", engine });
    if (hits.length >= 20) break;
  }
  return hits;
}

function dedupe(hits: SearchHit[], limit: number): SearchHit[] {
  const seen = new Set<string>();
  const unique: SearchHit[] = [];
  for (const hit of hits) {
    const key = normalizeKey(hit.url);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(hit);
    if (unique.length >= limit) break;
  }
  return unique;
}

interface EngineResult {
  hits: SearchHit[];
  captcha?: boolean;
}

async function searchDdgHtml(query: string, signal: AbortSignal | undefined): Promise<EngineResult> {
  const body = new URLSearchParams({ q: query, kl: "wt-wt", b: "" }).toString();
  const { status, text } = await request(
    DDG_HTML,
    { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    signal,
    15000,
  );
  if (isCaptcha(status, text)) return { hits: [], captcha: true };
  if (status >= 400) throw new Error(`HTTP ${status}`);
  const hits = parsePairs(text, "result__a", ["a", "div", "span"], "result__snippet", "DuckDuckGo");
  return { hits: hits.length > 0 ? hits : parseFallbackLinks(text, "DuckDuckGo") };
}

async function searchDdgLite(query: string, signal: AbortSignal | undefined): Promise<EngineResult> {
  const body = new URLSearchParams({ q: query, kl: "wt-wt" }).toString();
  const { status, text } = await request(
    DDG_LITE,
    { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    signal,
    15000,
  );
  if (isCaptcha(status, text)) return { hits: [], captcha: true };
  if (status >= 400) throw new Error(`HTTP ${status}`);
  const hits = parsePairs(text, "result-link", ["td", "a", "div", "span"], "result-snippet", "DuckDuckGo");
  return { hits: hits.length > 0 ? hits : parseFallbackLinks(text, "DuckDuckGo") };
}

/** Bing wraps result links in `bing.com/ck/a?...&u=a1<base64url>`. */
function decodeBingUrl(href: string): string {
  const url = href.replace(/&amp;/g, "&").trim();
  const match = url.match(/[?&]u=a1([^&]+)/);
  if (!match) return url;
  try {
    const base64 = match[1].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = Buffer.from(base64, "base64").toString("utf8");
    return /^https?:\/\//i.test(decoded) ? decoded : url;
  } catch {
    return url;
  }
}

function parseBing(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const blocks = html.split(/<li class="b_algo"/i).slice(1);
  for (const block of blocks) {
    const anchor = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const url = decodeBingUrl(anchor[1]);
    if (!isUsefulUrl(url, ["bing.com", "microsoft.com", "msn.com"])) continue;
    const title = stripTags(anchor[2]);
    if (title.length < 2) continue;
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    hits.push({
      title,
      url,
      snippet: snippetMatch ? stripTags(snippetMatch[1]) : "",
      engine: "Bing",
    });
  }
  return hits;
}

async function searchBing(query: string, signal: AbortSignal | undefined): Promise<EngineResult> {
  // `form=QBRE` matters: without it Bing serves a degraded page with junk results.
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&form=QBRE&qs=n&sp=-1`;
  const { status, text } = await request(url, { method: "GET" }, signal, 15000);
  if (status >= 400) throw new Error(`HTTP ${status}`);
  return { hits: parseBing(text) };
}

function wikipediaLanguage(query: string): string {
  return /[а-яё]/i.test(query) ? "ru" : "en";
}

async function searchWikipedia(query: string, signal: AbortSignal | undefined): Promise<EngineResult> {
  const lang = wikipediaLanguage(query);
  const url =
    `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=5&srsearch=` +
    encodeURIComponent(query);
  const { status, text } = await request(url, { method: "GET", headers: { Accept: "application/json" } }, signal, 12000);
  if (status >= 400) throw new Error(`HTTP ${status}`);

  const payload = JSON.parse(text) as { query?: { search?: { title: string; snippet: string }[] } };
  const items = payload.query?.search ?? [];
  return {
    hits: items.map((item) => ({
      title: item.title,
      url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, "_"))}`,
      snippet: stripTags(item.snippet ?? ""),
      engine: "Wikipedia",
    })),
  };
}

/**
 * Settings can come from environment variables or from a JSON file that does
 * not depend on how LM Studio was launched:
 *   %USERPROFILE%\.lmstudio\web-search-config.json
 *   { "serperApiKey": "...", "braveApiKey": "...", "googleApiKey": "...", "googleCseId": "..." }
 */
let fileSettings: Record<string, string> | null = null;

function loadFileSettings(): Record<string, string> {
  if (fileSettings) return fileSettings;
  const candidates = [
    join(homedir(), ".lmstudio", "web-search-config.json"),
    join(homedir(), ".lmstudio", "extensions", "plugins", "dozzics", "web-search", "config.json"),
  ];
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        fileSettings = parsed as Record<string, string>;
        return fileSettings;
      }
    } catch {
      // missing or invalid file - try the next location
    }
  }
  fileSettings = {};
  return fileSettings;
}

function setting(fileKey: string, envKey: string): string | undefined {
  const fromEnv = process.env[envKey]?.trim();
  if (fromEnv) return fromEnv;
  const fromFile = loadFileSettings()[fileKey];
  return typeof fromFile === "string" && fromFile.trim() ? fromFile.trim() : undefined;
}

/**
 * Optional API engines. They are used first when a key is present in the
 * environment, which avoids HTML scraping and its rate limits altogether.
 */
async function searchBrave(query: string, signal: AbortSignal | undefined): Promise<EngineResult> {
  const key = setting("braveApiKey", "BRAVE_API_KEY");
  if (!key) return { hits: [] };
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=10&safesearch=moderate`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": key, "User-Agent": USER_AGENT },
    signal: withTimeout(signal, 15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as {
    web?: { results?: { title?: string; url?: string; description?: string }[] };
  };
  return {
    hits: (json.web?.results ?? [])
      .filter((item) => item.url)
      .map((item) => ({
        title: stripTags(item.title ?? ""),
        url: item.url as string,
        snippet: stripTags(item.description ?? ""),
        engine: "Brave",
      })),
  };
}

/** Serper.dev: Google results over a simple JSON API (2,500 free queries). */
async function searchSerper(query: string, signal: AbortSignal | undefined): Promise<EngineResult> {
  const key = setting("serperApiKey", "SERPER_API_KEY");
  if (!key) return { hits: [] };
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: { "X-API-KEY": key, "Content-Type": "application/json" },
    body: JSON.stringify({ q: query, num: 10 }),
    signal: withTimeout(signal, 15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { organic?: { title?: string; link?: string; snippet?: string }[] };
  return {
    hits: (json.organic ?? [])
      .filter((item) => item.link)
      .map((item) => ({
        title: stripTags(item.title ?? ""),
        url: item.link as string,
        snippet: stripTags(item.snippet ?? ""),
        engine: "Serper",
      })),
  };
}

/** Google programmable search: 100 free queries per day. */
async function searchGoogleCse(query: string, signal: AbortSignal | undefined): Promise<EngineResult> {
  const key = setting("googleApiKey", "GOOGLE_API_KEY");
  const cx = setting("googleCseId", "GOOGLE_CSE_ID");
  if (!key || !cx) return { hits: [] };
  const url =
    `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(key)}` +
    `&cx=${encodeURIComponent(cx)}&num=10&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: withTimeout(signal, 15000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as { items?: { title?: string; link?: string; snippet?: string }[] };
  return {
    hits: (json.items ?? [])
      .filter((item) => item.link)
      .map((item) => ({
        title: stripTags(item.title ?? ""),
        url: item.link as string,
        snippet: stripTags(item.snippet ?? ""),
        engine: "Google",
      })),
  };
}

const API_ENGINES: [string, (query: string, signal: AbortSignal | undefined) => Promise<EngineResult>][] = [
  ["brave", searchBrave],
  ["serper", searchSerper],
  ["google-cse", searchGoogleCse],
];

function cacheGet(key: string): SearchOutcome | null {
  const entry = searchCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > SEARCH_CACHE_TTL_MS) {
    searchCache.delete(key);
    return null;
  }
  return entry.outcome;
}

function cacheSet(key: string, outcome: SearchOutcome): void {
  if (searchCache.size > 40) searchCache.clear();
  searchCache.set(key, { at: Date.now(), outcome });
}

/**
 * Search the web: DuckDuckGo first, then Bing, then Wikipedia.
 * Returns whatever worked plus notes about what did not, so the model can tell
 * a temporary block apart from "this does not exist".
 */
export async function searchWeb(
  query: string,
  limit: number,
  signal?: AbortSignal,
): Promise<SearchOutcome> {
  const cacheKey = query.trim().toLowerCase();
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const notes: string[] = [];
  let captcha = false;

  const finish = (hits: SearchHit[], engine: string): SearchOutcome => {
    const outcome: SearchOutcome = { hits: dedupe(hits, limit), engine, captcha, notes };
    if (outcome.hits.length > 0) cacheSet(cacheKey, outcome);
    return outcome;
  };

  // Keyed API engines are tried first: no scraping, no captchas.
  for (const [name, engine] of API_ENGINES) {
    try {
      const result = await engine(query, signal);
      if (result.hits.length > 0) return finish(result.hits, result.hits[0].engine);
    } catch (error) {
      notes.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const ddgCoolingDown = Date.now() < ddgBlockedUntil;

  if (!ddgCoolingDown) {
    try {
      const html = await searchDdgHtml(query, signal);
      if (html.hits.length > 0) return finish(html.hits, "DuckDuckGo");
      if (html.captcha) captcha = true;
    } catch (error) {
      notes.push(`duckduckgo: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      const lite = await searchDdgLite(query, signal);
      if (lite.hits.length > 0) return finish(lite.hits, "DuckDuckGo");
      if (lite.captcha) captcha = true;
    } catch (error) {
      notes.push(`duckduckgo-lite: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    notes.push("duckduckgo: skipped (recent captcha)");
  }

  if (captcha) {
    ddgBlockedUntil = Date.now() + DDG_COOLDOWN_MS;
    notes.push("duckduckgo: captcha (rate limit)");
  }

  try {
    const bing = await searchBing(query, signal);
    if (bing.hits.length > 0) return finish(bing.hits, "Bing");
    notes.push("bing: no results");
  } catch (error) {
    notes.push(`bing: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const wiki = await searchWikipedia(query, signal);
    if (wiki.hits.length > 0) return finish(wiki.hits, "Wikipedia");
    notes.push("wikipedia: no results");
  } catch (error) {
    notes.push(`wikipedia: ${error instanceof Error ? error.message : String(error)}`);
  }

  return { hits: [], engine: "", captcha, notes };
}

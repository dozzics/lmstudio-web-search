# Web Search for LM Studio

A tools plugin that gives local models in [LM Studio](https://lmstudio.ai) a real internet connection:
it searches with Serper or a fallback engine, **reads the top pages itself**, extracts the text and hands the model a
ready-to-use digest of facts — with direct links to the source pages.

> Local models usually answer questions about current events with *"I don't have internet access,
> please search for it yourself."* This plugin fixes that: the model calls `web_search`, gets page
> text back, and answers from facts.

## Demo

Without the plugin:

> I don't have access to the internet. Please search for this information yourself.

With the plugin:

```
Capri (Project Capricorn) is a personality construct from Cyberpunk: Edgerunners 2.
She has no physical form and can only project herself for her current subject…
Sources: [cyberpunk.fandom.com](https://cyberpunk.fandom.com/wiki/Capri), [hero.fandom.com](https://hero.fandom.com/wiki/Capri_(Cyberpunk))
```

## Features

- **Two tools:** `web_search` (search + read pages) and `open_page` (open a specific URL).
- **Returns text, not links.** The model doesn't need to browse — it receives the facts directly.
- **Resilient search:** Serper (with a key) → DuckDuckGo HTML/Lite → other configured APIs → Bing → Wikipedia. Empty or unrelated results trigger fallback.
- **Captcha detection:** DuckDuckGo answers with HTTP 202 and an `anomaly.js` page when rate-limited;
  the plugin detects it, skips DuckDuckGo for 90 seconds and switches engines instead of looping.
- **Honest failures:** when every engine is down, the model is told it is a *technical problem*,
  not proof that the subject doesn't exist.
- **Readability-style extraction:** picks the block with the most text and the fewest links,
  not the whole page with menus.
- **Clean text:** strips wiki markup and embedded JSON (e.g. Wikipedia's `data-mw` wikitext blobs),
  so the model receives prose instead of `{{templates}}` and `{"wt":"…"}` noise.
- **Strict answer rules:** the model may use only facts from the fetched text — no names, dates or
  numbers from memory, and proper names must be copied verbatim, never transliterated.
- **Mandatory search for factual questions:** the tool description tells the model to call
  `web_search` before answering anything that needs exact facts, lists, tables, note names, chords,
  code or formulas — and never to build such tables from memory.
- **Query hints for niche facts:** for "what key/BPM is this song" questions the query gets an
  explicit `key bpm` hint, and music-data sites (songbpm, songdata, tunebat, 12notez) are ranked
  above tab and sequencer pages. For "tell me about this track" the plugin also runs a second,
  focused key/BPM search so the key is present even when the question is generic.
- **Junk filtering:** when a fallback engine serves unrelated anti-bot results, they are discarded
  and the tool reports a technical failure instead of feeding the model nonsense.
- **Fandom via the MediaWiki API**, bypassing the Cloudflare challenge on regular requests.
- **Relevance ranking:** title matches weigh more than snippets; prefix fuzzy matching tolerates
  typos (`cyberpank` → `Cyberpunk`).
- **One-line sources:** the model is asked to put clickable links to the pages it used on the last line.
- **Caching:** search results for 5 minutes, pages for 10 minutes.

## Installation

### From LM Studio Hub (one click)

Open **https://lmstudio.ai/dozzics/web-search** and press **Run in LM Studio**,
or search for `dozzics/web-search` in the Hub inside the app.

### From source

Requires [LM Studio](https://lmstudio.ai) and Node.js 20+.

```powershell
git clone https://github.com/DOZZIcs/lmstudio-web-search.git
cd lmstudio-web-search
npm install
npm run build

# install the plugin into LM Studio
& "$env:USERPROFILE\.lmstudio\bin\lms.exe" dev --install -y
```

If `lms` is already on your PATH, the last line is just `lms dev --install -y`.

After installing, **restart LM Studio**, open the **Integrations** panel (icon next to the chat
input) and enable `dozzics/web-search`. A tools button will appear in the input field.

The model must support tool calling — gemma, qwen, llama 3.x, mistral and others work.
If another plugin exposes similar tools (for example `alex-garbar/web-search`), disable it:
two sets of tools conflict.

## Usage

`web_search(query, pages)`:

| Parameter | Description |
|---|---|
| `query` | Search query in the language of the question |
| `pages` | How many top pages to read in full, 0–5 (default 3). `0` = search results with snippets only |

`open_page(url, offset?)` reads up to 12,000 characters from a page. Pass the returned `next_offset` as `offset` to continue.

The model calls the tools on its own when the plugin is enabled in the chat. Sometimes it helps to
ask explicitly: *"search the web for who Capri from Edgerunners 2 is"*.

The model is asked to answer in the user's language and to flag unresolved conflicts between sources.

## Testing without LM Studio

```powershell
npm run build
node smoke-test.js "who is Capri from Cyberpunk Edgerunners 2" 3
```

The script runs the same pipeline (search → read → digest) and prints exactly what the model receives.

## How it works

1. The query goes to `html.duckduckgo.com` (POST, with `lite.duckduckgo.com` as a twin).
2. The plugin collects titles, URLs and snippets from the results and ranks them by relevance.
3. It opens the top 3–5 pages and extracts the main text (readability-style heuristics).
4. If a page is rendered entirely by JavaScript, the next result is used instead.
5. Fandom pages blocked by Cloudflare are read through the MediaWiki API.
6. Search returns contiguous page text in its original order, up to 12,000 characters per page and 36,000 across selected pages. Longer pages include a continuation offset.
7. The digest identifies each source by URL. It asks the model to verify conflicting claims and distinguish confirmed events from forecasts.

### When search engines block requests

DuckDuckGo starts answering with a captcha page (HTTP 202, `anomaly.js`) under heavy use.
The plugin recognises it by status code and markup, skips DuckDuckGo for 90 seconds and switches to
Bing (`form=QBRE`, links unwrapped from the `bing.com/ck/a` redirect), then to the Wikipedia API.
The digest then contains `engine: Bing` and a note that these are fallback but still real results.

If no engine works, the tool returns `[WEB SEARCH FAILED - TECHNICAL PROBLEM]`: the model should
offer to retry in a minute instead of claiming the information does not exist.

## Project layout

```
manifest.json          plugin manifest (owner/name)
index.js               entry point, loads the bundle from .lmstudio/
src/index.ts           tools provider registration
src/toolsProvider.ts   tool descriptions shown to the model
src/research.ts        search + page reading + answer formatting
src/search.ts          engine scraping, captcha handling, cache, fallbacks
src/extract.ts         HTML → text, relevant fragment selection
smoke-test.js          pipeline runner without LM Studio
```

Dependencies are minimal: `@lmstudio/sdk` and `zod`. HTTP uses the built-in `fetch`.

### Optional: API keys (bypass rate limits)

HTML scraping is free but rate-limited. If captchas get in the way, add an API key. The plugin reads
keys from a config file (works regardless of how LM Studio was launched) or from environment variables:

```
%USERPROFILE%\.lmstudio\web-search-config.json
```

```json
{
  "serperApiKey": "your-key",
  "braveApiKey": "optional",
  "googleApiKey": "optional",
  "googleCseId": "optional"
}
```

| Engine | Config key / env variable | Free tier |
|---|---|---|
| Brave Search API | `braveApiKey` / `BRAVE_API_KEY` | 2,000 queries / month |
| Serper.dev (Google results) | `serperApiKey` / `SERPER_API_KEY` | 2,500 queries once |
| Google Programmable Search | `googleApiKey` + `googleCseId` | 100 queries / day |

Environment variables (alternative), then restart LM Studio:

```powershell
setx SERPER_API_KEY "your-key-here"
```

Without keys the plugin falls back to DuckDuckGo → Bing → Wikipedia as before.

## Limitations

- DuckDuckGo captchas depend on your IP and are temporary; meanwhile Bing (and Wikipedia for
  encyclopedic questions) takes over.
- Sites rendered entirely in JavaScript (e.g. weather widgets) expose only their description and
  search snippet — the plugin marks this explicitly in the text.
- PDF and binary files are not parsed.
- A proxy or corporate filter may block the search engines.

## License

[MIT](https://github.com/DOZZIcs/lmstudio-web-search/blob/main/LICENSE). Not affiliated with
LM Studio or Element Labs.

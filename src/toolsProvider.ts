import { tool, type Tool, type ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import { clampPages, MAX_PAGES, DEFAULT_PAGES, readUrl, researchWeb } from "./research";

export async function toolsProvider(_ctl: ToolsProviderController): Promise<Tool[]> {
  const webSearch = tool({
    name: "web_search",
    description: [
      "Search the internet and read the top pages. Returns real page text, not links.",
      "You MUST call this tool BEFORE answering any request that needs exact facts: news, weather, prices, releases, dates, specifications, statistics, people, companies, products, code, API references, formulas, tables, lists, music theory (notes, scales, chords, keys), recipes, schedules, medical or legal information.",
      "Never generate lists, tables, chord charts, note names, code or formulas from memory - even when you are confident. Memory is often wrong and the user will see the mistake.",
      "If the user asks for a table or a full list (for example chords in all keys), search first, then build the table strictly from the fetched text.",
      "The user expects a finished answer: after calling this tool, answer from its output and never ask the user to search or open links.",
      "If the user asks a follow-up about the same subject (for example 'what key is it in', 'how long is it'), call this tool again with the subject and the aspect, e.g. '<track> key bpm'. Never answer that you already searched.",
      "Put clickable links to the pages used only on the final Sources line. Keep citations and URLs out of the answer body. For official confirmation, include the known official domain with site: in the query or open the official result with open_page.",
    ].join(" "),
    parameters: {
      query: z
        .string()
        .min(1)
        .describe("Search query, written the way a person would type it into a search engine, in the language of the question."),
      pages: z
        .number()
        .int()
        .min(0)
        .max(MAX_PAGES)
        .optional()
        .describe(`How many top pages to read in full (0-${MAX_PAGES}). Default ${DEFAULT_PAGES}.`),
    },
    implementation: async ({ query, pages }, { signal, status }) => {
      return await researchWeb(query, clampPages(pages), signal, (message) => status(message));
    },
  });

  const openPage = tool({
    name: "open_page",
    description:
      "Open a specific URL and return its readable text. Use it when the user pastes a link, or when web_search results need more detail from one page.",
    parameters: {
      url: z.string().min(3).describe("Full URL, e.g. https://example.com/article"),
    },
    implementation: async ({ url }, { signal, status }) => {
      return await readUrl(url, signal, (message) => status(message));
    },
  });

  return [webSearch, openPage];
}

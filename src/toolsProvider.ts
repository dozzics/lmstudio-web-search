import { tool, type Tool, type ToolsProviderController } from "@lmstudio/sdk";
import { z } from "zod";
import { clampPages, MAX_PAGES, DEFAULT_PAGES, readUrl, researchWeb } from "./research";

export async function toolsProvider(_ctl: ToolsProviderController): Promise<Tool[]> {
  const webSearch = tool({
    name: "web_search",
    description: [
      "Search the internet with DuckDuckGo AND read the top pages. Returns the actual page text, not just links.",
      "Use it for ANY question about current events, news, weather, prices, releases, products, people, companies, documentation or anything you are not 100% sure about.",
      "The user expects a finished answer: after calling this tool, answer from its output and never ask the user to search or open links.",
      "Finish the answer with the short markdown 'SOURCES LINE' from the tool output, copied verbatim.",
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

// Web search for API/docs discovery: Brave Search API when BRAVE_API_KEY is
// set, otherwise (or when Brave fails) DuckDuckGo's HTML results page.

export type WebSearchResult = { title: string; url: string; snippet: string };
export type WebSearch = (query: string) => Promise<WebSearchResult[]>;

const MAX_RESULTS = 8;
const TIMEOUT_MS = 8_000;

export function createWebSearch(opts: { braveApiKey?: string; fetch?: typeof fetch }): WebSearch {
  const doFetch = opts.fetch ?? fetch;
  return async (query) => {
    if (opts.braveApiKey) {
      try {
        const results = await braveSearch(query, opts.braveApiKey, doFetch);
        if (results.length > 0) return results;
      } catch (error) {
        console.warn("[agent] Brave search failed; falling back to DuckDuckGo", error instanceof Error ? error.message : error);
      }
    }
    return duckDuckGoSearch(query, doFetch);
  };
}

async function braveSearch(query: string, apiKey: string, doFetch: typeof fetch): Promise<WebSearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${MAX_RESULTS}`;
  const response = await doFetch(url, {
    headers: { Accept: "application/json", "X-Subscription-Token": apiKey },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Brave search returned HTTP ${response.status}`);
  const body = (await response.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
  return (body.web?.results ?? [])
    .filter((result) => typeof result.url === "string")
    .slice(0, MAX_RESULTS)
    .map((result) => ({
      title: stripHtml(result.title ?? ""),
      url: result.url as string,
      snippet: stripHtml(result.description ?? ""),
    }));
}

async function duckDuckGoSearch(query: string, doFetch: typeof fetch): Promise<WebSearchResult[]> {
  const response = await doFetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0 (compatible; OysterAgent/1.0)" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`DuckDuckGo search returned HTTP ${response.status}`);
  return parseDuckDuckGoHtml(await response.text());
}

/** Extracts results from DuckDuckGo's HTML endpoint, unwrapping its `/l/?uddg=` redirect links. */
export function parseDuckDuckGoHtml(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/).slice(1);
  for (const block of blocks) {
    const link = /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/.exec(block);
    if (!link) continue;
    const url = unwrapDuckDuckGoLink(decodeEntities(link[1] ?? ""));
    if (!url) continue;
    const snippet = /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(block)?.[1] ?? "";
    results.push({ title: stripHtml(link[2] ?? ""), url, snippet: stripHtml(snippet) });
    if (results.length === MAX_RESULTS) break;
  }
  return results;
}

function unwrapDuckDuckGoLink(href: string): string | null {
  try {
    const url = new URL(href, "https://duckduckgo.com");
    if (url.hostname.endsWith("duckduckgo.com") && url.pathname.startsWith("/l/")) {
      return url.searchParams.get("uddg");
    }
    // Ads point back into duckduckgo.com (`/y.js`); skip them.
    if (url.hostname.endsWith("duckduckgo.com")) return null;
    return url.href;
  } catch {
    return null;
  }
}

function stripHtml(text: string): string {
  return decodeEntities(text.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim();
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

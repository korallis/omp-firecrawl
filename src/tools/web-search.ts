/**
 * `web_search` + `firecrawl_search` — Firecrawl `/v2/search`.
 *
 * `web_search` shadows the built-in tool, so every existing prompt, skill and
 * unrestricted subagent that already calls `web_search` routes through
 * Firecrawl with no rewiring, and on failure the call is delegated back to the
 * native provider chain via `ctx.invokeTool`.
 *
 * `firecrawl_search` registers the same implementation under a name that cannot
 * collide. A restricted session — an agent with an explicit `tools:` list, or
 * `--tools web_search` — resolves the *built-in* `web_search`, so those callers
 * need this alias to reach Firecrawl directly.
 */

import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";

import {
	type FirecrawlDocument,
	failFrom,
	type OutputWriter,
	ok,
	renderDocument,
	type ToolResult,
} from "../core/output.ts";
import { scrapeOptionsSchema } from "../core/schema.ts";
import { compact, defineTool, type FirecrawlToolEnv, type FirecrawlToolModule } from "../core/tool.ts";

/** `recency` maps onto Google's `tbs` time filter, which Firecrawl forwards. */
const RECENCY_TBS: Record<string, string> = {
	hour: "qdr:h",
	day: "qdr:d",
	week: "qdr:w",
	month: "qdr:m",
	year: "qdr:y",
};

interface WebResult extends FirecrawlDocument {
	title?: string;
	description?: string;
	url?: string;
	position?: number;
	category?: string;
}

interface NewsResult extends FirecrawlDocument {
	title?: string;
	snippet?: string;
	url?: string;
	date?: string;
	imageUrl?: string;
	position?: number;
}

interface ImageResult {
	title?: string;
	imageUrl?: string;
	imageWidth?: number;
	imageHeight?: number;
	url?: string;
	position?: number;
}

interface SearchResponse {
	success?: boolean;
	warning?: string;
	data?: {
		web?: WebResult[];
		news?: NewsResult[];
		images?: ImageResult[];
	};
}

function line(index: number, title: string | undefined, url: string | undefined, extra?: string): string {
	const head = `[${index}] ${title?.trim() || "(untitled)"}`;
	return extra ? `${head}\n    ${url ?? ""}\n    ${extra}` : `${head}\n    ${url ?? ""}`;
}

function snippet(text: string | undefined, limit = 320): string | undefined {
	if (!text) return undefined;
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed === "") return undefined;
	return collapsed.length > limit ? `${collapsed.slice(0, limit - 1)}…` : collapsed;
}

const module: FirecrawlToolModule = (env: FirecrawlToolEnv) => {
	const { z, client, out } = env;

	const parameters = z.object({
		query: z
			.string()
			.describe(
				'Search query. Google-style operators work: site:, -site:, inurl:, intitle:, filetype:, "exact phrase", -term, OR.',
			),
		limit: z.number().int().optional().describe("Max results per source (1-100, default 10)"),
		recency: z
			.enum(["hour", "day", "week", "month", "year"])
			.optional()
			.describe("Restrict to recently published pages"),
		sources: z
			.array(z.enum(["web", "news", "images"]))
			.optional()
			.describe("Result families to query. Default ['web']."),
		categories: z
			.array(z.enum(["github", "research", "pdf"]))
			.optional()
			.describe("Narrow to a corpus: 'github' repos/code, 'research' papers, 'pdf' documents."),
		includeDomains: z.array(z.string()).optional().describe("Restrict to these hostnames (no protocol/path)"),
		excludeDomains: z.array(z.string()).optional().describe("Exclude these hostnames"),
		location: z.string().optional().describe("Geo hint, e.g. 'London,England,United Kingdom'"),
		country: z.string().optional().describe("ISO country code for geo-targeting, default 'US'"),
		tbs: z.string().optional().describe("Raw Google tbs filter; overrides `recency` (e.g. 'sbd:1' to sort by date)"),
		safe: z.boolean().optional().describe("Enable SafeSearch filtering"),
		highlights: z
			.boolean()
			.optional()
			.describe("Return query-relevant extracted passages instead of site descriptions. Default true."),
		scrape: z
			.boolean()
			.optional()
			.describe("Also fetch full page content for every result (slower, costs credits per page)"),
		scrapeOptions: scrapeOptionsSchema(z)
			.optional()
			.describe("Scrape configuration when `scrape` is true; defaults to markdown with cache reuse."),
		ignoreInvalidURLs: z.boolean().optional().describe("Drop results that other Firecrawl endpoints cannot process"),
		timeout: z.number().int().optional().describe("Search timeout in ms (default 60000)"),
		maxChars: z
			.number()
			.int()
			.optional()
			.describe("Inline character budget per scraped page before spilling to a file"),
		fallback: z
			.boolean()
			.optional()
			.describe("On Firecrawl failure, retry through omp's built-in search providers. Default true."),
		num_search_results: z.number().int().optional().describe("Alias for `limit`, accepted for built-in compatibility"),
		max_tokens: z.number().int().optional().describe("Accepted for built-in compatibility; unused by Firecrawl"),
		temperature: z.number().optional().describe("Accepted for built-in compatibility; unused by Firecrawl"),
	});

	const description =
		"Search the web through Firecrawl and get ranked results with query-relevant highlights, optionally with full page content. Supports Google operators, domain include/exclude, recency, geo-targeting, and corpus filters (github/research/pdf). Falls back to omp's built-in providers if Firecrawl fails.";

	type SearchParams = typeof parameters extends { readonly _output: infer Out } ? Out : never;

	// One implementation, registered twice. `ctx.invokeTool` is present only for
	// the `web_search` registration, which is what gates native fallback.
	const execute = async (
		_id: string,
		params: SearchParams,
		signal: AbortSignal | undefined,
		_onUpdate: unknown,
		ctx: ExtensionContext,
	): Promise<ToolResult> => {
		const limit = params.limit ?? params.num_search_results;
		const scrapeOptions = params.scrape
			? compact({ formats: ["markdown"], onlyMainContent: true, ...(params.scrapeOptions ?? {}) })
			: params.scrapeOptions
				? compact(params.scrapeOptions)
				: undefined;

		const body = compact({
			query: params.query,
			limit,
			sources: params.sources?.map((type) => ({ type })),
			categories: params.categories?.map((type) => ({ type })),
			includeDomains: params.includeDomains,
			excludeDomains: params.excludeDomains,
			location: params.location,
			country: params.country,
			tbs: params.tbs ?? (params.recency ? RECENCY_TBS[params.recency] : undefined),
			safe: params.safe,
			highlights: params.highlights,
			ignoreInvalidURLs: params.ignoreInvalidURLs,
			timeout: params.timeout,
			scrapeOptions,
		});

		try {
			const response = await client.request<SearchResponse>("/search", {
				method: "POST",
				body,
				signal,
				timeoutMs: params.timeout ? params.timeout + 15_000 : undefined,
			});
			const text = await renderSearch(out, response, params.maxChars);
			if (text === undefined) {
				throw new Error(`Firecrawl returned no results for "${params.query}"`);
			}
			return ok(text, {
				provider: "firecrawl",
				authMode: client.auth.lastResolved.mode,
				counts: {
					web: response.data?.web?.length ?? 0,
					news: response.data?.news?.length ?? 0,
					images: response.data?.images?.length ?? 0,
				},
			});
		} catch (error) {
			if (signal?.aborted) throw error;
			// `invokeTool` exists only for the shadowed `web_search` registration,
			// so the alias simply reports the failure instead of delegating.
			const native = ctx.invokeTool;
			if (params.fallback !== false && native) {
				const reason = error instanceof Error ? error.message : String(error);
				const delegated = await native(
					compact({
						query: params.query,
						limit,
						recency: params.recency === "hour" ? "day" : params.recency,
						num_search_results: params.num_search_results,
						max_tokens: params.max_tokens,
						temperature: params.temperature,
					}),
					{ signal },
				);
				const head = {
					type: "text" as const,
					text: `Note: Firecrawl search failed (${reason}); used omp's built-in providers.`,
				};
				return { ...delegated, content: [head, ...delegated.content] };
			}
			return failFrom(error, signal);
		}
	};

	return [
		defineTool({
			name: "web_search",
			label: "Web Search",
			description,
			parameters,
			loadMode: "essential",
			approval: "read",
			execute,
		}),
		defineTool({
			// A restricted session (an agent with an explicit `tools:` list, or
			// `--tools web_search`) resolves the built-in `web_search` rather than
			// this shadow, so agents need a name that cannot collide.
			name: "firecrawl_search",
			label: "Firecrawl Search",
			description: `${description} Identical to web_search; use this name from agents with an explicit tool list, where the built-in web_search wins.`,
			parameters,
			loadMode: "essential",
			approval: "read",
			execute,
		}),
	];
};

/** Render Firecrawl's per-source arrays into one flat, cited list. */
async function renderSearch(
	out: OutputWriter,
	response: SearchResponse,
	maxChars: number | undefined,
): Promise<string | undefined> {
	const sections: string[] = [];
	let index = 0;

	const web = response.data?.web ?? [];
	if (web.length > 0) {
		const rows: string[] = [];
		for (const result of web) {
			index += 1;
			const tail = [snippet(result.description)].filter(Boolean).join(" ");
			rows.push(line(index, result.title, result.url, tail || undefined));
			if (result.markdown || result.json !== undefined || result.summary) {
				rows.push(await renderDocument(out, result, { label: result.url, inlineChars: maxChars }));
			}
		}
		sections.push(`## Web (${web.length})\n${rows.join("\n")}`);
	}

	const news = response.data?.news ?? [];
	if (news.length > 0) {
		const rows: string[] = [];
		for (const result of news) {
			index += 1;
			const tail = [result.date, snippet(result.snippet)].filter(Boolean).join(" — ");
			rows.push(line(index, result.title, result.url, tail || undefined));
			if (result.markdown) {
				rows.push(await renderDocument(out, result, { label: result.url, inlineChars: maxChars }));
			}
		}
		sections.push(`## News (${news.length})\n${rows.join("\n")}`);
	}

	const images = response.data?.images ?? [];
	if (images.length > 0) {
		sections.push(
			`## Images (${images.length})\n${images
				.map((image, position) => {
					const size = image.imageWidth && image.imageHeight ? ` ${image.imageWidth}x${image.imageHeight}` : "";
					return `[${position + 1}] ${image.title ?? "(untitled)"}${size}\n    ${image.imageUrl ?? ""}\n    page: ${image.url ?? ""}`;
				})
				.join("\n")}`,
		);
	}

	if (sections.length === 0) return undefined;
	if (response.warning) sections.unshift(`Note: ${response.warning}`);
	return sections.join("\n\n");
}

export default module;

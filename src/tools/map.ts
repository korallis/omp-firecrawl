/**
 * `firecrawl_map` — `POST /v2/map`.
 *
 * URL discovery without scraping: Firecrawl combines the site's sitemap with
 * its own link index and returns the URL list (plus titles and descriptions
 * when known). This is the cheap, fast reconnaissance step before a crawl —
 * map first to see the shape of a site, then scrape or crawl only the paths
 * that matter.
 */
import { failFrom, ok } from "../core/output.ts";
import { locationSchema, threatProtectionSchema } from "../core/schema.ts";
import { compact, defineTool, type FirecrawlToolEnv, type FirecrawlToolModule } from "../core/tool.ts";

/** Inline row ceiling; longer link lists go to a file instead of the transcript. */
const INLINE_LINK_LIMIT = 100;

interface MapLink {
	url?: string;
	title?: string;
	description?: string;
}

interface MapResponse {
	success?: boolean;
	links?: MapLink[];
}

const module: FirecrawlToolModule = (env: FirecrawlToolEnv) => {
	const { z, client, out } = env;

	const parameters = z.object({
		url: z.string().describe("Base URL of the site to map, e.g. 'https://docs.firecrawl.dev'"),
		search: z
			.string()
			.optional()
			.describe(
				"Rank results by relevance to this query and keep the matching URLs first, e.g. 'blog' or 'pricing'. Use it to find a section without downloading every page.",
			),
		sitemap: z
			.enum(["skip", "include", "only"])
			.optional()
			.describe(
				"Sitemap mode, default 'include' (sitemap plus Firecrawl's other discovery methods). 'only' returns exactly the sitemap URLs; 'skip' ignores the sitemap entirely.",
			),
		includeSubdomains: z.boolean().optional().describe("Include URLs on subdomains of the base domain. Default true."),
		ignoreQueryParameters: z.boolean().optional().describe("Drop URLs that only differ by query string. Default true."),
		ignoreCache: z
			.boolean()
			.optional()
			.describe(
				"Bypass the sitemap cache for fresh URLs. Sitemap data is cached up to 7 days; set true only when the sitemap was just updated, since it is slower.",
			),
		limit: z.number().int().positive().optional().describe("Maximum links to return, default 5000, maximum 100000."),
		timeout: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Timeout in milliseconds. Unbounded by default; large sites can take a while."),
		location: locationSchema(z).optional().describe("Proxy country and emulated language for geo-varying sitemaps"),
		threatProtection: threatProtectionSchema(z)
			.optional()
			.describe("Per-request Threat Protection override for URL scanning (enterprise)"),
		auditMetadata: z
			.object({ username: z.string().describe("Username attributed to this request") })
			.optional()
			.describe("SIEM attribution metadata, when SIEM logging is enabled for the organization"),
		maxChars: z
			.number()
			.int()
			.optional()
			.describe("Inline character budget for the rendered link list before it is written to a file"),
	});

	return [
		defineTool({
			name: "firecrawl_map",
			label: "Firecrawl Map",
			description:
				"List a website's URLs with Firecrawl — sitemap plus Firecrawl's link index, with titles and descriptions when available. One fast request, no per-page scraping, so prefer this over firecrawl_crawl whenever you only need to know which pages exist, locate a docs/blog/pricing section (use `search`), or pick targets before scraping. Follow up with firecrawl_scrape for a single page or firecrawl_crawl for many.",
			parameters,
			approval: "read",
			async execute(_id, params, signal, _onUpdate, _ctx) {
				const { maxChars, ...body } = params;

				try {
					const response = await client.request<MapResponse>("/map", {
						method: "POST",
						body: compact(body),
						signal,
						timeoutMs: params.timeout === undefined ? undefined : params.timeout + 20_000,
						retryOn5xx: true,
					});

					const links = response.links ?? [];
					if (links.length === 0) {
						return ok(
							`No URLs found for ${params.url}.${params.search ? ` The \`search\` filter "${params.search}" may be too narrow — retry without it.` : " Try sitemap:'skip' to discover pages by following links instead."}`,
							{ url: params.url, count: 0 },
						);
					}

					const rows = links.map((link, position) => {
						const heading = `${position + 1}. ${link.url ?? "(missing url)"}${link.title ? ` — ${link.title}` : ""}`;
						return link.description ? `${heading}\n    ${link.description}` : heading;
					});
					const inlineBudget = maxChars ?? out.inlineChars;
					const shown = rows.slice(0, INLINE_LINK_LIMIT);
					let listing = shown.join("\n");
					let spilledPath: string | undefined;
					if (rows.length > shown.length || listing.length > inlineBudget) {
						const { path, bytes } = await out.spill(`map-${params.url}`, rows.join("\n"), "txt");
						spilledPath = path;
						const trimmed = listing.length > inlineBudget;
						if (trimmed) listing = listing.slice(0, inlineBudget);
						listing += `\n\n[showing ${shown.length} of ${rows.length} URLs${trimmed ? `, inline text trimmed to ${inlineBudget} chars` : ""}. Full list (${(bytes / 1024).toFixed(0)}KB) saved to ${path} — read it for the rest, or narrow the map with \`search\`/\`limit\`.]`;
					}

					const header = `# Site map for ${params.url} (${links.length} URL${links.length === 1 ? "" : "s"})${
						params.search ? `\nranked by relevance to "${params.search}"` : ""
					}`;
					return ok(`${header}\n\n${listing}`, {
						url: params.url,
						count: links.length,
						urls: links.slice(0, INLINE_LINK_LIMIT).map((link) => link.url),
						fullListPath: spilledPath,
					});
				} catch (error) {
					return failFrom(error, signal);
				}
			},
		}),
	];
};

export default module;

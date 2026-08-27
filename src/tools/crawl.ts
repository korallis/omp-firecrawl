/**
 * `firecrawl_crawl` — the whole `/v2/crawl` surface behind one `action` enum:
 * `POST /crawl`, `GET /crawl/{id}`, `DELETE /crawl/{id}`,
 * `GET /crawl/{id}/errors`, `GET /crawl/active` and `POST /crawl/params-preview`.
 *
 * A crawl is a long-running fan-out job: Firecrawl discovers URLs from the
 * entered page and the sitemap, scrapes each one with the shared
 * `scrapeOptions`, and exposes the result as a paginated job. This tool starts
 * the job, streams progress while polling, follows `next` pages, and renders
 * each returned document — spilling anything long to disk rather than pasting
 * a whole site into the transcript.
 */
import {
	type FirecrawlDocument,
	fail,
	failFrom,
	type OutputWriter,
	ok,
	renderDocument,
	stringify,
} from "../core/output.ts";
import { scrapeOptionsSchema, webhookSchema } from "../core/schema.ts";
import { compact, defineTool, type FirecrawlToolEnv, type FirecrawlToolModule } from "../core/tool.ts";

interface CrawlStartResponse {
	success?: boolean;
	id?: string;
	url?: string;
}

interface CrawlStatusResponse {
	status?: string;
	total?: number;
	completed?: number;
	creditsUsed?: number;
	expiresAt?: string;
	createdAt?: string;
	completedAt?: string;
	duration?: number;
	next?: string | null;
	data?: FirecrawlDocument[];
}

interface CrawlCancelResponse {
	status?: string;
}

interface CrawlErrorsResponse {
	errors?: Array<{ id?: string; timestamp?: string; url?: string; error?: string }>;
	robotsBlocked?: string[];
}

interface ActiveCrawlsResponse {
	success?: boolean;
	crawls?: Array<{ id?: string; teamId?: string; url?: string; options?: unknown }>;
}

interface CrawlParamsPreviewResponse {
	success?: boolean;
	data?: Record<string, unknown>;
}

/** Crawls only reach a terminal status through this vocabulary; anything else is still running. */
const TERMINAL_CRAWL_STATUSES: Record<string, true> = {
	completed: true,
	failed: true,
	cancelled: true,
	canceled: true,
};

function crawlHeadline(id: string, snapshot: CrawlStatusResponse): string {
	const facts: string[] = [`status: ${snapshot.status ?? "unknown"}`];
	if (snapshot.completed !== undefined || snapshot.total !== undefined) {
		facts.push(`pages: ${snapshot.completed ?? 0}/${snapshot.total ?? 0}`);
	}
	if (snapshot.creditsUsed !== undefined) facts.push(`credits used: ${snapshot.creditsUsed}`);
	if (snapshot.duration !== undefined) facts.push(`duration: ${snapshot.duration.toFixed(1)}s`);
	if (snapshot.createdAt) facts.push(`created: ${snapshot.createdAt}`);
	if (snapshot.completedAt) facts.push(`finished: ${snapshot.completedAt}`);
	if (snapshot.expiresAt) facts.push(`expires: ${snapshot.expiresAt}`);
	return `# Crawl ${id}\n${facts.join(" | ")}`;
}

/** Render up to `maxDocuments` crawled pages; the rest becomes a spilled URL manifest. */
async function renderCrawlDocuments(
	out: OutputWriter,
	docs: FirecrawlDocument[],
	maxDocuments: number,
	maxChars: number | undefined,
): Promise<string> {
	if (docs.length === 0) return "No pages have been returned for this crawl yet.";

	const budget = maxDocuments > 0 ? maxDocuments : 0;
	const shown = docs.slice(0, budget);
	const parts: string[] = [];
	for (const [position, doc] of shown.entries()) {
		parts.push(await renderDocument(out, doc, { index: position + 1, inlineChars: maxChars }));
	}

	if (docs.length > shown.length) {
		const manifest = docs
			.map((doc, position) => {
				const meta = doc.metadata ?? {};
				return `${position + 1}. ${meta.sourceURL ?? meta.url ?? "(unknown url)"}${meta.title ? ` — ${meta.title}` : ""}`;
			})
			.join("\n");
		const { path } = await out.spill("crawl-pages", manifest, "txt");
		parts.push(
			`${docs.length - shown.length} further page(s) were fetched but not rendered inline (maxDocuments=${budget}). Manifest of all ${docs.length} crawled URLs: ${path}. Raise \`maxDocuments\` to render more, or scrape a specific URL with firecrawl_scrape.`,
		);
	}

	return parts.join("\n\n");
}

const module: FirecrawlToolModule = (env: FirecrawlToolEnv) => {
	const { z, client, out } = env;

	const parameters = z.object({
		action: z
			.enum(["start", "status", "cancel", "errors", "active", "preview"])
			.describe(
				"start: launch a crawl (POST /crawl). status: read a crawl's progress and pages. cancel: stop a running crawl. errors: list failed URLs and robots.txt blocks. active: list this team's in-flight crawls. preview: derive crawl parameters from a natural-language prompt without spending credits.",
			),
		id: z.string().optional().describe("Crawl job id. Required for 'status', 'cancel' and 'errors'."),
		url: z
			.string()
			.optional()
			.describe("Base URL to start crawling from. Required for 'start' and 'preview'; ignored by other actions."),
		prompt: z
			.string()
			.optional()
			.describe(
				"Natural-language crawl instruction (e.g. 'only the docs pages, skip changelogs'). Firecrawl derives the path filters and depth limits from it; any parameter you set explicitly overrides the derived value. Required for 'preview', optional for 'start'.",
			),
		includePaths: z
			.array(z.string())
			.optional()
			.describe(
				"URL pathname regex patterns to include; only matching paths are crawled. The starting URL is also tested against these patterns.",
			),
		excludePaths: z
			.array(z.string())
			.optional()
			.describe("URL pathname regex patterns to exclude, e.g. ['blog/.*'] to skip every blog page."),
		regexOnFullURL: z
			.boolean()
			.optional()
			.describe(
				"Match includePaths/excludePaths against the full URL including query string instead of just the pathname. Default false.",
			),
		maxDiscoveryDepth: z
			.number()
			.int()
			.optional()
			.describe(
				"Maximum depth in discovery order. The entered URL and sitemapped pages are depth 0, so with sitemap:'skip' a value of 1 crawls the entered URL plus its direct links.",
			),
		sitemap: z
			.enum(["skip", "include", "only"])
			.optional()
			.describe(
				"Sitemap mode, default 'include'. 'skip' ignores the sitemap and discovers pages by following links; 'only' crawls just the sitemap URLs.",
			),
		ignoreQueryParameters: z
			.boolean()
			.optional()
			.describe("Treat URLs differing only by query string as the same page. Default false."),
		limit: z
			.number()
			.int()
			.positive()
			.optional()
			.describe(
				"Maximum pages to crawl, default 10000. Each page costs at least 1 credit, so set this deliberately — a large site can burn thousands of credits.",
			),
		crawlEntireDomain: z
			.boolean()
			.optional()
			.describe(
				"Follow sibling and parent links instead of only deeper child paths. Default false (child paths only, e.g. /features/x -> /features/x/tips but never /pricing).",
			),
		allowExternalLinks: z.boolean().optional().describe("Follow links to other domains, one hop deep. Default false."),
		allowSubdomains: z.boolean().optional().describe("Follow links to subdomains of the base domain. Default false."),
		ignoreRobotsTxt: z
			.boolean()
			.optional()
			.describe("Ignore the site's robots.txt rules. Default false; enterprise plans only."),
		robotsUserAgent: z
			.string()
			.optional()
			.describe("User-Agent used to fetch and match robots.txt rules. Enterprise plans only."),
		delay: z
			.number()
			.nonnegative()
			.optional()
			.describe("Seconds to wait between page scrapes, to respect rate limits. Setting it forces concurrency to 1."),
		maxConcurrency: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Cap concurrent scrapes for this crawl. Defaults to the team's concurrency limit."),
		webhook: webhookSchema(z)
			.optional()
			.describe(
				"Webhook target for crawl.started / crawl.page / crawl.completed / crawl.failed events. Useful with wait:false for very long crawls.",
			),
		scrapeOptions: scrapeOptionsSchema(z)
			.optional()
			.describe("How each crawled page is scraped: formats, main-content filtering, caching, actions, proxy, PII."),
		zeroDataRetention: z
			.boolean()
			.optional()
			.describe("Enable zero data retention for this crawl. Must be enabled for the team first."),
		wait: z
			.boolean()
			.optional()
			.describe(
				"For 'start': poll until the crawl finishes and return the pages (default true). Set false to return the job id immediately — the right choice for crawls of thousands of pages.",
			),
		waitTimeout: z
			.number()
			.int()
			.positive()
			.optional()
			.describe(
				"Seconds to keep polling before returning the latest snapshot (default 600). The crawl keeps running server-side; fetch it later with action:'status'.",
			),
		collectAll: z
			.boolean()
			.optional()
			.describe(
				"For 'status': follow the response's `next` links and merge every page of results. Default false, which returns only the first ~10MB page.",
			),
		maxResultPages: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Cap on paginated result pages followed when collecting crawl output. Default 20 (~200MB ceiling)."),
		maxDocuments: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe(
				"How many crawled pages to render inline, default 10. Remaining pages are listed in a spilled URL manifest instead.",
			),
		maxChars: z
			.number()
			.int()
			.optional()
			.describe("Inline character budget per rendered page before content is written to a file and only a head shown."),
	});

	return [
		defineTool({
			name: "firecrawl_crawl",
			label: "Firecrawl Crawl",
			description:
				"Crawl a whole site or site section with Firecrawl and get clean markdown/JSON for every page. Prefer this over repeated firecrawl_scrape calls when you need many pages under one domain, and prefer firecrawl_map when you only need the URL list. Costs at least 1 credit per page and can run for minutes, so bound it with `limit`, `includePaths`/`excludePaths` and `maxDiscoveryDepth`. Actions: 'start' (launch; polls to completion by default, or wait:false to get a job id), 'status' (progress plus pages, collectAll to follow pagination), 'cancel' (stop a running crawl), 'errors' (failed URLs and robots.txt blocks), 'active' (this team's in-flight crawls), 'preview' (turn a natural-language prompt into concrete crawl parameters for free before spending credits).",
			parameters,
			approval: "write",
			async execute(_id, params, signal, onUpdate, _ctx) {
				const {
					action,
					id,
					url,
					prompt,
					wait,
					waitTimeout,
					collectAll,
					maxResultPages,
					maxDocuments,
					maxChars,
					...crawlFields
				} = params;

				if ((action === "status" || action === "cancel" || action === "errors") && !id) {
					return fail(
						`\`id\` is required for action "${action}". Start a crawl with action:"start", or list running crawl ids with action:"active".`,
					);
				}
				if ((action === "start" || action === "preview") && !url) {
					return fail(`\`url\` is required for action "${action}".`);
				}
				if (action === "preview" && !prompt) {
					return fail(
						'`prompt` is required for action "preview" — it is the natural-language instruction the crawl parameters are derived from.',
					);
				}

				const documentBudget = maxDocuments ?? 10;
				// Non-empty for every action validated above; the other actions never read it.
				const crawlId = id ?? "";

				try {
					switch (action) {
						case "start": {
							const started = await client.request<CrawlStartResponse>("/crawl", {
								method: "POST",
								body: compact({ url, prompt, ...crawlFields }),
								signal,
							});
							const jobId = started.id;
							if (!jobId) {
								return fail("Firecrawl accepted the crawl but returned no job id.", started);
							}
							if (wait === false) {
								return ok(
									`Crawl started.\nid: ${jobId}\nurl: ${started.url ?? url}\n\nFetch results with firecrawl_crawl action:"status", id:"${jobId}" (add collectAll:true once it completes). Stop it early with action:"cancel", id:"${jobId}". Inspect failures with action:"errors", id:"${jobId}".`,
									{ id: jobId, url: started.url ?? url, status: "started" },
								);
							}

							onUpdate?.({
								content: [{ type: "text", text: `Crawl ${jobId} started; polling for completion...` }],
							});
							const final = await client.pollJob<CrawlStatusResponse>(`/crawl/${encodeURIComponent(jobId)}`, {
								signal,
								timeoutMs: waitTimeout === undefined ? undefined : waitTimeout * 1_000,
								onPoll: (snapshot) => {
									onUpdate?.({
										content: [
											{
												type: "text",
												text: `Crawl ${jobId}: ${snapshot.status ?? "running"} — ${snapshot.completed ?? 0}/${snapshot.total ?? 0} pages, ${snapshot.creditsUsed ?? 0} credits used`,
											},
										],
									});
								},
							});

							const collected = final.next
								? await client.collectPages<CrawlStatusResponse>(final, { signal, maxPages: maxResultPages })
								: final;
							const docs = collected.data ?? [];
							const unfinished =
								collected.status === undefined || TERMINAL_CRAWL_STATUSES[collected.status] !== true
									? `Still running when polling stopped. Resume with firecrawl_crawl action:"status", id:"${jobId}", collectAll:true.`
									: undefined;
							const text = [
								crawlHeadline(jobId, collected),
								`pages returned: ${docs.length}`,
								...(unfinished ? [unfinished] : []),
								await renderCrawlDocuments(out, docs, documentBudget, maxChars),
							].join("\n\n");
							return ok(text, {
								id: jobId,
								status: collected.status,
								completed: collected.completed,
								total: collected.total,
								creditsUsed: collected.creditsUsed,
								returned: docs.length,
								rendered: Math.min(docs.length, documentBudget),
							});
						}

						case "status": {
							const snapshot = await client.request<CrawlStatusResponse>(`/crawl/${encodeURIComponent(crawlId)}`, {
								signal,
							});
							const collected =
								collectAll === true && snapshot.next
									? await client.collectPages<CrawlStatusResponse>(snapshot, { signal, maxPages: maxResultPages })
									: snapshot;
							const docs = collected.data ?? [];
							const pagination = collected.next
								? `More results remain. ${collectAll === true ? "Pagination cap reached — raise `maxResultPages`." : "Set collectAll:true to merge every page."}`
								: undefined;
							const text = [
								crawlHeadline(crawlId, collected),
								`pages returned: ${docs.length}`,
								...(pagination ? [pagination] : []),
								await renderCrawlDocuments(out, docs, documentBudget, maxChars),
							].join("\n\n");
							return ok(text, {
								id: crawlId,
								status: collected.status,
								completed: collected.completed,
								total: collected.total,
								creditsUsed: collected.creditsUsed,
								expiresAt: collected.expiresAt,
								returned: docs.length,
								hasMore: Boolean(collected.next),
							});
						}

						case "cancel": {
							const response = await client.request<CrawlCancelResponse>(`/crawl/${encodeURIComponent(crawlId)}`, {
								method: "DELETE",
								signal,
								retryOn5xx: true,
							});
							return ok(
								`Crawl ${crawlId} ${response.status ?? "cancelled"}. Pages already scraped stay readable with action:"status", id:"${crawlId}" until the job expires.`,
								{ id: crawlId, status: response.status ?? "cancelled" },
							);
						}

						case "errors": {
							const response = await client.request<CrawlErrorsResponse>(
								`/crawl/${encodeURIComponent(crawlId)}/errors`,
								{ signal },
							);
							const errors = response.errors ?? [];
							const blocked = response.robotsBlocked ?? [];
							const errorText =
								errors.length === 0
									? "No failed scrapes."
									: await out.section(
											`crawl-${crawlId}-errors`,
											errors
												.map((entry, position) => {
													const lines = [`[${position + 1}] ${entry.url ?? "(unknown url)"}`];
													lines.push(`    ${entry.error ?? "(no error message)"}`);
													if (entry.timestamp) lines.push(`    at ${entry.timestamp}`);
													if (entry.id) lines.push(`    scrape id: ${entry.id}`);
													return lines.join("\n");
												})
												.join("\n"),
											maxChars,
										);
							const blockedText =
								blocked.length === 0
									? "None."
									: await out.section(
											`crawl-${crawlId}-robots-blocked`,
											blocked.map((blockedUrl) => `- ${blockedUrl}`).join("\n"),
											maxChars,
										);
							const text = [
								`# Crawl ${crawlId} errors`,
								`failed scrapes: ${errors.length} | blocked by robots.txt: ${blocked.length}`,
								`## Failed URLs\n${errorText}`,
								`## Blocked by robots.txt\n${blockedText}`,
							].join("\n\n");
							return ok(text, { id: crawlId, failed: errors.length, robotsBlocked: blocked.length });
						}

						case "active": {
							const response = await client.request<ActiveCrawlsResponse>("/crawl/active", { signal });
							const crawls = response.crawls ?? [];
							if (crawls.length === 0) {
								return ok("No active crawls for this team.", { count: 0 });
							}
							const rows = crawls.map((crawl, position) => {
								const lines = [`[${position + 1}] ${crawl.id ?? "(no id)"}`];
								lines.push(`    url: ${crawl.url ?? "(unknown)"}`);
								if (crawl.teamId) lines.push(`    team: ${crawl.teamId}`);
								return lines.join("\n");
							});
							const withOptions = crawls.filter((crawl) => crawl.options !== undefined);
							const optionsBlock =
								withOptions.length === 0
									? ""
									: `\n\n## Crawler options\n${await out.section(
											"active-crawls-options",
											stringify(withOptions.map((crawl) => ({ id: crawl.id, options: crawl.options }))),
											maxChars,
											"json",
										)}`;
							const text = `# Active crawls (${crawls.length})\n${rows.join("\n")}${optionsBlock}\n\nRead any of them with action:"status", id:"<id>".`;
							return ok(text, { count: crawls.length, ids: crawls.map((crawl) => crawl.id) });
						}

						case "preview": {
							const response = await client.request<CrawlParamsPreviewResponse>("/crawl/params-preview", {
								method: "POST",
								body: { url, prompt },
								signal,
								retryOn5xx: true,
							});
							const derived = response.data;
							if (!derived) {
								return fail("Firecrawl returned no derived crawl parameters for this prompt.", response);
							}
							const json = await out.section(`crawl-params-${url}`, stringify(derived), maxChars, "json");
							const text = [
								"# Derived crawl parameters",
								`url: ${url}\nprompt: ${prompt}`,
								json,
								'Reuse these fields verbatim in action:"start" (explicitly passed parameters always win over prompt-derived ones). No pages were crawled, so no credits were spent.',
							].join("\n\n");
							return ok(text, derived);
						}

						default:
							return fail(`Unsupported action "${action}".`);
					}
				} catch (error) {
					return failFrom(error, signal);
				}
			},
		}),
	];
};

export default module;

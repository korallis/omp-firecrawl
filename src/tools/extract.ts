/**
 * `firecrawl_extract` — `POST /v2/extract` plus `GET /v2/extract/{id}`.
 *
 * One-shot LLM extraction across a set of URLs (wildcards allowed): Firecrawl
 * discovers pages under each pattern, scrapes them and folds the result into a
 * single JSON object shaped by `prompt` and/or `schema`. Asynchronous, so the
 * tool starts a job and polls it, or hands back the job id when `wait: false`.
 *
 * The endpoint is in maintenance mode. Every status read carries a `warning`
 * pointing at `/v2/scrape` json mode (and sometimes a `replacement` endpoint);
 * both are rendered verbatim so a caller who sees them knows the job itself is
 * fine. `urls` is optional server-side — `prompt` alone is enough — but the
 * URL-less path is alpha and `firecrawl_agent` does it better.
 */
import { fail, failFrom, type OutputWriter, ok, stringify } from "../core/output.ts";
import { scrapeOptionsSchema, threatProtectionSchema, webhookSchema } from "../core/schema.ts";
import { compact, defineTool, type FirecrawlToolEnv, type FirecrawlToolModule } from "../core/tool.ts";

interface ExtractStartResponse {
	success?: boolean;
	id?: string;
	/** Present when `ignoreInvalidURLs` kept the job alive despite bad inputs. */
	invalidURLs?: string[];
	error?: string;
	warning?: string;
}

interface ExtractStatusResponse {
	success?: boolean;
	status?: string;
	data?: unknown;
	/** Field-path -> supporting URLs, only when `showSources` was set. */
	sources?: Record<string, unknown>;
	/** Per-URL discovery and scrape decisions, only when `urlTrace` was set. */
	urlTrace?: unknown[];
	/** Browser sessions the extraction opened, when it opened any. */
	sessionIds?: string[];
	error?: string;
	warning?: string;
	warnings?: string[];
	/** Endpoint the deprecation warning steers callers to, e.g. `/v2/scrape`. */
	replacement?: string;
	expiresAt?: string;
	tokensUsed?: number;
	creditsUsed?: number;
	/** Echoed by some status reads; otherwise only the start response carries it. */
	invalidURLs?: string[];
	next?: string | null;
}

/** Render a finished (or timed-out) extract job into agent-readable text. */
async function renderExtract(
	out: OutputWriter,
	id: string,
	response: ExtractStatusResponse,
	maxChars: number | undefined,
	startInvalidURLs: string[] | undefined,
): Promise<string> {
	const lines = [`## Extract ${id}`];

	const facts = [`status: ${response.status ?? "unknown"}`];
	if (response.tokensUsed !== undefined) facts.push(`tokens: ${response.tokensUsed}`);
	if (response.creditsUsed !== undefined) facts.push(`credits: ${response.creditsUsed}`);
	if (response.expiresAt) facts.push(`expires: ${response.expiresAt}`);
	lines.push(facts.join(" | "));

	const rejected = response.invalidURLs ?? startInvalidURLs;
	if (rejected && rejected.length > 0) lines.push(`ignored invalid URLs: ${rejected.join(", ")}`);
	if (response.sessionIds && response.sessionIds.length > 0) {
		lines.push(`browser sessions: ${response.sessionIds.join(", ")}`);
	}

	if (response.error) lines.push(`error: ${response.error}`);
	if (response.warning) lines.push(`warning: ${response.warning}`);
	for (const warning of response.warnings ?? []) lines.push(`warning: ${warning}`);
	if (response.replacement) lines.push(`recommended replacement: ${response.replacement}`);

	if (response.data !== undefined && response.data !== null) {
		lines.push(`\n### Data\n${await out.section(`extract-${id}-data`, stringify(response.data), maxChars, "json")}`);
	} else if (response.status === "completed") {
		lines.push("\nNo data returned: the pages matched no schema fields, or every URL failed to scrape.");
	}

	if (response.sources && Object.keys(response.sources).length > 0) {
		lines.push(
			`\n### Sources\n${await out.section(`extract-${id}-sources`, stringify(response.sources), maxChars, "json")}`,
		);
	}

	if (response.urlTrace && response.urlTrace.length > 0) {
		lines.push(
			`\n### URL trace\n${await out.section(`extract-${id}-urltrace`, stringify(response.urlTrace), maxChars, "json")}`,
		);
	}

	return lines.join("\n");
}

const module: FirecrawlToolModule = (env: FirecrawlToolEnv) => {
	const { z, client, out } = env;

	const parameters = z.object({
		action: z
			.enum(["start", "status"])
			.describe(
				"'start' launches an extraction over `urls` (requires `prompt` and/or `schema`); 'status' reads a job by `jobId`.",
			),
		urls: z
			.array(z.string())
			.optional()
			.describe(
				"URLs or glob patterns to extract from, e.g. 'https://example.com/*' to crawl the whole site, 'https://example.com/blog/*' for a section, or a plain URL for one page. Maximum 10 entries per request while the endpoint is in beta. Wildcards make the job much slower and more expensive, so pair them with `limit`. Omit it entirely and pass only `prompt` to let Firecrawl find the pages itself — an alpha path that firecrawl_agent handles far better.",
			),
		prompt: z
			.string()
			.optional()
			.describe(
				"Natural-language description of the data to extract, max 10000 characters. Required unless `schema` is given, and required whenever `urls` is omitted; supplying prompt and schema together gives the most reliable output.",
			),
		schema: z
			.record(z.string(), z.unknown())
			.optional()
			.describe(
				"JSON Schema (https://json-schema.org) describing the object to return. Use `type: 'object'` with a top-level array property to extract lists of items.",
			),
		systemPrompt: z
			.string()
			.optional()
			.describe(
				"System-level instruction prepended to the extraction model, e.g. tone, units, canonicalization rules. Max 10000 characters.",
			),
		limit: z
			.number()
			.int()
			.optional()
			.describe(
				"Cap how many discovered pages the job extracts from after wildcard expansion. Unlimited when unset — the main cost control for patterns like 'https://example.com/*'.",
			),
		allowExternalLinks: z
			.boolean()
			.optional()
			.describe(
				"Follow links that leave the domains in `urls` when the answer is not on-site. Default false; enabling it widens crawl cost. Setting `enableWebSearch` turns this on implicitly.",
			),
		enableWebSearch: z
			.boolean()
			.optional()
			.describe(
				"Let the extractor run web searches to fill fields the given pages do not cover. Default false; adds latency and credits, and implies `allowExternalLinks`.",
			),
		ignoreSitemap: z
			.boolean()
			.optional()
			.describe("Skip sitemap.xml discovery when expanding wildcard URLs. Default false."),
		includeSubdomains: z.boolean().optional().describe("Also scan subdomains of the supplied URLs. Default true."),
		showSources: z
			.boolean()
			.optional()
			.describe(
				"Return the URLs each extracted value came from, under `sources` in the result. Default false. Set it whenever the answer must be citable.",
			),
		urlTrace: z
			.boolean()
			.optional()
			.describe(
				"Return a per-URL record of what the job discovered, scraped, skipped or failed on, under `urlTrace`. Default false; the cheapest way to see why a wildcard pattern produced nothing.",
			),
		scrapeOptions: scrapeOptionsSchema(z)
			.optional()
			.describe(
				"How each discovered page is scraped before extraction (formats, onlyMainContent, maxAge cache reuse, actions, proxy, location, timeout).",
			),
		ignoreInvalidURLs: z
			.boolean()
			.optional()
			.describe(
				"Drop unparseable entries in `urls` and extract from the rest, returning the rejects as `invalidURLs`. Default true; false fails the whole request instead.",
			),
		timeout: z
			.number()
			.int()
			.optional()
			.describe(
				"Server-side ceiling in ms for the whole extraction, minimum 1000. Distinct from `waitTimeoutMs`, which only bounds how long this tool polls; the job keeps running when polling stops but not when this expires.",
			),
		agent: z
			.object({
				model: z
					.enum(["FIRE-1"])
					.describe(
						"'FIRE-1' drives a real browser during extraction. The former 'v3-beta' model is rejected here with a 400 telling you to call /agent instead — use firecrawl_agent.",
					),
			})
			.optional()
			.describe(
				"Opt into agentic extraction for pages that need interaction (pagination, tabs, logins). Substantially slower and more expensive — for genuinely multi-step navigation prefer `firecrawl_agent`.",
			),
		webhook: webhookSchema(z)
			.optional()
			.describe(
				"Webhook target for this job's started/page/completed/failed events, so a long extraction need not be polled. `x-firecrawl-signature` is reserved and rejected as a header name.",
			),
		origin: z.string().optional().describe("Origin identifier recorded for analytics and logging. Default 'api'."),
		integration: z.string().optional().describe("Optional integration identifier recorded with the request"),
		threatProtection: threatProtectionSchema(z)
			.optional()
			.describe("Per-request Threat Protection override applied to every URL this job touches."),
		jobId: z.string().optional().describe("Required for 'status'. The extract job id returned by 'start'."),
		wait: z
			.boolean()
			.optional()
			.describe(
				"For 'start': poll until the job finishes and return the data. Default true. Set false to get the job id immediately and read it later with action:'status'.",
			),
		waitTimeoutMs: z
			.number()
			.int()
			.optional()
			.describe(
				"Wall-clock ceiling in ms for polling when `wait` is true. On expiry the last snapshot is returned and the job keeps running server-side.",
			),
		maxChars: z
			.number()
			.int()
			.optional()
			.describe("Inline character budget before extracted data, sources or the URL trace spill to a file"),
	});

	return [
		defineTool({
			name: "firecrawl_extract",
			label: "Firecrawl Extract",
			description:
				"Extract one structured JSON object from many pages at once with Firecrawl's LLM extractor. Actions: 'start' (launch a job over up to 10 URLs or glob patterns like 'https://example.com/*', shaped by prompt and/or JSON Schema, optionally with web search and per-value sources) and 'status' (read a job by id). /extract is in maintenance mode and its status reads carry the warning \"/v2/extract/:jobId is deprecated. Use /v2/scrape with formats including a 'json' format object.\" — this tool prints that warning verbatim, and seeing it does not mean the job failed. Route new work by shape: firecrawl_scrape with a {type:'json'} format for one known page (synchronous and cheapest, but single-URL only), firecrawl_agent when the data needs navigation or lives on pages you cannot enumerate, and this tool for a fixed list of URLs or a wildcard site pattern that neither of those covers in one call. Asynchronous and credit-hungry: wildcard URLs crawl and scrape every match, so scope patterns tightly and set `limit`. Teams with zero data retention forced on cannot use /extract at all — the API rejects the request.",
			parameters,
			approval: "write",
			async execute(_id, params, signal, onUpdate, _ctx) {
				const { action, jobId, wait, waitTimeoutMs, maxChars, ...request } = params;

				try {
					if (action === "status") {
						if (!jobId) return fail("action:'status' requires `jobId` (the id returned by action:'start').");
						const snapshot = await client.request<ExtractStatusResponse>(`/extract/${encodeURIComponent(jobId)}`, {
							signal,
						});
						const collected = snapshot.next ? await client.collectPages(snapshot, { signal }) : snapshot;
						const text = await renderExtract(out, jobId, collected, maxChars, undefined);
						const details = {
							id: jobId,
							status: collected.status,
							tokensUsed: collected.tokensUsed,
							creditsUsed: collected.creditsUsed,
						};
						return collected.status === "failed" ? fail(text, details) : ok(text, details);
					}

					if ((request.urls === undefined || request.urls.length === 0) && !request.prompt) {
						return fail(
							"action:'start' requires `urls` (one or more URLs or glob patterns such as 'https://x.com/*'), or a `prompt` alone if you want Firecrawl to find the pages itself.",
						);
					}
					if (!request.prompt && !request.schema) {
						return fail("action:'start' requires `prompt`, `schema`, or both — otherwise there is nothing to extract.");
					}

					const started = await client.request<ExtractStartResponse>("/extract", {
						method: "POST",
						body: compact(request),
						signal,
					});

					const id = started.id;
					if (!id) {
						return fail(
							`Firecrawl accepted the extract request but returned no job id${started.error ? `: ${started.error}` : "."}`,
						);
					}

					if (wait === false) {
						const lines = [`Extract job started: ${id}`];
						if (started.invalidURLs && started.invalidURLs.length > 0) {
							lines.push(`Ignored invalid URLs: ${started.invalidURLs.join(", ")}`);
						}
						if (started.warning) lines.push(`warning: ${started.warning}`);
						lines.push(`Read it with action:'status', jobId:'${id}'.`);
						return ok(lines.join("\n"), { id, invalidURLs: started.invalidURLs });
					}

					const startedAt = Date.now();
					const snapshot = await client.pollJob<ExtractStatusResponse>(`/extract/${encodeURIComponent(id)}`, {
						signal,
						timeoutMs: waitTimeoutMs,
						onPoll(current) {
							const seconds = Math.round((Date.now() - startedAt) / 1000);
							onUpdate?.({
								content: [{ type: "text", text: `extract ${id}: ${current.status ?? "processing"} (${seconds}s)` }],
							});
						},
					});

					const collected = snapshot.next ? await client.collectPages(snapshot, { signal }) : snapshot;
					const text = await renderExtract(out, id, collected, maxChars, started.invalidURLs);

					if (collected.status === "failed") {
						return fail(text, { id, status: collected.status });
					}
					if (collected.status !== "completed") {
						return ok(
							`${text}\n\nStill ${collected.status ?? "processing"} when polling stopped. Re-read with action:'status', jobId:'${id}'.`,
							{ id, status: collected.status },
						);
					}
					return ok(text, {
						id,
						status: collected.status,
						tokensUsed: collected.tokensUsed,
						creditsUsed: collected.creditsUsed,
					});
				} catch (error) {
					return failFrom(error, signal);
				}
			},
		}),
	];
};

export default module;

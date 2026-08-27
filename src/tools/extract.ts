/**
 * `firecrawl_extract` — `POST /v2/extract` plus `GET /v2/extract/{id}`.
 *
 * One-shot LLM extraction across a set of URLs (wildcards allowed): Firecrawl
 * discovers pages under each pattern, scrapes them and folds the result into a
 * single JSON object shaped by `prompt` and/or `schema`. Asynchronous, so the
 * tool starts a job and polls it, or hands back the job id when `wait: false`.
 */
import { fail, failFrom, type OutputWriter, ok, stringify } from "../core/output.ts";
import { scrapeOptionsSchema, threatProtectionSchema } from "../core/schema.ts";
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
	error?: string;
	warning?: string;
	warnings?: string[];
	expiresAt?: string;
	tokensUsed?: number;
	creditsUsed?: number;
	next?: string | null;
}

/** Render a finished (or timed-out) extract job into agent-readable text. */
async function renderExtract(
	out: OutputWriter,
	id: string,
	response: ExtractStatusResponse,
	maxChars: number | undefined,
): Promise<string> {
	const lines = [`## Extract ${id}`];

	const facts = [`status: ${response.status ?? "unknown"}`];
	if (response.tokensUsed !== undefined) facts.push(`tokens: ${response.tokensUsed}`);
	if (response.creditsUsed !== undefined) facts.push(`credits: ${response.creditsUsed}`);
	if (response.expiresAt) facts.push(`expires: ${response.expiresAt}`);
	lines.push(facts.join(" | "));

	if (response.error) lines.push(`error: ${response.error}`);
	if (response.warning) lines.push(`warning: ${response.warning}`);
	for (const warning of response.warnings ?? []) lines.push(`warning: ${warning}`);

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
				"Required for 'start'. URLs or glob patterns to extract from, e.g. 'https://example.com/*' to crawl the whole site, 'https://example.com/blog/*' for a section, or a plain URL for one page. Wildcards make the job much slower and more expensive.",
			),
		prompt: z
			.string()
			.optional()
			.describe(
				"Natural-language description of the data to extract. Required unless `schema` is given; supplying both gives the most reliable output.",
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
				"System-level instruction prepended to the extraction model, e.g. tone, units, canonicalization rules.",
			),
		allowExternalLinks: z
			.boolean()
			.optional()
			.describe(
				"Follow links that leave the domains in `urls` when the answer is not on-site. Default false; enabling it widens crawl cost.",
			),
		enableWebSearch: z
			.boolean()
			.optional()
			.describe(
				"Let the extractor run web searches to fill fields the given pages do not cover. Default false; adds latency and credits.",
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
		agent: z
			.object({
				model: z
					.enum(["FIRE-1", "v3-beta"])
					.describe("'FIRE-1' drives a real browser during extraction; 'v3-beta' is the newer agentic extractor."),
			})
			.optional()
			.describe(
				"Opt into agentic extraction for pages that need interaction (pagination, tabs, logins). Substantially slower and more expensive — for genuinely multi-step navigation prefer `firecrawl_agent`.",
			),
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
			.describe("Inline character budget before extracted data or sources spill to a file"),
	});

	return [
		defineTool({
			name: "firecrawl_extract",
			label: "Firecrawl Extract",
			description:
				"Extract one structured JSON object from many pages at once with Firecrawl's LLM extractor. Actions: 'start' (launch a job over URLs or glob patterns like 'https://example.com/*', shaped by prompt and/or JSON Schema, optionally with web search and per-value sources) and 'status' (read a job by id). Prefer this over firecrawl_scrape's json format when the answer spans a whole site or a list of URLs; prefer firecrawl_scrape when one known page holds the data, and firecrawl_agent when the data needs multi-step navigation or interaction. Asynchronous and credit-hungry: wildcard URLs crawl and scrape every match, so scope patterns tightly. Note that Firecrawl now treats /extract as maintenance-mode — new work should usually go to firecrawl_scrape (json) or firecrawl_agent.",
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
						const text = await renderExtract(out, jobId, snapshot, maxChars);
						return snapshot.status === "failed"
							? fail(text, { id: jobId, status: snapshot.status })
							: ok(text, { id: jobId, status: snapshot.status, tokensUsed: snapshot.tokensUsed });
					}

					if (!request.urls || request.urls.length === 0) {
						return fail(
							"action:'start' requires `urls` (one or more URLs or glob patterns such as 'https://x.com/*').",
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

					const invalidNote =
						started.invalidURLs && started.invalidURLs.length > 0
							? `Ignored invalid URLs: ${started.invalidURLs.join(", ")}`
							: "";

					if (wait === false) {
						const lines = [`Extract job started: ${id}`];
						if (invalidNote !== "") lines.push(invalidNote);
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
					const rendered = await renderExtract(out, id, collected, maxChars);
					const text = invalidNote === "" ? rendered : `${invalidNote}\n\n${rendered}`;

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

/**
 * `firecrawl_batch` — `POST /v2/batch/scrape` plus the job's status, cancel and
 * error endpoints.
 *
 * One batch job scrapes many URLs under a single set of scrape options: far
 * cheaper to orchestrate and much faster than looping `firecrawl_scrape`,
 * because Firecrawl fans the URLs out across its own concurrency budget. The
 * tool starts the job, streams progress while polling, follows the paginated
 * `next` links and renders the finished documents.
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
import { scrapeOptionsShape, webhookSchema } from "../core/schema.ts";
import { compact, defineTool, type FirecrawlToolEnv, type FirecrawlToolModule } from "../core/tool.ts";

interface BatchStartResponse {
	success?: boolean;
	id?: string;
	url?: string;
	/** Populated only when `ignoreInvalidURLs` is true. */
	invalidURLs?: string[] | null;
}

interface BatchStatusResponse {
	success?: boolean;
	status?: string;
	total?: number;
	completed?: number;
	creditsUsed?: number;
	createdAt?: string;
	completedAt?: string;
	expiresAt?: string;
	duration?: number;
	next?: string | null;
	data?: FirecrawlDocument[];
}

interface BatchErrorEntry {
	id?: string;
	timestamp?: string | null;
	url?: string;
	error?: string;
}

interface BatchErrorsResponse {
	errors?: BatchErrorEntry[];
	robotsBlocked?: string[];
}

interface BatchCancelResponse {
	status?: string;
	success?: boolean;
}

/** Statuses that mean the job will not progress further. */
const TERMINAL_BATCH_STATUSES: Record<string, true> = {
	completed: true,
	failed: true,
	cancelled: true,
	canceled: true,
};

function progressLine(snapshot: BatchStatusResponse): string {
	const parts = [`status: ${snapshot.status ?? "unknown"}`];
	if (snapshot.total !== undefined) parts.push(`${snapshot.completed ?? 0}/${snapshot.total} pages`);
	else if (snapshot.completed !== undefined) parts.push(`${snapshot.completed} pages`);
	if (snapshot.creditsUsed !== undefined) parts.push(`${snapshot.creditsUsed} credits`);
	if (snapshot.duration !== undefined) parts.push(`${Math.round(snapshot.duration)}s elapsed`);
	return parts.join(" | ");
}

/** Header facts plus up to `maxDocuments` rendered documents; the rest spills to disk. */
async function renderBatch(
	out: OutputWriter,
	jobId: string,
	snapshot: BatchStatusResponse,
	options: { maxDocuments: number; maxChars: number | undefined; invalidURLs: string[] },
): Promise<string> {
	const documents = snapshot.data ?? [];
	const lines = [`# Batch scrape ${jobId}`, progressLine(snapshot)];
	if (snapshot.createdAt) lines.push(`started: ${snapshot.createdAt}`);
	if (snapshot.completedAt) lines.push(`finished: ${snapshot.completedAt}`);
	if (snapshot.expiresAt) lines.push(`results expire: ${snapshot.expiresAt}`);
	if (options.invalidURLs.length > 0) {
		lines.push(`invalid URLs ignored (${options.invalidURLs.length}): ${options.invalidURLs.join(", ")}`);
	}
	if (snapshot.next) {
		lines.push(`More result pages remain — re-run with action 'status', id '${jobId}' and collectAll true.`);
	}
	lines.push(`documents returned: ${documents.length}`);

	if (documents.length === 0) {
		lines.push("", "No documents in this payload yet.");
		return lines.join("\n");
	}

	const shown = documents.slice(0, options.maxDocuments);
	for (const [index, document] of shown.entries()) {
		lines.push("", await renderDocument(out, document, { inlineChars: options.maxChars, index: index + 1 }));
	}
	if (documents.length > shown.length) {
		const remaining = documents.slice(shown.length);
		const { path } = await out.spill(`batch-${jobId}-remaining`, stringify(remaining), "json");
		lines.push(
			"",
			`${remaining.length} further documents were not rendered inline. Full JSON saved to ${path} — read it, or raise maxDocuments.`,
		);
	}
	return lines.join("\n");
}

const module: FirecrawlToolModule = (env: FirecrawlToolEnv) => {
	const { z, client, out } = env;

	const parameters = z.object({
		action: z
			.enum(["start", "status", "cancel", "errors"])
			.describe(
				"'start' queues a batch scrape for `urls`; 'status' fetches a job's progress and documents by `id`; 'cancel' stops a running job by `id`; 'errors' lists the failed URLs and robots.txt-blocked URLs of a job by `id`.",
			),
		urls: z
			.array(z.string())
			.optional()
			.describe("Required for 'start': the URLs to scrape. Every URL is scraped with the same options below."),
		id: z.string().optional().describe("Required for 'status', 'cancel' and 'errors': the batch job id from 'start'."),
		wait: z
			.boolean()
			.optional()
			.describe(
				"'start' only. Default true: poll until the job finishes and return the documents. Set false to return the job id immediately and read results later with action 'status'.",
			),
		waitTimeout: z
			.number()
			.int()
			.optional()
			.describe(
				"'start' with wait: wall-clock polling budget in ms (default FIRECRAWL_JOB_TIMEOUT_MS, 600000). When it runs out the last snapshot is returned and the job keeps running server-side.",
			),
		maxDocuments: z
			.number()
			.int()
			.optional()
			.describe(
				"Documents rendered inline (default 10). The remainder is written to a JSON file and its path reported.",
			),
		collectAll: z
			.boolean()
			.optional()
			.describe(
				"Follow the response's `next` links and merge every result page before rendering. Default true for 'start' with wait, false for 'status'. Large batches can be tens of MB.",
			),
		maxChars: z
			.number()
			.int()
			.optional()
			.describe(
				"Inline character budget per document section before content is written to a file and only a head is shown.",
			),
		webhook: webhookSchema(z)
			.optional()
			.describe(
				"'start' only: webhook target for batch_scrape.started / batch_scrape.page / batch_scrape.completed / batch_scrape.failed events. Page payloads match /scrape responses.",
			),
		maxConcurrency: z
			.number()
			.int()
			.optional()
			.describe(
				"'start' only: cap concurrent scrapes for this job. Defaults to the team's concurrency limit; lower it to leave headroom for other jobs.",
			),
		ignoreInvalidURLs: z
			.boolean()
			.optional()
			.describe(
				"'start' only, default true: skip malformed URLs and return them in invalidURLs instead of failing the whole request.",
			),
		...scrapeOptionsShape(z),
	});

	return [
		defineTool({
			name: "firecrawl_batch",
			label: "Firecrawl Batch Scrape",
			description:
				"Scrape many known URLs in one Firecrawl job. Use this instead of repeated firecrawl_scrape calls whenever you already have the URL list (sitemap output, search results, docs pages); use firecrawl_crawl when the URLs must be discovered by following links. Actions: 'start' (queue urls; by default polls to completion and returns the documents, wait:false returns the job id), 'status' (progress plus documents for a job id), 'cancel' (stop a running job), 'errors' (failed URLs with their error text and robots.txt-blocked URLs). Costs one scrape's credits per URL, and the same format/action/proxy/PII options as firecrawl_scrape apply to every URL. Long lists take minutes; content beyond the inline budget is written to files whose paths are reported.",
			parameters,
			approval: "write",
			async execute(_id, params, signal, onUpdate, _ctx) {
				const {
					action,
					urls,
					id,
					wait,
					waitTimeout,
					maxDocuments,
					collectAll,
					maxChars,
					webhook,
					maxConcurrency,
					ignoreInvalidURLs,
					...scrapeOptions
				} = params;
				const renderOptions = { maxDocuments: maxDocuments ?? 10, maxChars };

				try {
					if (action === "start") {
						if (!urls || urls.length === 0) {
							return fail("`urls` is required for action 'start': pass at least one URL to scrape.");
						}

						const started = await client.request<BatchStartResponse>("/batch/scrape", {
							method: "POST",
							body: compact({ urls, webhook, maxConcurrency, ignoreInvalidURLs, ...scrapeOptions }),
							signal,
							timeoutMs: scrapeOptions.timeout ? scrapeOptions.timeout + 20_000 : undefined,
						});

						const jobId = started.id;
						if (!jobId) {
							return fail("Firecrawl accepted the batch but returned no job id.", started);
						}
						const invalidURLs = started.invalidURLs ?? [];
						const invalidNote = invalidURLs.length > 0 ? ` Invalid URLs ignored: ${invalidURLs.join(", ")}.` : "";

						if (wait === false) {
							return ok(
								`Batch scrape ${jobId} started for ${urls.length} URLs.${invalidNote}\nRead results with action 'status' and id '${jobId}', list failures with action 'errors', stop it with action 'cancel'.`,
								{ id: jobId, url: started.url, invalidURLs, requested: urls.length },
							);
						}

						const statusPath = `/batch/scrape/${encodeURIComponent(jobId)}`;
						const finished = await client.pollJob<BatchStatusResponse>(statusPath, {
							signal,
							timeoutMs: waitTimeout,
							onPoll: (snapshot) => {
								onUpdate?.({
									content: [{ type: "text", text: `Batch ${jobId} — ${progressLine(snapshot)}` }],
								});
							},
						});
						const collected =
							collectAll === false ? finished : await client.collectPages<BatchStatusResponse>(finished, { signal });

						const body = await renderBatch(out, jobId, collected, { ...renderOptions, invalidURLs });
						const unfinished = collected.status !== undefined && TERMINAL_BATCH_STATUSES[collected.status] !== true;
						const text = unfinished
							? `${body}\n\nStill '${collected.status}' when the wait budget ran out; the job keeps running. Re-check with action 'status' and id '${jobId}'.`
							: body;
						return ok(text, {
							id: jobId,
							status: collected.status,
							total: collected.total,
							completed: collected.completed,
							creditsUsed: collected.creditsUsed,
							documents: collected.data?.length ?? 0,
							invalidURLs,
						});
					}

					if (!id) {
						return fail(`\`id\` is required for action '${action}': pass the batch job id returned by action 'start'.`);
					}
					const jobId = id;
					const encodedId = encodeURIComponent(jobId);

					if (action === "status") {
						const snapshot = await client.request<BatchStatusResponse>(`/batch/scrape/${encodedId}`, { signal });
						const collected =
							collectAll === true ? await client.collectPages<BatchStatusResponse>(snapshot, { signal }) : snapshot;
						const text = await renderBatch(out, jobId, collected, { ...renderOptions, invalidURLs: [] });
						return ok(text, {
							id: jobId,
							status: collected.status,
							total: collected.total,
							completed: collected.completed,
							creditsUsed: collected.creditsUsed,
							documents: collected.data?.length ?? 0,
							next: collected.next ?? null,
						});
					}

					if (action === "cancel") {
						const cancelled = await client.request<BatchCancelResponse>(`/batch/scrape/${encodedId}`, {
							method: "DELETE",
							signal,
							retryOn5xx: true,
						});
						return ok(`Batch scrape ${jobId} is now '${cancelled.status ?? "cancelled"}'.`, {
							id: jobId,
							status: cancelled.status,
						});
					}

					const failures = await client.request<BatchErrorsResponse>(`/batch/scrape/${encodedId}/errors`, { signal });
					const errors = failures.errors ?? [];
					const robotsBlocked = failures.robotsBlocked ?? [];
					const lines = [
						`# Batch scrape ${jobId} errors`,
						`failed: ${errors.length} | robots-blocked: ${robotsBlocked.length}`,
					];
					if (errors.length > 0) {
						lines.push(
							"",
							"## Failed URLs",
							errors
								.map((entry) => {
									const when = entry.timestamp ? ` (${entry.timestamp})` : "";
									return `- ${entry.url ?? "(unknown url)"}${when}: ${entry.error ?? "no error text"}${entry.id ? `\n  scrape id: ${entry.id}` : ""}`;
								})
								.join("\n"),
						);
					}
					if (robotsBlocked.length > 0) {
						lines.push(
							"",
							`## Blocked by robots.txt (${robotsBlocked.length})`,
							await out.section(`batch-${jobId}-robots`, robotsBlocked.map((url) => `- ${url}`).join("\n"), maxChars),
						);
					}
					if (errors.length === 0 && robotsBlocked.length === 0) {
						lines.push("", "No failed or blocked URLs recorded for this job.");
					}
					return ok(lines.join("\n"), {
						id: jobId,
						errors: errors.length,
						robotsBlocked: robotsBlocked.length,
					});
				} catch (error) {
					return failFrom(error, signal);
				}
			},
		}),
	];
};

export default module;

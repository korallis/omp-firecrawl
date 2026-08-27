/**
 * `firecrawl_agent` — Firecrawl's agentic extractor: `POST /v2/agent`,
 * `GET /v2/agent/{jobId}`, `DELETE /v2/agent/{jobId}`,
 * `GET /v2/agent/{jobId}/trace` and `GET /v2/agent/{jobId}/snapshots/{id}`.
 *
 * A browser-driving agent (Spark) that plans, navigates, clicks, searches and
 * writes its findings into an output artifact. Unlike /extract it can take
 * multiple dependent steps, so it handles logins, pagination, filters and
 * "find X then use it to look up Y" tasks — at the highest cost of the three
 * extraction paths. The trace and snapshot actions expose what it actually did.
 */
import { fail, failFrom, type OutputWriter, ok, stringify } from "../core/output.ts";
import { threatProtectionSchema } from "../core/schema.ts";
import { compact, defineTool, type FirecrawlToolEnv, type FirecrawlToolModule } from "../core/tool.ts";

interface AgentStartResponse {
	success?: boolean;
	id?: string;
	error?: string;
}

interface AgentStatusResponse {
	success?: boolean;
	status?: string;
	data?: unknown;
	model?: string;
	effort?: string;
	error?: string;
	expiresAt?: string;
	creditsUsed?: number;
	next?: string | null;
}

interface AgentTraceError {
	code?: string;
	source?: string;
	retryable?: boolean;
	message?: string;
}

/**
 * Flattened union of every documented trace event: the variants share the
 * envelope and differ only in which payload keys are present, so one optional
 * shape narrows more cheaply than a discriminated union the server may extend.
 */
interface AgentTraceEvent {
	type?: string;
	eventId?: string;
	occurredAt?: string;
	producerSequence?: number;
	agent?: { id?: string; role?: string; name?: string; parentId?: string };
	phase?: string;
	message?: string;
	text?: string;
	reason?: string;
	toolCallId?: string;
	toolName?: string;
	parameters?: unknown;
	result?: unknown;
	sessionId?: string;
	outcome?: string;
	durationMs?: number;
	error?: AgentTraceError | null;
	artifact?: {
		kind?: string;
		artifactId?: string;
		path?: string;
		snapshotId?: string;
		change?: string;
		changedFields?: string[];
		itemCount?: number;
		sourceToolCallId?: string;
	};
}

interface AgentTraceResponse {
	success?: boolean;
	id?: string;
	events?: AgentTraceEvent[];
	creditsUsed?: number;
	activeBrowserSessions?: Array<{ id?: string; liveViewUrl?: string; viewport?: { width?: number; height?: number } }>;
}

interface AgentSnapshotResponse {
	success?: boolean;
	id?: string;
	snapshotId?: string;
	/** JSON-encoded string: the agent's working output artifact at that point. */
	snapshot?: string;
}

/** Single-line, length-capped rendering of arbitrary trace payloads. */
function oneLine(value: unknown, limit: number): string {
	let text: string;
	if (typeof value === "string") {
		text = value;
	} else {
		try {
			text = JSON.stringify(value) ?? String(value);
		} catch {
			text = String(value);
		}
	}
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

/** Compact one trace event: what the agent did and how it turned out. */
function describeEvent(event: AgentTraceEvent): string {
	const type = event.type ?? "unknown";
	switch (type) {
		case "run.started":
		case "agent.started":
			return `${type} ${event.agent?.role ?? "?"}:${event.agent?.name ?? event.agent?.id ?? "?"}`;
		case "run.cancel_requested":
			return `${type} reason=${event.reason ?? "?"}`;
		case "run.finished":
		case "agent.finished": {
			const duration = event.durationMs === undefined ? "" : ` ${(event.durationMs / 1000).toFixed(1)}s`;
			const error = event.error?.message
				? ` — ${event.error.code ?? "error"}: ${oneLine(event.error.message, 160)}`
				: "";
			return `${type} ${event.outcome ?? "?"}${duration}${error}`;
		}
		case "progress.reported":
			return `${event.phase ?? "progress"}: ${oneLine(event.message, 200)}`;
		case "reasoning.summary":
			return `reasoning: ${oneLine(event.text, 240)}`;
		case "tool_call.started":
			return `→ ${event.toolName ?? "tool"}(${oneLine(event.parameters, 160)})`;
		case "tool_call.finished":
			return `← ${event.toolName ?? "tool"} = ${oneLine(event.result, 200)}`;
		case "browser.session.started":
			return `browser session ${event.sessionId ?? "?"} started`;
		case "browser.session.finished": {
			const duration = event.durationMs === undefined ? "" : ` after ${(event.durationMs / 1000).toFixed(1)}s`;
			return `browser session ${event.sessionId ?? "?"} finished${duration}`;
		}
		case "artifact.updated": {
			const artifact = event.artifact ?? {};
			const items = artifact.itemCount === undefined ? "" : ` items=${artifact.itemCount}`;
			const fields = artifact.changedFields?.length ? ` fields=${artifact.changedFields.join(",")}` : "";
			return `artifact ${artifact.kind ?? "?"} ${artifact.change ?? "?"}${items}${fields} snapshotId=${artifact.snapshotId ?? "?"}`;
		}
		case "error.occurred":
			return `error ${event.error?.code ?? "?"} (${event.error?.source ?? "?"}): ${oneLine(event.error?.message, 200)}`;
		default:
			return `${type} ${oneLine(event, 200)}`;
	}
}

/** Render a finished (or in-flight) agent job status. */
async function renderStatus(
	out: OutputWriter,
	jobId: string,
	response: AgentStatusResponse,
	maxChars: number | undefined,
): Promise<string> {
	const lines = [`## Agent ${jobId}`];

	const facts = [`status: ${response.status ?? "unknown"}`];
	if (response.model) facts.push(`model: ${response.model}`);
	if (response.effort) facts.push(`effort: ${response.effort}`);
	if (response.creditsUsed !== undefined) facts.push(`credits: ${response.creditsUsed}`);
	if (response.expiresAt) facts.push(`expires: ${response.expiresAt}`);
	lines.push(facts.join(" | "));

	if (response.error) lines.push(`error: ${response.error}`);

	if (response.data !== undefined && response.data !== null) {
		lines.push(`\n### Data\n${await out.section(`agent-${jobId}-data`, stringify(response.data), maxChars, "json")}`);
	} else if (response.status === "completed") {
		lines.push("\nThe run completed without producing data — check the trace for what the agent saw.");
	}

	return lines.join("\n");
}

const module: FirecrawlToolModule = (env: FirecrawlToolEnv) => {
	const { z, client, out } = env;

	const parameters = z.object({
		action: z
			.enum(["start", "status", "cancel", "trace", "snapshot"])
			.describe(
				"'start' launches an agent run (requires `prompt`); 'status' reads the run and its data; 'cancel' stops a running job; 'trace' lists the execution steps; 'snapshot' fetches one output artifact snapshot (requires `snapshotId` from the trace).",
			),
		prompt: z
			.string()
			.optional()
			.describe(
				"Required for 'start'. What the agent should accomplish and return, written as an objective: which data, from where, and any navigation it must perform (log in, paginate, filter, follow links).",
			),
		urls: z
			.array(z.string())
			.optional()
			.describe(
				"Starting URLs the agent should work from. Optional: without them the agent finds its own entry points via search.",
			),
		schema: z
			.record(z.string(), z.unknown())
			.optional()
			.describe(
				"JSON Schema (https://json-schema.org) for the returned object. Strongly recommended — without it the agent returns free-form JSON of its own design.",
			),
		strictConstrainToURLs: z
			.boolean()
			.optional()
			.describe("Forbid the agent from visiting anything outside `urls`. Default false."),
		model: z
			.enum(["spark-2", "spark-1-pro", "spark-1-mini"])
			.optional()
			.describe(
				"Agent model preset. Default and only live model is 'spark-2'; the 'spark-1-*' names are accepted for backwards compatibility and route to spark-2.",
			),
		effort: z
			.enum(["low", "medium", "high"])
			.optional()
			.describe(
				"Reasoning budget. 'low' finishes fastest and cheapest, 'high' plans more steps for tangled multi-page tasks. Can be sent with or without `model`.",
			),
		maxCredits: z
			.number()
			.optional()
			.describe(
				"Hard credit ceiling for the run; the agent stops with outcome 'credit_limit_reached' when hit. Defaults to 2500. Values above 2500 are always billed as paid requests.",
			),
		webhook: z
			.object({
				url: z.string().describe("Destination URL for agent lifecycle events"),
				headers: z.record(z.string(), z.string()).optional().describe("Headers sent with each webhook delivery"),
				metadata: z
					.record(z.string(), z.unknown())
					.optional()
					.describe("Custom metadata echoed in every payload for this job"),
				events: z
					.array(z.enum(["started", "action", "completed", "failed", "cancelled"]))
					.optional()
					.describe("Event subset to deliver; omit for all five"),
			})
			.optional()
			.describe("Webhook target subscribing to agent.started/action/completed/failed/cancelled"),
		auditMetadata: z
			.object({ username: z.string().describe("Username attributed to this request") })
			.optional()
			.describe("SIEM attribution metadata, used when SIEM logging is enabled for the team"),
		threatProtection: threatProtectionSchema(z)
			.optional()
			.describe("Per-request Threat Protection override applied to every URL the agent visits"),
		jobId: z
			.string()
			.optional()
			.describe("Required for 'status', 'cancel', 'trace' and 'snapshot'. The agent job id returned by 'start'."),
		snapshotId: z
			.string()
			.optional()
			.describe("Required for 'snapshot'. Taken from an `artifact.updated` event in the trace output."),
		liveView: z
			.boolean()
			.optional()
			.describe("For 'trace': also return currently active browser sessions with live-view URLs you can open."),
		wait: z
			.boolean()
			.optional()
			.describe(
				"For 'start': poll until the run finishes and return its data. Default true. Set false to get the job id immediately, then watch it with action:'trace' / action:'status'.",
			),
		waitTimeoutMs: z
			.number()
			.int()
			.optional()
			.describe(
				"Wall-clock ceiling in ms for polling when `wait` is true. On expiry the last snapshot is returned and the run continues server-side.",
			),
		maxEvents: z
			.number()
			.int()
			.optional()
			.describe(
				"For 'trace': how many of the most recent events to render inline. Default 60; the raw trace is always saved.",
			),
		maxChars: z
			.number()
			.int()
			.optional()
			.describe("Inline character budget before extracted data or snapshot content spills to a file"),
	});

	return [
		defineTool({
			name: "firecrawl_agent",
			label: "Firecrawl Agent",
			description:
				"Run Firecrawl's browser agent (Spark) to gather data that needs multi-step navigation: logging in, paginating, applying filters, following one page's result into another lookup, or deciding where to go next. Actions: 'start', 'status', 'cancel', 'trace' (step-by-step execution log with live browser-view URLs), 'snapshot' (an output artifact at a point in the run). Choose between the three extractors by how much navigation is needed: firecrawl_scrape with the json format for structured data on one known page (cheapest, seconds), firecrawl_extract for one-shot LLM extraction across many URLs or a wildcard site pattern, and this tool when the data is only reachable by acting on the site. This is by far the most expensive and slowest of the three (minutes, up to `maxCredits`, default 2500) — set `maxCredits` and a `schema`, and do not use it for pages a plain scrape can already read.",
			parameters,
			approval: "write",
			async execute(_id, params, signal, onUpdate, _ctx) {
				const { action, jobId, snapshotId, liveView, wait, waitTimeoutMs, maxEvents, maxChars, ...request } = params;

				try {
					if (action !== "start") {
						if (!jobId) {
							return fail(`action:'${action}' requires \`jobId\` (the id returned by action:'start').`);
						}
						const job = encodeURIComponent(jobId);

						if (action === "status") {
							const snapshot = await client.request<AgentStatusResponse>(`/agent/${job}`, { signal });
							const text = await renderStatus(out, jobId, snapshot, maxChars);
							return snapshot.status === "failed"
								? fail(text, { id: jobId, status: snapshot.status })
								: ok(text, { id: jobId, status: snapshot.status, creditsUsed: snapshot.creditsUsed });
						}

						if (action === "cancel") {
							const response = await client.request<{ success?: boolean }>(`/agent/${job}`, {
								method: "DELETE",
								signal,
								retryOn5xx: true,
							});
							return ok(
								response.success === false
									? `Firecrawl did not confirm cancellation of agent job ${jobId}; check action:'status'.`
									: `Cancellation requested for agent job ${jobId}. Credits already spent are not refunded.`,
								{ id: jobId, success: response.success },
							);
						}

						if (action === "trace") {
							const trace = await client.request<AgentTraceResponse>(`/agent/${job}/trace`, {
								signal,
								query: { liveView: liveView === true ? "true" : undefined },
							});
							const events = [...(trace.events ?? [])].sort(
								(left, right) => (left.producerSequence ?? 0) - (right.producerSequence ?? 0),
							);
							const limit = maxEvents ?? 60;
							const shown = events.length > limit ? events.slice(-limit) : events;
							const rows = shown.map((event) => {
								const stamp = event.occurredAt ? `${event.occurredAt} ` : "";
								return `[${event.producerSequence ?? "?"}] ${stamp}${describeEvent(event)}`;
							});

							const { path } = await out.spill(`agent-${jobId}-trace`, stringify(trace), "json");
							const lines = [`## Agent trace ${jobId}`];
							const facts = [`events: ${events.length}`];
							if (trace.creditsUsed !== undefined) facts.push(`credits: ${trace.creditsUsed}`);
							lines.push(facts.join(" | "));
							if (events.length > shown.length) {
								lines.push(`Showing the last ${shown.length} of ${events.length} events.`);
							}
							lines.push(rows.length > 0 ? `\n${rows.join("\n")}` : "\nNo events recorded yet.");
							for (const session of trace.activeBrowserSessions ?? []) {
								lines.push(`\nlive browser ${session.id ?? "?"}: ${session.liveViewUrl ?? "(no url)"}`);
							}
							lines.push(`\nRaw trace saved to ${path}`);
							return ok(lines.join("\n"), { id: jobId, events: events.length, creditsUsed: trace.creditsUsed, path });
						}

						if (!snapshotId) {
							return fail(
								"action:'snapshot' requires `snapshotId`; take it from an `artifact.updated` event in action:'trace' output.",
							);
						}
						const response = await client.request<AgentSnapshotResponse>(
							`/agent/${job}/snapshots/${encodeURIComponent(snapshotId)}`,
							{ signal },
						);
						if (response.snapshot === undefined) {
							return fail(`Agent job ${jobId} returned no content for snapshot ${snapshotId}.`, {
								id: jobId,
								snapshotId,
							});
						}
						let content = response.snapshot;
						try {
							content = stringify(JSON.parse(response.snapshot));
						} catch {
							// Snapshot is not JSON (markdown, html or plain-text artifact); render it as-is.
						}
						const body = await out.section(`agent-${jobId}-snapshot-${snapshotId}`, content, maxChars, "json");
						return ok(`## Agent snapshot ${snapshotId} (job ${jobId})\n\n${body}`, { id: jobId, snapshotId });
					}

					if (!request.prompt) {
						return fail("action:'start' requires `prompt` describing the objective the agent should accomplish.");
					}

					const started = await client.request<AgentStartResponse>("/agent", {
						method: "POST",
						body: compact(request),
						signal,
					});

					const id = started.id;
					if (!id) {
						return fail(
							`Firecrawl accepted the agent request but returned no job id${started.error ? `: ${started.error}` : "."}`,
						);
					}

					if (wait === false) {
						return ok(
							`Agent job started: ${id}\nWatch it with action:'trace', jobId:'${id}' (add liveView:true for a browser view) and read the result with action:'status'.`,
							{ id },
						);
					}

					const startedAt = Date.now();
					const snapshot = await client.pollJob<AgentStatusResponse>(`/agent/${encodeURIComponent(id)}`, {
						signal,
						timeoutMs: waitTimeoutMs,
						onPoll(current) {
							const seconds = Math.round((Date.now() - startedAt) / 1000);
							const credits = current.creditsUsed === undefined ? "" : `, ${current.creditsUsed} credits`;
							onUpdate?.({
								content: [
									{ type: "text", text: `agent ${id}: ${current.status ?? "processing"} (${seconds}s${credits})` },
								],
							});
						},
					});

					const collected = snapshot.next ? await client.collectPages(snapshot, { signal }) : snapshot;
					const text = await renderStatus(out, id, collected, maxChars);

					if (collected.status === "failed") {
						return fail(`${text}\n\nInspect what happened with action:'trace', jobId:'${id}'.`, {
							id,
							status: collected.status,
						});
					}
					if (collected.status !== "completed") {
						return ok(
							`${text}\n\nStill ${collected.status ?? "processing"} when polling stopped. Re-read with action:'status', jobId:'${id}', or cancel it with action:'cancel'.`,
							{ id, status: collected.status },
						);
					}
					return ok(text, { id, status: collected.status, creditsUsed: collected.creditsUsed });
				} catch (error) {
					return failFrom(error, signal);
				}
			},
		}),
	];
};

export default module;

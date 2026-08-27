/**
 * `firecrawl_interact` — Firecrawl's live browser surface:
 * `POST /v2/interact`, `GET /v2/interact`, `POST /v2/interact/{sessionId}/execute`,
 * `DELETE /v2/interact/{sessionId}`, plus the scrape-bound pair
 * `POST /v2/scrape/{jobId}/interact` and `DELETE /v2/scrape/{jobId}/interact`.
 *
 * Two lifecycles share one tool because they share one mental model: a real
 * Chromium session you drive with Playwright code, agent-browser CLI commands,
 * or a natural-language prompt. Standalone sessions are created and destroyed
 * explicitly; scrape-bound sessions are created lazily from an earlier scrape's
 * page state and stopped through the scrape job id. Both bill for wall-clock
 * time while alive, so every action here reports how to shut the session down.
 */
import { fail, failFrom, type OutputWriter, ok } from "../core/output.ts";
import { compact, defineTool, type FirecrawlToolEnv, type FirecrawlToolModule } from "../core/tool.ts";

/** Base64 signatures for the image blobs `page.screenshot()` returns from a sandbox. */
const IMAGE_BASE64_PREFIXES = ["iVBOR", "/9j/", "R0lGOD", "UklGR"];

/**
 * `success` only reports that the sandbox accepted the request; sandbox code
 * that threw still comes back `success: true` with a non-zero exit code.
 */
function failedExecution(response: { exitCode?: number | null; killed?: boolean }): boolean {
	if (response.killed === true) return true;
	return response.exitCode !== undefined && response.exitCode !== null && response.exitCode !== 0;
}

interface SessionSummary {
	id?: string;
	status?: string;
	cdpUrl?: string | null;
	liveViewUrl?: string | null;
	interactiveLiveViewUrl?: string | null;
	streamWebView?: boolean;
	createdAt?: string;
	lastActivity?: string;
}

interface CreateSessionResponse {
	success?: boolean;
	id?: string;
	cdpUrl?: string | null;
	liveViewUrl?: string | null;
	interactiveLiveViewUrl?: string | null;
	expiresAt?: string;
}

interface ListSessionsResponse {
	success?: boolean;
	sessions?: SessionSummary[];
}

interface ExecuteResponse {
	success?: boolean;
	/** AI agent's final answer; only present when `prompt` drove the call. */
	output?: string | null;
	stdout?: string | null;
	/** Return value: last expression for node, final page snapshot for prompts. */
	result?: string | null;
	stderr?: string | null;
	exitCode?: number | null;
	killed?: boolean;
	error?: string | null;
	cdpUrl?: string | null;
	liveViewUrl?: string | null;
	interactiveLiveViewUrl?: string | null;
}

interface DeleteSessionResponse {
	success?: boolean;
	sessionDurationMs?: number;
	creditsBilled?: number;
}

/** Live-view/CDP endpoints, rendered once per action that returns them. */
function renderEndpoints(source: {
	cdpUrl?: string | null;
	liveViewUrl?: string | null;
	interactiveLiveViewUrl?: string | null;
}): string[] {
	const lines: string[] = [];
	if (source.liveViewUrl) lines.push(`live view (read-only): ${source.liveViewUrl}`);
	if (source.interactiveLiveViewUrl) lines.push(`live view (interactive): ${source.interactiveLiveViewUrl}`);
	if (source.cdpUrl) lines.push(`cdp websocket: ${source.cdpUrl}`);
	return lines;
}

/**
 * Render one execution result: agent answer, return value, stdout/stderr and
 * exit status. Screenshot base64 is written to disk rather than inlined, and
 * any long stream is spilled with only a head kept in the transcript.
 */
async function renderExecution(
	out: OutputWriter,
	label: string,
	response: ExecuteResponse,
	maxChars: number | undefined,
): Promise<string> {
	const budget = maxChars ?? out.inlineChars;
	const blocks: string[] = [];

	if (response.output) {
		blocks.push(`### Agent output\n${await out.section(`${label}-agent-output`, response.output, maxChars)}`);
	}

	const streams: Array<{ heading: string; value: string }> = [];
	if (response.result) streams.push({ heading: "Return value", value: response.result });
	if (response.stdout && response.stdout !== response.result) {
		streams.push({ heading: "stdout", value: response.stdout });
	}
	if (response.stderr) streams.push({ heading: "stderr", value: response.stderr });

	for (const stream of streams) {
		const trimmed = stream.value.trim();
		const compactValue = trimmed.replace(/\s+/g, "");
		const looksLikeImage =
			compactValue.length > 1_000 &&
			(trimmed.startsWith("data:image/") ||
				(/^[A-Za-z0-9+/=]+$/.test(compactValue) &&
					IMAGE_BASE64_PREFIXES.some((prefix) => compactValue.startsWith(prefix))));

		if (looksLikeImage) {
			const payload = trimmed.startsWith("data:image/") ? trimmed.slice(trimmed.indexOf(",") + 1) : compactValue;
			const spilled = await out.spill(`${label}-screenshot`, payload, "b64");
			blocks.push(
				`### ${stream.heading}\nBase64 image (${(spilled.bytes / 1024).toFixed(0)}KB) saved to ${spilled.path}\nDecode it with: base64 -d ${spilled.path} > screenshot.png`,
			);
			continue;
		}
		blocks.push(`### ${stream.heading}\n${await out.section(`${label}-${stream.heading}`, stream.value, budget)}`);
	}

	if (response.error) blocks.push(`### Error\n${response.error}`);

	const status: string[] = [];
	if (response.exitCode !== undefined && response.exitCode !== null) status.push(`exitCode=${response.exitCode}`);
	if (response.killed) status.push("killed=true (execution hit the timeout)");
	if (response.success !== undefined) status.push(`success=${response.success}`);
	if (status.length > 0) blocks.push(status.join(", "));

	const endpoints = renderEndpoints(response);
	if (endpoints.length > 0) blocks.push(endpoints.join("\n"));

	if (blocks.length === 0) return "Execution returned no output.";
	return blocks.join("\n\n");
}

const module: FirecrawlToolModule = (env: FirecrawlToolEnv) => {
	const { z, client, out } = env;

	const parameters = z.object({
		action: z
			.enum(["create", "list", "execute", "delete", "scrape_execute", "scrape_stop"])
			.describe(
				"create: open a standalone browser session. list: show sessions and their status. execute: run code in a standalone session (needs `sessionId`). delete: destroy a standalone session and see what it cost. scrape_execute: run code or a natural-language prompt in the browser session bound to an earlier scrape job (needs `jobId`). scrape_stop: stop that scrape-bound session.",
			),
		sessionId: z
			.string()
			.optional()
			.describe("Standalone session id from `create`/`list`. Required for `execute` and `delete`."),
		jobId: z
			.string()
			.optional()
			.describe(
				"Scrape job id (`data.metadata.scrapeId` of a previous firecrawl_scrape call). Required for `scrape_execute` and `scrape_stop`.",
			),
		code: z
			.string()
			.optional()
			.describe(
				"Code to run in the sandbox (1-100000 chars). The body runs at top level in an async scope, so: `await` freely, but a top-level `return` is a SYNTAX ERROR — end with a bare expression instead, because the value of the LAST expression becomes `result`. Only `page` is pre-bound (a live Playwright Page already attached to this session); `browser` and `context` are NOT bound, so never call `chromium.connect*` or `browser.newPage()`. Wrap multiple values as `JSON.stringify({ a, b })` on the final line. Screenshot with `(await page.screenshot()).toString('base64')` in node, `await page.screenshot(path='/tmp/s.png')` in python, `agent-browser screenshot` in bash. Sandbox exceptions come back as `success: true` with `exitCode: 1` plus `error`/`stderr`, which this tool reports as a failure.",
			),
		prompt: z
			.string()
			.optional()
			.describe(
				"Natural-language task for Firecrawl's browser agent (1-10000 chars), e.g. 'click the first result and report the price'. Only valid for `scrape_execute`, and mutually exclusive with `code`. The agent's answer comes back as `output` (`result` holds the raw page snapshot it used). Keep each prompt to one focused step; session state carries across calls. Prompt-driven sessions bill 7 credits per browser minute instead of the 2 that code-only sessions cost.",
			),
		language: z
			.enum(["node", "python", "bash"])
			.optional()
			.describe(
				"Language of `code`, default 'node' (Playwright JS, `page` pre-bound). 'python' uses Playwright's Python API with the same `page` (print to produce stdout). 'bash' has the agent-browser CLI preinstalled — `agent-browser snapshot -i` lists interactive elements as `@e1`-style refs, then `agent-browser click @e1`, `fill @e1 \"text\"`, `press Enter`, `get text @e1`. Ignored when `prompt` is used.",
			),
		timeout: z
			.number()
			.int()
			.optional()
			.describe(
				"Execution timeout in seconds (1-300). Standalone `execute` inherits the sandbox default when omitted; `scrape_execute` defaults to 30, which is usually too short for a multi-step `prompt`. Hitting it returns `killed: true`.",
			),
		origin: z.string().optional().describe("Optional origin label for execution telemetry (`scrape_execute` only)"),
		ttl: z
			.number()
			.int()
			.optional()
			.describe(
				"`create`: total session lifetime in seconds (30-3600). The OpenAPI spec says the default is 300 while the prose docs say 600 — pass it explicitly if the ceiling matters. Billing runs until the session is deleted or the TTL expires.",
			),
		activityTtl: z
			.number()
			.int()
			.optional()
			.describe("`create`: idle seconds before the session self-destructs (10-3600, default 300). Cheap safety net."),
		streamWebView: z
			.boolean()
			.optional()
			.describe(
				"`create`: stream a live view of the browser (default true) so the URLs below are watchable. Setting false drops `liveViewUrl`/`interactiveLiveViewUrl` and leaves only the CDP websocket.",
			),
		profile: z
			.object({
				name: z.string().describe("Profile name (1-128 chars); same name = shared cookies, localStorage and logins"),
				saveChanges: z
					.boolean()
					.optional()
					.describe(
						"Persist browser state back to the profile on close (default true). Many non-saving sessions may run concurrently, but only one saving session at a time — a second saver gets HTTP 409.",
					),
			})
			.optional()
			.describe(
				"`create` only: persistent browser profile. Scrape-bound sessions inherit the profile from the scrape job, so never pass this with `scrape_execute`.",
			),
		status: z
			.enum(["active", "destroyed"])
			.optional()
			.describe("`list` only: filter sessions by status. Omit to see both."),
		maxChars: z
			.number()
			.int()
			.optional()
			.describe("Inline character budget for stdout/return values before they spill to a file"),
	});

	return [
		defineTool({
			name: "firecrawl_interact",
			label: "Firecrawl Interact",
			description:
				"Drive a real cloud Chromium session through Firecrawl: run Playwright code, agent-browser CLI commands, or a natural-language prompt against a live page, and watch it over a live-view URL. Prefer this over firecrawl_scrape when a single fetch is not enough — logins, multi-step forms, paginated apps, drop-downs, checkout flows, anything behind a click. Two flavours: standalone sessions (`create` -> `execute` -> `delete`) and sessions bound to an earlier scrape (`scrape_execute` on the scrape id, then `scrape_stop`), which resume from that page's exact state. IMPORTANT: a live session bills continuously for wall-clock time (2 credits per browser minute for code, 7 with a `prompt`, minimum one minute, credits are reported on delete), so always finish with `delete`/`scrape_stop` — do not rely on the TTL. Actions: create, list, execute, delete, scrape_execute, scrape_stop.",
			parameters,
			approval: "exec",
			async execute(_id, params, signal, onUpdate, _ctx) {
				const { action, sessionId, jobId, code, prompt, language, timeout, origin, maxChars } = params;

				if ((action === "execute" || action === "delete") && !sessionId) {
					return fail(`Action '${action}' requires \`sessionId\`. Use action 'list' to find live session ids.`);
				}
				if ((action === "scrape_execute" || action === "scrape_stop") && !jobId) {
					return fail(
						`Action '${action}' requires \`jobId\` — the scrape id returned as \`data.metadata.scrapeId\` by firecrawl_scrape.`,
					);
				}
				if (action === "execute" && !code) {
					return fail("Action 'execute' requires `code`. Standalone sessions do not accept `prompt`.");
				}
				if (action === "execute" && prompt) {
					return fail(
						"`prompt` is only supported by action 'scrape_execute'. For a standalone session, pass Playwright `code` instead.",
					);
				}
				if (action === "scrape_execute" && !code && !prompt) {
					return fail("Action 'scrape_execute' requires either `code` or `prompt`.");
				}
				if (action === "scrape_execute" && code && prompt) {
					return fail("Pass either `code` or `prompt` to 'scrape_execute', not both.");
				}
				if (action === "scrape_execute" && params.profile) {
					return fail(
						"Do not pass `profile` to 'scrape_execute'; the scrape-bound session inherits the profile from the original scrape job. Set `profile` on the firecrawl_scrape call instead.",
					);
				}

				// Transport ceiling only: the API's own limit stays whatever `timeout` says.
				const ceilingSeconds = timeout ?? (prompt ? 300 : 120);
				const executeTimeoutMs = ceilingSeconds * 1_000 + 30_000;

				try {
					switch (action) {
						case "create": {
							const response = await client.request<CreateSessionResponse>("/interact", {
								method: "POST",
								body: compact({
									ttl: params.ttl,
									activityTtl: params.activityTtl,
									streamWebView: params.streamWebView,
									profile: params.profile,
								}),
								signal,
							});
							const lines = [
								`Interact session ${response.id ?? "(no id returned)"} is live.`,
								...renderEndpoints(response),
								...(response.expiresAt ? [`expires at: ${response.expiresAt}`] : []),
								`Run code with action 'execute' and \`sessionId: "${response.id ?? ""}"\`. Billing continues until you call action 'delete'.`,
							];
							return ok(lines.join("\n"), { sessionId: response.id, expiresAt: response.expiresAt });
						}

						case "list": {
							const response = await client.request<ListSessionsResponse>("/interact", {
								query: { status: params.status },
								signal,
							});
							const sessions = response.sessions ?? [];
							if (sessions.length === 0) {
								return ok(
									params.status
										? `No interact sessions with status '${params.status}'.`
										: "No interact sessions on this team.",
									{ count: 0 },
								);
							}
							const rows = sessions.map((session) => {
								const parts = [
									`${session.id ?? "(no id)"}  ${session.status ?? "?"}`,
									`    created: ${session.createdAt ?? "?"}  lastActivity: ${session.lastActivity ?? "?"}`,
								];
								if (session.streamWebView !== undefined) {
									parts.push(`    streamWebView: ${session.streamWebView}`);
								}
								if (session.liveViewUrl) parts.push(`    live view: ${session.liveViewUrl}`);
								if (session.interactiveLiveViewUrl) {
									parts.push(`    interactive: ${session.interactiveLiveViewUrl}`);
								}
								if (session.cdpUrl) parts.push(`    cdp: ${session.cdpUrl}`);
								return parts.join("\n");
							});
							const active = sessions.filter((session) => session.status === "active").length;
							const warning =
								active > 0 ? `\n\n${active} session(s) still active and billing — delete them when finished.` : "";
							return ok(`## Interact sessions (${sessions.length})\n${rows.join("\n")}${warning}`, {
								count: sessions.length,
								active,
								ids: sessions.map((session) => session.id),
							});
						}

						case "execute": {
							onUpdate?.({
								content: [{ type: "text", text: `Running ${language ?? "node"} code in session ${sessionId}...` }],
							});
							const response = await client.request<ExecuteResponse>(
								`/interact/${encodeURIComponent(sessionId ?? "")}/execute`,
								{
									method: "POST",
									body: compact({ code, language, timeout }),
									signal,
									timeoutMs: executeTimeoutMs,
								},
							);
							const text = await renderExecution(out, `interact-${sessionId}`, response, maxChars);
							const details = {
								sessionId,
								exitCode: response.exitCode,
								killed: response.killed,
								success: response.success,
							};
							// The API reports `success: true` for a session that accepted the code
							// even when the code itself threw, so exitCode is the real verdict.
							return failedExecution(response) ? fail(text, details) : ok(text, details);
						}

						case "delete": {
							const response = await client.request<DeleteSessionResponse>(
								`/interact/${encodeURIComponent(sessionId ?? "")}`,
								{ method: "DELETE", signal },
							);
							const duration =
								response.sessionDurationMs === undefined
									? "unknown duration"
									: `${(response.sessionDurationMs / 1_000).toFixed(1)}s`;
							const credits =
								response.creditsBilled === undefined ? "credits not reported" : `${response.creditsBilled} credits`;
							return ok(`Session ${sessionId} destroyed after ${duration}, billed ${credits}.`, {
								sessionId,
								sessionDurationMs: response.sessionDurationMs,
								creditsBilled: response.creditsBilled,
							});
						}

						case "scrape_execute": {
							onUpdate?.({
								content: [
									{
										type: "text",
										text: prompt
											? `Browser agent working on scrape ${jobId}: ${prompt.slice(0, 120)}`
											: `Running ${language ?? "node"} code in the browser session of scrape ${jobId}...`,
									},
								],
							});
							const response = await client.request<ExecuteResponse>(
								`/scrape/${encodeURIComponent(jobId ?? "")}/interact`,
								{
									method: "POST",
									body: compact({ code, prompt, language: prompt ? undefined : language, timeout, origin }),
									signal,
									timeoutMs: executeTimeoutMs,
								},
							);
							const rendered = await renderExecution(out, `scrape-${jobId}-interact`, response, maxChars);
							const text = `${rendered}\n\nThe browser session for scrape ${jobId} stays live and billing; stop it with action 'scrape_stop'.`;
							const details = {
								jobId,
								mode: prompt ? "prompt" : "code",
								exitCode: response.exitCode,
								killed: response.killed,
								success: response.success,
							};
							return failedExecution(response) ? fail(text, details) : ok(text, details);
						}

						case "scrape_stop": {
							const response = await client.request<{ success?: boolean }>(
								`/scrape/${encodeURIComponent(jobId ?? "")}/interact`,
								{ method: "DELETE", signal },
							);
							const suffix = "Any writable profile attached to the original scrape has been saved back at shutdown.";
							return ok(`Browser session for scrape ${jobId} stopped. ${suffix}`, {
								jobId,
								success: response.success,
							});
						}
					}
				} catch (error) {
					return failFrom(error, signal);
				}
			},
		}),
	];
};

export default module;

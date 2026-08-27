/**
 * `firecrawl_monitor` — the Monitors surface: `POST /v2/monitor`, `GET /v2/monitor`,
 * `GET /v2/monitor/{monitorId}`, `PATCH /v2/monitor/{monitorId}`,
 * `DELETE /v2/monitor/{monitorId}`, `POST /v2/monitor/{monitorId}/run`,
 * `GET /v2/monitor/{monitorId}/checks` and
 * `GET /v2/monitor/{monitorId}/checks/{checkId}`.
 *
 * A monitor is a scheduled diff: Firecrawl re-scrapes/re-crawls/re-searches its
 * targets on a cron, classifies every page as same/new/changed/removed, and
 * optionally has an LLM judge decide whether a change matters for a stated
 * goal. Each run is a "check", and a check carries per-page unified diffs or
 * per-field JSON diffs — which is why check rendering here spills diffs to disk
 * instead of pasting them into the transcript.
 */
import { fail, failFrom, type OutputWriter, ok, stringify } from "../core/output.ts";
import { scrapeOptionsSchema } from "../core/schema.ts";
import { compact, defineTool, type FirecrawlToolEnv, type FirecrawlToolModule } from "../core/tool.ts";

/** Check states that will never change again. `partial` and `skipped_overlap` are terminal too. */
const TERMINAL_CHECK_STATUSES: Record<string, true> = {
	completed: true,
	failed: true,
	partial: true,
	skipped_overlap: true,
};

interface CheckCounts {
	totalPages?: number;
	same?: number;
	changed?: number;
	new?: number;
	removed?: number;
	error?: number;
}

interface MonitorTargetView {
	id?: string;
	type?: string;
	urls?: string[];
	url?: string;
	queries?: string[];
	searchWindow?: string;
	maxResults?: number;
	includeDomains?: string[];
	excludeDomains?: string[];
	crawlOptions?: Record<string, unknown>;
	scrapeOptions?: Record<string, unknown>;
}

interface MonitorRecord {
	id?: string;
	name?: string;
	status?: string;
	schedule?: { cron?: string; text?: string; timezone?: string };
	nextRunAt?: string;
	lastRunAt?: string;
	currentCheckId?: string;
	targets?: MonitorTargetView[];
	goal?: string;
	judgeEnabled?: boolean;
	retentionDays?: number;
	estimatedCreditsPerMonth?: number | null;
	lastCheckSummary?: CheckCounts | null;
	webhook?: { url?: string; events?: string[] } | null;
	notification?: { email?: { enabled?: boolean; recipients?: string[]; includeDiffs?: boolean } } | null;
	createdAt?: string;
	updatedAt?: string;
}

interface MonitorCheckRecord {
	id?: string;
	monitorId?: string;
	status?: string;
	trigger?: string;
	scheduledFor?: string;
	startedAt?: string;
	finishedAt?: string;
	estimatedCredits?: number;
	reservedCredits?: number;
	actualCredits?: number;
	billingStatus?: string;
	summary?: CheckCounts | null;
	targetResults?: unknown[] | null;
	notificationStatus?: unknown;
	error?: string | null;
	createdAt?: string;
	updatedAt?: string;
}

interface MonitorCheckPage {
	id?: string;
	targetId?: string;
	url?: string;
	status?: string;
	previousScrapeId?: string;
	currentScrapeId?: string;
	statusCode?: number;
	error?: string | null;
	metadata?: Record<string, unknown> | null;
	judgment?: {
		meaningful?: boolean;
		confidence?: string;
		reason?: string;
		meaningfulChanges?: Array<{ type?: string; before?: string | null; after?: string | null; reason?: string }>;
	} | null;
	diff?: { text?: string | null; json?: unknown } | null;
	snapshot?: { json?: unknown } | null;
	createdAt?: string;
}

interface MonitorCheckDetail extends MonitorCheckRecord {
	pages?: MonitorCheckPage[];
	next?: string | null;
}

interface MonitorResponse {
	success?: boolean;
	data?: MonitorRecord;
}

interface MonitorListResponse {
	success?: boolean;
	data?: MonitorRecord[];
}

interface MonitorRunResponse {
	success?: boolean;
	id?: string;
	data?: MonitorCheckRecord;
}

interface CheckListResponse {
	success?: boolean;
	data?: MonitorCheckRecord[];
}

interface CheckDetailResponse {
	success?: boolean;
	next?: string | null;
	data?: MonitorCheckDetail;
}

/** `scrape(3 urls) + search(2 queries)` — what this monitor actually watches. */
function describeTargets(targets: MonitorTargetView[] | undefined): string {
	if (!targets || targets.length === 0) return "no targets";
	const parts: string[] = [];
	for (const target of targets) {
		if (target.type === "scrape") {
			const count = target.urls?.length ?? 0;
			parts.push(`scrape(${count} url${count === 1 ? "" : "s"})`);
		} else if (target.type === "crawl") {
			parts.push(`crawl(${target.url ?? "?"})`);
		} else if (target.type === "search") {
			const count = target.queries?.length ?? 0;
			parts.push(`search(${count} quer${count === 1 ? "y" : "ies"})`);
		} else {
			parts.push(target.type ?? "unknown");
		}
	}
	return parts.join(" + ");
}

function describeSchedule(schedule: MonitorRecord["schedule"]): string {
	if (!schedule) return "no schedule";
	const spec = schedule.cron ?? schedule.text ?? "?";
	return schedule.timezone ? `${spec} (${schedule.timezone})` : spec;
}

function describeCounts(counts: CheckCounts | null | undefined): string {
	if (!counts) return "no page summary";
	const entries: string[] = [];
	if (counts.totalPages !== undefined) entries.push(`total=${counts.totalPages}`);
	if (counts.same !== undefined) entries.push(`same=${counts.same}`);
	if (counts.changed !== undefined) entries.push(`changed=${counts.changed}`);
	if (counts.new !== undefined) entries.push(`new=${counts.new}`);
	if (counts.removed !== undefined) entries.push(`removed=${counts.removed}`);
	if (counts.error !== undefined) entries.push(`error=${counts.error}`);
	return entries.length > 0 ? entries.join(" ") : "no page summary";
}

/** One compact table row per monitor: id, name, kind, schedule, status. */
function renderMonitorRows(monitors: MonitorRecord[]): string {
	const rows: string[] = ["id | name | kind | schedule | status | nextRunAt"];
	for (const monitor of monitors) {
		rows.push(
			[
				monitor.id ?? "(no id)",
				monitor.name ?? "(unnamed)",
				describeTargets(monitor.targets),
				describeSchedule(monitor.schedule),
				monitor.status ?? "?",
				monitor.nextRunAt ?? "-",
			].join(" | "),
		);
	}
	return rows.join("\n");
}

function renderMonitorDetail(monitor: MonitorRecord): string {
	const lines: string[] = [
		`## Monitor ${monitor.id ?? "(no id)"} — ${monitor.name ?? "(unnamed)"}`,
		`status: ${monitor.status ?? "?"}   schedule: ${describeSchedule(monitor.schedule)}`,
		`nextRunAt: ${monitor.nextRunAt ?? "-"}   lastRunAt: ${monitor.lastRunAt ?? "-"}`,
	];
	if (monitor.currentCheckId) lines.push(`check in flight: ${monitor.currentCheckId}`);
	if (monitor.goal) lines.push(`goal: ${monitor.goal}`);
	if (monitor.judgeEnabled !== undefined) lines.push(`judgeEnabled: ${monitor.judgeEnabled}`);
	if (monitor.retentionDays !== undefined) lines.push(`retentionDays: ${monitor.retentionDays}`);
	if (monitor.estimatedCreditsPerMonth !== undefined && monitor.estimatedCreditsPerMonth !== null) {
		lines.push(`estimatedCreditsPerMonth (upper bound): ${monitor.estimatedCreditsPerMonth}`);
	}
	if (monitor.lastCheckSummary) lines.push(`last check: ${describeCounts(monitor.lastCheckSummary)}`);
	if (monitor.webhook?.url) {
		const events = monitor.webhook.events?.join(", ") ?? "all monitor events";
		lines.push(`webhook: ${monitor.webhook.url} [${events}]`);
	}
	const email = monitor.notification?.email;
	if (email) {
		lines.push(
			`email: enabled=${email.enabled ?? false} includeDiffs=${email.includeDiffs ?? false} recipients=${email.recipients?.join(", ") ?? "none"}`,
		);
	}

	lines.push("", "### Targets");
	for (const [index, target] of (monitor.targets ?? []).entries()) {
		const head = `[${index + 1}] ${target.type ?? "?"}${target.id ? ` (id ${target.id})` : ""}`;
		const body: string[] = [];
		if (target.urls) body.push(`urls: ${target.urls.join(", ")}`);
		if (target.url) body.push(`url: ${target.url}`);
		if (target.queries) body.push(`queries: ${target.queries.join(" | ")}`);
		if (target.searchWindow) body.push(`searchWindow: ${target.searchWindow}`);
		if (target.maxResults !== undefined) body.push(`maxResults: ${target.maxResults}`);
		if (target.includeDomains) body.push(`includeDomains: ${target.includeDomains.join(", ")}`);
		if (target.excludeDomains) body.push(`excludeDomains: ${target.excludeDomains.join(", ")}`);
		if (target.crawlOptions) body.push(`crawlOptions: ${JSON.stringify(target.crawlOptions)}`);
		if (target.scrapeOptions?.formats) body.push(`formats: ${JSON.stringify(target.scrapeOptions.formats)}`);
		lines.push(body.length > 0 ? `${head}\n    ${body.join("\n    ")}` : head);
	}
	if ((monitor.targets ?? []).length === 0) lines.push("(none)");
	return lines.join("\n");
}

function renderCheckRows(checks: MonitorCheckRecord[]): string {
	const rows: string[] = ["id | status | trigger | scheduledFor | finishedAt | credits | pages"];
	for (const check of checks) {
		const credits = check.actualCredits ?? check.reservedCredits ?? check.estimatedCredits ?? "-";
		rows.push(
			[
				check.id ?? "(no id)",
				check.status ?? "?",
				check.trigger ?? "?",
				check.scheduledFor ?? "-",
				check.finishedAt ?? "-",
				String(credits),
				describeCounts(check.summary),
			].join(" | "),
		);
	}
	return rows.join("\n");
}

/**
 * Render a check plus its page results. Page diffs are collected into one
 * document and spilled when they exceed the inline budget, so a 40-page check
 * still returns a readable summary.
 */
async function renderCheckDetail(
	out: OutputWriter,
	check: MonitorCheckDetail,
	options: { maxChars?: number; truncated: boolean },
): Promise<string> {
	const header: string[] = [
		`## Check ${check.id ?? "(no id)"} of monitor ${check.monitorId ?? "?"}`,
		`status: ${check.status ?? "?"}   trigger: ${check.trigger ?? "?"}`,
		`scheduledFor: ${check.scheduledFor ?? "-"}   startedAt: ${check.startedAt ?? "-"}   finishedAt: ${check.finishedAt ?? "-"}`,
		`pages: ${describeCounts(check.summary)}`,
		`credits: estimated=${check.estimatedCredits ?? "-"} reserved=${check.reservedCredits ?? "-"} actual=${check.actualCredits ?? "-"} billing=${check.billingStatus ?? "-"}`,
	];
	if (check.error) header.push(`error: ${check.error}`);

	const pages = check.pages ?? [];
	const rows: string[] = [];
	const diffSections: string[] = [];

	for (const [index, page] of pages.entries()) {
		const bits = [`[${index + 1}] ${page.status ?? "?"} ${page.url ?? "(no url)"}`];
		if (page.statusCode !== undefined) bits.push(`http ${page.statusCode}`);
		if (page.error) bits.push(`error: ${page.error}`);
		const searchStatus = page.metadata?.searchStatus;
		if (typeof searchStatus === "string") bits.push(`searchStatus: ${searchStatus}`);
		if (page.judgment) {
			bits.push(
				`judge: meaningful=${page.judgment.meaningful ?? "?"} confidence=${page.judgment.confidence ?? "?"}${page.judgment.reason ? ` — ${page.judgment.reason}` : ""}`,
			);
			for (const change of page.judgment.meaningfulChanges ?? []) {
				const before = change.before ? ` before: ${change.before.slice(0, 200)}` : "";
				const after = change.after ? ` after: ${change.after.slice(0, 200)}` : "";
				bits.push(`  ${change.type ?? "changed"}:${before}${after}${change.reason ? ` (${change.reason})` : ""}`);
			}
		}
		rows.push(bits.join("\n    "));

		const parts: string[] = [];
		if (page.diff?.text) parts.push(page.diff.text);
		if (page.diff?.json !== undefined && page.diff.json !== null) parts.push(stringify(page.diff.json));
		if (page.snapshot?.json !== undefined && page.snapshot.json !== null) {
			parts.push(`snapshot:\n${stringify(page.snapshot.json)}`);
		}
		if (parts.length > 0) {
			diffSections.push(`### ${page.status ?? "changed"} ${page.url ?? page.id ?? ""}\n${parts.join("\n\n")}`);
		}
	}

	const blocks: string[] = [header.join("\n")];
	if (rows.length > 0) blocks.push(`### Page results (${pages.length})\n${rows.join("\n")}`);
	else blocks.push("No page results on this check yet.");

	if (diffSections.length > 0) {
		const document = diffSections.join("\n\n---\n\n");
		const budget = options.maxChars ?? out.inlineChars;
		if (document.length <= budget) {
			blocks.push(`### Detected changes\n${document}`);
		} else {
			const spilled = await out.spill(`monitor-check-${check.id ?? "diff"}`, document, "md");
			blocks.push(
				`### Detected changes\n${diffSections.length} page diff(s), ${document.length} chars — written to ${spilled.path} (${(spilled.bytes / 1024).toFixed(0)}KB). Read that file for the diffs.\n\n${document.slice(0, budget)}`,
			);
		}
	}

	if (options.truncated) {
		blocks.push("More page results remain; re-request with a higher `limit` or a larger `skip` to page further.");
	}
	return blocks.join("\n\n");
}

const module: FirecrawlToolModule = (env: FirecrawlToolEnv) => {
	const { z, client, out } = env;

	const scrapeTarget = z.object({
		type: z.literal("scrape").describe("Watch a fixed list of pages"),
		id: z.string().optional().describe("Stable target id; generated when omitted"),
		urls: z.array(z.string()).describe("Pages to re-scrape on every check"),
		scrapeOptions: scrapeOptionsSchema(z)
			.optional()
			.describe(
				"How each page is scraped. Include a `changeTracking` format (optionally with a JSON schema/prompt) to get per-field JSON diffs instead of markdown diffs.",
			),
	});

	const crawlTarget = z.object({
		type: z.literal("crawl").describe("Watch a whole site by re-crawling it"),
		id: z.string().optional().describe("Stable target id; generated when omitted"),
		url: z.string().describe("Root URL to crawl on every check"),
		crawlOptions: z
			.record(z.string(), z.unknown())
			.optional()
			.describe("Crawl controls such as `limit`, `maxDepth`, `includePaths`, `excludePaths`"),
		scrapeOptions: scrapeOptionsSchema(z).optional().describe("How each crawled page is scraped"),
	});

	const searchTarget = z.object({
		type: z.literal("search").describe("Web-scale watch: run queries and alert on new results"),
		id: z.string().optional().describe("Stable target id; generated when omitted"),
		queries: z.array(z.string()).describe("Search queries to run on each check (1-12)"),
		searchWindow: z
			.enum(["5m", "15m", "1h", "6h", "24h", "7d"])
			.optional()
			.describe("Recency filter: only consider results published within this window (default '24h')"),
		maxResults: z
			.number()
			.int()
			.optional()
			.describe("Combined results evaluated per check, deduped across queries (1-50, default 10)"),
		includeDomains: z.array(z.string()).optional().describe("Restrict results to these domains"),
		excludeDomains: z.array(z.string()).optional().describe("Drop results from these domains"),
	});

	const parameters = z.object({
		action: z
			.enum(["create", "list", "get", "update", "delete", "run", "checks", "check"])
			.describe(
				"create: schedule a new monitor. list: all monitors. get: one monitor's full config. update: partial edit (PATCH). delete: remove a monitor. run: trigger a check now. checks: run history for a monitor. check: one check with its per-page diffs.",
			),
		monitorId: z.string().optional().describe("Monitor id. Required for get, update, delete, run, checks and check."),
		checkId: z.string().optional().describe("Check id. Required for action 'check'."),
		name: z.string().optional().describe("Human-readable monitor name. Required for 'create'."),
		schedule: z
			.object({
				cron: z
					.string()
					.optional()
					.describe("Five-field cron expression, e.g. '*/30 * * * *'. Minimum interval 5 minutes."),
				text: z
					.string()
					.optional()
					.describe(
						"Natural-language schedule: 'every 30 minutes', 'every 15 minutes starting at :07', 'hourly', 'every 2 hours', 'daily', 'daily at 9am', 'daily at 5:30 PM', 'weekly'.",
					),
				timezone: z.string().optional().describe("IANA timezone for the schedule, default 'UTC'"),
			})
			.optional()
			.describe("Check cadence. Provide exactly one of `cron` or `text`. Required for 'create'."),
		targets: z
			.array(z.union([scrapeTarget, crawlTarget, searchTarget]))
			.optional()
			.describe(
				"What to watch (1-50 targets): 'scrape' for specific pages, 'crawl' for a whole site, 'search' for web-scale query watching. Required for 'create'.",
			),
		webhook: z
			.object({
				url: z.string().describe("Destination URL for monitor webhooks"),
				headers: z.record(z.string(), z.string()).optional().describe("Headers sent with each delivery"),
				metadata: z.record(z.string(), z.unknown()).optional().describe("Custom metadata echoed in the payload"),
				events: z
					.array(z.enum(["monitor.page", "monitor.check.completed"]))
					.optional()
					.describe(
						"Events to receive: 'monitor.page' fires per changed page, 'monitor.check.completed' fires once per check. Omit for both.",
					),
			})
			.optional()
			.describe("Webhook notification target. Monitors use monitor-specific event names, not the job event names."),
		notification: z
			.object({
				email: z
					.object({
						enabled: z.boolean().optional().describe("Send email summaries (default false)"),
						recipients: z.array(z.string()).optional().describe("Email recipients (max 25)"),
						includeDiffs: z
							.boolean()
							.optional()
							.describe("Include changed page details in the email body (default false)"),
					})
					.optional(),
			})
			.optional()
			.describe("Email notification config"),
		goal: z
			.string()
			.optional()
			.describe(
				"Plain-language goal used to judge whether a change matters, e.g. 'alert only when pricing changes'. Supplying it turns judging on automatically unless `judgeEnabled` says otherwise. Required (non-empty) when any target is a 'search' target.",
			),
		judgeEnabled: z
			.boolean()
			.optional()
			.describe(
				"Judge changed pages against `goal` with an LLM. Needs a non-empty `goal`; judge credits apply only to changed pages.",
			),
		retentionDays: z
			.number()
			.int()
			.optional()
			.describe("Days of check history and diffs to retain (1-365, default 30)"),
		status: z
			.enum(["active", "paused"])
			.optional()
			.describe("'update' only: pause a monitor to stop scheduled checks without deleting it, or reactivate it"),
		limit: z
			.number()
			.int()
			.optional()
			.describe("Page size for 'list', 'checks', and the page results of 'check' (1-100, default 25)"),
		offset: z.number().int().optional().describe("Results to skip for 'list' and 'checks' (default 0)"),
		skip: z.number().int().optional().describe("'check' only: page results to skip (default 0)"),
		checkStatus: z
			.enum(["queued", "running", "completed", "failed", "partial", "skipped_overlap"])
			.optional()
			.describe("'checks' only: filter run history by check status"),
		pageStatus: z
			.enum(["same", "new", "changed", "removed", "error"])
			.optional()
			.describe("'check' only: filter page results, e.g. 'changed' to skip unchanged pages"),
		wait: z
			.boolean()
			.optional()
			.describe(
				"'run' only: poll the triggered check until it finishes and return its diffs (default true). Set false to return the check id immediately and read it later with action 'check'.",
			),
		pollTimeout: z
			.number()
			.int()
			.optional()
			.describe("'run' with wait: seconds to keep polling before returning the latest snapshot"),
		maxPages: z
			.number()
			.int()
			.optional()
			.describe("'check'/'run': how many `next` pages of page results to follow (default 5)"),
		maxChars: z
			.number()
			.int()
			.optional()
			.describe("Inline character budget for detected changes before diffs spill to a file"),
	});

	return [
		defineTool({
			name: "firecrawl_monitor",
			label: "Firecrawl Monitor",
			description:
				"Manage Firecrawl Monitors: scheduled change detection over pages ('scrape' targets), whole sites ('crawl' targets) or web-scale search queries ('search' targets). Each scheduled run is a check that classifies every page as same/new/changed/removed and returns unified markdown diffs or per-field JSON diffs, with optional LLM judging against a plain-language `goal` so you only hear about meaningful changes. Prefer this over repeatedly scraping a page yourself when you want ongoing surveillance with webhooks or email alerts. Cost scales with targets x frequency (every check re-scrapes, and judging bills per changed page), so keep schedules as slow as the question allows — the minimum cron interval is 5 minutes. `update` is a PATCH: only the fields you pass are changed, but `targets` is replaced wholesale, so send the complete target list when editing it. Actions: create, list, get, update, delete, run, checks, check.",
			parameters,
			approval: "write",
			async execute(_id, params, signal, onUpdate, _ctx) {
				const { action, monitorId, checkId, maxChars } = params;

				const needsMonitor = action !== "create" && action !== "list";
				if (needsMonitor && !monitorId) {
					return fail(`Action '${action}' requires \`monitorId\`. Use action 'list' to find monitor ids.`);
				}
				if (action === "check" && !checkId) {
					return fail("Action 'check' requires `checkId`. Use action 'checks' to list check ids for this monitor.");
				}
				if (action === "create") {
					if (!params.name) return fail("Action 'create' requires `name`.");
					if (!params.schedule) return fail("Action 'create' requires `schedule` with either `cron` or `text`.");
					if (!params.schedule.cron && !params.schedule.text) {
						return fail("`schedule` needs either `cron` (five-field cron) or `text` (natural language).");
					}
					if (params.schedule.cron && params.schedule.text) {
						return fail("Provide either `schedule.cron` or `schedule.text`, not both.");
					}
					if (!params.targets || params.targets.length === 0) {
						return fail("Action 'create' requires at least one entry in `targets`.");
					}
					const hasSearchTarget = params.targets.some((target) => target.type === "search");
					if (hasSearchTarget && !params.goal && params.judgeEnabled !== false) {
						return fail(
							"Search targets need a non-empty `goal` so the judge can decide which results are alerts, or `judgeEnabled: false` to skip judging.",
						);
					}
					if (params.status) {
						return fail("`status` only applies to action 'update'; a new monitor starts active.");
					}
				}
				// PATCH is partial: only the fields the caller supplied are sent.
				const updateBody = compact({
					name: params.name,
					schedule: params.schedule,
					targets: params.targets,
					webhook: params.webhook,
					notification: params.notification,
					goal: params.goal,
					judgeEnabled: params.judgeEnabled,
					retentionDays: params.retentionDays,
					status: params.status,
				});
				if (action === "update" && Object.keys(updateBody).length === 0) {
					return fail(
						"Action 'update' needs at least one field to change: name, schedule, targets, webhook, notification, goal, judgeEnabled, retentionDays or status.",
					);
				}

				const encodedMonitor = encodeURIComponent(monitorId ?? "");
				const maxFollowPages = params.maxPages ?? 5;

				/** Fetch a check with its page results, following `next` links. */
				const loadCheck = async (id: string): Promise<{ detail: MonitorCheckDetail; truncated: boolean }> => {
					const first = await client.request<CheckDetailResponse>(
						`/monitor/${encodedMonitor}/checks/${encodeURIComponent(id)}`,
						{
							query: { limit: params.limit, skip: params.skip, status: params.pageStatus },
							signal,
						},
					);
					const detail: MonitorCheckDetail = first.data ?? {};
					const pages = [...(detail.pages ?? [])];
					let next = detail.next ?? first.next ?? undefined;
					let followed = 0;
					while (next && followed < maxFollowPages) {
						const page = await client.request<CheckDetailResponse>("(paginated)", {
							absoluteUrl: next,
							signal,
						});
						pages.push(...(page.data?.pages ?? []));
						next = page.data?.next ?? page.next ?? undefined;
						followed += 1;
					}
					return { detail: { ...detail, pages, next: next ?? null }, truncated: Boolean(next) };
				};

				try {
					switch (action) {
						case "create": {
							const response = await client.request<MonitorResponse>("/monitor", {
								method: "POST",
								body: compact({
									name: params.name,
									schedule: params.schedule,
									targets: params.targets,
									webhook: params.webhook,
									notification: params.notification,
									goal: params.goal,
									judgeEnabled: params.judgeEnabled,
									retentionDays: params.retentionDays,
								}),
								signal,
							});
							const monitor = response.data;
							if (!monitor) return fail("Firecrawl accepted the monitor but returned no monitor object.");
							return ok(
								`Monitor created.\n\n${renderMonitorDetail(monitor)}\n\nTrigger it immediately with action 'run', or wait for ${describeSchedule(monitor.schedule)}.`,
								{ monitorId: monitor.id, status: monitor.status },
							);
						}

						case "list": {
							const response = await client.request<MonitorListResponse>("/monitor", {
								query: { limit: params.limit, offset: params.offset },
								signal,
							});
							const monitors = response.data ?? [];
							if (monitors.length === 0) {
								return ok("No monitors on this team. Create one with action 'create'.", { count: 0 });
							}
							return ok(`## Monitors (${monitors.length})\n${renderMonitorRows(monitors)}`, {
								count: monitors.length,
								ids: monitors.map((monitor) => monitor.id),
							});
						}

						case "get": {
							const response = await client.request<MonitorResponse>(`/monitor/${encodedMonitor}`, { signal });
							const monitor = response.data;
							if (!monitor) return fail(`Monitor ${monitorId} returned no data.`);
							return ok(renderMonitorDetail(monitor), { monitorId: monitor.id, status: monitor.status });
						}

						case "update": {
							const response = await client.request<MonitorResponse>(`/monitor/${encodedMonitor}`, {
								method: "PATCH",
								body: updateBody,
								signal,
							});
							const monitor = response.data;
							if (!monitor) return fail(`Monitor ${monitorId} was updated but returned no monitor object.`);
							return ok(`Monitor updated.\n\n${renderMonitorDetail(monitor)}`, {
								monitorId: monitor.id,
								status: monitor.status,
							});
						}

						case "delete": {
							const response = await client.request<{ success?: boolean }>(`/monitor/${encodedMonitor}`, {
								method: "DELETE",
								signal,
							});
							return ok(
								`Monitor ${monitorId} deleted. Scheduled checks stop immediately; stored checks and diffs age out with the retention window.`,
								{ monitorId, success: response.success },
							);
						}

						case "run": {
							const response = await client.request<MonitorRunResponse>(`/monitor/${encodedMonitor}/run`, {
								method: "POST",
								signal,
							});
							const started = response.data;
							const triggeredId = started?.id ?? response.id;
							if (!triggeredId) return fail(`Monitor ${monitorId} accepted the run but returned no check id.`);

							if (params.wait === false) {
								return ok(
									`Check ${triggeredId} queued for monitor ${monitorId} (status ${started?.status ?? "queued"}). Read it later with action 'check' and \`checkId: "${triggeredId}"\`.`,
									{ monitorId, checkId: triggeredId, status: started?.status },
								);
							}

							const polled = await client.pollJob<CheckDetailResponse>(
								`/monitor/${encodedMonitor}/checks/${encodeURIComponent(triggeredId)}`,
								{
									signal,
									timeoutMs: params.pollTimeout ? params.pollTimeout * 1_000 : undefined,
									isDone(snapshot) {
										const status = snapshot.data?.status;
										return status !== undefined && TERMINAL_CHECK_STATUSES[status] === true;
									},
									onPoll(snapshot) {
										const check = snapshot.data;
										onUpdate?.({
											content: [
												{
													type: "text",
													text: `Check ${triggeredId}: ${check?.status ?? "queued"} — ${describeCounts(check?.summary)}`,
												},
											],
										});
									},
								},
							);

							const status = polled.data?.status;
							if (status === undefined || TERMINAL_CHECK_STATUSES[status] !== true) {
								return ok(
									`Check ${triggeredId} is still ${status ?? "queued"} after polling. Read it with action 'check' and \`checkId: "${triggeredId}"\`.`,
									{ monitorId, checkId: triggeredId, status },
								);
							}

							const { detail, truncated } = await loadCheck(triggeredId);
							const text = await renderCheckDetail(out, detail, { maxChars, truncated });
							return ok(text, {
								monitorId,
								checkId: triggeredId,
								status: detail.status,
								summary: detail.summary,
								actualCredits: detail.actualCredits,
							});
						}

						case "checks": {
							const response = await client.request<CheckListResponse>(`/monitor/${encodedMonitor}/checks`, {
								query: { limit: params.limit, offset: params.offset, status: params.checkStatus },
								signal,
							});
							const checks = response.data ?? [];
							if (checks.length === 0) {
								return ok(
									params.checkStatus
										? `Monitor ${monitorId} has no checks with status '${params.checkStatus}'.`
										: `Monitor ${monitorId} has not run any checks yet. Trigger one with action 'run'.`,
									{ monitorId, count: 0 },
								);
							}
							return ok(`## Checks for monitor ${monitorId} (${checks.length})\n${renderCheckRows(checks)}`, {
								monitorId,
								count: checks.length,
								ids: checks.map((check) => check.id),
							});
						}

						case "check": {
							const { detail, truncated } = await loadCheck(checkId ?? "");
							const text = await renderCheckDetail(out, detail, { maxChars, truncated });
							return ok(text, {
								monitorId,
								checkId,
								status: detail.status,
								summary: detail.summary,
								actualCredits: detail.actualCredits,
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

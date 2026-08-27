/**
 * `firecrawl_account` — team account, policy and support surface.
 *
 * Covers credit and token balances plus their historical billing periods
 * (`/v2/team/credit-usage`, `/v2/team/credit-usage/historical`,
 * `/v2/team/token-usage`, `/v2/team/token-usage/historical`), queue pressure
 * (`/v2/team/queue-status`), the recent job log (`/v2/team/activity`), the
 * Threat Protection policy (`GET`/`PUT /v2/team/threat-protection`), job
 * feedback and credit refunds (`/v2/feedback`, `/v2/search/{jobId}/feedback`)
 * and the support agents (`/v2/support/ask`, `/v2/support/docs-search`).
 *
 * `approval: "write"` because `set_threat_protection` replaces an
 * account-wide security policy and the feedback actions are not idempotent.
 */
import { fail, failFrom, ok, stringify } from "../core/output.ts";
import { compact, defineTool, type FirecrawlToolEnv, type FirecrawlToolModule } from "../core/tool.ts";

const ACTIVITY_ENDPOINTS = [
	"scrape",
	"crawl",
	"batch_scrape",
	"search",
	"extract",
	"llmstxt",
	"deep_research",
	"map",
	"agent",
	"browser",
	"interact",
] as const;

/**
 * Where a listed job's full result lives. `/team/activity` hands back an id and
 * an endpoint name, and the retrieval path is not derivable from either — batch
 * scrapes live under `/batch/scrape/{id}` and interact sessions under
 * `/interact/{sessionId}`. Endpoints absent here have no GET retrieval route:
 * `search`, `map`, `llmstxt`, `deep_research` and `browser` return their result
 * inline on the original call.
 */
const JOB_RESULT_PATHS: Record<string, string> = {
	scrape: "GET /v2/scrape/{id}",
	crawl: "GET /v2/crawl/{id}",
	batch_scrape: "GET /v2/batch/scrape/{id}",
	extract: "GET /v2/extract/{id}",
	agent: "GET /v2/agent/{id}",
	interact: "GET /v2/interact/{id}",
};

interface CreditUsageResponse {
	success?: boolean;
	data?: {
		remainingCredits?: number;
		planCredits?: number;
		billingPeriodStart?: string;
		billingPeriodEnd?: string;
	};
}

interface TokenUsageResponse {
	success?: boolean;
	data?: {
		remainingTokens?: number;
		planTokens?: number;
		billingPeriodStart?: string;
		billingPeriodEnd?: string;
	};
}

interface HistoricalPeriod {
	startDate?: string;
	/** `null` on the open, current billing period. */
	endDate?: string | null;
	apiKey?: string | null;
	/** The live API returns `creditsUsed`/`tokensUsed`; the spec documents the `total*` names. */
	creditsUsed?: number;
	tokensUsed?: number;
	totalCredits?: number;
	totalTokens?: number;
}

interface HistoricalUsageResponse {
	success?: boolean;
	periods?: HistoricalPeriod[];
}

interface QueueStatusResponse {
	success?: boolean;
	jobsInQueue?: number;
	activeJobsInQueue?: number;
	waitingJobsInQueue?: number;
	maxConcurrency?: number;
	mostRecentSuccess?: string;
}

interface ActivityResponse {
	success?: boolean;
	data?: Array<{
		id?: string;
		endpoint?: string;
		api_version?: string;
		created_at?: string;
		target?: string;
	}>;
	cursor?: string | null;
	has_more?: boolean;
}

interface ThreatProtectionPolicy {
	mode?: "off" | "normal";
	riskScoreThreshold?: number;
	blacklist?: string[];
	whitelist?: string[];
	blockedTlds?: string[];
	failurePolicy?: "open" | "closed";
	allowRequestOverrides?: boolean;
	configured?: boolean;
	updatedAt?: string;
}

interface ThreatProtectionResponse {
	success?: boolean;
	data?: ThreatProtectionPolicy;
}

interface FeedbackResponse {
	success?: boolean;
	feedbackId?: string;
	creditsRefunded?: number;
	alreadySubmitted?: boolean;
	dailyCapReached?: boolean;
	creditsRefundedToday?: number;
	dailyRefundCap?: number;
	warning?: string;
}

/** Documented shape of `validation`; the object is open, so extras pass through. */
interface SupportValidation {
	tested?: boolean;
	result?: "success" | "failure" | "skipped";
	evidence?: unknown;
	[key: string]: unknown;
}

/** Documented shape of `feedback`, present only when the agent gets stuck. */
interface SupportBlocked {
	blockedBy?: string;
	attempted?: unknown;
	[key: string]: unknown;
}

interface SupportAskResponse {
	answer?: string;
	confidence?: "high" | "medium" | "low";
	fixParameters?: Record<string, unknown> | null;
	validation?: SupportValidation | null;
	feedback?: SupportBlocked | null;
	durationMs?: number;
}

interface DocsSearchResponse {
	requestId?: string;
	answer?: string;
	evidence?: Array<{ pathOrUrl?: string; reason?: string }>;
	usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
	durationMs?: number;
}

const module: FirecrawlToolModule = (env: FirecrawlToolEnv) => {
	const { z, client, out } = env;

	const parameters = z.object({
		action: z
			.enum([
				"credits",
				"credits_history",
				"tokens",
				"tokens_history",
				"queue",
				"activity",
				"threat_protection",
				"set_threat_protection",
				"feedback",
				"search_feedback",
				"ask",
				"docs_search",
			])
			.describe(
				"'credits'/'tokens' current balance and billing window; 'credits_history'/'tokens_history' past billing periods; 'queue' concurrency pressure; 'activity' recent job log with ids; 'threat_protection' read the policy; 'set_threat_protection' replace the policy — both are enterprise-gated and answer 403 when Threat Protection is not enabled for the team; 'feedback' rate a finished scrape/parse/map/search job; 'search_feedback' rate a /search job by id; 'ask' have the support agent diagnose a failure; 'docs_search' answer a Firecrawl docs question with citations.",
			),
		byApiKey: z
			.boolean()
			.optional()
			.describe(
				"'credits_history'/'tokens_history' only. Break each billing period down per API key instead of aggregating the team (default false, which reports `apiKey` as null).",
			),
		endpoint: z
			.enum([...ACTIVITY_ENDPOINTS])
			.optional()
			.describe("'activity' only. Filter the job log to one endpoint. The log only covers the last 24 hours."),
		limit: z
			.number()
			.int()
			.min(1)
			.max(100)
			.optional()
			.describe("'activity' only. Maximum jobs per page, 1-100, default 50."),
		cursor: z
			.string()
			.optional()
			.describe("'activity' only. Pagination cursor; pass the `cursor` value returned by the previous call."),
		policy: z
			.object({
				mode: z
					.enum(["off", "normal"])
					.describe("'off' disables checks; 'normal' checks URLs against Google Web Risk (+2 credits per URL scanned)"),
				riskScoreThreshold: z
					.number()
					.int()
					.min(0)
					.max(100)
					.describe("Normalized score 0-100 at or above which a classifier verdict is blocked; lower is stricter"),
				blacklist: z
					.array(z.string())
					.describe(
						"Exact domains or globs like '*.example.com' always blocked without a classifier call; [] for none",
					),
				whitelist: z
					.array(z.string())
					.describe("Exact domains or globs always allowed; wins over every other rule. [] for none"),
				blockedTlds: z
					.array(z.string())
					.describe("Top-level domains blocked outright, lowercase without a leading dot; [] for none"),
				failurePolicy: z
					.enum(["open", "closed"])
					.describe("Behavior when the classifier is unreachable: 'closed' blocks (Firecrawl default), 'open' allows"),
				allowRequestOverrides: z
					.boolean()
					.describe(
						"Whether individual requests may pass their own `threatProtection` object; when false such requests are rejected with 403",
					),
			})
			.optional()
			.describe(
				"'set_threat_protection' only. The COMPLETE replacement policy — this is a full-document update, so every field is required and any value you change from the current policy takes effect account-wide.",
			),
		jobId: z
			.string()
			.optional()
			.describe("Required for 'feedback' and 'search_feedback': the job id returned by the original endpoint."),
		jobEndpoint: z
			.enum(["search", "scrape", "parse", "map"])
			.optional()
			.describe("Required for 'feedback': which endpoint produced `jobId`. 'search_feedback' implies 'search'."),
		rating: z
			.enum(["good", "partial", "bad"])
			.optional()
			.describe(
				"Required for 'feedback' and 'search_feedback'. For 'good' include valuableSources; for 'partial' include valuableSources or missingContent; for 'bad' include missingContent or querySuggestions. A 'bad' rating may refund the job's credits.",
			),
		issues: z
			.array(z.string())
			.optional()
			.describe(
				"'feedback' only. Up to 20 short machine-readable issue slugs, each at most 80 characters and matching ^[a-z0-9][a-z0-9_-]*$, e.g. 'paywalled', 'js_not_rendered'.",
			),
		tags: z
			.array(z.string())
			.optional()
			.describe(
				"'feedback' only. Up to 20 slugs (same charset and 80-character limit as `issues`) for your own categorisation.",
			),
		note: z.string().optional().describe("'feedback' only. Free-form explanation, max 4000 characters."),
		url: z.string().optional().describe("'feedback' only. The specific result URL the feedback is about."),
		pageNumbers: z
			.array(z.number().int().positive())
			.optional()
			.describe("'feedback' only. Up to 100 1-based page numbers the feedback applies to (parse/PDF jobs)."),
		metadata: z
			.record(z.string(), z.unknown())
			.optional()
			.describe(
				"'feedback' only. Small endpoint-specific metadata object, 8KB max. Do not put full endpoint results in here.",
			),
		valuableSources: z
			.array(
				z.object({
					url: z.string().describe("Result URL that was actually useful"),
					reason: z.string().optional().describe("Why it was useful, max 1000 characters"),
				}),
			)
			.optional()
			.describe("Up to 50 results worth keeping. Expected for a 'good' rating."),
		missingContent: z
			.array(
				z.object({
					topic: z.string().describe("What was missing, 1-200 characters"),
					description: z.string().optional().describe("Detail about the gap, max 2000 characters"),
				}),
			)
			.optional()
			.describe(
				"Gaps in the result: up to 50 for 'feedback', up to 20 for 'search_feedback'. Expected for a 'bad' rating.",
			),
		querySuggestions: z
			.string()
			.optional()
			.describe("Better query or parameters that would have worked, max 2000 characters."),
		origin: z.string().optional().describe("Feedback origin label, default 'api'."),
		integration: z.string().optional().describe("Integration identifier to attribute the feedback to."),
		question: z
			.string()
			.optional()
			.describe(
				"Required for 'ask' (the failure or integration problem to diagnose) and 'docs_search' (the documentation question to answer).",
			),
		rationale: z
			.string()
			.optional()
			.describe("'ask' only. What you are ultimately trying to accomplish, so the agent can suggest a better route."),
		maxChars: z
			.number()
			.int()
			.optional()
			.describe("Inline character budget before long answers and payloads are written to a file"),
	});

	return [
		defineTool({
			name: "firecrawl_account",
			label: "Firecrawl Account & Support",
			description:
				"Inspect and manage the Firecrawl team account, and reach Firecrawl's support agents. Read credit/token balances and their billing windows, list historical usage per period or per API key, check queue depth against your plan's max concurrency, and list recent jobs with their ids so you can re-fetch results from the matching GET endpoint. Read or replace the account-wide Threat Protection policy (the PUT is a full-document update: always read the current policy first, because unspecified fields reset to defaults). Submit feedback on a finished scrape/parse/map/search job — a 'bad' rating can refund its credits. Finally, 'ask' runs an agentic support diagnosis of a failing job or integration, and 'docs_search' answers Firecrawl documentation questions with citations. Reads are cheap and fast; 'ask' and 'docs_search' are agentic and take seconds.",
			parameters,
			approval: "write",
			async execute(_id, params, signal, _onUpdate, _ctx) {
				const {
					action,
					byApiKey,
					endpoint,
					limit,
					cursor,
					policy,
					jobId,
					jobEndpoint,
					rating,
					issues,
					tags,
					note,
					url,
					pageNumbers,
					metadata,
					valuableSources,
					missingContent,
					querySuggestions,
					origin,
					integration,
					question,
					rationale,
					maxChars,
				} = params;

				try {
					switch (action) {
						case "credits": {
							const response = await client.request<CreditUsageResponse>("/team/credit-usage", { signal });
							const data = response.data ?? {};
							const lines = [
								"## Credit usage",
								`remaining credits: ${data.remainingCredits?.toLocaleString("en-US") ?? "unknown"}`,
								`plan credits: ${data.planCredits?.toLocaleString("en-US") ?? "unknown"} (excludes coupons, credit packs and auto-recharge)`,
								`billing period: ${data.billingPeriodStart ?? "?"} to ${data.billingPeriodEnd ?? "?"}`,
							];
							return ok(lines.join("\n"), data);
						}

						case "tokens": {
							const response = await client.request<TokenUsageResponse>("/team/token-usage", { signal });
							const data = response.data ?? {};
							const lines = [
								"## Token usage",
								`remaining tokens: ${data.remainingTokens?.toLocaleString("en-US") ?? "unknown"}`,
								`plan tokens: ${data.planTokens?.toLocaleString("en-US") ?? "unknown"} (excludes coupon tokens)`,
								`billing period: ${data.billingPeriodStart ?? "?"} to ${data.billingPeriodEnd ?? "?"}`,
							];
							return ok(lines.join("\n"), data);
						}

						case "credits_history":
						case "tokens_history": {
							const isCredits = action === "credits_history";
							const path = isCredits ? "/team/credit-usage/historical" : "/team/token-usage/historical";
							const response = await client.request<HistoricalUsageResponse>(path, {
								query: { byApiKey },
								signal,
							});
							const periods = response.periods ?? [];
							if (periods.length === 0) {
								return ok(`No historical ${isCredits ? "credit" : "token"} usage periods returned.`, { periods });
							}
							const rows = periods.map((period) => {
								const total = isCredits
									? (period.creditsUsed ?? period.totalCredits)
									: (period.tokensUsed ?? period.totalTokens);
								const key = period.apiKey ? ` [key: ${period.apiKey}]` : "";
								const end = period.endDate ?? "now (current period)";
								return `${period.startDate ?? "?"} to ${end}: ${total?.toLocaleString("en-US") ?? "unknown"}${key}`;
							});
							const header = `## Historical ${isCredits ? "credits" : "tokens"} (${periods.length} periods${byApiKey ? ", per API key" : ""})`;
							return ok(`${header}\n${rows.join("\n")}`, { periods });
						}

						case "queue": {
							const response = await client.request<QueueStatusResponse>("/team/queue-status", { signal });
							const lines = [
								"## Queue status",
								`jobs in queue: ${response.jobsInQueue ?? "unknown"} (active ${response.activeJobsInQueue ?? "?"}, waiting ${response.waitingJobsInQueue ?? "?"})`,
								`max concurrency on this plan: ${response.maxConcurrency ?? "unknown"}`,
								`most recent success: ${response.mostRecentSuccess ?? "none recorded"}`,
							];
							return ok(lines.join("\n"), {
								jobsInQueue: response.jobsInQueue,
								activeJobsInQueue: response.activeJobsInQueue,
								waitingJobsInQueue: response.waitingJobsInQueue,
								maxConcurrency: response.maxConcurrency,
								mostRecentSuccess: response.mostRecentSuccess,
							});
						}

						case "activity": {
							const response = await client.request<ActivityResponse>("/team/activity", {
								query: { endpoint, limit, cursor },
								signal,
							});
							const jobs = response.data ?? [];
							if (jobs.length === 0) {
								return ok(
									`No recent jobs${endpoint ? ` for endpoint '${endpoint}'` : ""}${cursor ? " after this cursor" : ""}.`,
									{ count: 0, cursor: response.cursor ?? null, has_more: response.has_more ?? false },
								);
							}
							const rows = jobs.map((job, position) => {
								const parts = [
									`[${position + 1}] ${job.endpoint ?? "?"}${job.api_version ? ` (${job.api_version})` : ""}`,
									`id: ${job.id ?? "?"}`,
									`created: ${job.created_at ?? "?"}`,
								];
								if (job.target) parts.push(`target: ${job.target}`);
								const retrieval = job.endpoint === undefined ? undefined : JOB_RESULT_PATHS[job.endpoint];
								if (retrieval && job.id) parts.push(`fetch: ${retrieval.replace("{id}", job.id)}`);
								return parts.join(" | ");
							});
							const paging = response.has_more
								? `More results available — call again with cursor: ${response.cursor ?? "(missing)"}`
								: "End of results (no further cursor).";
							const text = [
								`## Recent activity, last 24 hours (${jobs.length} jobs${endpoint ? `, endpoint '${endpoint}'` : ""})`,
								"Each row's `fetch` field is the exact call that returns that job's full result. Rows without one — search, map, llmstxt, deep_research, browser — have no GET retrieval route.",
								await out.section("firecrawl-activity", rows.join("\n"), maxChars),
								paging,
							].join("\n\n");
							return ok(text, {
								count: jobs.length,
								cursor: response.cursor ?? null,
								has_more: response.has_more ?? false,
								ids: jobs.map((job) => job.id),
							});
						}

						case "threat_protection": {
							const response = await client.request<ThreatProtectionResponse>("/team/threat-protection", {
								signal,
							});
							const data = response.data ?? {};
							const lines = [
								`## Threat Protection (${data.configured ? "configured" : "serving defaults — no saved policy"})`,
								`mode: ${data.mode ?? "unknown"}`,
								`riskScoreThreshold: ${data.riskScoreThreshold ?? "unknown"}`,
								`failurePolicy: ${data.failurePolicy ?? "unknown"}`,
								`allowRequestOverrides: ${data.allowRequestOverrides ?? "unknown"}`,
								`blacklist (${data.blacklist?.length ?? 0}): ${data.blacklist?.join(", ") || "(empty)"}`,
								`whitelist (${data.whitelist?.length ?? 0}): ${data.whitelist?.join(", ") || "(empty)"}`,
								`blockedTlds (${data.blockedTlds?.length ?? 0}): ${data.blockedTlds?.join(", ") || "(empty)"}`,
								`updatedAt: ${data.updatedAt ?? "never"}`,
								"",
								"To change this policy, pass the whole object back via action 'set_threat_protection' with your edits applied — omitted fields reset to defaults.",
							];
							return ok(lines.join("\n"), data);
						}

						case "set_threat_protection": {
							if (!policy) {
								return fail(
									"Action 'set_threat_protection' requires the complete `policy` object. Run action 'threat_protection' first, then resend every field with your edits applied — this is a full-document update and omitted fields reset to Firecrawl defaults.",
								);
							}
							const response = await client.request<ThreatProtectionResponse>("/team/threat-protection", {
								method: "PUT",
								body: policy,
								signal,
								retryOn5xx: true,
							});
							const data = response.data ?? {};
							const lines = [
								"## Threat Protection updated",
								`mode: ${data.mode ?? "unknown"} | riskScoreThreshold: ${data.riskScoreThreshold ?? "unknown"} | failurePolicy: ${data.failurePolicy ?? "unknown"} | allowRequestOverrides: ${data.allowRequestOverrides ?? "unknown"}`,
								`blacklist (${data.blacklist?.length ?? 0}): ${data.blacklist?.join(", ") || "(empty)"}`,
								`whitelist (${data.whitelist?.length ?? 0}): ${data.whitelist?.join(", ") || "(empty)"}`,
								`blockedTlds (${data.blockedTlds?.length ?? 0}): ${data.blockedTlds?.join(", ") || "(empty)"}`,
								`updatedAt: ${data.updatedAt ?? "unknown"}`,
							];
							return ok(lines.join("\n"), data);
						}

						case "feedback":
						case "search_feedback": {
							if (!jobId) return fail(`Action '${action}' requires \`jobId\` (the id returned by the original job).`);
							if (!rating) return fail(`Action '${action}' requires \`rating\` ('good', 'partial' or 'bad').`);
							const shared = compact({
								rating,
								valuableSources,
								missingContent,
								querySuggestions,
								origin,
								integration,
							});
							let path = `/search/${encodeURIComponent(jobId)}/feedback`;
							let body = shared;
							if (action === "feedback") {
								if (!jobEndpoint) {
									return fail(
										"Action 'feedback' requires `jobEndpoint` ('search', 'scrape', 'parse' or 'map') naming the endpoint that produced `jobId`.",
									);
								}
								const substantive =
									issues !== undefined ||
									note !== undefined ||
									url !== undefined ||
									pageNumbers !== undefined ||
									valuableSources !== undefined ||
									missingContent !== undefined ||
									querySuggestions !== undefined;
								if (!substantive) {
									return fail(
										"Action 'feedback' needs at least one substantive signal: `issues`, `note`, `url`, `pageNumbers`, `valuableSources`, `missingContent` or `querySuggestions`.",
									);
								}
								path = "/feedback";
								body = compact({
									...shared,
									endpoint: jobEndpoint,
									jobId,
									issues,
									tags,
									note,
									url,
									pageNumbers,
									metadata,
								});
							}
							const response = await client.request<FeedbackResponse>(path, {
								method: "POST",
								body,
								signal,
							});
							const lines = [
								`## Feedback recorded${response.alreadySubmitted ? " (already submitted earlier)" : ""}`,
								`feedbackId: ${response.feedbackId ?? "unknown"}`,
								`credits refunded: ${response.creditsRefunded?.toLocaleString("en-US") ?? "0"}`,
							];
							if (response.creditsRefundedToday !== undefined || response.dailyRefundCap !== undefined) {
								lines.push(
									`refunded today: ${response.creditsRefundedToday?.toLocaleString("en-US") ?? "?"} of daily cap ${response.dailyRefundCap?.toLocaleString("en-US") ?? "?"}${response.dailyCapReached ? " — cap reached" : ""}`,
								);
							}
							if (response.warning) lines.push(`warning: ${response.warning}`);
							return ok(lines.join("\n"), response);
						}

						case "ask": {
							if (!question) {
								return fail(
									"Action 'ask' requires `question` describing the failure or integration problem to diagnose.",
								);
							}
							const response = await client.request<SupportAskResponse>("/support/ask", {
								method: "POST",
								body: compact({ question, rationale }),
								signal,
							});
							const sections = [
								`## Support diagnosis${response.confidence ? ` (confidence: ${response.confidence})` : ""}`,
								await out.section("firecrawl-support-ask", response.answer?.trim() || "(no answer returned)", maxChars),
							];
							if (response.fixParameters) {
								sections.push(
									`### Suggested fix parameters\n${await out.section("firecrawl-fix-parameters", stringify(response.fixParameters), maxChars, "json")}`,
								);
							}
							if (response.validation) {
								// `tested`/`result` decide whether the fix above is proven or merely
								// suggested, so they belong in the heading rather than buried in JSON.
								const verdict = [
									response.validation.tested === undefined ? undefined : `tested: ${response.validation.tested}`,
									response.validation.result ? `result: ${response.validation.result}` : undefined,
								].filter((part): part is string => part !== undefined);
								sections.push(
									`### Validation${verdict.length > 0 ? ` (${verdict.join(", ")})` : ""}\n${await out.section("firecrawl-support-validation", stringify(response.validation), maxChars, "json")}`,
								);
							}
							if (response.feedback) {
								const blocker = response.feedback.blockedBy ? ` — blocked by ${response.feedback.blockedBy}` : "";
								sections.push(
									`### Agent needs more information${blocker}\n${await out.section("firecrawl-support-feedback", stringify(response.feedback), maxChars, "json")}`,
								);
							}
							if (response.durationMs !== undefined) {
								sections.push(`(support agent took ${(response.durationMs / 1000).toFixed(1)}s)`);
							}
							return ok(sections.join("\n\n"), {
								confidence: response.confidence,
								fixParameters: response.fixParameters,
								validation: response.validation,
								blocked: Boolean(response.feedback),
								durationMs: response.durationMs,
							});
						}

						case "docs_search": {
							if (!question)
								return fail("Action 'docs_search' requires `question` (the documentation question to answer).");
							const response = await client.request<DocsSearchResponse>("/support/docs-search", {
								method: "POST",
								body: { question },
								signal,
							});
							const sections = [
								"## Firecrawl docs answer",
								await out.section("firecrawl-docs-answer", response.answer?.trim() || "(no answer returned)", maxChars),
							];
							const evidence = response.evidence ?? [];
							if (evidence.length > 0) {
								const citations = evidence.map((item, position) => {
									const reason = item.reason ? ` — ${item.reason}` : "";
									return `[${position + 1}] ${item.pathOrUrl ?? "(unknown source)"}${reason}`;
								});
								sections.push(`### Citations\n${citations.join("\n")}`);
							}
							const usage = response.usage;
							const footer = [
								usage?.totalTokens !== undefined
									? `tokens: ${usage.totalTokens.toLocaleString("en-US")} (in ${usage.inputTokens?.toLocaleString("en-US") ?? "?"}, out ${usage.outputTokens?.toLocaleString("en-US") ?? "?"})`
									: undefined,
								response.durationMs !== undefined ? `took ${(response.durationMs / 1000).toFixed(1)}s` : undefined,
								response.requestId ? `requestId: ${response.requestId}` : undefined,
							].filter((part): part is string => part !== undefined);
							if (footer.length > 0) sections.push(`(${footer.join(" | ")})`);
							return ok(sections.join("\n\n"), {
								citations: evidence.length,
								requestId: response.requestId,
								usage,
							});
						}

						default:
							return fail(`Unsupported action '${action}'.`);
					}
				} catch (error) {
					return failFrom(error, signal);
				}
			},
		}),
	];
};

export default module;

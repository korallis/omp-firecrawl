/**
 * `firecrawl_developer` — `POST /v2/search/developer`.
 *
 * Firecrawl's Developer Index: GitHub issues, merged pull requests, repository
 * READMEs, indexed agent-skill files and curated documentation sites, returned
 * as matched markdown passages. This is the right first stop for "has anyone
 * hit this error", "how does library X do Y", and API-behaviour questions,
 * because the evidence comes back as quotable passages rather than SERP blurbs.
 *
 * `GET /v2/search/developer` is the query-string twin of this POST: the same
 * fourteen fields, the same response, with `types`/`repos`/`sources` squeezed
 * into repeated or comma-joined parameters. POST carries the arrays natively
 * and has no URL length ceiling, so only POST is exposed here.
 */
import { failFrom, ok } from "../core/output.ts";
import { compact, defineTool, type FirecrawlToolEnv, type FirecrawlToolModule } from "../core/tool.ts";

type ResultType = "doc" | "issue" | "pull_request" | "readme";

/** Per-type outcome reported by `coverage`. */
type CoverageState = "ok" | "degraded" | "unavailable" | "skipped";

/**
 * Repository-half index state, keyed by the camelCase names the API returns.
 * A mapped type rather than an interface so `Object.entries` keeps the value
 * type instead of widening to `any`.
 */
type RepoTypeCoverage = Partial<Record<"issue" | "pullRequest" | "readme", boolean>>;

interface DeveloperResult {
	id?: string;
	/** Present on some corpora only; otherwise the kind is the `id` prefix. */
	type?: ResultType;
	url?: string;
	title?: string;
	passages?: Array<{ text?: string }>;
	license?: string;
	language?: string;
	stars?: number;
}

interface DeveloperResponse {
	success?: boolean;
	results?: DeveloperResult[];
	coverage?: Partial<Record<ResultType, CoverageState>>;
	reranked?: boolean;
	repos?: Array<{ repo?: string; indexed?: boolean; types?: RepoTypeCoverage }>;
	sources?: Array<{ source?: string; indexed?: boolean }>;
}

const module: FirecrawlToolModule = (env: FirecrawlToolEnv) => {
	const { z, client, out } = env;

	const parameters = z.object({
		query: z.string().describe("Natural-language question or search phrase"),
		k: z.number().int().min(1).optional().describe("Ranked results to return (1-100, default 10)"),
		types: z
			.array(z.enum(["doc", "issue", "pull_request", "readme"]))
			.optional()
			.describe("Result kinds to search. Defaults to all four."),
		repos: z
			.array(z.string())
			.optional()
			.describe(
				"Repository slugs like 'firecrawl/firecrawl' scoping the repository half of the index — the `issue`, `pull_request` and `readme` types. Sent together with `sources` the two halves are combined, not intersected. Returns 400 when `types` names no repository type; the response echoes each slug back with an `indexed` flag and a per-type breakdown.",
			),
		sources: z
			.array(z.string())
			.optional()
			.describe(
				"Documentation source ids scoping the `doc` half (max 20 ids, each at most 512 characters). Ids are not a fixed enum and the set grows over time. Returns 400 when `types` omits `doc`; the response echoes each id back with an `indexed` flag, so an unknown id is distinguishable from a query that simply found nothing.",
			),
		skills: z.enum(["only"]).optional().describe("Set to 'only' to search indexed agent-skill files exclusively"),
		passages: z.number().int().min(1).max(5).optional().describe("Matched passages per result (1-5, default 1)"),
		language: z
			.string()
			.optional()
			.describe(
				"Repository primary language, e.g. 'Rust'. Repository filter: sending it without a `sources` scope returns no `doc` results, because a crawled documentation page has no repository behind it.",
			),
		topic: z
			.string()
			.optional()
			.describe(
				"Repository topic, e.g. 'async'. Repository filter: without a `sources` scope no `doc` results come back.",
			),
		license: z
			.string()
			.optional()
			.describe(
				"Repository license, e.g. 'MIT'. Repository filter: without a `sources` scope no `doc` results come back.",
			),
		min_stars: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe(
				"Lower bound on repository stars. Repository filter: without a `sources` scope no `doc` results come back.",
			),
		max_stars: z
			.number()
			.int()
			.min(0)
			.optional()
			.describe(
				"Upper bound on repository stars. Repository filter: without a `sources` scope no `doc` results come back.",
			),
		archived: z
			.boolean()
			.optional()
			.describe(
				"Include or exclude archived repositories. Repository filter: without a `sources` scope no `doc` results come back.",
			),
		fork: z
			.boolean()
			.optional()
			.describe("Include or exclude forks. Repository filter: without a `sources` scope no `doc` results come back."),
		maxChars: z.number().int().optional().describe("Inline character budget before passages spill to a file"),
	});

	return [
		defineTool({
			name: "firecrawl_developer",
			label: "Firecrawl Developer Index",
			description:
				"Search Firecrawl's Developer Index for GitHub issues, merged pull requests, repository READMEs, agent-skill files and curated documentation, returned as matched markdown passages. Prefer this over generic web search for error messages, library behaviour, upgrade breakages and API semantics. Filter by repos, doc sources, language, topic, license, stars, archived and fork. Costs 2 credits per 10 results, rounded up, so `k` is the cost knob.",
			parameters,
			loadMode: "essential",
			approval: "read",
			async execute(_id, params, signal, _onUpdate, _ctx) {
				const { maxChars, ...body } = params;
				try {
					const response = await client.request<DeveloperResponse>("/search/developer", {
						method: "POST",
						body: compact(body),
						signal,
					});

					const results = response.results ?? [];

					// The `repos`/`sources` echoes are the only way to tell an id that is not
					// in the index from a query that simply found nothing, so they have to be
					// reported on the empty path too.
					const scopeNotes: string[] = [];
					for (const repo of response.repos ?? []) {
						if (repo.indexed === false) {
							scopeNotes.push(`Repository not indexed: ${repo.repo}`);
							continue;
						}
						// An indexed repository can still be missing one half of its corpus,
						// which is the only explanation for a scoped query returning nothing
						// of that kind.
						const unindexed = Object.entries(repo.types ?? {})
							.filter(([, indexed]) => indexed === false)
							.map(([type]) => type);
						if (unindexed.length > 0) {
							scopeNotes.push(
								`Repository ${repo.repo} has no indexed ${unindexed.join("/")} — those kinds cannot match`,
							);
						}
					}
					for (const source of response.sources ?? []) {
						if (source.indexed === false) scopeNotes.push(`Doc source not indexed: ${source.source}`);
					}

					if (results.length === 0) {
						const coverage = response.coverage
							? ` Coverage: ${Object.entries(response.coverage)
									.map(([type, state]) => `${type}=${state}`)
									.join(", ")}.`
							: "";
						const text = [
							`No Developer Index results for "${params.query}".${coverage} 'skipped' means the type was not requested; 'degraded'/'unavailable' means the index could not serve it.`,
							...(scopeNotes.length > 0 ? [scopeNotes.join("\n")] : []),
						].join("\n\n");
						return ok(text, {
							count: 0,
							coverage: response.coverage,
							repos: response.repos,
							sources: response.sources,
						});
					}

					const rows: string[] = [];
					for (const [position, result] of results.entries()) {
						// Live responses often omit `type`; the `id` is prefixed with the kind
						// (`issue:owner/repo#12`), so fall back to that rather than showing "?".
						const kind = result.type ?? result.id?.split(":")[0];
						const facts = [result.language, result.license, result.stars === undefined ? undefined : `${result.stars}★`]
							.filter(Boolean)
							.join(" | ");
						const header = `[${position + 1}]${kind ? ` (${kind})` : ""} ${result.title?.trim() || result.url || result.id || "(untitled)"}${facts ? `\n    ${facts}` : ""}`;
						const passages = (result.passages ?? [])
							.map((passage) => passage.text?.trim())
							.filter((text): text is string => Boolean(text))
							.join("\n\n---\n\n");
						const passageBlock =
							passages === "" ? "" : `\n${await out.section(result.id ?? result.url ?? "passage", passages, maxChars)}`;
						rows.push(`${header}\n    ${result.url ?? ""}${result.id ? `\n    id: ${result.id}` : ""}${passageBlock}`);
					}

					const notes = [...scopeNotes];
					if (response.coverage) {
						const degraded = Object.entries(response.coverage).filter(
							([, state]) => state === "degraded" || state === "unavailable",
						);
						if (degraded.length > 0) {
							notes.unshift(`Partial coverage: ${degraded.map(([type, state]) => `${type}=${state}`).join(", ")}`);
						}
					}

					const text = [
						`## Developer Index (${results.length} results${response.reranked ? ", reranked" : ""})`,
						...(notes.length > 0 ? [notes.join("\n")] : []),
						rows.join("\n\n"),
					].join("\n\n");
					return ok(text, {
						count: results.length,
						coverage: response.coverage,
						reranked: response.reranked,
						repos: response.repos,
						sources: response.sources,
					});
				} catch (error) {
					return failFrom(error, signal);
				}
			},
		}),
	];
};

export default module;

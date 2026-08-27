/**
 * `firecrawl_developer` — `POST /v2/search/developer`.
 *
 * Firecrawl's Developer Index: GitHub issues, merged pull requests, repository
 * READMEs, indexed agent-skill files and curated documentation sites, returned
 * as matched markdown passages. This is the right first stop for "has anyone
 * hit this error", "how does library X do Y", and API-behaviour questions,
 * because the evidence comes back as quotable passages rather than SERP blurbs.
 */
import { failFrom, ok } from "../core/output.ts";
import { compact, defineTool, type FirecrawlToolEnv, type FirecrawlToolModule } from "../core/tool.ts";

type ResultType = "doc" | "issue" | "pull_request" | "readme";

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
	coverage?: Partial<Record<ResultType, string>>;
	reranked?: boolean;
	repos?: Array<{ repo?: string; indexed?: boolean; types?: Record<string, boolean> }>;
	sources?: Array<{ source?: string; indexed?: boolean }>;
}

const module: FirecrawlToolModule = (env: FirecrawlToolEnv) => {
	const { z, client, out } = env;

	const parameters = z.object({
		query: z.string().describe("Natural-language question or search phrase"),
		k: z.number().int().optional().describe("Ranked results to return (1-100, default 10)"),
		types: z
			.array(z.enum(["doc", "issue", "pull_request", "readme"]))
			.optional()
			.describe("Result kinds to search. Defaults to all four."),
		repos: z
			.array(z.string())
			.optional()
			.describe("Repository slugs like 'firecrawl/firecrawl' scoping issue/pull_request/readme results"),
		sources: z
			.array(z.string())
			.optional()
			.describe("Documentation source ids scoping `doc` results (max 20). Ids are not a fixed enum."),
		skills: z.enum(["only"]).optional().describe("Set to 'only' to search indexed agent-skill files exclusively"),
		passages: z.number().int().optional().describe("Matched passages per result (1-5, default 1)"),
		language: z.string().optional().describe("Repository primary language, e.g. 'Rust'"),
		topic: z.string().optional().describe("Repository topic, e.g. 'async'"),
		license: z.string().optional().describe("Repository license, e.g. 'MIT'"),
		min_stars: z.number().int().optional().describe("Lower bound on repository stars"),
		max_stars: z.number().int().optional().describe("Upper bound on repository stars"),
		archived: z.boolean().optional().describe("Include or exclude archived repositories"),
		fork: z.boolean().optional().describe("Include or exclude forks"),
		maxChars: z.number().int().optional().describe("Inline character budget before passages spill to a file"),
	});

	return [
		defineTool({
			name: "firecrawl_developer",
			label: "Firecrawl Developer Index",
			description:
				"Search Firecrawl's Developer Index for GitHub issues, merged pull requests, repository READMEs, agent-skill files and curated documentation, returned as matched markdown passages. Prefer this over generic web search for error messages, library behaviour, upgrade breakages and API semantics. Filter by repos, doc sources, language, topic, license, stars, archived and fork.",
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
					if (results.length === 0) {
						const coverage = response.coverage
							? ` Coverage: ${Object.entries(response.coverage)
									.map(([type, state]) => `${type}=${state}`)
									.join(", ")}.`
							: "";
						return ok(
							`No Developer Index results for "${params.query}".${coverage} 'skipped' means the type was not requested; 'degraded'/'unavailable' means the index could not serve it.`,
							{ coverage: response.coverage },
						);
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

					const notes: string[] = [];
					if (response.coverage) {
						const degraded = Object.entries(response.coverage).filter(
							([, state]) => state === "degraded" || state === "unavailable",
						);
						if (degraded.length > 0) {
							notes.push(`Partial coverage: ${degraded.map(([type, state]) => `${type}=${state}`).join(", ")}`);
						}
					}
					for (const repo of response.repos ?? []) {
						if (repo.indexed === false) notes.push(`Repository not indexed: ${repo.repo}`);
					}
					for (const source of response.sources ?? []) {
						if (source.indexed === false) notes.push(`Doc source not indexed: ${source.source}`);
					}

					const text = [
						`## Developer Index (${results.length} results${response.reranked ? ", reranked" : ""})`,
						...(notes.length > 0 ? [notes.join("\n")] : []),
						rows.join("\n\n"),
					].join("\n\n");
					return ok(text, { count: results.length, coverage: response.coverage, reranked: response.reranked });
				} catch (error) {
					return failFrom(error, signal);
				}
			},
		}),
	];
};

export default module;

/**
 * `firecrawl_research` — Firecrawl's Research Index.
 *
 * Covers `GET /v2/search/research/papers` (ranked paper search),
 * `GET /v2/search/research/papers/{id}` (metadata inspection, or full-text
 * passage read when a question is supplied) and
 * `GET /v2/search/research/papers/{id}/similar` (structural expansion over
 * citations/references plus semantic reranking).
 *
 * This is the academic-literature surface: results are papers with canonical
 * arXiv/PubMed/DOI identifiers and quotable in-body passages, not SERP blurbs.
 */
import { fail, failFrom, type OutputWriter, ok } from "../core/output.ts";
import { defineTool, type FirecrawlToolEnv, type FirecrawlToolModule } from "../core/tool.ts";

/** Source identifiers grouped by namespace, e.g. `{ arxiv: ["2105.05233"] }`. */
type PaperIdMap = Record<string, string[]>;

interface PaperSignals {
	structural?: number;
	semantic?: number;
	articleRank?: number;
	seedOverlap?: number;
}

interface PaperResult {
	paperId?: string;
	primaryId?: string;
	ids?: PaperIdMap;
	title?: string;
	abstract?: string;
	score?: number;
	signals?: PaperSignals;
}

interface PaperMetadata {
	paperId?: string;
	ids?: PaperIdMap;
	title?: string;
	abstract?: string;
	authors?: string;
	categories?: string[];
	createdDate?: string;
	updateDate?: string;
}

interface SearchPapersResponse {
	success?: boolean;
	results?: PaperResult[];
}

interface SimilarPapersResponse extends SearchPapersResponse {
	poolSize?: number;
	truncated?: boolean;
	note?: string;
}

interface PaperResponse {
	success?: boolean;
	paper?: PaperMetadata;
	paperId?: string;
	query?: string;
	passages?: Array<{ text?: string; score?: number }>;
}

/** Flatten the namespaced id map into `arxiv:2105.05233, doi:10.1000/x`. */
function formatIds(ids: PaperIdMap | undefined): string | undefined {
	if (!ids) return undefined;
	const pairs: string[] = [];
	for (const [namespace, values] of Object.entries(ids)) {
		for (const value of values ?? []) pairs.push(`${namespace}:${value}`);
	}
	return pairs.length === 0 ? undefined : pairs.join(", ");
}

function formatSignals(signals: PaperSignals | undefined): string | undefined {
	if (!signals) return undefined;
	const parts: string[] = [];
	if (signals.semantic !== undefined) parts.push(`semantic ${signals.semantic.toFixed(3)}`);
	if (signals.structural !== undefined) parts.push(`structural ${signals.structural.toFixed(3)}`);
	if (signals.articleRank !== undefined) parts.push(`articleRank ${signals.articleRank.toFixed(3)}`);
	if (signals.seedOverlap !== undefined) parts.push(`seeds ${signals.seedOverlap}`);
	return parts.length === 0 ? undefined : parts.join(", ");
}

/** Numbered entries: title, ids, score/signals, abstract (spilled when long). */
async function renderResults(out: OutputWriter, results: PaperResult[], maxChars: number | undefined): Promise<string> {
	const rows: string[] = [];
	for (const [position, result] of results.entries()) {
		const lines = [`[${position + 1}] ${result.title?.trim() || "(untitled)"}`];
		const identity = [
			result.primaryId ? `cite: ${result.primaryId}` : undefined,
			result.paperId && result.paperId !== result.primaryId ? `paperId: ${result.paperId}` : undefined,
			result.score !== undefined ? `score: ${result.score.toFixed(4)}` : undefined,
		].filter((part): part is string => part !== undefined);
		if (identity.length > 0) lines.push(`    ${identity.join(" | ")}`);
		const ids = formatIds(result.ids);
		if (ids) lines.push(`    ids: ${ids}`);
		const signals = formatSignals(result.signals);
		if (signals) lines.push(`    signals: ${signals}`);
		const abstract = result.abstract?.trim();
		if (abstract) {
			const label = result.primaryId ?? result.paperId ?? `paper-${position + 1}`;
			lines.push(`    abstract: ${await out.section(`${label}-abstract`, abstract, maxChars)}`);
		}
		rows.push(lines.join("\n"));
	}
	return rows.join("\n\n");
}

const module: FirecrawlToolModule = (env: FirecrawlToolEnv) => {
	const { z, client, out } = env;

	const parameters = z.object({
		action: z
			.enum(["search", "paper", "related"])
			.describe(
				"'search' ranks papers for a natural-language query; 'paper' inspects one paper's metadata, or reads its full text when `query` is set; 'related' expands the citation graph around a seed paper.",
			),
		query: z
			.string()
			.optional()
			.describe(
				"Required for 'search': natural-language paper search query. For 'paper' it switches the call into read mode and returns the top matching full-text passages for this question; omit it to only inspect metadata.",
			),
		id: z
			.string()
			.optional()
			.describe(
				"Required for 'paper' and 'related': a canonical paperId or source-specific primaryId such as 'arxiv:2105.05233', 'doi:10.1038/nature14539', 'pmid:12345678' or 'pmcid:PMC1234567'.",
			),
		intent: z
			.string()
			.optional()
			.describe(
				"Required for 'related': natural-language ranking/filtering intent used to semantically rank the structurally expanded candidate pool.",
			),
		mode: z
			.enum(["similar", "citers", "references"])
			.optional()
			.describe(
				"'related' only. Structural expansion mode: 'similar' (default) blends the neighbourhood, 'citers' returns papers citing the seed, 'references' returns papers the seed cites.",
			),
		k: z
			.number()
			.int()
			.optional()
			.describe(
				"Result cap. For 'search' and 'related': 1-500 papers, default 40. For 'paper' in read mode: passage count, default 4 — and only valid when `query` is present.",
			),
		rerank: z
			.boolean()
			.optional()
			.describe("'related' only. Apply an additional rerank pass over the fused candidate pool; costs extra latency."),
		anchors: z
			.array(z.string())
			.optional()
			.describe(
				"'related' only. Additional seed paper references beyond `id`, sent as repeated `anchor` parameters. More anchors widen the structural pool and raise `seedOverlap` for papers connected to several seeds.",
			),
		authors: z
			.array(z.string())
			.optional()
			.describe(
				"'search' only. Author substring filters, sent comma-separated. All filters must match, so multiple entries narrow rather than widen.",
			),
		categories: z
			.array(z.string())
			.optional()
			.describe(
				"'search' only. Paper category filters (e.g. 'cs.LG'), sent comma-separated. All filters must match, so multiple entries narrow rather than widen.",
			),
		from: z
			.string()
			.optional()
			.describe("'search' only. Inclusive lower bound on the paper's created/updated date, as 'YYYY-MM-DD'."),
		to: z
			.string()
			.optional()
			.describe("'search' only. Inclusive upper bound on the paper's created/updated date, as 'YYYY-MM-DD'."),
		maxChars: z
			.number()
			.int()
			.optional()
			.describe("Inline character budget per abstract/passage before it is written to a file and only a head is shown"),
	});

	return [
		defineTool({
			name: "firecrawl_research",
			label: "Firecrawl Research Index",
			description:
				"Search Firecrawl's Research Index for academic papers and read their full text. Prefer this over generic web search whenever the question is about the scientific literature — prior work, methods, benchmark numbers, who cites whom — because results carry canonical arXiv/PubMed/DOI ids and quotable in-body passages instead of SERP blurbs. Actions: 'search' (rank papers for a query, filter by author, category and date range), 'paper' (inspect one paper's metadata, or pass `query` to read the top matching full-text passages), 'related' (expand the citation graph around one or more seed papers via similar/citers/references and rank the pool by a stated intent). All three are metered Firecrawl requests; 'search' and 'related' are ranked-retrieval and fast, 'paper' in read mode is the heaviest because it retrieves full text, and `rerank` adds a further pass.",
			parameters,
			approval: "read",
			async execute(_id, params, signal, _onUpdate, _ctx) {
				const { action, query, id, intent, mode, k, rerank, anchors, authors, categories, from, to, maxChars } = params;

				try {
					if (action === "search") {
						if (!query) return fail("Action 'search' requires `query` (the natural-language paper search query).");
						const response = await client.request<SearchPapersResponse>("/search/research/papers", {
							query: {
								query,
								k,
								authors: authors && authors.length > 0 ? authors.join(",") : undefined,
								categories: categories && categories.length > 0 ? categories.join(",") : undefined,
								from,
								to,
							},
							signal,
						});
						const results = response.results ?? [];
						if (results.length === 0) {
							return ok(
								`No Research Index papers matched "${query}". Loosen the author/category filters or widen the from/to date range.`,
								{ count: 0 },
							);
						}
						return ok(
							`## Research Index — ${results.length} papers for "${query}"\n\n${await renderResults(out, results, maxChars)}`,
							{ count: results.length, ids: results.map((result) => result.primaryId ?? result.paperId) },
						);
					}

					if (action === "paper") {
						if (!id)
							return fail(
								"Action 'paper' requires `id` (a canonical paperId or primaryId such as 'arxiv:2105.05233').",
							);
						if (k !== undefined && !query) {
							return fail(
								"`k` sets the passage count for read mode and is only valid with `query`; drop `k` to inspect metadata.",
							);
						}
						const response = await client.request<PaperResponse>(`/search/research/papers/${encodeURIComponent(id)}`, {
							query: { query, k },
							signal,
						});
						const paper = response.paper;
						if (!paper) return fail(`Firecrawl returned no paper for id '${id}'.`);

						const header = [`## ${paper.title?.trim() || "(untitled)"}`];
						const identity = [
							(response.paperId ?? paper.paperId) ? `paperId: ${response.paperId ?? paper.paperId}` : undefined,
							paper.createdDate ? `created: ${paper.createdDate}` : undefined,
							paper.updateDate ? `updated: ${paper.updateDate}` : undefined,
						].filter((part): part is string => part !== undefined);
						if (identity.length > 0) header.push(identity.join(" | "));
						if (paper.authors) header.push(`authors: ${paper.authors}`);
						if (paper.categories && paper.categories.length > 0) {
							header.push(`categories: ${paper.categories.join(", ")}`);
						}
						const ids = formatIds(paper.ids);
						if (ids) header.push(`ids: ${ids}`);
						const abstract = paper.abstract?.trim();
						if (abstract) header.push(`### Abstract\n${await out.section(`${id}-abstract`, abstract, maxChars)}`);

						const passages = response.passages ?? [];
						if (passages.length > 0) {
							const rendered: string[] = [];
							for (const [position, passage] of passages.entries()) {
								const score = passage.score !== undefined ? ` (score ${passage.score.toFixed(4)})` : "";
								const text = await out.section(`${id}-passage-${position + 1}`, passage.text?.trim() ?? "", maxChars);
								rendered.push(`[${position + 1}]${score} ${text}`);
							}
							header.push(
								`### Matched passages for "${response.query ?? query}" (${passages.length})\n${rendered.join("\n\n")}`,
							);
						} else if (query) {
							header.push(`### Matched passages\nNo full-text passages matched "${query}" for this paper.`);
						}

						return ok(header.join("\n\n"), {
							paperId: response.paperId ?? paper.paperId,
							passages: passages.length,
						});
					}

					if (!id) return fail("Action 'related' requires `id` (the primary seed paper reference).");
					if (!intent) {
						return fail(
							"Action 'related' requires `intent` (the natural-language ranking intent for the expanded pool).",
						);
					}
					let path = `/search/research/papers/${encodeURIComponent(id)}/similar`;
					if (anchors && anchors.length > 0) {
						const repeated = new URLSearchParams();
						for (const anchor of anchors) repeated.append("anchor", anchor);
						path = `${path}?${repeated.toString()}`;
					}
					const response = await client.request<SimilarPapersResponse>(path, {
						query: { intent, mode, k, rerank },
						signal,
					});
					const results = response.results ?? [];
					const stats = [
						`mode: ${mode ?? "similar"}`,
						response.poolSize !== undefined ? `pool: ${response.poolSize}` : undefined,
						response.truncated ? "truncated" : undefined,
					].filter((part): part is string => part !== undefined);
					if (results.length === 0) {
						return ok(
							`No related papers for seed '${id}' (${stats.join(", ")}).${response.note ? ` Note: ${response.note}` : ""}`,
							{ count: 0, poolSize: response.poolSize },
						);
					}
					const text = [
						`## Related papers for '${id}' — ${results.length} of ${stats.join(", ")}`,
						...(response.note ? [`Note: ${response.note}`] : []),
						await renderResults(out, results, maxChars),
					].join("\n\n");
					return ok(text, {
						count: results.length,
						poolSize: response.poolSize,
						truncated: response.truncated,
						ids: results.map((result) => result.primaryId ?? result.paperId),
					});
				} catch (error) {
					return failFrom(error, signal);
				}
			},
		}),
	];
};

export default module;

/**
 * `firecrawl_scrape` — `POST /v2/scrape` plus `GET /v2/scrape/{jobId}`.
 *
 * The single-page workhorse: markdown/summary/HTML/links/images/screenshots,
 * LLM JSON extraction, page questions, query highlights, change tracking,
 * branding/product/menu/audio/video extraction, browser actions, PDF and
 * document parsing, proxy escalation, PII redaction and cache control.
 */
import { type FirecrawlDocument, failFrom, ok, renderDocument } from "../core/output.ts";
import { scrapeOptionsShape } from "../core/schema.ts";
import { compact, defineTool, type FirecrawlToolEnv, type FirecrawlToolModule } from "../core/tool.ts";

interface ScrapeResponse {
	success?: boolean;
	data?: FirecrawlDocument;
	warning?: string;
}

const module: FirecrawlToolModule = (env: FirecrawlToolEnv) => {
	const { z, client, out } = env;

	const parameters = z.object({
		url: z.string().optional().describe("URL to scrape. Omit only when reading a finished job with `jobId`."),
		jobId: z.string().optional().describe("Fetch the stored result of an earlier scrape job instead of scraping"),
		maxChars: z
			.number()
			.int()
			.optional()
			.describe("Inline character budget before content is written to a file and only a head is shown"),
		...scrapeOptionsShape(z),
	});

	return [
		defineTool({
			name: "firecrawl_scrape",
			label: "Firecrawl Scrape",
			description:
				"Scrape one URL into clean data via Firecrawl. Formats: markdown, summary, html, rawHtml, links, images, screenshot, json (schema/prompt extraction), question (ask the page), highlights (query-relevant passages), changeTracking, branding, product, menu, audio, video. Also runs browser actions (click/write/press/scroll/executeJavascript/pdf), parses PDFs and documents, redacts PII, and reuses Firecrawl's cache via maxAge for ~500% faster repeat reads.",
			parameters,
			approval: "read",
			async execute(_id, params, signal, _onUpdate, _ctx) {
				const { url, jobId, maxChars, ...scrapeOptions } = params;
				if (!url && !jobId) {
					return failFrom(new Error("Provide `url` to scrape, or `jobId` to read a finished job."), signal);
				}

				try {
					const response = jobId
						? await client.request<ScrapeResponse>(`/scrape/${encodeURIComponent(jobId)}`, { signal })
						: await client.request<ScrapeResponse>("/scrape", {
								method: "POST",
								body: compact({ url, ...scrapeOptions }),
								signal,
								timeoutMs: scrapeOptions.timeout ? scrapeOptions.timeout + 20_000 : undefined,
							});

					const doc = response.data;
					if (!doc) return failFrom(new Error("Firecrawl returned no document"), signal);

					const rendered = await renderDocument(out, doc, { label: url ?? jobId, inlineChars: maxChars });
					const text = response.warning ? `Note: ${response.warning}\n\n${rendered}` : rendered;
					return ok(text, {
						url: doc.metadata?.sourceURL ?? url,
						statusCode: doc.metadata?.statusCode,
						formats: Object.keys(doc).filter((key) => key !== "metadata"),
					});
				} catch (error) {
					return failFrom(error, signal);
				}
			},
		}),
	];
};

export default module;

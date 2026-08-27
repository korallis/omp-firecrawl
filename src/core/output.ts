/**
 * Output shaping: keep tool text small enough to be worth reading, and spill
 * anything long to a file the agent can page with `read`.
 *
 * A 200KB crawl result pasted into the transcript is worse than useless, so
 * every large payload lands on disk and the tool reports the path plus a head.
 */
import { mkdir, writeFile } from "node:fs/promises";

import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent";

import { FirecrawlError } from "./client.ts";

/**
 * The host's own tool-result contract. Aliased rather than redeclared so a
 * delegated built-in result (which may carry image blocks) passes straight
 * through without a cast.
 */
export type ToolResult = AgentToolResult;

export interface SpillResult {
	path: string;
	bytes: number;
}

/** Firecrawl document shape shared by scrape, batch, crawl and search results. */
export interface FirecrawlDocument {
	markdown?: string;
	summary?: string;
	html?: string;
	rawHtml?: string;
	rawBase64?: string;
	links?: string[];
	images?: string[];
	screenshot?: string;
	audio?: string;
	video?: string;
	json?: unknown;
	branding?: unknown;
	product?: unknown;
	menu?: unknown;
	/** `{type:"question"}` answers land under `answer`, not `question`. */
	answer?: unknown;
	question?: unknown;
	highlights?: unknown;
	changeTracking?: Record<string, unknown>;
	pages?: Array<{ pageNumber?: number; markdown?: string }>;
	blocks?: unknown;
	/** Present only when the request supplied `actions`; ordered per action. */
	actions?: {
		screenshots?: string[];
		scrapes?: Array<{ url?: string; html?: string }>;
		javascriptReturns?: Array<{ type?: string; value?: unknown }>;
		pdfs?: string[];
	} | null;
	warning?: string;
	metadata?: Record<string, unknown> & {
		title?: string;
		description?: string;
		sourceURL?: string;
		url?: string;
		statusCode?: number;
		numPages?: number;
		totalPages?: number;
		error?: string;
		/** MIME type; required to interpret `rawBase64`. */
		contentType?: string;
		language?: string;
		keywords?: string;
		/** True when the request waited on the team's concurrency limit. */
		concurrencyLimited?: boolean;
		concurrencyQueueDurationMs?: number;
		/** Live-only field; the handle for `firecrawl_interact` and job replay. */
		scrapeId?: string;
	};
}

function slugify(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/^https?:\/\//, "")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 48) || "firecrawl"
	);
}

export class OutputWriter {
	#cacheDir: string;
	#inlineChars: number;

	constructor(cacheDir: string, inlineChars: number) {
		this.#cacheDir = cacheDir;
		this.#inlineChars = inlineChars;
	}

	get inlineChars(): number {
		return this.#inlineChars;
	}

	/** Persist content and return its absolute path. */
	async spill(label: string, content: string, extension = "md"): Promise<SpillResult> {
		const day = new Date().toISOString().slice(0, 10);
		const dir = `${this.#cacheDir}/${day}`;
		await mkdir(dir, { recursive: true });
		const stamp = Date.now().toString(36);
		const path = `${dir}/${slugify(label)}-${stamp}.${extension}`;
		await writeFile(path, content, "utf8");
		return { path, bytes: Buffer.byteLength(content, "utf8") };
	}

	/**
	 * Inline `content` when short; otherwise spill and inline only a head.
	 * `limit` overrides the configured inline budget for one call.
	 */
	async section(label: string, content: string, limit?: number, extension = "md"): Promise<string> {
		const budget = limit ?? this.#inlineChars;
		if (content.length <= budget) return content;
		const { path, bytes } = await this.spill(label, content, extension);
		const head = content.slice(0, budget);
		return `${head}\n\n[truncated: showing ${budget} of ${content.length} chars. Full ${(bytes / 1024).toFixed(0)}KB saved to ${path} — read it for the rest.]`;
	}
}

/** Render one Firecrawl document into agent-readable text. */
export async function renderDocument(
	writer: OutputWriter,
	doc: FirecrawlDocument,
	options: { label?: string; inlineChars?: number; index?: number } = {},
): Promise<string> {
	const meta = doc.metadata ?? {};
	const url = meta.sourceURL ?? meta.url ?? options.label ?? "(unknown url)";
	const lines: string[] = [];
	const heading = options.index === undefined ? `## ${url}` : `## [${options.index}] ${url}`;
	lines.push(heading);

	const facts: string[] = [];
	if (meta.title) facts.push(`title: ${meta.title}`);
	if (meta.statusCode !== undefined) facts.push(`status: ${meta.statusCode}`);
	if (meta.url && meta.sourceURL && meta.url !== meta.sourceURL) facts.push(`final url: ${meta.url}`);
	if (meta.numPages !== undefined) {
		facts.push(
			meta.totalPages !== undefined && meta.totalPages > meta.numPages
				? `pages: ${meta.numPages} of ${meta.totalPages} (truncated)`
				: `pages: ${meta.numPages}`,
		);
	}
	// `contentType` is the only way to interpret `rawBase64`; the concurrency
	// fields explain a slow call that was queued rather than slow to fetch.
	if (meta.contentType) facts.push(`content-type: ${meta.contentType}`);
	if (meta.language) facts.push(`language: ${meta.language}`);
	if (meta.concurrencyLimited) {
		const queued =
			meta.concurrencyQueueDurationMs === undefined
				? ""
				: ` (queued ${(meta.concurrencyQueueDurationMs / 1_000).toFixed(1)}s)`;
		facts.push(`concurrency limited${queued}`);
	}
	if (facts.length > 0) lines.push(facts.join(" | "));
	if (meta.keywords) lines.push(`keywords: ${meta.keywords}`);
	if (meta.error) lines.push(`error: ${meta.error}`);
	if (doc.warning) lines.push(`warning: ${doc.warning}`);

	if (doc.summary) lines.push(`\n### Summary\n${doc.summary}`);
	const answer = doc.answer ?? doc.question;
	if (answer !== undefined) lines.push(`\n### Answer\n${stringify(answer)}`);
	if (doc.highlights !== undefined) lines.push(`\n### Highlights\n${stringify(doc.highlights)}`);
	if (doc.json !== undefined) {
		lines.push(`\n### JSON\n${await writer.section(`${url}-json`, stringify(doc.json), options.inlineChars, "json")}`);
	}
	for (const [key, label] of [
		["branding", "Branding"],
		["product", "Product"],
		["menu", "Menu"],
	] as const) {
		const value = doc[key];
		if (value !== undefined) {
			lines.push(
				`\n### ${label}\n${await writer.section(`${url}-${key}`, stringify(value), options.inlineChars, "json")}`,
			);
		}
	}
	if (doc.changeTracking) {
		lines.push(`\n### Change tracking\n${stringify(doc.changeTracking)}`);
	}
	if (doc.markdown) {
		lines.push(`\n### Markdown\n${await writer.section(url, doc.markdown, options.inlineChars)}`);
	}
	if (doc.pages && doc.pages.length > 0) {
		const joined = doc.pages
			.map((page) => `<!-- page ${page.pageNumber ?? "?"} -->\n${page.markdown ?? ""}`)
			.join("\n\n");
		lines.push(`\n### Per-page markdown\n${await writer.section(`${url}-pages`, joined, options.inlineChars)}`);
	}
	if (doc.blocks !== undefined) {
		const { path } = await writer.spill(`${url}-blocks`, stringify(doc.blocks), "json");
		lines.push(`\n### Layout blocks\nSaved to ${path}`);
	}
	if (doc.html) {
		const { path } = await writer.spill(`${url}-html`, doc.html, "html");
		lines.push(`\n### HTML\nSaved to ${path} (${doc.html.length} chars)`);
	}
	if (doc.rawHtml) {
		const { path } = await writer.spill(`${url}-raw`, doc.rawHtml, "html");
		lines.push(`\n### Raw HTML\nSaved to ${path} (${doc.rawHtml.length} chars)`);
	}
	if (doc.rawBase64) {
		// A bare Base64 body, not a data URI; `metadata.contentType` names the type.
		const spilled = await writer.spill(`${url}-rawbase64`, doc.rawBase64, "b64");
		lines.push(
			`\n### Raw response body (base64)\n${(spilled.bytes / 1024).toFixed(0)}KB of base64${
				meta.contentType ? ` for ${meta.contentType}` : ""
			} saved to ${spilled.path}\nDecode it with: base64 -d ${spilled.path} > out.bin`,
		);
	}
	if (doc.actions) {
		const rows: string[] = [];
		for (const [position, shot] of (doc.actions.screenshots ?? []).entries()) {
			rows.push(`screenshot[${position}]: ${shot} (expires in 24h)`);
		}
		for (const [position, pdf] of (doc.actions.pdfs ?? []).entries()) {
			rows.push(`pdf[${position}]: ${pdf}`);
		}
		for (const [position, value] of (doc.actions.javascriptReturns ?? []).entries()) {
			rows.push(`javascript[${position}] (${value.type ?? "unknown"}): ${stringify(value.value).slice(0, 500)}`);
		}
		for (const [position, scrape] of (doc.actions.scrapes ?? []).entries()) {
			const html = scrape.html ?? "";
			const spilled = html === "" ? undefined : await writer.spill(`${url}-action-${position}`, html, "html");
			rows.push(`scrape[${position}]: ${scrape.url ?? "(no url)"}${spilled ? ` — HTML saved to ${spilled.path}` : ""}`);
		}
		if (rows.length > 0) lines.push(`\n### Action results\n${rows.join("\n")}`);
	}
	if (doc.links && doc.links.length > 0) {
		const shown = doc.links.slice(0, 50);
		let text = shown.map((link) => `- ${link}`).join("\n");
		if (doc.links.length > shown.length) {
			const { path } = await writer.spill(`${url}-links`, doc.links.join("\n"), "txt");
			text += `\n- ...${doc.links.length - shown.length} more links saved to ${path}`;
		}
		lines.push(`\n### Links (${doc.links.length})\n${text}`);
	}
	if (doc.images && doc.images.length > 0) {
		lines.push(
			`\n### Images (${doc.images.length})\n${doc.images
				.slice(0, 25)
				.map((img) => `- ${img}`)
				.join("\n")}`,
		);
	}
	for (const [key, note] of [
		["screenshot", "expires in 24h"],
		["audio", "signed URL, expires in 1h"],
		["video", "signed URL, expires in 1h"],
	] as const) {
		const value = doc[key];
		if (typeof value === "string" && value !== "") lines.push(`\n${key}: ${value} (${note})`);
	}

	return lines.join("\n");
}

export function stringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2) ?? String(value);
	} catch {
		return String(value);
	}
}

export function ok(text: string, details?: unknown): ToolResult {
	return { content: [{ type: "text", text }], details };
}

export function fail(text: string, details?: unknown): ToolResult {
	return { content: [{ type: "text", text }], details, isError: true };
}

/** Normalize a thrown value into an error result; rethrows genuine cancellation. */
export function failFrom(error: unknown, signal?: AbortSignal): ToolResult {
	if (signal?.aborted) throw error;
	if (error instanceof FirecrawlError) {
		return fail(error.describe(), { status: error.status, code: error.code, path: error.path });
	}
	if (error instanceof Error && error.name === "AbortError") throw error;
	return fail(`Firecrawl call failed: ${error instanceof Error ? error.message : String(error)}`);
}

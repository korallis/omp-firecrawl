/**
 * Shared parameter-schema fragments.
 *
 * `scrapeOptions` is accepted verbatim by /scrape, /batch/scrape, /crawl,
 * /search and /monitor, so it is defined once here and reused by every tool.
 * Schemas are built from the host-injected Zod-compatible builder, hence the
 * factory functions.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

export type Z = ExtensionAPI["zod"];

/** Every `formats` entry Firecrawl v2 accepts as a bare string. */
export const FORMAT_NAMES = [
	"markdown",
	"summary",
	"html",
	"rawHtml",
	"rawBase64",
	"links",
	"images",
	"screenshot",
	"json",
	"changeTracking",
	"branding",
	"product",
	"menu",
	"audio",
	"video",
	"question",
	"highlights",
] as const;

export const ACTION_TYPES = [
	"wait",
	"screenshot",
	"click",
	"write",
	"press",
	"scroll",
	"scrape",
	"executeJavascript",
	"pdf",
] as const;

export function viewportSchema(z: Z) {
	return z
		.object({
			width: z.number().int().describe("Viewport width in px"),
			height: z.number().int().describe("Viewport height in px"),
		})
		.describe("Screenshot viewport");
}

/** Union of bare format names and their object forms (screenshot/json/changeTracking/question/highlights). */
export function formatsSchema(z: Z) {
	return z
		.array(
			z.union([
				z.enum(FORMAT_NAMES),
				z.object({
					type: z.enum(FORMAT_NAMES).describe("Format type"),
					fullPage: z.boolean().optional().describe("screenshot: capture the whole scrollable page"),
					quality: z.number().int().optional().describe("screenshot: JPEG quality 1-100"),
					viewport: viewportSchema(z).optional(),
					schema: z
						.record(z.string(), z.unknown())
						.optional()
						.describe("json/changeTracking: JSON Schema for the structured result"),
					prompt: z.string().optional().describe("json/changeTracking: natural-language extraction instruction"),
					checkPromptInjection: z
						.boolean()
						.optional()
						.describe("json: flag suspected prompt-injection content in the page"),
					modes: z
						.array(z.enum(["git-diff", "json"]))
						.optional()
						.describe("changeTracking: diff representations to compute"),
					tag: z.string().optional().describe("changeTracking: comparison bucket for this URL"),
					question: z.string().optional().describe("question: the question to answer from the page"),
					query: z.string().optional().describe("highlights: query the highlights must be relevant to"),
				}),
			]),
		)
		.describe(
			"Output formats. Strings for plain formats ('markdown', 'summary', 'links', 'images', 'html', 'rawHtml', 'branding', 'product', 'menu', 'audio', 'video'), objects for parameterized ones ({type:'json',schema|prompt}, {type:'screenshot',fullPage}, {type:'changeTracking',modes}, {type:'question',question}, {type:'highlights',query}). Default ['markdown'].",
		);
}

export function actionsSchema(z: Z) {
	return z
		.array(
			z.object({
				type: z.enum(ACTION_TYPES).describe("Action kind"),
				milliseconds: z.number().int().optional().describe("wait: delay in ms"),
				selector: z.string().optional().describe("wait/click/scroll: CSS selector"),
				all: z.boolean().optional().describe("click: click every match"),
				text: z.string().optional().describe("write: text to type"),
				key: z.string().optional().describe("press: key name, e.g. 'Enter'"),
				direction: z.enum(["up", "down"]).optional().describe("scroll: direction, default 'down'"),
				script: z.string().optional().describe("executeJavascript: script body"),
				fullPage: z.boolean().optional().describe("screenshot: capture the whole page"),
				quality: z.number().int().optional().describe("screenshot: JPEG quality"),
				viewport: viewportSchema(z).optional(),
				format: z
					.enum(["A0", "A1", "A2", "A3", "A4", "A5", "A6", "Letter", "Legal", "Tabloid", "Ledger"])
					.optional()
					.describe("pdf: paper size, default 'Letter'"),
				landscape: z.boolean().optional().describe("pdf: landscape orientation"),
				scale: z.number().optional().describe("pdf: render scale, default 1"),
			}),
		)
		.describe(
			"Browser actions run in order before content capture. Interleave 'scrape'/'screenshot' actions to capture intermediate states.",
		);
}

export function locationSchema(z: Z) {
	return z
		.object({
			country: z.string().optional().describe("ISO 3166-1 alpha-2 country code, default 'US'"),
			languages: z.array(z.string()).optional().describe("Accept-Language preferences in priority order"),
		})
		.describe("Proxy country plus emulated language/timezone");
}

export function threatProtectionSchema(z: Z) {
	return z
		.object({
			mode: z
				.enum(["off", "normal"])
				.optional()
				.describe("'normal' scans URLs against Google Web Risk (+2 credits/URL)"),
			riskScoreThreshold: z
				.number()
				.int()
				.optional()
				.describe("0-100; block at or above this score (lower is stricter)"),
			blacklist: z.array(z.string()).optional().describe("Always-block domains or wildcard globs"),
			whitelist: z.array(z.string()).optional().describe("Always-allow domains; wins over every other rule"),
			blockedTlds: z.array(z.string()).optional().describe("TLDs to block, lowercase without the dot"),
			failurePolicy: z.enum(["open", "closed"]).optional().describe("Behavior when the classifier is unreachable"),
		})
		.describe("Per-request Threat Protection override (enterprise)");
}

export function parsersSchema(z: Z) {
	return z
		.array(
			z.union([
				z.enum(["pdf"]),
				z.object({
					type: z.enum(["pdf"]),
					mode: z.enum(["fast", "auto", "ocr"]).optional().describe("PDF parsing mode, default 'auto'"),
					maxPages: z.number().int().optional().describe("Cap pages parsed (1-10000)"),
					pages: z.boolean().optional().describe("Also return per-page markdown"),
					blocks: z.boolean().optional().describe("Also return typed layout blocks with bounding boxes"),
					pageMarkers: z.boolean().optional().describe("Annotate page breaks in the document markdown"),
				}),
			]),
		)
		.describe("File parsing controls. Pass [] to skip PDF parsing entirely.");
}

export function webhookSchema(z: Z) {
	return z
		.object({
			url: z.string().describe("Destination URL"),
			headers: z.record(z.string(), z.string()).optional(),
			metadata: z.record(z.string(), z.unknown()).optional(),
			events: z
				.array(z.enum(["completed", "page", "failed", "started"]))
				.optional()
				.describe("Event subset to deliver; omit for all"),
		})
		.describe("Webhook notification target for job progress");
}

/**
 * The `scrapeOptions` object shared by scrape, batch, crawl, search and monitor.
 * Kept as a shape (not a schema) so `firecrawl_scrape` can splat it next to `url`.
 */
export function scrapeOptionsShape(z: Z) {
	return {
		formats: formatsSchema(z).optional(),
		onlyMainContent: z
			.boolean()
			.optional()
			.describe("Strip nav/header/footer boilerplate before markdown generation. Default true."),
		onlyCleanContent: z
			.boolean()
			.optional()
			.describe("Beta: extra LLM pass to remove residual boilerplate. Costs more, slower."),
		includeTags: z.array(z.string()).optional().describe("CSS selectors/tags to keep"),
		excludeTags: z.array(z.string()).optional().describe("CSS selectors/tags to drop"),
		maxAge: z
			.number()
			.int()
			.optional()
			.describe(
				"Serve from Firecrawl's index when the cached page is younger than this many ms (default 172800000 = 2 days). 0 forces a live scrape. Cache hits are ~500% faster and cheaper.",
			),
		minAge: z.number().int().optional().describe("Cache-only read: never triggers a live scrape"),
		headers: z.record(z.string(), z.string()).optional().describe("Request headers, e.g. cookies or user-agent"),
		waitFor: z.number().int().optional().describe("Extra delay in ms before capture"),
		mobile: z.boolean().optional().describe("Emulate a mobile device"),
		skipTlsVerification: z.boolean().optional().describe("Ignore TLS certificate errors"),
		timeout: z.number().int().optional().describe("Per-page timeout in ms (1000-300000, default 60000)"),
		parsers: parsersSchema(z).optional(),
		actions: actionsSchema(z).optional(),
		location: locationSchema(z).optional(),
		removeBase64Images: z.boolean().optional().describe("Drop inline base64 images from markdown. Default true."),
		blockAds: z.boolean().optional().describe("Block ads and cookie banners. Default true."),
		proxy: z
			.enum(["basic", "enhanced", "auto"])
			.optional()
			.describe("'basic' fast, 'enhanced' for anti-bot sites (costs 5 credits), 'auto' retries basic then enhanced."),
		storeInCache: z.boolean().optional().describe("Store the page in Firecrawl's index/cache. Default true."),
		lockdown: z.boolean().optional().describe("Cache-only: never make an outbound request to the target"),
		redactPII: z
			.union([
				z.boolean(),
				z.object({
					mode: z.enum(["accurate", "aggressive", "fast"]).optional(),
					entities: z.array(z.enum(["PERSON", "EMAIL", "PHONE", "LOCATION", "FINANCIAL", "SECRET"])).optional(),
					replaceStyle: z.enum(["tag", "mask", "remove"]).optional(),
				}),
			])
			.optional()
			.describe("Redact PII from returned content"),
		profile: z
			.object({
				name: z.string().describe("Shared browser-state name (cookies, localStorage, sessions)"),
				saveChanges: z.boolean().optional().describe("Persist state back to the profile. Default true."),
			})
			.optional()
			.describe("Persistent browser profile reused across scrape/interact sessions"),
		threatProtection: threatProtectionSchema(z).optional(),
		auditMetadata: z.object({ username: z.string() }).optional().describe("SIEM attribution metadata"),
		zeroDataRetention: z
			.boolean()
			.optional()
			.describe("Enable zero data retention for this job (must be enabled for the team)"),
	};
}

/** Nested `scrapeOptions` object for endpoints that take it as one field. */
export function scrapeOptionsSchema(z: Z) {
	return z.object(scrapeOptionsShape(z)).describe("How each page is scraped");
}

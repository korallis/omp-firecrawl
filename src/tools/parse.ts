/**
 * `firecrawl_parse` — `POST /v2/parse`.
 *
 * Firecrawl's document parser: PDF, Word, Excel, PowerPoint, OpenDocument,
 * RTF, EPUB, CSV and HTML bytes converted into markdown, per-page markdown,
 * typed layout blocks or schema-driven JSON. `/parse` is the only Firecrawl
 * endpoint that takes raw bytes (`multipart/form-data`) instead of a URL, so
 * this module builds the multipart body itself instead of going through the
 * JSON request path, while still using the shared auth, base URL and error
 * shapes.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { type FirecrawlClient, FirecrawlError } from "../core/client.ts";
import { type FirecrawlDocument, fail, failFrom, ok, renderDocument } from "../core/output.ts";
import { compact, defineTool, type FirecrawlToolEnv, type FirecrawlToolModule } from "../core/tool.ts";

/** Extensions `/parse` accepts, mapped to the content type sent with the upload. */
const CONTENT_TYPES: Record<string, string> = {
	html: "text/html",
	htm: "text/html",
	xhtml: "application/xhtml+xml",
	pdf: "application/pdf",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	doc: "application/msword",
	docm: "application/vnd.ms-word.document.macroEnabled.12",
	odt: "application/vnd.oasis.opendocument.text",
	ods: "application/vnd.oasis.opendocument.spreadsheet",
	odp: "application/vnd.oasis.opendocument.presentation",
	rtf: "application/rtf",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	xls: "application/vnd.ms-excel",
	xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
	xlsb: "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	ppt: "application/vnd.ms-powerpoint",
	pptm: "application/vnd.ms-powerpoint.presentation.macroEnabled.12",
	epub: "application/epub+zip",
	csv: "text/csv",
};

/** Documented per-request upload ceiling. */
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

interface ParseResponse {
	success?: boolean;
	data?: FirecrawlDocument;
	warning?: string;
}

/** One page of `blocks`, used only to summarize what landed in the spilled JSON. */
interface BlockPage {
	pageNumber?: number;
	status?: string;
	items?: Array<{ type?: string }>;
}

/**
 * Send the multipart upload `/parse` requires. The shared client only speaks
 * JSON, so this reuses its auth resolver, base URL and error type by hand.
 */
async function uploadForParse(
	client: FirecrawlClient,
	file: { bytes: Uint8Array; filename: string; contentType: string },
	options: Record<string, unknown>,
	signal: AbortSignal | undefined,
	timeoutMs: number,
): Promise<ParseResponse> {
	const auth = await client.auth.resolve();
	const headers: Record<string, string> = { Accept: "application/json" };
	if (auth.apiKey) headers.Authorization = `Bearer ${auth.apiKey}`;

	const form = new FormData();
	form.append("file", new Blob([file.bytes], { type: file.contentType }), file.filename);
	if (Object.keys(options).length > 0) {
		form.append("options", new Blob([JSON.stringify(options)], { type: "application/json" }));
	}

	const deadline = AbortSignal.timeout(timeoutMs);
	const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;

	let response: Response;
	try {
		response = await fetch(`${client.config.baseUrl}/v2/parse`, {
			method: "POST",
			headers,
			body: form,
			signal: requestSignal,
		});
	} catch (cause) {
		if (signal?.aborted) throw cause;
		const aborted = cause instanceof Error && cause.name === "AbortError";
		throw new FirecrawlError({
			message: aborted ? `upload exceeded ${timeoutMs}ms` : cause instanceof Error ? cause.message : String(cause),
			path: "/parse",
			hint: aborted ? "Raise `timeout`, or parse fewer pages with parsers[].maxPages." : undefined,
		});
	}

	const body = await response.text();
	let payload: unknown;
	try {
		payload = body.trim() === "" ? undefined : JSON.parse(body);
	} catch {
		payload = undefined;
	}

	if (!response.ok) {
		if (response.status === 401 || response.status === 403) client.auth.invalidate();
		const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : undefined;
		const message = typeof record?.error === "string" ? record.error : body.slice(0, 400) || response.statusText;
		const code = typeof record?.code === "string" ? record.code : undefined;
		throw new FirecrawlError({ message, path: "/parse", status: response.status, code });
	}

	if (typeof payload !== "object" || payload === null) {
		throw new FirecrawlError({ message: "response was not JSON", path: "/parse", status: response.status });
	}
	return payload as ParseResponse;
}

const module: FirecrawlToolModule = (env: FirecrawlToolEnv) => {
	const { z, client, out } = env;

	const parameters = z.object({
		filePath: z
			.string()
			.optional()
			.describe(
				"Absolute or cwd-relative path to the document to parse. The primary input: the file is read locally and uploaded. Exactly one of filePath, base64 or url is required.",
			),
		base64: z
			.string()
			.optional()
			.describe(
				"Base64-encoded document bytes for content that is not on disk. Requires `filename` so Firecrawl can detect the type.",
			),
		url: z
			.string()
			.optional()
			.describe(
				"URL the document is downloaded from before being uploaded to /parse. Use only for documents Firecrawl cannot fetch itself (auth headers via `fetchHeaders`, private network, signed link); for public document URLs call firecrawl_scrape instead — it parses them directly and can serve them from cache.",
			),
		fetchHeaders: z
			.record(z.string(), z.string())
			.optional()
			.describe("Headers used for the local download when `url` is set, e.g. Authorization or Cookie."),
		filename: z
			.string()
			.optional()
			.describe(
				"Name (and, decisively, extension) sent with the upload. Required with `base64`; otherwise derived from filePath/url. Supported extensions: .html, .htm, .xhtml, .pdf, .docx, .doc, .docm, .odt, .ods, .odp, .rtf, .xlsx, .xls, .xlsm, .xlsb, .pptx, .ppt, .pptm, .epub, .csv.",
			),
		formats: z
			.array(
				z.union([
					z.enum(["markdown", "summary", "html", "rawHtml", "links", "images", "json"]),
					z.object({
						type: z.enum(["markdown", "summary", "html", "rawHtml", "links", "images", "json"]).describe("Format type"),
						schema: z
							.record(z.string(), z.unknown())
							.optional()
							.describe("json: JSON Schema the extracted object must conform to"),
						prompt: z.string().optional().describe("json: natural-language extraction instruction"),
					}),
				]),
			)
			.optional()
			.describe(
				"Output formats, default ['markdown']. Only markdown, summary, html, rawHtml, links, images and json are supported here — browser-rendering formats (screenshot, actions) and changeTracking are not available for uploads.",
			),
		onlyMainContent: z
			.boolean()
			.optional()
			.describe("HTML uploads: strip headers, navs and footers before markdown generation. Default true."),
		includeTags: z.array(z.string()).optional().describe("HTML uploads: CSS selectors/tags to keep"),
		excludeTags: z.array(z.string()).optional().describe("HTML uploads: CSS selectors/tags to drop"),
		headers: z
			.record(z.string(), z.string())
			.optional()
			.describe("Headers Firecrawl sends for any additional network request the document triggers"),
		timeout: z
			.number()
			.int()
			.optional()
			.describe("Server-side parse timeout in ms. Default 30000, maximum 300000. Raise it for large scanned PDFs."),
		parsers: z
			.array(
				z.object({
					type: z.enum(["pdf"]).describe("Parser to configure"),
					mode: z
						.enum(["fast", "auto", "ocr"])
						.optional()
						.describe("'fast' text-only, 'auto' (default) text-first with OCR fallback, 'ocr' OCR on every page"),
					maxPages: z.number().int().optional().describe("Cap pages parsed, 1-10000"),
					pages: z
						.boolean()
						.optional()
						.describe("Also return physical per-page markdown as `pages` [{pageNumber, markdown}]. No extra cost."),
					blocks: z
						.boolean()
						.optional()
						.describe(
							"Also return typed layout blocks (title, section_header, text, table, formula, figure, caption, ...) with normalized bboxes, reading order and markdown spans. No extra cost.",
						),
					pageMarkers: z
						.boolean()
						.optional()
						.describe(
							"Annotate page breaks in the document markdown with '<!-- page N -->'. Markers sit between pages only and may skip pages merged across a break; use `pages` when every physical page matters.",
						),
				}),
			)
			.optional()
			.describe("File parser controls. Default [{type:'pdf'}] with mode 'auto'."),
		skipTlsVerification: z.boolean().optional().describe("Skip TLS verification on follow-on requests. Default true."),
		removeBase64Images: z
			.boolean()
			.optional()
			.describe("Drop inline base64 images and keep alt-text placeholders. Default true."),
		blockAds: z.boolean().optional().describe("Block ads and cookie popups in HTML uploads. Default true."),
		redactPII: z
			.union([
				z.boolean(),
				z.object({
					mode: z
						.enum(["accurate", "aggressive", "fast"])
						.optional()
						.describe("'accurate' (default) model-only, 'aggressive' adds heuristics, 'fast' heuristics only"),
					entities: z
						.array(z.enum(["PERSON", "EMAIL", "PHONE", "LOCATION", "FINANCIAL", "SECRET"]))
						.optional()
						.describe("Restrict redaction to these buckets; omit for all"),
					replaceStyle: z
						.enum(["tag", "mask", "remove"])
						.optional()
						.describe("'tag' (default) placeholders like <EMAIL>, 'mask' asterisks, 'remove' deletes the span"),
				}),
			])
			.optional()
			.describe("Redact personally identifiable information from the returned content. Default false."),
		proxy: z
			.enum(["basic", "auto"])
			.optional()
			.describe("Proxy mode for follow-on requests. /parse supports only 'basic' and 'auto'."),
		origin: z.string().optional().describe("Origin identifier recorded for analytics and logging. Default 'api'."),
		integration: z.string().optional().describe("Optional integration identifier recorded with the request"),
		auditMetadata: z
			.object({ username: z.string().describe("Username attributed to this request") })
			.optional()
			.describe("SIEM attribution metadata (enterprise)"),
		zeroDataRetention: z
			.boolean()
			.optional()
			.describe("Enable zero data retention for this parse. Must be enabled for the team first."),
		maxChars: z
			.number()
			.int()
			.optional()
			.describe("Inline character budget per section before content is written to a file and only a head is shown."),
	});

	return [
		defineTool({
			name: "firecrawl_parse",
			label: "Firecrawl Parse",
			description:
				"Convert a document's bytes into clean markdown or structured JSON with Firecrawl's parser: PDF (native text or OCR), Word (.doc/.docx/.docm), Excel (.xls/.xlsx/.xlsm/.xlsb), PowerPoint (.ppt/.pptx/.pptm), OpenDocument (.odt/.ods/.odp), RTF, EPUB, CSV and HTML. Tables and reading order are preserved. UPLOADS DATA OFF THIS MACHINE: `filePath` reads a local file and `url` fetches a possibly-internal address, then sends those bytes to api.firecrawl.dev — never point it at secrets, credentials or private repositories, and prefer firecrawl_scrape for any publicly reachable document URL. PDFs can additionally return per-page markdown (parsers[].pages), typed layout blocks with bounding boxes (parsers[].blocks) and page-break markers. Files up to 50MB; the call is synchronous and returns the parsed document, with anything past the inline budget written to a file.",
			parameters,
			// Reads local files and fetches arbitrary (possibly intranet) URLs, then
			// uploads those bytes to a third party. That is not read-only web access.
			approval: "exec",
			async execute(_id, params, signal, onUpdate, _ctx) {
				const { filePath, base64, url, fetchHeaders, filename, maxChars, ...parseOptions } = params;

				const sources = [filePath, base64, url].filter((value) => value !== undefined && value !== "");
				if (sources.length > 1) {
					return fail("Provide only one of `filePath`, `base64` or `url`; they are mutually exclusive inputs.");
				}
				if (base64 && !filename) {
					return fail(
						"`filename` is required with `base64` so Firecrawl can detect the document type from its extension.",
					);
				}

				try {
					let bytes: Uint8Array;
					let resolvedName: string;

					if (filePath) {
						bytes = await readFile(filePath);
						resolvedName = filename ?? basename(filePath);
					} else if (base64) {
						bytes = Buffer.from(base64, "base64");
						resolvedName = filename ?? "document";
					} else if (url) {
						const download = await fetch(url, { headers: fetchHeaders, signal });
						if (!download.ok) {
							return fail(
								`Downloading ${url} failed with HTTP ${download.status} ${download.statusText}. Pass credentials via \`fetchHeaders\`, or use firecrawl_scrape if the URL is public.`,
							);
						}
						bytes = new Uint8Array(await download.arrayBuffer());
						resolvedName = filename ?? (basename(new URL(url).pathname) || "document");
					} else {
						return fail("Provide exactly one of `filePath`, `base64` or `url`: /parse needs the document's bytes.");
					}

					const extension = /\.([a-z0-9]+)$/i.exec(resolvedName)?.[1]?.toLowerCase();
					const contentType = extension ? CONTENT_TYPES[extension] : undefined;
					if (!contentType) {
						return fail(
							`'${resolvedName}' has ${extension ? `an unsupported extension '.${extension}'` : "no file extension"}. /parse accepts: ${Object.keys(
								CONTENT_TYPES,
							)
								.map((value) => `.${value}`)
								.join(", ")}. Set \`filename\` to the real document name.`,
						);
					}
					if (bytes.byteLength === 0) {
						return fail(`'${resolvedName}' is empty — nothing to parse.`);
					}
					if (bytes.byteLength > MAX_UPLOAD_BYTES) {
						return fail(
							`'${resolvedName}' is ${(bytes.byteLength / 1024 / 1024).toFixed(1)}MB; /parse accepts at most 50MB per request. Split the document, or scrape it from a URL instead.`,
						);
					}

					onUpdate?.({
						content: [
							{
								type: "text",
								text: `Uploading ${resolvedName} (${(bytes.byteLength / 1024).toFixed(0)}KB) to Firecrawl /parse...`,
							},
						],
					});

					const response = await uploadForParse(
						client,
						{ bytes, filename: resolvedName, contentType },
						compact({ ...parseOptions }),
						signal,
						(parseOptions.timeout ?? 30_000) + 60_000,
					);

					const doc = response.data;
					if (!doc) {
						return fail("Firecrawl parsed the upload but returned no document.", response);
					}

					const rendered = await renderDocument(out, doc, { label: resolvedName, inlineChars: maxChars });
					const notes: string[] = [];
					if (response.warning) notes.push(`Note: ${response.warning}`);
					if (Array.isArray(doc.blocks)) {
						const pages = doc.blocks as BlockPage[];
						const counts: Record<string, number> = {};
						for (const page of pages) {
							for (const item of page.items ?? []) {
								const type = item.type ?? "unknown";
								counts[type] = (counts[type] ?? 0) + 1;
							}
						}
						const summary = Object.entries(counts)
							.sort((left, right) => right[1] - left[1])
							.map(([type, count]) => `${type}=${count}`)
							.join(", ");
						notes.push(`Layout blocks: ${pages.length} pages${summary === "" ? "" : ` — ${summary}`}`);
					}
					if (doc.pages && doc.pages.length > 0) notes.push(`Per-page markdown: ${doc.pages.length} pages`);

					const text = notes.length > 0 ? `${notes.join("\n")}\n${rendered}` : rendered;
					return ok(text, {
						filename: resolvedName,
						bytes: bytes.byteLength,
						contentType,
						pages: doc.pages?.length,
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

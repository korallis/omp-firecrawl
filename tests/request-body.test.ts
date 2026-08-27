/**
 * Request-body contract tests.
 *
 * These assert what actually goes on the wire, because several Firecrawl
 * options change behaviour or billing by their emptiness rather than their
 * presence. A body-shaping regression here is invisible in tool output.
 */
import { describe, expect, test } from "bun:test";
import * as zod from "@oh-my-pi/omptype/zod";
import type { ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";

import { FirecrawlAuthResolver } from "../src/core/auth.ts";
import { FirecrawlClient } from "../src/core/client.ts";
import { loadConfig } from "../src/core/config.ts";
import { OutputWriter } from "../src/core/output.ts";
import { compact, type FirecrawlToolEnv } from "../src/core/tool.ts";
import crawlModule from "../src/tools/crawl.ts";
import scrapeModule from "../src/tools/scrape.ts";

interface CapturedRequest {
	url: string;
	method: string | undefined;
	body: Record<string, unknown>;
}

/** Build a tool environment whose transport records requests instead of sending them. */
function harness(response: unknown): { env: FirecrawlToolEnv; requests: CapturedRequest[] } {
	const requests: CapturedRequest[] = [];
	const config = { ...loadConfig(), envApiKey: "fc-test", cacheDir: "/tmp/omp-firecrawl-test" };
	// Only the call signature matters here; `typeof fetch` also demands `preconnect`.
	const stubFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
		requests.push({
			url: String(input),
			method: init?.method,
			body: init?.body === undefined ? {} : (JSON.parse(String(init.body)) as Record<string, unknown>),
		});
		return new Response(JSON.stringify(response), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	};
	const client = new FirecrawlClient(config, new FirecrawlAuthResolver(config), stubFetch as unknown as typeof fetch);
	return {
		env: { z: zod, client, config, out: new OutputWriter(config.cacheDir, config.inlineChars) },
		requests,
	};
}

function findTool(tools: ToolDefinition[], name: string): ToolDefinition {
	const tool = tools.find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`tool ${name} not registered`);
	return tool;
}

async function run(tool: ToolDefinition, params: Record<string, unknown>): Promise<void> {
	const schema = tool.parameters as { parse?: (value: unknown) => unknown };
	const parsed = typeof schema.parse === "function" ? schema.parse(params) : params;
	await tool.execute("test", parsed, undefined, undefined, {} as ExtensionContext);
}

describe("compact", () => {
	test("drops undefined only", () => {
		expect(compact({ a: undefined, b: 1 })).toEqual({ b: 1 });
	});

	test("preserves empty arrays and objects, which are meaningful requests", () => {
		// `parsers: []` disables PDF parsing; `{}` is a valid scrapeOptions.
		expect(compact({ parsers: [], scrapeOptions: {}, blacklist: [] })).toEqual({
			parsers: [],
			scrapeOptions: {},
			blacklist: [],
		});
	});

	test("keeps null, which some fields use to clear a value", () => {
		expect(compact({ tag: null })).toEqual({ tag: null });
	});
});

describe("firecrawl_scrape request body", () => {
	test("sends parsers: [] so PDF parsing is disabled instead of defaulted", async () => {
		const { env, requests } = harness({ success: true, data: { markdown: "hi", metadata: { statusCode: 200 } } });
		await run(findTool(scrapeModule(env), "firecrawl_scrape"), {
			url: "https://example.com/doc.pdf",
			parsers: [],
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://api.firecrawl.dev/v2/scrape");
		expect(requests[0]?.body).toEqual({ url: "https://example.com/doc.pdf", parsers: [] });
	});

	test("omits every option the caller did not set", async () => {
		const { env, requests } = harness({ success: true, data: { markdown: "hi" } });
		await run(findTool(scrapeModule(env), "firecrawl_scrape"), { url: "https://example.com" });

		expect(requests[0]?.body).toEqual({ url: "https://example.com" });
	});

	test("passes maxAge: 0 through rather than treating it as absent", async () => {
		const { env, requests } = harness({ success: true, data: { markdown: "hi" } });
		await run(findTool(scrapeModule(env), "firecrawl_scrape"), { url: "https://example.com", maxAge: 0 });

		expect(requests[0]?.body).toMatchObject({ maxAge: 0 });
	});
});

describe("firecrawl_crawl request body", () => {
	test("forwards an empty scrapeOptions.parsers into the crawl job", async () => {
		const { env, requests } = harness({ success: true, id: "job-1", url: "https://api.firecrawl.dev/v2/crawl/job-1" });
		await run(findTool(crawlModule(env), "firecrawl_crawl"), {
			action: "start",
			url: "https://example.com",
			limit: 1,
			wait: false,
			scrapeOptions: { parsers: [] },
		});

		expect(requests[0]?.method).toBe("POST");
		expect(requests[0]?.body).toEqual({
			url: "https://example.com",
			limit: 1,
			scrapeOptions: { parsers: [] },
		});
	});
});

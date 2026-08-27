#!/usr/bin/env bun
/**
 * Live verification harness.
 *
 * Runs one registered tool against the real Firecrawl API outside omp, using
 * the same modules the extension loads, so a tool can be exercised end to end
 * without a full session:
 *
 *   bun scripts/smoke.ts firecrawl_developer '{"query":"bun test timeout","k":2}'
 *   bun scripts/smoke.ts --list
 */
import * as zod from "@oh-my-pi/omptype/zod";
import type { ExtensionContext, ToolDefinition } from "@oh-my-pi/pi-coding-agent";

import { FirecrawlAuthResolver } from "../src/core/auth.ts";
import { FirecrawlClient } from "../src/core/client.ts";
import { loadConfig } from "../src/core/config.ts";
import { OutputWriter } from "../src/core/output.ts";
import type { FirecrawlToolEnv, FirecrawlToolModule } from "../src/core/tool.ts";

const MODULE_FILES = [
	"web-search",
	"scrape",
	"developer",
	"research",
	"map",
	"crawl",
	"batch",
	"parse",
	"extract",
	"agent",
	"interact",
	"monitor",
	"account",
];

const config = loadConfig();
const auth = new FirecrawlAuthResolver(config);
const env: FirecrawlToolEnv = {
	z: zod,
	client: new FirecrawlClient(config, auth),
	config,
	out: new OutputWriter(config.cacheDir, config.inlineChars),
};

const tools: ToolDefinition[] = [];
const missing: string[] = [];
for (const file of MODULE_FILES) {
	try {
		const imported = (await import(`../src/tools/${file}.ts`)) as { default: FirecrawlToolModule };
		tools.push(...imported.default(env));
	} catch (error) {
		missing.push(`${file}: ${error instanceof Error ? error.message.split("\n")[0] : String(error)}`);
	}
}

const [name, rawParams] = process.argv.slice(2);

if (!name || name === "--list") {
	const resolved = await auth.resolve();
	console.log(`auth: ${resolved.mode} (${resolved.source})  endpoint: ${config.baseUrl}/v2`);
	console.log(`\n${tools.length} tools registered:`);
	for (const tool of tools) {
		console.log(`  ${tool.name.padEnd(22)} ${tool.loadMode ?? "discoverable"}/${tool.approval ?? "exec"}`);
	}
	if (missing.length > 0) console.log(`\nmodules not loaded yet:\n  ${missing.join("\n  ")}`);
	process.exit(0);
}

const tool = tools.find((candidate) => candidate.name === name);
if (!tool) {
	console.error(`unknown tool: ${name}. Known: ${tools.map((candidate) => candidate.name).join(", ")}`);
	process.exit(1);
}

const parsed: unknown = rawParams ? JSON.parse(rawParams) : {};
const schema = tool.parameters as { parse?: (value: unknown) => unknown };
const params = typeof schema.parse === "function" ? schema.parse(parsed) : parsed;

const started = Date.now();
const result = await tool.execute(
	"smoke",
	params,
	undefined,
	(update) => {
		for (const block of update.content ?? []) {
			if (block.type === "text") console.error(`[update] ${block.text.slice(0, 200)}`);
		}
	},
	{} as ExtensionContext,
);

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
console.log(`--- ${tool.name} ${result.isError ? "ERROR" : "ok"} in ${elapsed}s ---`);
for (const block of result.content) {
	if (block.type === "text") console.log(block.text);
}
if (result.details !== undefined) console.log(`--- details ---\n${JSON.stringify(result.details, null, 2)}`);
process.exit(result.isError ? 1 : 0);

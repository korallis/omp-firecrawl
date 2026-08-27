/**
 * omp-firecrawl — Firecrawl v2 as first-class omp tools.
 *
 * Registration only: the factory builds one shared client and hands it to every
 * tool module. `web_search` deliberately shadows the built-in tool so existing
 * prompts, skills and subagents route through Firecrawl with no rewiring; it
 * delegates back to the native provider chain when Firecrawl fails.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { FirecrawlAuthResolver } from "./core/auth.ts";
import { FirecrawlClient } from "./core/client.ts";
import { loadConfig } from "./core/config.ts";
import { OutputWriter } from "./core/output.ts";
import type { FirecrawlToolEnv, FirecrawlToolModule } from "./core/tool.ts";
import account from "./tools/account.ts";
import agent from "./tools/agent.ts";
import batch from "./tools/batch.ts";
import crawl from "./tools/crawl.ts";
import developer from "./tools/developer.ts";
import extract from "./tools/extract.ts";
import interact from "./tools/interact.ts";
import map from "./tools/map.ts";
import monitor from "./tools/monitor.ts";
import parse from "./tools/parse.ts";
import research from "./tools/research.ts";
import scrape from "./tools/scrape.ts";
import webSearch from "./tools/web-search.ts";

const CORE_MODULES: FirecrawlToolModule[] = [
	scrape,
	developer,
	research,
	map,
	crawl,
	batch,
	parse,
	extract,
	agent,
	interact,
	monitor,
	account,
];

export default function firecrawlExtension(pi: ExtensionAPI) {
	const config = loadConfig();
	const auth = new FirecrawlAuthResolver(config);
	const client = new FirecrawlClient(config, auth);
	const env: FirecrawlToolEnv = {
		z: pi.zod,
		client,
		config,
		out: new OutputWriter(config.cacheDir, config.inlineChars),
	};

	pi.setLabel("Firecrawl");

	const modules = config.takeoverWebSearch ? [webSearch, ...CORE_MODULES] : CORE_MODULES;
	let registered = 0;
	for (const module of modules) {
		for (const tool of module(env)) {
			pi.registerTool(tool);
			registered += 1;
		}
	}
	pi.logger.debug("firecrawl: registered tools", {
		count: registered,
		takeoverWebSearch: config.takeoverWebSearch,
		baseUrl: config.baseUrl,
	});

	pi.registerCommand("firecrawl", {
		description: "Firecrawl status (auth, credits, queue). `/firecrawl refresh` re-reads the key from 1Password.",
		handler: async (args, ctx) => {
			if (args.trim() === "refresh") {
				auth.invalidate();
				const refreshed = await auth.resolve();
				ctx.ui.notify(
					refreshed.mode === "api_key"
						? `Firecrawl key re-read from ${refreshed.source}; cached for ${config.credentialCacheTtlMs / 3_600_000}h.`
						: `Firecrawl key unavailable (${auth.opError ?? "no source"}); running keyless.`,
					refreshed.mode === "api_key" ? "info" : "warning",
				);
				return;
			}

			const resolved = await auth.resolve();
			const lines = [
				`endpoint: ${config.baseUrl}/v2`,
				`auth: ${resolved.mode}${resolved.source === "none" ? "" : ` (from ${resolved.source})`}`,
				config.credentialCacheTtlMs > 0
					? `key cache: ${config.credentialCachePath} (ttl ${config.credentialCacheTtlMs / 3_600_000}h, keeps 1Password from prompting per process)`
					: "key cache: disabled",
				`web_search takeover: ${config.takeoverWebSearch ? "on" : "off"}`,
				`inline budget: ${config.inlineChars} chars, spill dir: ${config.cacheDir}`,
			];
			if (auth.opError) lines.push(`last 1Password error: ${auth.opError}`);
			try {
				const credits = await client.request<{ data?: { remainingCredits?: number; planCredits?: number } }>(
					"/team/credit-usage",
				);
				lines.push(
					`credits: ${credits.data?.remainingCredits ?? "?"} remaining of ${credits.data?.planCredits ?? "?"}`,
				);
				const queue = await client.request<{
					jobsInQueue?: number;
					activeJobsInQueue?: number;
					waitingJobsInQueue?: number;
				}>("/team/queue-status");
				lines.push(`queue: ${queue.jobsInQueue ?? 0} jobs (${queue.activeJobsInQueue ?? 0} active)`);
			} catch (error) {
				lines.push(`usage lookup failed: ${error instanceof Error ? error.message : String(error)}`);
			}
			ctx.ui.notify(lines.join("\n"), resolved.mode === "api_key" ? "info" : "warning");
		},
	});
}

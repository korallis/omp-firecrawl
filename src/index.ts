/**
 * omp-firecrawl — Firecrawl v2 as first-class omp tools.
 *
 * Registration only: the factory builds one shared client and hands it to every
 * tool module. `web_search` deliberately shadows the built-in tool so existing
 * prompts, skills and subagents route through Firecrawl with no rewiring; it
 * delegates back to the native provider chain when Firecrawl fails.
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { FirecrawlAuthResolver, NO_KEY_HINT } from "./core/auth.ts";
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

	// The search module registers both `web_search` (shadowing the built-in) and
	// the `firecrawl_search` alias. Only the shadow is optional; the alias is how
	// restricted agents reach Firecrawl at all.
	let registered = 0;
	for (const module of [webSearch, ...CORE_MODULES]) {
		for (const tool of module(env)) {
			if (tool.name === "web_search" && !config.takeoverWebSearch) continue;
			pi.registerTool(tool);
			registered += 1;
		}
	}
	pi.logger.debug("firecrawl: registered tools", {
		count: registered,
		takeoverWebSearch: config.takeoverWebSearch,
		baseUrl: config.baseUrl,
	});

	// Warm the credential so `FIRECRAWL_API_KEY` is exported into this process
	// before any subagent runs: a restricted subagent uses omp's built-in
	// `web_search`, which reads that variable to pick the Firecrawl provider.
	//
	// Deliberately NOT awaited. Awaiting it here made a machine whose `op`
	// binary could not authenticate hang session start until the extension
	// handler timed out. Credential resolution is never on the startup path.
	pi.on("session_start", (_event, ctx) => {
		const timer = ctx.setTimeout(() => {
			auth
				.resolve()
				.then((resolved) => {
					if (resolved.mode === "keyless") {
						pi.logger.debug("firecrawl: running keyless", { reason: auth.opError ?? "no key configured" });
					}
				})
				.catch((error: unknown) => {
					pi.logger.debug("firecrawl: credential warm-up failed", { error });
				});
		}, 0);
		pi.on("session_shutdown", () => ctx.clearTimer(timer));
	});

	pi.registerCommand("firecrawl", {
		description:
			"Firecrawl status and auth. `/firecrawl login fc-...` stores an API key, `/firecrawl logout` removes it, `/firecrawl refresh` re-reads it.",
		handler: async (args, ctx) => {
			const [subcommand, ...rest] = args.trim().split(/\s+/);

			if (subcommand === "login") {
				const supplied = rest.join("").trim();
				const key = supplied || (await ctx.ui.input("Firecrawl API key", "fc-...")) || "";
				if (key.trim() === "") {
					ctx.ui.notify("No key entered; nothing stored.", "warning");
					return;
				}
				const path = auth.saveKey(key);
				const resolved = await auth.resolve();
				ctx.ui.notify(
					resolved.mode === "api_key"
						? `Firecrawl key stored (0600) at ${path}. 1Password is not required.`
						: `Stored a key at ${path}, but it did not resolve — check the value.`,
					resolved.mode === "api_key" ? "info" : "warning",
				);
				return;
			}

			if (subcommand === "logout") {
				const removed = auth.forgetKey();
				ctx.ui.notify(
					removed ? "Removed the stored Firecrawl key and cached credential." : "No stored key to remove.",
					"info",
				);
				return;
			}

			if (subcommand === "refresh") {
				auth.invalidate();
				const refreshed = await auth.resolve();
				ctx.ui.notify(
					refreshed.mode === "api_key"
						? `Firecrawl key re-read from ${refreshed.source}.`
						: `No Firecrawl key available (${auth.opError ?? "none configured"}); running keyless. Use /firecrawl login fc-...`,
					refreshed.mode === "api_key" ? "info" : "warning",
				);
				return;
			}

			const resolved = await auth.resolve();
			const lines = [
				`endpoint: ${config.baseUrl}/v2`,
				`auth: ${resolved.mode}${resolved.source === "none" ? "" : ` (from ${resolved.source})`}`,
				`key file: ${config.keyFilePath}`,
				`web_search takeover: ${config.takeoverWebSearch ? "on" : "off"}`,
				`inline budget: ${config.inlineChars} chars, spill dir: ${config.cacheDir}`,
			];
			if (resolved.mode === "keyless") lines.push(NO_KEY_HINT);
			if (auth.opUnusable && config.opEnabled) {
				lines.push(`1Password not used: ${auth.opError ?? "unavailable"} (optional; ignore if you use a key file)`);
			}
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

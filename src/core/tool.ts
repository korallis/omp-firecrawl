/**
 * Tool-module contract.
 *
 * Every file under `src/tools/` default-exports a `FirecrawlToolModule`: given
 * the shared environment it returns fully-formed omp tool definitions. The
 * extension factory in `src/index.ts` is the only place that touches `pi`.
 */

import type { TSchema } from "@oh-my-pi/pi-ai";
import type { ToolDefinition } from "@oh-my-pi/pi-coding-agent";

import type { FirecrawlClient } from "./client.ts";
import type { FirecrawlConfig } from "./config.ts";
import type { OutputWriter } from "./output.ts";
import type { Z } from "./schema.ts";

export interface FirecrawlToolEnv {
	/** Host-injected Zod-compatible schema builder. */
	z: Z;
	client: FirecrawlClient;
	config: FirecrawlConfig;
	/** Inline-vs-spill writer for large payloads. */
	out: OutputWriter;
}

export type FirecrawlToolModule = (env: FirecrawlToolEnv) => ToolDefinition[];

/**
 * Preserve `params` inference from the parameter schema at the definition site
 * while erasing the generic for the heterogeneous registration list.
 */
export function defineTool<S extends TSchema, D = unknown>(definition: ToolDefinition<S, D>): ToolDefinition {
	return definition as unknown as ToolDefinition;
}

/**
 * Drop only keys the caller did not set.
 *
 * Emptiness is meaningful in this API: `parsers: []` disables PDF parsing and
 * switches billing to flat rate, `blacklist: []` clears a threat-protection
 * list in a full-document PUT, and `{}` is a valid `scrapeOptions`. Pruning
 * those would silently change behaviour and cost, so `undefined` is the only
 * thing removed here.
 */
export function compact<T extends Record<string, unknown>>(body: T): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(body)) {
		if (value === undefined) continue;
		out[key] = value;
	}
	return out;
}

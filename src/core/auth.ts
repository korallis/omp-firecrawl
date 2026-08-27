/**
 * Firecrawl credential resolution.
 *
 * Order: `FIRECRAWL_API_KEY` -> on-disk cache -> 1Password CLI -> keyless.
 * Keyless is a real Firecrawl mode (heavily rate limited), so the plugin stays
 * useful before a key exists instead of failing to load.
 *
 * The on-disk cache exists to stop 1Password prompting. Every omp process,
 * subagent and `omp -p` invocation is a fresh process, so an in-memory cache
 * alone means one `op read` per process — and one prompt per process on a
 * machine where `op` is not backed by a service-account token. The cache turns
 * that into at most one lookup per TTL for the whole machine. It holds the key
 * in a `0600` file under the plugin cache directory; delete it (or run
 * `/firecrawl refresh`) to force a fresh read.
 */
import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { FirecrawlConfig } from "./config.ts";

export type FirecrawlAuthMode = "api_key" | "keyless";

export interface FirecrawlAuth {
	apiKey: string | undefined;
	mode: FirecrawlAuthMode;
	/** Where the key came from, for `/firecrawl` diagnostics. */
	source: "env" | "cache" | "1password" | "none";
}

const KEYLESS: FirecrawlAuth = { apiKey: undefined, mode: "keyless", source: "none" };

/** A failed lookup is retried after a minute rather than pinned for the whole TTL. */
const OP_FAILURE_TTL_MS = 60_000;
/**
 * `op read` is normally 2-3s but a cold session has been measured at 28s, and a
 * tight timeout silently demotes the session to keyless.
 */
const OP_TIMEOUT_MS = 45_000;

interface CachedCredential {
	ref: string;
	key: string;
	fetchedAt: number;
}

export interface OpReadOutcome {
	value: string | undefined;
	error: string | undefined;
}

function runOpRead(ref: string): Promise<OpReadOutcome> {
	const { promise, resolve } = Promise.withResolvers<OpReadOutcome>();
	const child = execFile(
		"op",
		["read", "--no-newline", ref],
		{ timeout: OP_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true },
		(error, stdout, stderr) => {
			if (error) {
				const detail = stderr.toString().trim().split("\n").at(-1) ?? error.message;
				resolve({ value: undefined, error: detail });
				return;
			}
			const value = stdout.toString().trim();
			resolve({ value: value === "" ? undefined : value, error: value === "" ? "empty secret" : undefined });
		},
	);
	// Never let a hung `op` keep the host process alive.
	child.unref?.();
	return promise;
}

export class FirecrawlAuthResolver {
	#config: FirecrawlConfig;
	#memoized: string | undefined;
	#failedUntil = 0;
	#inFlight: Promise<OpReadOutcome> | undefined;
	#lastResolved: FirecrawlAuth = KEYLESS;
	#opError: string | undefined;
	/** The value this resolver exported to `process.env`, if any. */
	#seededEnv: string | undefined;

	constructor(config: FirecrawlConfig) {
		this.#config = config;
	}

	/** Last auth actually used by a request; drives `/firecrawl` output. */
	get lastResolved(): FirecrawlAuth {
		return this.#lastResolved;
	}

	/** Why the last 1Password lookup failed, when it did. */
	get opError(): string | undefined {
		return this.#opError;
	}

	/**
	 * Forget the key everywhere, so a rotated secret is picked up. Called on a
	 * 401 and by `/firecrawl refresh`.
	 */
	invalidate(): void {
		this.#memoized = undefined;
		this.#failedUntil = 0;
		// Also drop the value we exported, or the stale key would keep winning:
		// `resolve()` checks the environment first. Never touch a value the user
		// set themselves.
		if (this.#seededEnv !== undefined && process.env.FIRECRAWL_API_KEY === this.#seededEnv) {
			delete process.env.FIRECRAWL_API_KEY;
		}
		this.#seededEnv = undefined;
		try {
			rmSync(this.#config.credentialCachePath, { force: true });
		} catch {
			// A cache we cannot delete is not worth failing a request over.
		}
	}

	async resolve(): Promise<FirecrawlAuth> {
		// Re-read the environment every time: a session may export the key after
		// the extension loaded.
		const envKey = [process.env.FIRECRAWL_API_KEY, process.env.FIRECRAWL_KEY, this.#config.envApiKey]
			.map((value) => value?.trim())
			.find((value) => value !== undefined && value !== "");
		if (envKey) {
			this.#lastResolved = { apiKey: envKey, mode: "api_key", source: "env" };
			return this.#lastResolved;
		}

		if (this.#memoized) {
			this.#lastResolved = this.#seed({ apiKey: this.#memoized, mode: "api_key", source: "cache" });
			return this.#lastResolved;
		}

		const cached = this.#readCache();
		if (cached) {
			this.#memoized = cached;
			this.#lastResolved = this.#seed({ apiKey: cached, mode: "api_key", source: "cache" });
			return this.#lastResolved;
		}

		const fromOp = await this.#readOnePassword();
		if (fromOp) {
			this.#memoized = fromOp;
			this.#writeCache(fromOp);
			this.#lastResolved = this.#seed({ apiKey: fromOp, mode: "api_key", source: "1password" });
			return this.#lastResolved;
		}

		this.#lastResolved = KEYLESS;
		return KEYLESS;
	}

	/**
	 * Export the key to this process's environment.
	 *
	 * omp's own built-in `web_search` resolves a Firecrawl credential through the
	 * environment, and a restricted subagent (`scout`, `librarian`, anything with
	 * an explicit `tools:` list) gets that built-in rather than this plugin's
	 * tools. Seeding the variable in-process is what makes those agents search
	 * through Firecrawl too. It never leaves this process and is never written to
	 * disk beyond the `0600` credential cache; set `FIRECRAWL_SEED_ENV=0` to opt out.
	 */
	#seed(auth: FirecrawlAuth): FirecrawlAuth {
		if (auth.apiKey && !process.env.FIRECRAWL_API_KEY && process.env.FIRECRAWL_SEED_ENV !== "0") {
			process.env.FIRECRAWL_API_KEY = auth.apiKey;
			this.#seededEnv = auth.apiKey;
		}
		return auth;
	}

	#readCache(): string | undefined {
		if (this.#config.credentialCacheTtlMs <= 0) return undefined;
		let parsed: CachedCredential;
		try {
			parsed = JSON.parse(readFileSync(this.#config.credentialCachePath, "utf8")) as CachedCredential;
		} catch {
			return undefined;
		}
		// A cache written for a different secret reference is not ours to use.
		if (parsed.ref !== this.#config.opRef) return undefined;
		if (typeof parsed.key !== "string" || parsed.key === "") return undefined;
		if (Date.now() - parsed.fetchedAt > this.#config.credentialCacheTtlMs) return undefined;
		return parsed.key;
	}

	#writeCache(key: string): void {
		if (this.#config.credentialCacheTtlMs <= 0) return;
		const path = this.#config.credentialCachePath;
		const payload: CachedCredential = { ref: this.#config.opRef, key, fetchedAt: Date.now() };
		try {
			mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
			writeFileSync(path, JSON.stringify(payload), { encoding: "utf8", mode: 0o600 });
			// writeFileSync only applies `mode` when creating the file.
			chmodSync(path, 0o600);
		} catch {
			// Caching is an optimization; a read-only home directory must not break auth.
		}
	}

	async #readOnePassword(): Promise<string | undefined> {
		if (!this.#config.opEnabled) return undefined;
		if (Date.now() < this.#failedUntil) return undefined;

		const pending =
			this.#inFlight ??
			runOpRead(this.#config.opRef).finally(() => {
				this.#inFlight = undefined;
			});
		this.#inFlight = pending;

		let outcome = await pending;
		// A cold 1Password session can time out or error once and then succeed
		// immediately; one retry is much cheaper than silently going keyless.
		if (!outcome.value) outcome = await runOpRead(this.#config.opRef);
		this.#opError = outcome.error;
		if (!outcome.value) this.#failedUntil = Date.now() + OP_FAILURE_TTL_MS;
		return outcome.value;
	}
}

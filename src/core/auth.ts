/**
 * Firecrawl credential resolution.
 *
 * Order: `FIRECRAWL_API_KEY` -> the key file written by `/firecrawl login`
 * -> a cached 1Password read -> 1Password -> keyless.
 *
 * **1Password is strictly optional.** A machine without it — a server, a CI
 * box, someone else's laptop — must work by typing a key once. Earlier versions
 * blocked session start for over a minute when an `op` binary was present but
 * could not authenticate, so every 1Password path here is short, single-shot,
 * gated on a preflight, and remembered as unusable for the process once it
 * fails. Nothing in this file may ever be on a blocking startup path.
 */
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import type { FirecrawlConfig } from "./config.ts";
import { clearSettingsCache, PACKAGE_NAME, settingsApiKey } from "./settings.ts";

export type FirecrawlAuthMode = "api_key" | "keyless";

export interface FirecrawlAuth {
	apiKey: string | undefined;
	mode: FirecrawlAuthMode;
	/** Where the key came from, for `/firecrawl` diagnostics. */
	source: "env" | "settings" | "keyfile" | "cache" | "1password" | "none";
}

const KEYLESS: FirecrawlAuth = { apiKey: undefined, mode: "keyless", source: "none" };

/** How the missing-key error reads wherever a tool reports it. */
export const NO_KEY_HINT =
	"No Firecrawl API key. Run `/firecrawl login fc-...` (stored 0600 in the plugin config dir), or set FIRECRAWL_API_KEY.";

/**
 * Deliberately short. A slow `op` must not delay a search, and the preflight
 * below means the common "1Password unavailable" case never even reaches here.
 */
const OP_READ_TIMEOUT_MS = 10_000;
const OP_PREFLIGHT_TIMEOUT_MS = 3_000;

interface CachedCredential {
	ref: string;
	key: string;
	fetchedAt: number;
}

export interface OpReadOutcome {
	value: string | undefined;
	error: string | undefined;
}

function runOp(args: string[], timeoutMs: number): Promise<OpReadOutcome> {
	const { promise, resolve } = Promise.withResolvers<OpReadOutcome>();
	let settled = false;
	const finish = (outcome: OpReadOutcome) => {
		if (settled) return;
		settled = true;
		resolve(outcome);
	};

	let child: ReturnType<typeof execFile>;
	try {
		child = execFile(
			"op",
			args,
			{ timeout: timeoutMs, maxBuffer: 64 * 1024, windowsHide: true },
			(error, stdout, stderr) => {
				if (error) {
					const detail = stderr.toString().trim().split("\n").at(-1) ?? error.message;
					finish({ value: undefined, error: detail || error.message });
					return;
				}
				const value = stdout.toString().trim();
				finish({ value: value === "" ? undefined : value, error: value === "" ? "empty secret" : undefined });
			},
		);
	} catch (error) {
		// Spawn itself can throw synchronously (no such binary, EACCES).
		finish({ value: undefined, error: error instanceof Error ? error.message : String(error) });
		return promise;
	}

	// `execFile`'s own timeout only fires once the process is spawned and is
	// implemented with a signal; belt-and-braces so a wedged `op` can never
	// hold a caller past the deadline.
	const timer = setTimeout(() => {
		child.kill("SIGKILL");
		finish({ value: undefined, error: `op timed out after ${timeoutMs}ms` });
	}, timeoutMs + 500);
	if (typeof timer === "object" && "unref" in timer) timer.unref();
	child.on("error", (error) => finish({ value: undefined, error: error.message }));
	child.unref?.();
	return promise;
}

export class FirecrawlAuthResolver {
	#config: FirecrawlConfig;
	#memoized: string | undefined;
	#memoizedSource: FirecrawlAuth["source"] = "keyfile";
	#lastResolved: FirecrawlAuth = KEYLESS;
	#opError: string | undefined;
	/** Set once `op` has proven unusable; stops all further attempts. */
	#opUnusable = false;
	/** Whether a 1Password read was ever actually attempted this process. */
	#opAttempted = false;
	#opAttempt: Promise<string | undefined> | undefined;
	/** The value this resolver exported to `process.env`, if any. */
	#seededEnv: string | undefined;
	/** Directory used to locate project-scoped plugin settings. */
	#cwd: string;

	constructor(config: FirecrawlConfig, cwd: string = process.cwd()) {
		this.#config = config;
		this.#cwd = cwd;
	}

	/**
	 * Every place a key can come from and whether it is currently set. This is
	 * what `/firecrawl` prints, so a user who cannot find where to put a key
	 * sees all the options and their state at once.
	 */
	describeSources(): string[] {
		// Exclude the value we exported ourselves: reporting our own seed as
		// "set" tells a user their environment holds a key when it does not.
		const envSet = [process.env.FIRECRAWL_API_KEY, process.env.FIRECRAWL_KEY, this.#config.envApiKey].some(
			(value) => value !== undefined && value.trim() !== "" && value !== this.#seededEnv,
		);
		const rows = [
			`env FIRECRAWL_API_KEY: ${envSet ? "set" : "not set"}`,
			`plugin setting apiKey: ${settingsApiKey(this.#cwd) ? "set" : `not set — omp plugin config set ${PACKAGE_NAME} apiKey fc-...`}`,
			`key file ${this.#config.keyFilePath}: ${existsSync(this.#config.keyFilePath) ? "present" : "not created — /firecrawl login fc-..."}`,
		];
		if (!this.#config.opEnabled) {
			rows.push("1Password: disabled by FIRECRAWL_OP_ENABLED=0");
		} else if (this.#opUnusable) {
			rows.push(`1Password ${this.#config.opRef}: unavailable (${this.#opError ?? "unknown"}) — optional, ignore this`);
		} else if (this.#opAttempted) {
			rows.push(`1Password ${this.#config.opRef}: read successfully`);
		} else {
			// Never probed, because an earlier source already had a key. Saying
			// "available" here would claim a check that never ran.
			rows.push(`1Password ${this.#config.opRef}: not needed — a key was found first`);
		}
		return rows;
	}

	/** Last auth actually used by a request; drives `/firecrawl` output. */
	get lastResolved(): FirecrawlAuth {
		return this.#lastResolved;
	}

	/** Why the last 1Password lookup failed, when it did. */
	get opError(): string | undefined {
		return this.#opError;
	}

	/** Whether 1Password has been ruled out for this process. */
	get opUnusable(): boolean {
		return this.#opUnusable;
	}

	/** Persist a key the user typed. Returns the file it was written to. */
	saveKey(apiKey: string): string {
		const path = this.#config.keyFilePath;
		mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
		writeFileSync(path, `${apiKey.trim()}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(path, 0o600);
		this.#memoized = apiKey.trim();
		this.#opUnusable = false;
		this.#opError = undefined;
		return path;
	}

	/** Remove a stored key. Returns true when something was deleted. */
	forgetKey(): boolean {
		this.#memoized = undefined;
		this.#clearSeededEnv();
		let removed = false;
		for (const path of [this.#config.keyFilePath, this.#config.credentialCachePath]) {
			try {
				rmSync(path, { force: true });
				removed = true;
			} catch {
				// Nothing to do: reporting a failed unlink of an optional file is noise.
			}
		}
		return removed;
	}

	/**
	 * Forget memoized and cached keys so a rotated secret is picked up. Called
	 * on a 401 and by `/firecrawl refresh`. The key file is left alone — it is
	 * user-supplied state, not a cache.
	 */
	invalidate(): void {
		this.#memoized = undefined;
		this.#opUnusable = false;
		this.#opError = undefined;
		// A key just written with `omp plugin config set` must be picked up now,
		// not after the settings cache expires.
		clearSettingsCache();
		this.#clearSeededEnv();
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
			this.#lastResolved = this.#seed({ apiKey: envKey, mode: "api_key", source: "env" });
			return this.#lastResolved;
		}

		if (this.#memoized) {
			this.#lastResolved = this.#seed({ apiKey: this.#memoized, mode: "api_key", source: this.#memoizedSource });
			return this.#lastResolved;
		}

		// `omp plugin config set <pkg> apiKey fc-...` — the native settings path.
		const fromSettings = settingsApiKey(this.#cwd);
		if (fromSettings) {
			this.#memoized = fromSettings;
			this.#memoizedSource = "settings";
			this.#lastResolved = this.#seed({ apiKey: fromSettings, mode: "api_key", source: "settings" });
			return this.#lastResolved;
		}

		const fromFile = this.#readKeyFile();
		if (fromFile) {
			this.#memoized = fromFile;
			this.#memoizedSource = "keyfile";
			this.#lastResolved = this.#seed({ apiKey: fromFile, mode: "api_key", source: "keyfile" });
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

	#readKeyFile(): string | undefined {
		try {
			const value = readFileSync(this.#config.keyFilePath, "utf8").trim();
			return value === "" ? undefined : value;
		} catch {
			return undefined;
		}
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

	/**
	 * One 1Password attempt per process, behind a 3s preflight.
	 *
	 * A machine with no `op`, an `op` that cannot reach a vault, or an `op` that
	 * hangs all land in the same place: `#opUnusable`, and never tried again.
	 */
	async #readOnePassword(): Promise<string | undefined> {
		if (!this.#config.opEnabled || this.#opUnusable) return undefined;
		if (this.#opAttempt) return this.#opAttempt;

		this.#opAttempt = (async () => {
			this.#opAttempted = true;
			const preflight = await runOp(["--version"], OP_PREFLIGHT_TIMEOUT_MS);
			if (!preflight.value) {
				this.#opUnusable = true;
				this.#opError = `1Password CLI unavailable (${preflight.error ?? "no version output"})`;
				return undefined;
			}
			const outcome = await runOp(["read", "--no-newline", this.#config.opRef], OP_READ_TIMEOUT_MS);
			if (!outcome.value) {
				this.#opUnusable = true;
				this.#opError = outcome.error;
				return undefined;
			}
			this.#opError = undefined;
			return outcome.value;
		})().finally(() => {
			this.#opAttempt = undefined;
		});

		return this.#opAttempt;
	}

	/**
	 * Export the key to this process's environment.
	 *
	 * omp's own built-in `web_search` resolves a Firecrawl credential through the
	 * environment, and a restricted subagent (`scout`, `librarian`, anything with
	 * an explicit `tools:` list) gets that built-in rather than this plugin's
	 * tools. Seeding the variable in-process is what makes those agents search
	 * through Firecrawl too. `config.seedEnv` (`FIRECRAWL_SEED_ENV=0`) opts out.
	 */
	#seed(auth: FirecrawlAuth): FirecrawlAuth {
		if (auth.apiKey && this.#config.seedEnv && !process.env.FIRECRAWL_API_KEY) {
			process.env.FIRECRAWL_API_KEY = auth.apiKey;
			this.#seededEnv = auth.apiKey;
		}
		return auth;
	}

	#clearSeededEnv(): void {
		// Never touch a value the user set themselves.
		if (this.#seededEnv !== undefined && process.env.FIRECRAWL_API_KEY === this.#seededEnv) {
			delete process.env.FIRECRAWL_API_KEY;
		}
		this.#seededEnv = undefined;
	}
}

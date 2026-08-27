/**
 * Environment-derived plugin configuration.
 *
 * Every knob is an environment variable so the plugin behaves identically in
 * interactive omp, `omp -p`, subagents, and RPC/ACP hosts without depending on
 * host settings plumbing.
 */

export interface FirecrawlConfig {
	/** API origin without version suffix, e.g. `https://api.firecrawl.dev`. */
	baseUrl: string;
	/** Explicit key from the environment, if any. */
	envApiKey: string | undefined;
	/**
	 * `0600` file holding a key the user supplied with `/firecrawl login`.
	 * This is the primary way to configure the plugin. It never expires and
	 * never involves 1Password.
	 */
	keyFilePath: string;
	/** 1Password secret reference consulted only when nothing else has a key. */
	opRef: string;
	/** Whether the 1Password lookup may be attempted at all. */
	opEnabled: boolean;
	/**
	 * How long a key read from 1Password may be reused from disk. This is what
	 * keeps `op` (and its prompts) from running once per omp process.
	 * Zero disables the on-disk cache.
	 */
	credentialCacheTtlMs: number;
	/** `0600` file holding the cached key. */
	credentialCachePath: string;
	/** Characters of page/document text rendered inline before spilling to disk. */
	inlineChars: number;
	/** Directory for spilled content files. */
	cacheDir: string;
	/** Register the Firecrawl-backed `web_search` over the built-in tool. */
	takeoverWebSearch: boolean;
	/** Default per-request transport timeout in milliseconds. */
	requestTimeoutMs: number;
	/** Default wall-clock ceiling for job polling in milliseconds. */
	jobTimeoutMs: number;
}

function envFlag(name: string, fallback: boolean): boolean {
	const raw = process.env[name];
	if (raw === undefined || raw.trim() === "") return fallback;
	const value = raw.trim().toLowerCase();
	if (value === "1" || value === "true" || value === "yes" || value === "on") return true;
	if (value === "0" || value === "false" || value === "no" || value === "off") return false;
	return fallback;
}

function envInt(name: string, fallback: number, min: number, max: number): number {
	const raw = process.env[name];
	if (raw === undefined) return fallback;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, parsed));
}

function defaultCacheDir(): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
	const xdg = process.env.XDG_CACHE_HOME;
	if (xdg && xdg.trim() !== "") return `${xdg.replace(/\/+$/, "")}/omp/firecrawl`;
	return `${home}/.omp/cache/firecrawl`;
}

/**
 * Durable plugin state, separate from the cache: a key the user typed should
 * survive a cache wipe.
 */
function configDir(): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
	const xdg = process.env.XDG_CONFIG_HOME;
	if (xdg && xdg.trim() !== "") return `${xdg.replace(/\/+$/, "")}/omp/firecrawl`;
	return `${home}/.omp/firecrawl`;
}

function normalizeBaseUrl(raw: string | undefined): string {
	const value = (raw ?? "https://api.firecrawl.dev").trim().replace(/\/+$/, "");
	// Tolerate users pasting a versioned base URL; the client owns the version.
	return value.replace(/\/v[12]$/, "");
}

export function loadConfig(): FirecrawlConfig {
	const envApiKey = [process.env.FIRECRAWL_API_KEY, process.env.FIRECRAWL_KEY]
		.map((value) => value?.trim())
		.find((value) => value !== undefined && value !== "");

	const cacheDir = process.env.FIRECRAWL_CACHE_DIR?.trim() || defaultCacheDir();

	return {
		baseUrl: normalizeBaseUrl(process.env.FIRECRAWL_API_URL ?? process.env.FIRECRAWL_BASE_URL),
		envApiKey,
		keyFilePath: process.env.FIRECRAWL_KEY_FILE?.trim() || `${configDir()}/credential`,
		opRef: process.env.FIRECRAWL_OP_REF?.trim() || "op://Dev-Env/Firecrawl/credential",
		opEnabled: envFlag("FIRECRAWL_OP_ENABLED", true),
		// 12h by default: long enough that `op` runs about once a day, short
		// enough that a rotated key is picked up without manual cleanup.
		credentialCacheTtlMs: envInt("FIRECRAWL_CREDENTIAL_CACHE_HOURS", 12, 0, 24 * 30) * 3_600_000,
		credentialCachePath: process.env.FIRECRAWL_CREDENTIAL_CACHE?.trim() || `${cacheDir}/credential.json`,
		inlineChars: envInt("FIRECRAWL_INLINE_CHARS", 12_000, 500, 400_000),
		cacheDir,
		takeoverWebSearch: envFlag("FIRECRAWL_TAKEOVER_WEB_SEARCH", true),
		requestTimeoutMs: envInt("FIRECRAWL_REQUEST_TIMEOUT_MS", 120_000, 5_000, 900_000),
		jobTimeoutMs: envInt("FIRECRAWL_JOB_TIMEOUT_MS", 600_000, 10_000, 3_600_000),
	};
}

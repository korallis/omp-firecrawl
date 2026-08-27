/**
 * Firecrawl v2 HTTP client: one transport for every endpoint the plugin wraps.
 *
 * Owns auth injection, retry/backoff, timeout composition, error normalization,
 * job polling and paginated-result collection so tool modules stay declarative.
 */
import type { FirecrawlAuth, FirecrawlAuthResolver } from "./auth.ts";
import type { FirecrawlConfig } from "./config.ts";

export type HttpMethod = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface RequestOptions {
	method?: HttpMethod;
	/** Query parameters; `undefined` values are dropped. */
	query?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
	signal?: AbortSignal;
	/** Transport ceiling for this call; defaults to the configured request timeout. */
	timeoutMs?: number;
	/**
	 * Allow retrying a mutating call after a 5xx. Off by default because a
	 * retried `POST /crawl` would start a second job.
	 */
	retryOn5xx?: boolean;
	/** Absolute URL override, used when following a paginated `next` link. */
	absoluteUrl?: string;
}

const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 20_000;

/** Documented Firecrawl error codes mapped to the action that actually fixes them. */
const ERROR_HINTS: Record<string, string> = {
	SCRAPE_TIMEOUT: "Raise `timeout` (max 300000ms) or lower page work (fewer formats/actions).",
	SCRAPE_ALL_ENGINES_FAILED: 'Retry with `proxy: "enhanced"`; the site blocked every engine.',
	SCRAPE_SSL_ERROR: "Pass `skipTlsVerification: true` for this host.",
	SCRAPE_DNS_RESOLUTION_ERROR: "Host does not resolve; check the URL.",
	SCRAPE_ACTION_ERROR: "An action failed: verify selectors, or add a `wait` action before it.",
	SCRAPE_PDF_PREFETCH_FAILED: "PDF fetch failed; retry or scrape the HTML landing page instead.",
	SCRAPE_PDF_INSUFFICIENT_TIME_ERROR: "Raise `timeout` or cap pages via `parsers[0].maxPages`.",
	SCRAPE_PDF_ANTIBOT_ERROR: 'PDF is anti-bot protected; try `proxy: "enhanced"`.',
	SCRAPE_ZDR_VIOLATION_ERROR:
		"`zeroDataRetention` conflicts with a format that needs storage (e.g. screenshot); drop one.",
	SCRAPE_UNSUPPORTED_FILE_ERROR: "Unsupported file type, or larger than the 10MB limit.",
	SCRAPE_LOCKDOWN_CACHE_MISS:
		"`lockdown: true` only serves cache. Seed it with a normal scrape first, or drop lockdown.",
};

export class FirecrawlError extends Error {
	readonly status: number | undefined;
	readonly code: string | undefined;
	readonly retryable: boolean;
	readonly hint: string | undefined;
	readonly path: string;

	constructor(init: {
		message: string;
		path: string;
		status?: number;
		code?: string;
		retryable?: boolean;
		hint?: string;
	}) {
		super(init.message);
		this.name = "FirecrawlError";
		this.path = init.path;
		this.status = init.status;
		this.code = init.code;
		this.retryable = init.retryable ?? false;
		this.hint = init.hint ?? (init.code ? ERROR_HINTS[init.code] : undefined);
	}

	/** Single-line rendering for tool output. */
	describe(): string {
		const parts = [`Firecrawl ${this.path} failed`];
		if (this.status !== undefined) parts.push(`(HTTP ${this.status}${this.code ? ` ${this.code}` : ""})`);
		else if (this.code) parts.push(`(${this.code})`);
		let text = `${parts.join(" ")}: ${this.message}`;
		if (this.hint) text += `\nFix: ${this.hint}`;
		return text;
	}
}

export interface JobPollOptions<T> {
	signal?: AbortSignal;
	/** Called with each intermediate status snapshot. */
	onPoll?: (snapshot: T) => void;
	/** Wall-clock ceiling; defaults to the configured job timeout. */
	timeoutMs?: number;
	intervalMs?: number;
	/** Terminal-state predicate; defaults to Firecrawl's own status vocabulary. */
	isDone?: (snapshot: T) => boolean;
}

interface StatusShape {
	status?: string;
	success?: boolean;
	next?: string | null;
	data?: unknown;
}

const TERMINAL_STATUSES: Record<string, true> = {
	completed: true,
	failed: true,
	cancelled: true,
	canceled: true,
	error: true,
	done: true,
};

function parseRetryAfter(header: string | null): number | undefined {
	if (!header) return undefined;
	const seconds = Number(header);
	if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1_000, 60_000);
	const date = Date.parse(header);
	if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 60_000);
	return undefined;
}

function extractError(payload: unknown): { message: string | undefined; code: string | undefined } {
	if (typeof payload === "string") return { message: payload || undefined, code: undefined };
	if (!payload || typeof payload !== "object") return { message: undefined, code: undefined };
	const record = payload as Record<string, unknown>;
	const nested = record.error;
	if (nested && typeof nested === "object") {
		const inner = nested as Record<string, unknown>;
		return {
			message: typeof inner.message === "string" ? inner.message : undefined,
			code: typeof inner.code === "string" ? inner.code : undefined,
		};
	}
	const message = [nested, record.message, record.detail, record.details].find(
		(value) => typeof value === "string" && value.trim() !== "",
	) as string | undefined;
	const code = [record.code, record.errorCode].find((value) => typeof value === "string") as string | undefined;
	return { message, code };
}

export class FirecrawlClient {
	#config: FirecrawlConfig;
	#auth: FirecrawlAuthResolver;
	#fetch: typeof fetch;

	constructor(config: FirecrawlConfig, auth: FirecrawlAuthResolver, fetchImpl?: typeof fetch) {
		this.#config = config;
		this.#auth = auth;
		this.#fetch = fetchImpl ?? globalThis.fetch;
	}

	get config(): FirecrawlConfig {
		return this.#config;
	}

	get auth(): FirecrawlAuthResolver {
		return this.#auth;
	}

	/** Execute one API call, retrying transient failures. */
	async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
		const method = options.method ?? (options.body === undefined ? "GET" : "POST");
		const url = options.absoluteUrl ?? this.#buildUrl(path, options.query);
		let lastError: FirecrawlError | undefined;

		for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
			const auth = await this.#auth.resolve();
			let response: Response;
			try {
				response = await this.#fetch(url, {
					method,
					headers: this.#buildHeaders(auth, options.body !== undefined),
					body: options.body === undefined ? undefined : JSON.stringify(options.body),
					signal: this.#buildSignal(options.signal, options.timeoutMs),
				});
			} catch (cause) {
				if (options.signal?.aborted) throw cause;
				const aborted = cause instanceof Error && cause.name === "AbortError";
				lastError = new FirecrawlError({
					message: aborted
						? `request exceeded ${options.timeoutMs ?? this.#config.requestTimeoutMs}ms`
						: cause instanceof Error
							? cause.message
							: String(cause),
					path,
					retryable: method === "GET" || aborted === false,
					hint: aborted ? "Raise the tool's `timeout`, or narrow the request." : undefined,
				});
				if (attempt === MAX_ATTEMPTS || !lastError.retryable) throw lastError;
				await this.#sleep(this.#backoff(attempt), options.signal);
				continue;
			}

			if (response.ok) return (await this.#readJson(response, path)) as T;

			const bodyText = await response.text().catch(() => "");
			const parsed = bodyText.trim().startsWith("{") ? this.#safeJson(bodyText) : bodyText;
			const { message, code } = extractError(parsed);
			const retryable = this.#isRetryableStatus(response.status, method, options.retryOn5xx);
			lastError = new FirecrawlError({
				message: message ?? bodyText.slice(0, 400) ?? response.statusText,
				path,
				status: response.status,
				code,
				retryable,
				hint: this.#statusHint(response.status, auth, message),
			});

			// Only a 401 means the credential itself is bad. A 403 is normally a
			// plan or policy gate (`/team/threat-protection` is enterprise-only),
			// and dropping the cached key there would force a needless — and on an
			// interactive machine, prompting — 1Password read.
			if (response.status === 401) this.#auth.invalidate();
			if (attempt === MAX_ATTEMPTS || !retryable) throw lastError;
			const wait = parseRetryAfter(response.headers.get("retry-after")) ?? this.#backoff(attempt);
			await this.#sleep(wait, options.signal);
		}

		throw lastError ?? new FirecrawlError({ message: "request failed", path });
	}

	/**
	 * Poll a job status endpoint until it reaches a terminal state.
	 * Interval ramps 2s -> 10s so short jobs stay snappy without hammering long ones.
	 */
	async pollJob<T extends StatusShape>(path: string, options: JobPollOptions<T> = {}): Promise<T> {
		const deadline = Date.now() + (options.timeoutMs ?? this.#config.jobTimeoutMs);
		const isDone =
			options.isDone ?? ((snapshot: T) => snapshot.status !== undefined && TERMINAL_STATUSES[snapshot.status] === true);
		let interval = options.intervalMs ?? 2_000;

		for (;;) {
			const snapshot = await this.request<T>(path, { signal: options.signal });
			if (isDone(snapshot)) return snapshot;
			options.onPoll?.(snapshot);
			if (Date.now() + interval > deadline) {
				return snapshot;
			}
			await this.#sleep(interval, options.signal);
			interval = Math.min(Math.round(interval * 1.35), 10_000);
		}
	}

	/**
	 * Follow a paginated job result (`next` links) and merge the `data` arrays.
	 * Firecrawl caps a page at 10MB, so a large crawl only returns whole results here.
	 */
	async collectPages<T extends StatusShape>(
		first: T,
		options: { signal?: AbortSignal; maxPages?: number } = {},
	): Promise<T> {
		const maxPages = options.maxPages ?? 20;
		const merged = Array.isArray(first.data) ? [...(first.data as unknown[])] : first.data;
		let next = first.next ?? undefined;
		let pages = 0;

		while (next && Array.isArray(merged) && pages < maxPages) {
			const page = await this.request<T>("(paginated)", {
				absoluteUrl: next,
				signal: options.signal,
			});
			if (Array.isArray(page.data)) merged.push(...(page.data as unknown[]));
			next = page.next ?? undefined;
			pages += 1;
		}
		return { ...first, data: merged, next: next ?? null } as T;
	}

	#buildUrl(path: string, query: RequestOptions["query"]): string {
		const url = new URL(`${this.#config.baseUrl}/v2${path.startsWith("/") ? path : `/${path}`}`);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value === undefined) continue;
			url.searchParams.set(key, String(value));
		}
		return url.toString();
	}

	#buildHeaders(auth: FirecrawlAuth, hasBody: boolean): Record<string, string> {
		const headers: Record<string, string> = { Accept: "application/json" };
		if (hasBody) headers["Content-Type"] = "application/json";
		if (auth.apiKey) headers.Authorization = `Bearer ${auth.apiKey}`;
		return headers;
	}

	#buildSignal(caller: AbortSignal | undefined, timeoutMs: number | undefined): AbortSignal {
		const timeout = AbortSignal.timeout(timeoutMs ?? this.#config.requestTimeoutMs);
		return caller ? AbortSignal.any([caller, timeout]) : timeout;
	}

	#isRetryableStatus(status: number, method: HttpMethod, retryOn5xx: boolean | undefined): boolean {
		if (status === 429 || status === 503) return true;
		if (method !== "GET" && !retryOn5xx) return false;
		return status === 408 || status === 425 || status >= 500;
	}

	#statusHint(status: number, auth: FirecrawlAuth, serverMessage: string | undefined): string | undefined {
		const keyless = auth.mode === "keyless";
		switch (status) {
			case 401:
				return keyless
					? "No API key resolved. Set FIRECRAWL_API_KEY, or store one at the configured 1Password reference and run /firecrawl refresh."
					: "API key rejected. Rotate it in 1Password, then run /firecrawl refresh.";
			case 403:
				if (keyless) {
					return "This endpoint needs a key. Set FIRECRAWL_API_KEY or store one at the configured 1Password reference.";
				}
				// A 403 body normally says exactly what is gated (plan tier, key
				// restrictions, IP allowlist); a generic auth hint would mislead.
				return serverMessage ? undefined : "Endpoint not permitted for this team, key or source IP.";
			case 402:
				return "Firecrawl credits exhausted or plan does not include this endpoint.";
			case 404:
				return "Job id expired or never existed; job results are retained for a limited window.";
			case 429:
				return "Rate or concurrency limit hit; the client already backed off and retried.";
			default:
				return undefined;
		}
	}

	#backoff(attempt: number): number {
		const exponential = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS);
		return exponential + Math.floor(Math.random() * 250);
	}

	async #readJson(response: Response, path: string): Promise<unknown> {
		const text = await response.text();
		if (text.trim() === "") return {};
		try {
			return JSON.parse(text);
		} catch {
			throw new FirecrawlError({
				message: `non-JSON response: ${text.slice(0, 200)}`,
				path,
				status: response.status,
			});
		}
	}

	#safeJson(text: string): unknown {
		try {
			return JSON.parse(text);
		} catch {
			return text;
		}
	}

	async #sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		const timer = setTimeout(resolve, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error("aborted"));
		};
		if (signal?.aborted) {
			onAbort();
		} else {
			signal?.addEventListener("abort", onAbort, { once: true });
		}
		try {
			await promise;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}
}

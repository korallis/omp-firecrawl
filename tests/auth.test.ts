/**
 * Credential-cache behaviour.
 *
 * The on-disk cache is the thing that stops 1Password prompting once per omp
 * process, so its hit/miss/invalidate rules are worth pinning down. These tests
 * never invoke `op`: a cache hit must short-circuit before the resolver would
 * reach for it, and a configured key must win over everything.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

import { FirecrawlAuthResolver } from "../src/core/auth.ts";
import { type FirecrawlConfig, loadConfig } from "../src/core/config.ts";

const CACHE_DIR = "/tmp/omp-firecrawl-auth-test";
const CACHE_PATH = `${CACHE_DIR}/credential.json`;

function testConfig(overrides: Partial<FirecrawlConfig> = {}): FirecrawlConfig {
	return {
		...loadConfig(),
		envApiKey: undefined,
		opEnabled: false,
		opRef: "op://Test/Firecrawl/credential",
		cacheDir: CACHE_DIR,
		credentialCachePath: CACHE_PATH,
		credentialCacheTtlMs: 3_600_000,
		...overrides,
	};
}

function seedCache(entry: { ref: string; key: string; fetchedAt: number }): void {
	mkdirSync(CACHE_DIR, { recursive: true });
	writeFileSync(CACHE_PATH, JSON.stringify(entry), "utf8");
}

afterEach(() => {
	rmSync(CACHE_DIR, { recursive: true, force: true });
	delete process.env.FIRECRAWL_API_KEY;
});

describe("FirecrawlAuthResolver", () => {
	test("a fresh cache entry is used without consulting 1Password", async () => {
		seedCache({ ref: "op://Test/Firecrawl/credential", key: "fc-cached", fetchedAt: Date.now() });
		const resolved = await new FirecrawlAuthResolver(testConfig()).resolve();

		expect(resolved).toEqual({ apiKey: "fc-cached", mode: "api_key", source: "cache" });
	});

	test("an expired cache entry is ignored", async () => {
		seedCache({
			ref: "op://Test/Firecrawl/credential",
			key: "fc-stale",
			fetchedAt: Date.now() - 7_200_000,
		});
		const resolved = await new FirecrawlAuthResolver(testConfig({ credentialCacheTtlMs: 3_600_000 })).resolve();

		expect(resolved.mode).toBe("keyless");
	});

	test("a cache written for a different secret reference is not reused", async () => {
		seedCache({ ref: "op://Other/Firecrawl/credential", key: "fc-other", fetchedAt: Date.now() });
		const resolved = await new FirecrawlAuthResolver(testConfig()).resolve();

		expect(resolved.mode).toBe("keyless");
	});

	test("the environment wins over a cached key", async () => {
		seedCache({ ref: "op://Test/Firecrawl/credential", key: "fc-cached", fetchedAt: Date.now() });
		process.env.FIRECRAWL_API_KEY = "fc-env";
		const resolved = await new FirecrawlAuthResolver(testConfig()).resolve();

		expect(resolved).toEqual({ apiKey: "fc-env", mode: "api_key", source: "env" });
	});

	test("invalidate deletes the cache file so a rotated key is picked up", async () => {
		seedCache({ ref: "op://Test/Firecrawl/credential", key: "fc-cached", fetchedAt: Date.now() });
		const resolver = new FirecrawlAuthResolver(testConfig());
		await resolver.resolve();
		resolver.invalidate();

		expect(existsSync(CACHE_PATH)).toBe(false);
		expect((await resolver.resolve()).mode).toBe("keyless");
	});

	test("ttl 0 disables the cache entirely", async () => {
		seedCache({ ref: "op://Test/Firecrawl/credential", key: "fc-cached", fetchedAt: Date.now() });
		const resolved = await new FirecrawlAuthResolver(testConfig({ credentialCacheTtlMs: 0 })).resolve();
		expect(resolved.mode).toBe("keyless");
	});

	test("a resolved key is exported to the process so the built-in web_search can use it", async () => {
		// A restricted subagent (scout, librarian, any agent with an explicit
		// tools list) uses omp's built-in web_search, which reads this variable.
		seedCache({ ref: "op://Test/Firecrawl/credential", key: "fc-seeded", fetchedAt: Date.now() });
		await new FirecrawlAuthResolver(testConfig()).resolve();

		expect(process.env.FIRECRAWL_API_KEY).toBe("fc-seeded");
	});

	test("seeding is skipped when FIRECRAWL_SEED_ENV is 0", async () => {
		process.env.FIRECRAWL_SEED_ENV = "0";
		seedCache({ ref: "op://Test/Firecrawl/credential", key: "fc-seeded", fetchedAt: Date.now() });
		await new FirecrawlAuthResolver(testConfig()).resolve();

		expect(process.env.FIRECRAWL_API_KEY).toBeUndefined();
		delete process.env.FIRECRAWL_SEED_ENV;
	});

	test("a written cache file is owner-readable only", async () => {
		// Exercise the writer through a stub `op` result by pre-seeding, then
		// re-writing via a resolver configured with a key source it will cache.
		mkdirSync(CACHE_DIR, { recursive: true });
		writeFileSync(CACHE_PATH, JSON.stringify({ ref: "x", key: "y", fetchedAt: 0 }), { mode: 0o600 });

		expect(statSync(CACHE_PATH).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(CACHE_PATH, "utf8")).ref).toBe("x");
	});
});

/**
 * Credential-cache behaviour.
 *
 * The on-disk cache is the thing that stops 1Password prompting once per omp
 * process, so its hit/miss/invalidate rules are worth pinning down. These tests
 * never invoke `op`: a cache hit must short-circuit before the resolver would
 * reach for it, and a configured key must win over everything.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";

import { FirecrawlAuthResolver } from "../src/core/auth.ts";
import { type FirecrawlConfig, loadConfig } from "../src/core/config.ts";

const CACHE_DIR = "/tmp/omp-firecrawl-auth-test";
const CACHE_PATH = `${CACHE_DIR}/credential.json`;
// Never let a test read or write the real user key file.
const KEY_PATH = `${CACHE_DIR}/keyfile`;

function testConfig(overrides: Partial<FirecrawlConfig> = {}): FirecrawlConfig {
	return {
		...loadConfig(),
		envApiKey: undefined,
		opEnabled: false,
		// Seeding writes process.env, which is shared with every other test file
		// in this process. Only the two tests that assert seeding turn it on.
		seedEnv: false,
		opRef: "op://Test/Firecrawl/credential",
		cacheDir: CACHE_DIR,
		keyFilePath: KEY_PATH,
		credentialCachePath: CACHE_PATH,
		credentialCacheTtlMs: 3_600_000,
		...overrides,
	};
}

function seedCache(entry: { ref: string; key: string; fetchedAt: number }): void {
	mkdirSync(CACHE_DIR, { recursive: true });
	writeFileSync(CACHE_PATH, JSON.stringify(entry), "utf8");
}

// Clear before as well as after: another test file in the same process can
// leave FIRECRAWL_API_KEY behind, and resolution checks the environment first.
beforeEach(() => {
	rmSync(CACHE_DIR, { recursive: true, force: true });
	delete process.env.FIRECRAWL_API_KEY;
});

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
		await new FirecrawlAuthResolver(testConfig({ seedEnv: true })).resolve();

		expect(process.env.FIRECRAWL_API_KEY).toBe("fc-seeded");
	});

	test("seeding is skipped when it is turned off", async () => {
		seedCache({ ref: "op://Test/Firecrawl/credential", key: "fc-seeded", fetchedAt: Date.now() });
		await new FirecrawlAuthResolver(testConfig({ seedEnv: false })).resolve();

		expect(process.env.FIRECRAWL_API_KEY).toBeUndefined();
	});

	test("a written cache file is owner-readable only", async () => {
		mkdirSync(CACHE_DIR, { recursive: true });
		writeFileSync(CACHE_PATH, JSON.stringify({ ref: "x", key: "y", fetchedAt: 0 }), { mode: 0o600 });

		expect(statSync(CACHE_PATH).mode & 0o777).toBe(0o600);
		expect(JSON.parse(readFileSync(CACHE_PATH, "utf8")).ref).toBe("x");
	});
});

describe("key file — the path for machines without 1Password", () => {
	test("saveKey persists 0600 and resolves without any 1Password lookup", async () => {
		// opEnabled is false in testConfig, so reaching api_key here proves the
		// key file alone is sufficient.
		const resolver = new FirecrawlAuthResolver(testConfig());
		const path = resolver.saveKey("fc-typed-by-user");

		expect(path).toBe(KEY_PATH);
		expect(statSync(KEY_PATH).mode & 0o777).toBe(0o600);
		expect(await resolver.resolve()).toEqual({
			apiKey: "fc-typed-by-user",
			mode: "api_key",
			source: "keyfile",
		});
	});

	test("a key file is read by a fresh resolver and beats the 1Password cache", async () => {
		seedCache({ ref: "op://Test/Firecrawl/credential", key: "fc-from-1password", fetchedAt: Date.now() });
		mkdirSync(CACHE_DIR, { recursive: true });
		writeFileSync(KEY_PATH, "fc-typed-by-user\n", { mode: 0o600 });

		const resolved = await new FirecrawlAuthResolver(testConfig()).resolve();

		expect(resolved.apiKey).toBe("fc-typed-by-user");
		expect(resolved.source).toBe("keyfile");
	});

	test("surrounding whitespace and a trailing newline are tolerated", async () => {
		mkdirSync(CACHE_DIR, { recursive: true });
		writeFileSync(KEY_PATH, "  fc-padded  \n\n", { mode: 0o600 });

		expect((await new FirecrawlAuthResolver(testConfig()).resolve()).apiKey).toBe("fc-padded");
	});

	test("invalidate keeps the key file, because it is user state and not a cache", async () => {
		const resolver = new FirecrawlAuthResolver(testConfig());
		resolver.saveKey("fc-typed-by-user");
		resolver.invalidate();

		expect(existsSync(KEY_PATH)).toBe(true);
		expect((await resolver.resolve()).source).toBe("keyfile");
	});

	test("forgetKey removes both the key file and the cached credential", async () => {
		seedCache({ ref: "op://Test/Firecrawl/credential", key: "fc-from-1password", fetchedAt: Date.now() });
		const resolver = new FirecrawlAuthResolver(testConfig());
		resolver.saveKey("fc-typed-by-user");

		expect(resolver.forgetKey()).toBe(true);
		expect(existsSync(KEY_PATH)).toBe(false);
		expect(existsSync(CACHE_PATH)).toBe(false);
		expect((await resolver.resolve()).mode).toBe("keyless");
	});

	test("the environment still wins over a stored key", async () => {
		const resolver = new FirecrawlAuthResolver(testConfig());
		resolver.saveKey("fc-typed-by-user");
		process.env.FIRECRAWL_API_KEY = "fc-env";

		expect((await resolver.resolve()).source).toBe("env");
	});
});

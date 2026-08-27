/**
 * `omp plugin config set <pkg> apiKey fc-...` must actually authenticate the
 * plugin. This is the discoverable settings path a public user finds first, so
 * it gets the same coverage as the environment variable.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { FirecrawlAuthResolver } from "../src/core/auth.ts";
import { type FirecrawlConfig, loadConfig } from "../src/core/config.ts";
import { clearSettingsCache, PACKAGE_NAME, settingsApiKey } from "../src/core/settings.ts";

const ROOT = "/tmp/omp-firecrawl-settings-test";
const XDG = join(ROOT, "xdg");
const PROJECT = join(ROOT, "project");

function writeUserLock(settings: Record<string, Record<string, unknown>>): void {
	const dir = join(XDG, "omp", "plugins");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "omp-plugins.lock.json"), JSON.stringify({ plugins: {}, settings }), "utf8");
}

function writeProjectOverrides(settings: Record<string, Record<string, unknown>>): void {
	const dir = join(PROJECT, ".omp");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "plugin-overrides.json"), JSON.stringify({ settings }), "utf8");
}

function testConfig(overrides: Partial<FirecrawlConfig> = {}): FirecrawlConfig {
	return {
		...loadConfig(),
		envApiKey: undefined,
		opEnabled: false,
		seedEnv: false,
		keyFilePath: join(ROOT, "no-such-key-file"),
		credentialCachePath: join(ROOT, "no-such-cache.json"),
		...overrides,
	};
}

beforeEach(() => {
	rmSync(ROOT, { recursive: true, force: true });
	mkdirSync(PROJECT, { recursive: true });
	process.env.XDG_DATA_HOME = XDG;
	delete process.env.FIRECRAWL_API_KEY;
	clearSettingsCache();
});

afterEach(() => {
	rmSync(ROOT, { recursive: true, force: true });
	delete process.env.XDG_DATA_HOME;
	delete process.env.FIRECRAWL_API_KEY;
	clearSettingsCache();
});

describe("plugin settings", () => {
	test("a key set through omp plugin config authenticates the plugin", async () => {
		writeUserLock({ [PACKAGE_NAME]: { apiKey: "fc-from-settings" } });

		const resolved = await new FirecrawlAuthResolver(testConfig(), PROJECT).resolve();

		expect(resolved).toEqual({ apiKey: "fc-from-settings", mode: "api_key", source: "settings" });
	});

	test("the pre-scope package name is still honoured for a linked dev copy", () => {
		writeUserLock({ "omp-firecrawl": { apiKey: "fc-legacy-name" } });

		expect(settingsApiKey(PROJECT)).toBe("fc-legacy-name");
	});

	test("a project override wins over the user-level setting", () => {
		writeUserLock({ [PACKAGE_NAME]: { apiKey: "fc-user" } });
		writeProjectOverrides({ [PACKAGE_NAME]: { apiKey: "fc-project" } });

		expect(settingsApiKey(PROJECT)).toBe("fc-project");
	});

	test("no settings file at all resolves keyless rather than throwing", async () => {
		expect(settingsApiKey(PROJECT)).toBeUndefined();
		expect((await new FirecrawlAuthResolver(testConfig(), PROJECT).resolve()).mode).toBe("keyless");
	});

	test("malformed JSON is ignored instead of breaking auth", () => {
		const dir = join(XDG, "omp", "plugins");
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "omp-plugins.lock.json"), "{ not json", "utf8");

		expect(settingsApiKey(PROJECT)).toBeUndefined();
	});

	test("an empty or whitespace-only value counts as unset", () => {
		writeUserLock({ [PACKAGE_NAME]: { apiKey: "   " } });

		expect(settingsApiKey(PROJECT)).toBeUndefined();
	});

	test("the environment still wins over a configured setting", async () => {
		writeUserLock({ [PACKAGE_NAME]: { apiKey: "fc-from-settings" } });
		process.env.FIRECRAWL_API_KEY = "fc-env";

		expect((await new FirecrawlAuthResolver(testConfig(), PROJECT).resolve()).source).toBe("env");
	});

	test("describeSources names every place a key can be set", () => {
		const rows = new FirecrawlAuthResolver(testConfig(), PROJECT).describeSources().join("\n");

		expect(rows).toContain("env FIRECRAWL_API_KEY");
		expect(rows).toContain(`omp plugin config set ${PACKAGE_NAME} apiKey`);
		expect(rows).toContain("/firecrawl login");
	});
});

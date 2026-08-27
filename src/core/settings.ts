/**
 * Plugin settings written by `omp plugin config set <pkg> apiKey fc-...`.
 *
 * omp persists them in `omp-plugins.lock.json#settings["<package>"]`, with
 * project-level overrides in `.omp/plugin-overrides.json`. The host exports a
 * reader for this (`getPluginSettings`), but a published plugin cannot import
 * it: the package deliberately has no dependencies, so a deep import of
 * `@oh-my-pi/pi-coding-agent` would not resolve from
 * `~/.omp/plugins/node_modules/...`. Reading the two documented JSON files is
 * dependency-free and works in every install shape.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve as resolvePath } from "node:path";

/** Both names this plugin has shipped under; a linked dev copy may use either. */
const PACKAGE_KEYS = ["@korallis/omp-firecrawl", "omp-firecrawl"] as const;

/** The published package name, used in the `omp plugin config` hint. */
export const PACKAGE_NAME = PACKAGE_KEYS[0];
/** Settings change rarely; re-reading three files on every API call is waste. */

const CACHE_TTL_MS = 30_000;

interface LockFile {
	settings?: Record<string, Record<string, unknown>>;
}

interface OverridesFile {
	settings?: Record<string, Record<string, unknown>>;
}

let cached: { at: number; values: Record<string, unknown> } | undefined;

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

/** User plugins root, honoring the XDG layout `omp config init-xdg` creates. */
function userPluginsRoot(): string {
	const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
	const xdg = process.env.XDG_DATA_HOME;
	if (xdg && xdg.trim() !== "") return join(xdg.replace(/\/+$/, ""), "omp", "plugins");
	return join(home, ".omp", "plugins");
}

/** Nearest ancestor holding a project anchor (`.omp` or `.git`). */
function projectAnchor(cwd: string): string | undefined {
	let dir = resolvePath(cwd);
	for (;;) {
		if (existsSync(join(dir, ".omp")) || existsSync(join(dir, ".git"))) return dir;
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

function pick(source: Record<string, Record<string, unknown>> | undefined): Record<string, unknown> {
	if (!source) return {};
	for (const key of PACKAGE_KEYS) {
		const found = source[key];
		if (found) return found;
	}
	return {};
}

/**
 * Merged settings for this plugin: user scope first, then the project plugins
 * root, then project overrides — the same precedence the host applies.
 */
export function readPluginSettings(cwd: string = process.cwd()): Record<string, unknown> {
	if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.values;

	const files: Array<Record<string, unknown>> = [];
	files.push(pick(readJson<LockFile>(join(userPluginsRoot(), "omp-plugins.lock.json"))?.settings));

	const anchor = projectAnchor(cwd);
	if (anchor) {
		files.push(
			pick(readJson<LockFile>(join(anchor, ".omp", "plugins", "omp-plugins.lock.json"))?.settings),
			pick(readJson<OverridesFile>(join(anchor, ".omp", "plugin-overrides.json"))?.settings),
		);
	}

	const values = Object.assign({}, ...files) as Record<string, unknown>;
	cached = { at: Date.now(), values };
	return values;
}

/** Forget the cached read, so a `omp plugin config set` takes effect at once. */
export function clearSettingsCache(): void {
	cached = undefined;
}

/** The configured API key, when one was set through `omp plugin config`. */
export function settingsApiKey(cwd?: string): string | undefined {
	const value = readPluginSettings(cwd).apiKey;
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

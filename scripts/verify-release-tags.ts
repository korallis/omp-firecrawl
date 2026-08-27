#!/usr/bin/env bun
/**
 * Does every published npm version have a git tag whose content actually
 * matches the published tarball?
 *
 * Tags drift silently: publish from one commit, add another, then tag, and the
 * tag now describes source that was never released. This happened here — v0.1.3
 * sat on the 0.1.2 source for a while. Comparing the registry tarball against
 * `git archive` is the only check that catches it.
 *
 *   bun scripts/verify-release-tags.ts
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

const PACKAGE_NAME = JSON.parse(readFileSync("package.json", "utf8")).name as string;

function run(command: string, args: string[], cwd?: string): string {
	const result = spawnSync(command, args, { cwd, encoding: "utf8" });
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed: ${result.stderr?.trim() || result.stdout?.trim()}`);
	}
	return result.stdout.trim();
}

/** Relative paths of every file in a directory tree, sorted. */
function fileList(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir)) {
			const full = join(dir, entry);
			if (statSync(full).isDirectory()) walk(full);
			else out.push(relative(root, full));
		}
	};
	walk(root);
	return out.sort();
}

const versions = JSON.parse(run("npm", ["view", PACKAGE_NAME, "versions", "--json"])) as string[];
const tags = new Set(run("git", ["tag"]).split("\n").filter(Boolean));

let failures = 0;
const work = mkdtempSync(join(tmpdir(), "verify-tags-"));

try {
	for (const version of versions) {
		const tag = `v${version}`;
		if (!tags.has(tag)) {
			console.log(`✗ ${version}: no ${tag} tag`);
			failures += 1;
			continue;
		}

		const published = join(work, `pub-${version}`);
		const tagged = join(work, `git-${version}`);
		run("mkdir", ["-p", published, tagged]);
		const tarball = run("npm", ["pack", `${PACKAGE_NAME}@${version}`, "--pack-destination", published]);
		run("tar", ["-xzf", join(published, tarball), "-C", published]);
		spawnSync("sh", ["-c", `git archive ${tag} | tar -x -C ${tagged}`], { encoding: "utf8" });

		// The published tree is authoritative: the tag may legitimately carry dev
		// files (tests, scripts) that `files` excludes from the tarball.
		const shipped = fileList(join(published, "package"));
		const mismatched = shipped.filter((file) => {
			const a = readFileSync(join(published, "package", file));
			let b: Buffer;
			try {
				b = readFileSync(join(tagged, file));
			} catch {
				return true;
			}
			return !a.equals(b);
		});

		if (mismatched.length === 0) {
			console.log(`✓ ${version}: ${tag} matches the published tarball (${shipped.length} files)`);
		} else {
			console.log(`✗ ${version}: ${tag} differs from the published tarball: ${mismatched.join(", ")}`);
			failures += 1;
		}
	}
} finally {
	rmSync(work, { recursive: true, force: true });
}

const localVersion = JSON.parse(readFileSync("package.json", "utf8")).version as string;
const latest = versions.at(-1);
if (localVersion === latest) {
	const head = run("git", ["rev-parse", "HEAD"]);
	const tagged = tags.has(`v${localVersion}`) ? run("git", ["rev-parse", `v${localVersion}^{commit}`]) : "";
	if (head !== tagged) {
		console.log(
			`! package.json is ${localVersion}, already published, but HEAD is not v${localVersion} — bump the version before publishing again`,
		);
		failures += 1;
	}
} else {
	console.log(`i package.json is ${localVersion}; npm latest is ${latest} — publish to close the gap`);
}

process.exit(failures === 0 ? 0 : 1);

/**
 * Autocomplete support for `#@` file references.
 *
 * Pure, UI-free logic so it can be unit tested: matching the reference being
 * typed, collecting candidate file paths, and rendering suggestion items.
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fuzzyFilter, type AutocompleteItem, type AutocompleteSuggestions } from "@earendil-works/pi-tui";

/** Directories that contain no user files worth completing. */
const EXCLUDED_DIRECTORIES = new Set(["node_modules", ".git", ".pi"]);

/** Hard cap on collected files to keep keystroke latency low. */
export const MAX_FILES = 2000;

/** Maximum number of suggestions returned per query. */
const MAX_SUGGESTIONS = 20;

/** How long the collected file list stays valid, in milliseconds. */
const FILE_CACHE_TTL_MS = 10_000;

/** Collected candidate paths with the time they were gathered. */
export interface FileCache {
	paths: string[];
	loadedAt: number;
}

/** A reference currently being typed before the cursor. */
export interface ReferenceContext {
	/** Full marker text being completed, e.g. `#@src/` or `#@"my no`. */
	prefix: string;
	/** The partial path typed so far, without the marker. */
	partial: string;
	/** True when the reference uses the quoted `#@"..."` form. */
	quoted: boolean;
}

/**
 * Detects an in-progress `#@` reference at the end of the text before the
 * cursor. Supports both `#@partial` and `#@"partial` (quoted form, spaces
 * allowed). Returns null when no reference is being typed there.
 */
export function matchReference(textBeforeCursor: string): ReferenceContext | null {
	const quoted = textBeforeCursor.match(/#@"([^"]*)$/);
	if (quoted) {
		return { prefix: `#@"${quoted[1]}`, partial: quoted[1], quoted: true };
	}
	const unquoted = textBeforeCursor.match(/#@([^\s]*)$/);
	if (unquoted) {
		return { prefix: `#@${unquoted[1]}`, partial: unquoted[1], quoted: false };
	}
	return null;
}

/**
 * Recursively collects candidate file and directory paths under `cwd`,
 * skipping excluded directories, as repo-relative paths.
 * Stops early once MAX_FILES entries are collected.
 */
export async function collectFiles(cwd: string): Promise<string[]> {
	const results: string[] = [];

	const walk = async (dir: string, relativeDir: string): Promise<void> => {
		if (results.length >= MAX_FILES) {
			return;
		}
		const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
		if (entries === null) {
			return;
		}
		for (const entry of entries) {
			if (results.length >= MAX_FILES) {
				return;
			}
			if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) {
				continue;
			}
			const relativePath = relativeDir ? join(relativeDir, entry.name) : entry.name;
			if (entry.isDirectory()) {
				results.push(`${relativePath}/`);
				await walk(join(dir, entry.name), relativePath);
			} else {
				results.push(relativePath);
			}
		}
	};

	await walk(cwd, "");
	return results;
}

/**
 * Renders the completion token for a path. Directories (encoded with a
 * trailing slash in the path list) complete with a closing slash so the
 * user stays in "complete next segment" mode. Paths with spaces come out
 * in the quoted `#@"..."` form.
 */
export function renderToken(path: string): string {
	const isDirectory = path.endsWith("/");
	const clean = isDirectory ? path.slice(0, -1) : path;
	let token = clean.includes(" ") ? `#@"${clean}"` : `#@${clean}`;
	if (isDirectory) {
		token = `${token}/`;
	}
	return token;
}

/**
 * Builds suggestion items for a reference context from the collected paths.
 * Each item's `value` is the full replacement token, which the editor swaps
 * in for the matched `prefix`.
 */
export function buildSuggestions(paths: string[], context: ReferenceContext): AutocompleteItem[] {
	const query = context.partial.replace(/"+$/g, "");
	const matches = fuzzyFilter(paths, query, (path) => path).slice(0, MAX_SUGGESTIONS);
	return matches.map((path) => ({
		value: renderToken(path),
		label: `#@${path}`,
		description: "inject file into prompt",
	}));
}

/**
 * Consolidated suggestion pipeline: match the reference, refresh the path
 * cache when stale, and build suggestions. Returns null when the cursor is
 * not on a reference or nothing matches.
 */
export async function suggest(
	textBeforeCursor: string,
	cwd: string,
	cache: FileCache | undefined,
): Promise<{ suggestions: AutocompleteSuggestions | null; cache: FileCache }> {
	const context = matchReference(textBeforeCursor);
	if (context === null) {
		return { suggestions: null, cache: cache ?? { paths: [], loadedAt: 0 } };
	}

	let entries = cache;
	if (!entries || Date.now() - entries.loadedAt > FILE_CACHE_TTL_MS) {
		entries = { paths: await collectFiles(cwd), loadedAt: Date.now() };
	}

	const items = buildSuggestions(entries.paths, context);
	if (items.length === 0) {
		return { suggestions: null, cache: entries };
	}
	return { suggestions: { items, prefix: context.prefix }, cache: entries };
}

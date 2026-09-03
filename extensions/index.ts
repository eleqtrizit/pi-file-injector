/**
 * File injector extension.
 *
 * Injects the full contents of a file into the user prompt at send time.
 * Any text matching `#@path` is replaced by a `<file>` block containing the
 * file contents. Paths containing spaces use the quoted form: `#@"my file.txt"`. The agent never sees the raw `#@` reference; the transformed
 * text is what goes into conversation history.
 *
 * Example:
 *   Input:  "Look over #@notes.md for typos"
 *   Sent:   "Look over\n<file path="notes.md">...contents...</file>\nfor typos"
 *
 * If a referenced file does not exist, the send is cancelled with an error
 * notification; the user can press arrow-up to edit the message and retry.
 */
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Marker that starts a file reference in the user's input. */
const REFERENCE_PREFIX = "#@";

/**
 * Matches a single file reference, e.g. `#@src/utils/foo.ts` or
 * `#@"my file.txt"` (quoted form for paths containing spaces).
 * The path is capture group 1 (quoted) or 2 (unquoted).
 */
const REFERENCE_PATTERN = /#@"([^"]+)"|#@(\S+)/g;

/** Wraps file contents in a `<file>` block for the LLM. */
function renderFileBlock(path: string, contents: string): string {
	return `<file path="${path}">\n${contents}\n</file>`;
}

/** Type returned by the injection step for each parsed reference. */
interface InjectionResult {
	text: string | null;
	missing: string[];
}

/**
 * Replaces every `#@path` reference in the input with its file contents.
 *
 * Returns `null` as `text` together with the list of missing paths when at
 * least one file cannot be read, so callers can fail the whole prompt.
 */
export async function injectFiles(text: string, cwd: string): Promise<InjectionResult> {
	const matches = [...text.matchAll(REFERENCE_PATTERN)];
	if (matches.length === 0) {
		return { text, missing: [] };
	}

	// Deduplicate read attempts for repeated references to the same path.
	const cache = new Map<string, Promise<string | null>>();
	const load = (rawPath: string): Promise<string | null> => {
		let entry = cache.get(rawPath);
		if (!entry) {
			const absolute = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
			entry = readFile(absolute, "utf8").catch(() => null);
			cache.set(rawPath, entry);
		}
		return entry;
	};

	const missing: string[] = [];
	const parts: string[] = [];
	let cursor = 0;

	for (const match of matches) {
		const [raw] = match;
		const path = match[1] ?? match[2];
		if (path === undefined) {
			continue;
		}
		const start = match.index ?? 0;
		parts.push(text.slice(cursor, start));

		const contents = await load(path);
		if (contents === null) {
			missing.push(path);
		} else {
			parts.push(renderFileBlock(path, contents));
		}
		cursor = start + raw.length;
	}
	parts.push(text.slice(cursor));

	if (missing.length > 0) {
		return { text: null, missing };
	}
	return { text: parts.join(""), missing: [] };
}

export default function (pi: ExtensionAPI) {
	pi.on("input", async (event, ctx) => {
		// Extension-injected messages have already been processed.
		if (event.source === "extension") {
			return { action: "continue" };
		}

		if (!event.text.includes(REFERENCE_PREFIX)) {
			return { action: "continue" };
		}

		const result = await injectFiles(event.text, ctx.cwd);

		if (result.missing.length > 0) {
			const list = result.missing.map((path) => `  - ${path}`).join("\n");
			ctx.ui.notify(
				`File injection failed, files not found:\n${list}\n\nPress the up arrow key to edit the message and try again.`,
				"error",
			);
			return { action: "handled" };
		}

		return { action: "transform", text: result.text ?? event.text };
	});
}

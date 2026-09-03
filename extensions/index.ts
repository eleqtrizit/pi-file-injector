/**
 * File and command injector extension.
 *
 * Injects content into the user prompt at send time:
 * - `#@path` or `#@"my file.txt"` is replaced by a `<file>` block containing
 *   the file contents.
 * - `` #`some command` `` is replaced by a `<command>` block containing the
 *   command and its output.
 *
 * The agent never sees the raw markers; the transformed text is what goes
 * into conversation history.
 *
 * Example:
 *   Input:  "Look over #@notes.md and run #`git status`"
 *   Sent:   "Look over <file path="notes.md">...</file> and run
 *            <command>\n<exec>git status</exec>\n<output>...\n</output>\n</command>"
 *
 * If a file does not exist or a command fails, the send is cancelled with an
 * error notification; the user can press arrow-up to edit the message and
 * retry.
 */
import { exec } from "node:child_process";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { suggest, type FileCache } from "./completions.js";

const execAsync = promisify(exec);

/** Marker that starts a file reference in the user's input. */
const REFERENCE_PREFIX = "#@";

/** Marker that starts a command reference in the user's input. */
const COMMAND_PREFIX = "#`";

/** Maximum time a command may run before it is killed. */
const COMMAND_TIMEOUT_MS = 30_000;

/** Maximum captured command output in bytes before the process is killed. */
const COMMAND_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Matches one injection token:
 * - `#@"path with spaces"` (group 1) or `#@path` (group 2): file reference
 * - `` #`command` `` (group 3): command reference (backticks not allowed
 *   inside the command; escape-free nesting is not supported)
 */
const TOKEN_PATTERN = /#@"([^"]+)"|#@(\S+)|#`([^`]+)`/g;

/** Wraps file contents in a `<file>` block for the LLM. */
function renderFileBlock(path: string, contents: string): string {
	return `<file path="${path}">\n${contents}\n</file>`;
}

/** Wraps a command and its output in a nested `<command>` block. */
function renderCommandBlock(command: string, output: string): string {
	const trimmed = output.length > 0 && !output.endsWith("\n") ? `${output}\n` : output;
	return `<command>\n<exec>${command}</exec>\n<output>\n${trimmed}</output>\n</command>`;
}

/** Resolves a file reference to its contents, or null when unreadable. */
function loadFile(rawPath: string, cwd: string): Promise<string | null> {
	const absolute = isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath);
	return readFile(absolute, "utf8").catch(() => null);
}

/**
 * Runs a command in `cwd` and returns its combined output.
 * Rejects with an error message when the command fails, times out, or
 * cannot be spawned.
 */
async function runCommand(command: string, cwd: string): Promise<string> {
	try {
		const { stdout, stderr } = await execAsync(command, {
			cwd,
			timeout: COMMAND_TIMEOUT_MS,
			maxBuffer: COMMAND_MAX_BUFFER,
		});
		return stderr.trim().length > 0 ? `${stdout}\n${stderr}` : stdout;
	} catch (error) {
		const err = error as { message?: string; killed?: boolean; stderr?: string };
		const reason = err.killed
			? `timed out after ${COMMAND_TIMEOUT_MS}ms`
			: (err.stderr?.trim() || err.message || "unknown error");
		throw new Error(`Command failed: ${command}\n${reason}`);
	}
}

/** Type returned by the token expansion step. */
interface ExpansionResult {
	text: string | null;
	errors: string[];
}

/**
 * Replaces every file and command reference in the input with injected
 * content.
 *
 * Returns `null` as `text` together with the list of errors when at least
 * one reference cannot be resolved, so callers can fail the whole prompt.
 */
export async function expandTokens(text: string, cwd: string): Promise<ExpansionResult> {
	const matches = [...text.matchAll(TOKEN_PATTERN)];
	if (matches.length === 0) {
		return { text, errors: [] };
	}

	// Resolve every token up front so unrelated tokens still get read even
	// when one fails, and all errors are reported at once.
	const resolved = await Promise.all(
		matches.map(async (match): Promise<{ ok: string } | { error: string }> => {
			const [raw, quotedPath, unquotedPath, command] = match;
			if (quotedPath !== undefined || unquotedPath !== undefined) {
				const path = quotedPath ?? unquotedPath;
				const contents = await loadFile(path, cwd);
				if (contents === null) {
					return { error: `File not found: ${path}` };
				}
				return { ok: renderFileBlock(path, contents) };
			}
			if (command !== undefined) {
				try {
					const output = await runCommand(command, cwd);
					return { ok: renderCommandBlock(command, output) };
				} catch (error) {
					return { error: error instanceof Error ? error.message : String(error) };
				}
			}
			return { error: `Unrecognized injection token: ${raw}` };
		}),
	);

	const errors: string[] = [];
	const parts: string[] = [];
	let cursor = 0;

	matches.forEach((match, index) => {
		const [raw] = match;
		const start = match.index ?? 0;
		parts.push(text.slice(cursor, start));

		const result = resolved[index];
		if (result && "error" in result) {
			errors.push(result.error);
		} else if (result) {
			// Keep the block on its own line, but avoid a double newline when
			// the marker already sits at the start of a line.
			const previousChar = parts.length > 0 ? parts.at(-1)?.at(-1) : undefined;
			if (result.ok.startsWith("<") && previousChar !== undefined && previousChar !== "\n") {
				parts.push("\n");
			}
			parts.push(result.ok);
		}
		cursor = start + raw.length;
	});
	parts.push(text.slice(cursor));

	if (errors.length > 0) {
		return { text: null, errors };
	}
	return { text: parts.join(""), errors: [] };
}

/** Backwards-compatible alias for the file-only injection entry point. */
export const injectFiles = expandTokens;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) {
			return;
		}

		// Lazily refreshed path cache shared across keystrokes.
		let fileCache: FileCache | undefined;

		ctx.ui.addAutocompleteProvider((current) => ({
			triggerCharacters: ["#"],
			async getSuggestions(lines, cursorLine, cursorCol, options) {
				const line = lines[cursorLine] ?? "";
				const before = line.slice(0, cursorCol);

				const result = await suggest(before, ctx.cwd, fileCache);
				fileCache = result.cache;
				if (options.signal.aborted || result.suggestions === null) {
					return current.getSuggestions(lines, cursorLine, cursorCol, options);
				}
				return result.suggestions;
			},

			applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			},

			shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
				return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
			},
		}));
	});

	pi.on("input", async (event, ctx) => {
		// Extension-injected messages have already been processed.
		if (event.source === "extension") {
			return { action: "continue" };
		}

		const text = event.text;
		if (!text.includes(REFERENCE_PREFIX) && !text.includes(COMMAND_PREFIX)) {
			return { action: "continue" };
		}

		const result = await expandTokens(text, ctx.cwd);

		if (result.errors.length > 0) {
			const list = result.errors.map((message) => `  - ${message}`).join("\n");
			ctx.ui.notify(
				`Injection failed:\n${list}\n\nPress the up arrow key to edit the message and try again.`,
				"error",
			);
			return { action: "handled" };
		}

		return { action: "transform", text: result.text ?? text };
	});
}

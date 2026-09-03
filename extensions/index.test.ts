import { exec } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandTokens } from "./index.js";

const execAsync = promisify(exec);

const IS_WINDOWS = process.platform === "win32";

describe("expandTokens", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "file-injector-"));
	});

	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it("passes text through unchanged when there is no reference", async () => {
		const result = await expandTokens("no references here", cwd);
		expect(result).toEqual({ text: "no references here", errors: [] });
	});

	it("injects file contents in place", async () => {
		await writeFile(join(cwd, "somefile"), "hello wrld how ar you doing");
		const result = await expandTokens(
			"Look over #@somefile and tell me if there are misspellings.",
			cwd,
		);
		expect(result.errors).toEqual([]);
		expect(result.text).toBe(
			'Look over \n<file path="somefile">\nhello wrld how ar you doing\n</file> and tell me if there are misspellings.',
		);
	});

	it("handles multiline prompts with the file block on its own lines", async () => {
		await writeFile(join(cwd, "a.txt"), "alpha");
		const result = await expandTokens("look over\n#@a.txt\nplease", cwd);
		expect(result.text).toBe('look over\n<file path="a.txt">\nalpha\n</file>\nplease');
	});

	it("resolves relative paths against cwd and absolute paths directly", async () => {
		await writeFile(join(cwd, "rel.txt"), "relative");
		const absFile = join(cwd, "abs.txt");
		await writeFile(absFile, "absolute");

		const rel = await expandTokens("#@rel.txt", cwd);
		expect(rel.text).toContain("relative");

		const abs = await expandTokens(`#@${absFile}`, cwd);
		expect(abs.text).toContain("absolute");
	});

	it("supports nested relative paths", async () => {
		await mkdir(join(cwd, "src", "utils"), { recursive: true });
		await writeFile(join(cwd, "src", "utils", "deep.ts"), "deep contents");
		const result = await expandTokens("#@src/utils/deep.ts", cwd);
		expect(result.text).toContain("deep contents");
	});

	it("reports all missing files and returns null text", async () => {
		const result = await expandTokens("#@nope.txt and #@also-missing.txt", cwd);
		expect(result.text).toBeNull();
		expect(result.errors).toHaveLength(2);
		expect(result.errors.join("\n")).toContain("nope.txt");
		expect(result.errors.join("\n")).toContain("also-missing.txt");
	});

	it("does not transform anything when at least one file is missing", async () => {
		await writeFile(join(cwd, "good.txt"), "good");
		const result = await expandTokens("#@good.txt #@missing.txt", cwd);
		expect(result.text).toBeNull();
		expect(result.errors).toHaveLength(1);
	});

	it("reuses one read for repeated references to the same path", async () => {
		await writeFile(join(cwd, "dup.txt"), "dup");
		const result = await expandTokens("#@dup.txt and #@dup.txt again", cwd);
		expect(result.errors).toEqual([]);
		const count = (result.text ?? "").split('<file path="dup.txt">').length - 1;
		expect(count).toBe(2);
	});

	it("injects empty files as empty blocks", async () => {
		await writeFile(join(cwd, "empty.txt"), "");
		const result = await expandTokens("#@empty.txt", cwd);
		expect(result.text).toBe('<file path="empty.txt">\n\n</file>');
	});

	it("truncates files beyond 2500 lines with a marker", async () => {
		await writeFile(join(cwd, "big.txt"), Array.from({ length: 3000 }, (_, index) => `line ${index}`).join("\n"));
		const result = await expandTokens("#@big.txt", cwd);
		expect(result.errors).toEqual([]);
		expect(result.text).toContain("line 0\n");
		expect(result.text).toContain("line 2499\n");
		expect(result.text).not.toContain("line 2500\n");
		expect(result.text).toContain("[...truncated: showing 2500 of 3000 lines...]");
	});

	it("keeps content at exactly 2500 lines untruncated", async () => {
		await writeFile(join(cwd, "edge.txt"), Array.from({ length: 2500 }, (_, index) => `l${index}`).join("\n"));
		const result = await expandTokens("#@edge.txt", cwd);
		expect(result.text).not.toContain("truncated");
	});

	it("truncates command output beyond 2500 lines", async () => {
		if (process.platform === "win32") {
			return;
		}
		const command = "seq 3000";
		const result = await expandTokens(`#\`${command}\``, cwd);
		expect(result.errors).toEqual([]);
		expect(result.text).toMatch(/<output>\n1\n[\s\S]*\n2500\n\[\.\.\.truncated: showing 2500 of 3000 lines\.\.\.\]\n<\/output>/);
	});

	it("supports quoted paths containing spaces", async () => {
		await writeFile(join(cwd, "my file.txt"), "spaced contents");
		const result = await expandTokens('#@"my file.txt" placeholder', cwd);
		expect(result.text).toContain("placeholder");
	});

	it("reports missing quoted paths", async () => {
		const result = await expandTokens('#@"no such file.txt"', cwd);
		expect(result.text).toBeNull();
		expect(result.errors.join("\n")).toContain("no such file.txt");
	});
});

describe("command injection", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "file-injector-cmd-"));
	});

	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it("injects command output in place", async () => {
		const command = "echo injected-output";
		const result = await expandTokens(`Branch info: #\`${command}\``, cwd);
		expect(result.errors).toEqual([]);
		expect(result.text).toBe(
			`Branch info: \n<command>\n<exec>${command}</exec>\n<output>\ninjected-output\n</output>\n</command>`,
		);
	});

	it("runs the command in the extension cwd", async () => {
		const { stdout } = await execAsync("pwd", { cwd });
		const result = await expandTokens("#`pwd`", cwd);
		expect(result.errors).toEqual([]);
		expect(result.text).toContain(stdout.trim());
	});

	it("includes stderr in the output block", async () => {
		const command = IS_WINDOWS
			? 'node -e "process.stderr.write(\'from stderr\')"'
			: "echo from stderr >&2";
		if (IS_WINDOWS) {
			return; // shell quoting differs; skip on Windows
		}
		const result = await expandTokens(`#\`${command}\``, cwd);
		expect(result.errors).toEqual([]);
		expect(result.text).toContain("from stderr");
	});

	it("trailing output without newline stays inside the block", async () => {
		const command = IS_WINDOWS ? "echo hi" : "printf hi";
		if (IS_WINDOWS) {
			return;
		}
		const result = await expandTokens(`#\`${command}\``, cwd);
		expect(result.errors).toEqual([]);
		expect(result.text).toBe(`<command>\n<exec>${command}</exec>\n<output>\nhi\n</output>\n</command>`);
	});

	it("fails the whole prompt for a failing command", async () => {
		const command = IS_WINDOWS ? "exit /b 3" : "exit 3";
		if (IS_WINDOWS) {
			return;
		}
		const result = await expandTokens(`#\`${command}\``, cwd);
		expect(result.text).toBeNull();
		expect(result.errors.join("\n")).toContain("Command failed");
		expect(result.errors.join("\n")).toContain(command);
	});

	it("reports both a missing file and a failing command", async () => {
		const command = IS_WINDOWS ? "exit /b 1" : "exit 1";
		if (IS_WINDOWS) {
			return;
		}
		const result = await expandTokens(`#@ghost.txt and #\`${command}\``, cwd);
		expect(result.text).toBeNull();
		expect(result.errors).toHaveLength(2);
		expect(result.errors.join("\n")).toContain("ghost.txt");
	});

	it("injects files and commands together in order", async () => {
		await writeFile(join(cwd, "notes.md"), "notes body");
		const result = await expandTokens(
			'Review #@notes.md next to #`echo combined`',
			cwd,
		);
		expect(result.errors).toEqual([]);
		expect(result.text).toContain('<file path="notes.md">\nnotes body\n</file>');
		expect(result.text).toContain("<exec>echo combined</exec>");
		const text = result.text ?? "";
		expect(text.indexOf("<file")).toBeLessThan(text.indexOf("<command"));
	});
});

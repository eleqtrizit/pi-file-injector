import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { injectFiles } from "./index.js";

describe("injectFiles", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "file-injector-"));
	});

	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it("passes text through unchanged when there is no reference", async () => {
		const result = await injectFiles("no references here", cwd);
		expect(result).toEqual({ text: "no references here", missing: [] });
	});

	it("injects file contents in place", async () => {
		await writeFile(join(cwd, "somefile"), "hello wrld how ar you doing");
		const result = await injectFiles(
			"Look over #@somefile and tell me if there are misspellings.",
			cwd,
		);
		expect(result.missing).toEqual([]);
		expect(result.text).toBe(
			'Look over <file path="somefile">\nhello wrld how ar you doing\n</file> and tell me if there are misspellings.',
		);
	});

	it("handles multiline prompts with the file block on its own lines", async () => {
		await writeFile(join(cwd, "a.txt"), "alpha");
		const result = await injectFiles("look over\n#@a.txt\nplease", cwd);
		expect(result.text).toBe('look over\n<file path="a.txt">\nalpha\n</file>\nplease');
	});

	it("resolves relative paths against cwd and absolute paths directly", async () => {
		await writeFile(join(cwd, "rel.txt"), "relative");
		const absFile = join(cwd, "abs.txt");
		await writeFile(absFile, "absolute");

		const rel = await injectFiles("#@rel.txt", cwd);
		expect(rel.text).toContain("relative");

		const abs = await injectFiles(`#@${absFile}`, cwd);
		expect(abs.text).toContain("absolute");
	});

	it("supports nested relative paths", async () => {
		await mkdir(join(cwd, "src", "utils"), { recursive: true });
		await writeFile(join(cwd, "src", "utils", "deep.ts"), "deep contents");
		const result = await injectFiles("#@src/utils/deep.ts", cwd);
		expect(result.text).toContain("deep contents");
	});

	it("reports all missing files and returns null text", async () => {
		const result = await injectFiles("#@nope.txt and #@also-missing.txt", cwd);
		expect(result.text).toBeNull();
		expect(result.missing).toEqual(["nope.txt", "also-missing.txt"]);
	});

	it("does not transform anything when at least one file is missing", async () => {
		await writeFile(join(cwd, "good.txt"), "good");
		const result = await injectFiles("#@good.txt #@missing.txt", cwd);
		expect(result.text).toBeNull();
		expect(result.missing).toEqual(["missing.txt"]);
	});

	it("reuses one read for repeated references to the same path", async () => {
		await writeFile(join(cwd, "dup.txt"), "dup");
		const result = await injectFiles("#@dup.txt and #@dup.txt again", cwd);
		expect(result.missing).toEqual([]);
		const count = (result.text ?? "").split('<file path="dup.txt">').length - 1;
		expect(count).toBe(2);
	});

	it("injects empty files as empty blocks", async () => {
		await writeFile(join(cwd, "empty.txt"), "");
		const result = await injectFiles("#@empty.txt", cwd);
		expect(result.text).toBe('<file path="empty.txt">\n\n</file>');
	});
});

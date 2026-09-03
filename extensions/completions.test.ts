import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	buildSuggestions,
	collectFiles,
	matchReference,
	renderToken,
	suggest,
} from "./completions.js";

describe("matchReference", () => {
	it("returns null when no reference is being typed", () => {
		expect(matchReference("plain text")).toBeNull();
		expect(matchReference("a @file")).toBeNull();
		expect(matchReference("#tag")).toBeNull();
		expect(matchReference("")).toBeNull();
	});

	it("matches an unquoted reference at the cursor", () => {
		expect(matchReference("look at #@src/ut")).toEqual({
			prefix: "#@src/ut",
			partial: "src/ut",
			quoted: false,
		});
	});

	it("matches a bare #@ marker", () => {
		expect(matchReference("#@")).toEqual({ prefix: "#@", partial: "", quoted: false });
	});

	it("matches a quoted reference and keeps spaces in the partial", () => {
		expect(matchReference('#@"my no')).toEqual({
			prefix: '#@"my no',
			partial: "my no",
			quoted: true,
		});
	});
});

describe("collectFiles", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "completions-"));
	});

	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it("collects files and directories while excluding noise directories", async () => {
		await mkdir(join(cwd, "src", "deep"), { recursive: true });
		await mkdir(join(cwd, "node_modules", "pkg"), { recursive: true });
		await writeFile(join(cwd, "README.md"), "x");
		await writeFile(join(cwd, "src", "a.ts"), "a");
		await writeFile(join(cwd, "src", "deep", "b.ts"), "b");
		await writeFile(join(cwd, "node_modules", "pkg", "junk.js"), "j");

		const paths = await collectFiles(cwd);
		expect(paths).toContain("README.md");
		expect(paths).toContain("src/");
		expect(paths).toContain(join("src", "a.ts"));
		expect(paths).toContain(join("src", "deep") + "/");
		expect(paths).toContain(join("src", "deep", "b.ts"));
		expect(paths.some((path) => path.startsWith("node_modules"))).toBe(false);
	});

	it("tolerates an unreadable directory", async () => {
		const paths = await collectFiles(join(cwd, "does-not-exist"));
		expect(paths).toEqual([]);
	});
});

describe("renderToken", () => {
	it("renders plain file tokens", () => {
		expect(renderToken("src/a.ts")).toBe("#@src/a.ts");
	});

	it("renders directories with a trailing slash", () => {
		expect(renderToken("src/")).toBe("#@src/");
	});

	it("quotes paths with spaces", () => {
		expect(renderToken("my file.txt")).toBe('#@"my file.txt"');
		expect(renderToken("my dir/")).toBe('#@"my dir"/');
	});
});

describe("buildSuggestions", () => {
	const paths = ["README.md", "src/", "src/index.ts", "src/fmt.ts", "my file.txt"];

	it("fuzzy-filters by the typed partial", () => {
		const items = buildSuggestions(paths, { prefix: "#@inde", partial: "inde", quoted: false });
		expect(items.map((item) => item.value)).toContain("#@src/index.ts");
	});

	it("preserves already-typed directory prefix in the query", () => {
		const items = buildSuggestions(paths, { prefix: "#@src/i", partial: "src/i", quoted: false });
		expect(items.map((item) => item.value)).toEqual(["#@src/index.ts"]);
	});

	it("caps the number of suggestions", () => {
		const many = Array.from({ length: 50 }, (_, index) => `file${index}.txt`);
		const items = buildSuggestions(many, { prefix: "#@", partial: "", quoted: false });
		expect(items.length).toBeLessThanOrEqual(20);
	});
});

describe("suggest", () => {
	let cwd: string;

	beforeEach(async () => {
		cwd = await mkdtemp(join(tmpdir(), "suggest-"));
	});

	afterEach(async () => {
		await rm(cwd, { recursive: true, force: true });
	});

	it("returns null and leaves the cache alone when not on a reference", async () => {
		const result = await suggest("hello", cwd, undefined);
		expect(result.suggestions).toBeNull();
	});

	it("suggests files for a bare reference and reuses a fresh cache", async () => {
		await writeFile(join(cwd, "notes.md"), "x");
		const first = await suggest("#@", cwd, undefined);
		expect(first.suggestions?.items.map((item) => item.value)).toContain("#@notes.md");
		expect(first.suggestions?.prefix).toBe("#@");

		const second = await suggest("#@not", cwd, first.cache);
		expect(second.suggestions?.items.map((item) => item.value)).toEqual(["#@notes.md"]);
		expect(second.suggestions?.prefix).toBe("#@not");
	});

	it("returns null when nothing matches", async () => {
		const result = await suggest("#@zzz", cwd, undefined);
		expect(result.suggestions).toBeNull();
	});
});

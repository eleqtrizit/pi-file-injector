# pi Extension Template

A starter repository for building extensions for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent). It ships a working extension (`extensions/index.ts`) with a custom tool, an event handler, and a slash command, plus the TypeScript and test setup already wired up.

## Getting Started

Point your pi agent at this repo and ask:

> How do I get started?

The agent reads `AGENTS.md` in this repo and will walk you through the setup: copying the template to a new directory, installing dependencies, and running the example extension.

## What's Included

```
extensions/index.ts   Example extension: hello_world and echo tools, tool_call gate, /template command
src/                  Source modules the extension imports
tests/                Vitest tests (mirrors src/)
package.json          pi-package metadata (main, pi.extensions)
tsconfig.json         Strict TypeScript (ESNext, NodeNext); typecheck only, no build step
```

## Manual Steps (for reference)

1. Copy the template to a new directory (Linux/macOS, skipping `.git` and `node_modules`):

   ```bash
   rsync -vrt --delete --delete-excluded --exclude node_modules --exclude .git ./ /path/to/new-repo/
   ```

2. `npm install` (or initialize from scratch: `npm init -y`, then `npm install --save-dev typescript vitest @types/node @earendil-works/pi-coding-agent && npm install typebox`).
3. Keep `tsconfig.json` as-is (ESNext, NodeNext, strict). No build step needed; pi loads TypeScript via jiti. Use `npx tsc --noEmit` for typechecking.
4. Check `package.json`: `main` and `pi.extensions` point at the entry point (`extensions/index.ts`), `keywords: ["pi-package"]`, `typebox` in `dependencies`, `@earendil-works/pi-coding-agent` as a peer.
5. Edit `extensions/index.ts` (or replace it). The default export is a factory receiving `ExtensionAPI`.
6. Test:

   ```bash
   npm run typecheck
   pi -e ./extensions/index.ts     # quick manual test
   npm test                        # vitest
   ```

   For auto-discovery and `/reload`, place extensions in `~/.pi/agent/extensions/` or project `.pi/extensions/`.
7. Publish: update the version, then `npm publish`. Users install with `pi install npm:<name>`. Runtime deps must go in `dependencies` (pi installs with `--omit=dev`).

Package names: `@earendil-works/pi-coding-agent` and `typebox` are current; `@mariozechner/pi-coding-agent` and `@sinclair/typebox` are obsolete.

## Key APIs

```ts
pi.registerTool()      // custom tools the LLM can call
pi.on(event, handler)  // session_start, session_shutdown, before_agent_start,
                       // tool_call, tool_result, turn_start/turn_end, ...
pi.registerCommand("name", {...})
```

Every handler receives an `ExtensionContext` with `ctx.ui` (notify, setStatus, setWidget, select, confirm, input, editor), `ctx.sessionManager`, `ctx.cwd`, `ctx.mode`, and more.

## Documentation

After `npm install`, docs and examples ship inside the pi package:

- Docs: `node_modules/@earendil-works/pi-coding-agent/docs/` (start with `extensions.md` and `writing-an-extension.md`)
- Examples: `node_modules/@earendil-works/pi-coding-agent/examples/extensions/`

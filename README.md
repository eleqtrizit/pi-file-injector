# pi-file-injector

A [pi coding agent](https://github.com/earendil-works/pi-coding-agent) extension that injects full file contents and command output directly into your prompt before it is sent to the LLM.

Normally, mentioning a file just tells the agent to go read it with a tool call. With this extension, the actual content is placed inside the prompt itself. The agent never sees a file path or the marker syntax. The transformed prompt is what enters conversation history.

## Install

```bash
pi install https://github.com/eleqtrizit/pi-file-injector
```

Restart pi (or run `/reload`) after installing.

## Usage

### File injection: `#@path`

```text
Look over #@somefile and tell me if there are misspellings.
```

If `somefile` contains `hello wrld how ar you doing`, the LLM receives:

```text
Look over
<file path="somefile">
hello wrld how ar you doing
</file>
and tell me if there are misspellings.
```

Paths resolve relative to the directory where pi is running. Absolute paths also work. For paths containing spaces, use the quoted form:

```text
Summarize #@"my notes file.txt" in three bullets.
```

### Command injection: `` #`command` ``

```text
Here is the diff of #@somefile against HEAD. Is #`git rev-parse --abbrev-ref HEAD` the right branch for it?
```

The command runs in the directory where pi is running, and the LLM receives:

```text
... against HEAD. Is
<command>
<exec>git rev-parse --abbrev-ref HEAD</exec>
<output>
main
</output>
</command>
the right branch for it?
```

Both markers can be mixed freely in one message.

## Errors

If a referenced file does not exist, or a command fails, the message is not sent. A notification lists every problem at once:

```text
Injection failed:
  - File not found: somefile

Press the up arrow key to edit the message and try again.
```

Press the up arrow key to edit the message and retry. Nothing broken is injected into history.

## Autocomplete

Type `#@` and completion suggestions appear, the same way `@` completes paths. Suggestions are fuzzy-filtered file and directory paths from the directory where pi is running (`node_modules`, `.git`, and `.pi` are excluded). Accepting a directory suggestion appends `/` so you can keep completing the next segment. For paths with spaces, use the quoted form `#@"` and the inserted token is quoted automatically.

## Limits

- Injected file contents and command output are capped at 2500 lines each. The head is kept, and a marker line (`[...truncated: showing 2500 of N lines...]`) tells the model what was cut. Content at 2500 lines or fewer is passed through untouched.
- Commands have a 30 second timeout. A timeout stops the process and fails the message. As a byte-level backstop, a command producing more than 10MB of output is killed (rare: one giant line); this also fails the message.
- A command cannot contain a literal backtick. Nesting and escaping are not supported.
- Commands run with your default shell. Only reference commands you trust.

## Behavior details

- Transformed text replaces your raw input in conversation history: the model never sees `#@` or `` #` `` markers. The command text itself is visible inside the `<exec>` element of the `<command>` block.
- Files are read once per mention, even when the same file appears several times.
- Surrounding whitespace and line structure are preserved; the `<file>` or `<command>` block takes the marker's exact place in the text and always starts on its own line (no double blank line when the marker is already at the start of one).
- Messages injected by other extensions are not re-processed.

## Development

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest
pi -e ./extensions/index.ts   # run pi with the extension loaded directly
```

## License

MIT

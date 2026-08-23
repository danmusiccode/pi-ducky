# pi-ducky

Hands-on edit approval for [Pi](https://pi.dev): Ducky pauses every `edit` and `write` tool call, shows a small digest of the proposed changes, and asks you to reply `yes` or `no` with optional notes.

The design goal is **you stay at the wheel**. The agent does the typing, but you approve each digestible change set before it lands.

## Features

- 🦆 **Approval before edits** — intercepts Pi's built-in `edit` and `write` tools.
- 🧾 **Small change digest** — shows file path, replacement count, line counts, and a compact old/new preview.
- 💬 **Yes/no with context** — type `yes`, `no`, or add instructions after either response.
- 🔁 **Feedback loop** — rejected edits are returned to the agent with your feedback so it can try again.
- 🧭 **Active-driver prompt** — nudges the model to make smaller, reviewable edit calls.
- ⚙️ **Toggle command** — `/ducky on`, `/ducky off`, `/ducky status`.
- 💾 **Session persistence** — enabled/disabled state survives reload/resume through Pi session entries.
- 🦆 **Rubber-ducky questions** — adds `ducky_ask_user`, a tool the agent uses when requirements or design decisions are unclear.

## Installation

### Try locally

From this repo's parent directory:

```bash
pi -e ./pi-ducky/src/index.ts
```

Or install as a local Pi package:

```bash
pi install ./pi-ducky
```

### Project-local install

From a project where you want Ducky enabled:

```bash
pi install -l /absolute/path/to/pi-ducky
```

Pi will add the package to `.pi/settings.json` for that project.

## Usage

Ducky is enabled by default. When the agent attempts an edit, you will see a prompt like:

```text
🦆 Ducky wants approval for edit

Edit file: src/app.ts
Replacement count: 1

Change 1: replace 3 line(s) with 5 line(s)
- old (...)
+ new (...)

Reply with:
  yes [optional note]  — approve this exact change
  no  [feedback]       — reject and tell the agent what to change
```

Example replies:

```text
yes
```

```text
no make this a smaller focused change first
```

```text
yes but after this also update the tests
```

If you approve with a note, Ducky lets the edit run and sends the note back as steering for the next step. If you reject, Ducky blocks the tool call and includes your feedback in the tool result so the agent can revise.

## Rubber-ducky questions

Ducky also registers a tool named `ducky_ask_user`. The system prompt tells the agent to use it when it catches itself making a meaningful assumption, for example:

- choosing CDN vs npm dependency
- selecting an architecture or migration strategy
- changing user-facing behavior
- deciding whether compatibility matters
- interpreting vague requirements

The question opens in an editor with context and optional choices. Fill in the `ANSWER:` line and the agent receives your guidance before continuing.

## Commands

```text
/ducky status   Show current state
/ducky on       Enable approval prompts
/ducky off      Disable approval prompts for this session
```

Keyboard shortcut:

```text
F6    Toggle Ducky approval mode on/off
```

## Package shape

This follows common Pi package conventions:

```json
{
  "keywords": ["pi-package", "pi-extension"],
  "pi": {
    "extensions": ["./src/index.ts"]
  },
  "peerDependencies": {
    "@earendil-works/pi-coding-agent": "*"
  }
}
```

Runtime code lives in `src/index.ts` and exports the standard Pi extension factory:

```ts
export default function ducky(pi: ExtensionAPI): void {
  // register commands and event hooks
}
```

## License

This project is source-available under the terms in [LICENSE](LICENSE). You may install and use it, but you may not distribute, sublicense, or sell it without prior written permission.

## Notes

- In non-interactive modes with no UI, Ducky blocks `edit`/`write` calls by default because it cannot ask for approval.
- Ducky does not intercept read-only tools.
- Ducky intentionally favors smaller edits. Large edits are shown in a scrollable approval editor so you can review the full change.

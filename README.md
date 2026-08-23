# pi-ducky

Hands-on collaborative AI workflow with approvals for the [Pi](https://pi.dev) coding harness.

Ducky pauses every `edit` and `write` tool call, explains the proposed changes, shows the diff with inline editing, and you can either approve it or ask for changes.

Continuous planning: When Ducky is trying to make an important design decision or needs clarification, it pauses and presents you with options to discuss.

The design goal is an AI coding workflow that is iterative and human-led. The agent does the typing for you but relies on you for the design.

## Installation

### Try locally

From this repo's parent directory:

```bash
pi install ./pi-ducky
```

Or run as a one-time trial:

```bash
pi -e ./pi-ducky/src/index.ts
```

### Project-local install

From a project where you want Ducky enabled:

```bash
pi install -l /absolute/path/to/pi-ducky
```

Pi will add the package to `.pi/settings.json` for that project.

## Other Recommended Pi Plugins to use with Ducky

* pi-usage
* pi-markdown-preview
* pi-mcp-adapter
* pi-simplify
* pi-web-access

## Recommended Model

gpt-5.5

## Usage

Ducky is enabled by default. When the agent attempts an edit, you will see a prompt like:

```
🦆 Adds a README section explaining the value of manual approvals before the existing Features section.                   

─── ↑ 24 more ─────────────────────────────────────────────────────────────────────────────────────────────────────────────
+ - Here's a change in the diff                                            
+ - Another proposed change                                                                                                              
──────────────── Yay or nay? Press enter or ask for changes ────────────────────                                           
Your feedback: [Your Response Goes Here]
```

If you approve with a note, Ducky lets the edit run and sends the note back as steering for the next step. If you reject, Ducky blocks the tool call and includes your feedback in the tool result so the agent can revise.

## Rubber-ducky questions

Ducky registers a tool named `ducky_ask_user`. The system prompt tells the agent to use it when it catches itself making a meaningful assumption, for example:

- choosing CDN vs npm dependency
- selecting an architecture or migration strategy
- changing user-facing behavior
- deciding whether compatibility matters
- interpreting vague requirements

The question opens in an editor with context and optional choices. Fill in the `ANSWER:` line and the agent takes your guidance into account before continuing.

## Commands

```text
/ducky status   Show current state
/ducky on       Enable approval prompts
/ducky off      Disable approval prompts for this session
```

Keyboard shortcuts:

```text
F6    Toggle Ducky approval mode on/off
```

## License

This project is source-available under the terms in [LICENSE](LICENSE). You may install and use it, but you may not distribute, sublicense, or sell it without prior written permission.

## Notes

- In non-interactive modes with no UI, Ducky blocks `edit`/`write` calls by default because it cannot ask for approval.
- Ducky does not intercept read-only tools.
- Ducky intentionally favors smaller edits. Large edits are shown in a scrollable approval editor so you can review the full change.

# pi-ducky

Hands-on collaborative AI workflow with approvals for the [Pi](https://pi.dev) coding harness.

Ducky collaborates with you on architectural design, then explains each proposed code change, incorporating your feedback at each step.

Press enter to approve, `e` to manually edit the proposed change yourself, or `r` to request changes. In safe mode, Ducky also asks before running commands except for read-only shell commands such as directory navigation and searches.

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
* pi-web-search
* pi-codex-goal

## Recommended Model

gpt-5.5

## Usage

Ducky starts in the last mode you selected. The first run defaults to edit approvals. When the agent attempts an edit, use the compact review controls:

```text
enter approve • e edit yourself • r request changes
```

If you request changes, Ducky blocks the tool call and includes your feedback in the tool result so the agent can revise.

Edit mode allows you to make manual changes to the proposed code in a text editor view without using more tokens.

## Settings

Ducky stores the last selected approval mode in `~/.pi/agent/settings.json` and starts in that mode the next time you open Pi.

Safe mode automatically allows simple read-only commands like `pwd`, `cd`, `ls`, `find`, `fd`, `rg`, `grep`, `sort`, `sed`, `cut`, `uniq`, read-only `git` inspection commands, and file viewing commands such as `cat`, `head`, `tail`, `wc`, `stat`, `file`, `du`, and `df`. Chained and piped commands are only auto-approved when each `&&`- or `|`-separated command is safe; commands with shell control operators, redirection, `find -delete`/`find -exec`, or in-place edit flags like `sed -i` still ask for approval.

Add your own command prefixes in `~/.pi/agent/settings.json`:

```json
{
  "ducky": {
    "safeCommands": [
      "npm test",
      "pnpm typecheck"
    ]
  }
}
```

A configured entry matches the exact command or the same command with additional arguments, so `"npm test"` also allows `npm test -- --watch=false`.

## Rubber Ducky questions

Ducky registers a tool named `ducky_ask_user`. The system prompt tells the agent to use it when it catches itself making a meaningful assumption, for example:

- choosing CDN vs npm dependency
- selecting an architecture or migration strategy
- changing user-facing behavior
- deciding whether compatibility matters
- interpreting vague requirements

The question opens in an editor with context and optional choices. Fill in the `ANSWER:` line and the agent takes your guidance into account before continuing.

## Commands

```text
/ducky status   Show current mode
/ducky on       Review edits and writes
/ducky safe     Review edits, writes, and commands
/ducky off      Disable approval prompts for this session
```

Keyboard shortcuts:

```text
F6    Cycle Ducky approval modes: off → edits → safe
```

## License

This project is source-available under the terms in [LICENSE](LICENSE). You may install and use it, but you may not distribute, sublicense, or sell it without prior written permission.

## Notes

- In non-interactive modes with no UI, Ducky blocks `edit`/`write` calls by default because it cannot ask for approval. Commands are also blocked when safe mode is active unless they match a safe command.
- Ducky does not intercept common read-only tools or those included in your safe list in pi config.
- Ducky intentionally favors small, incremental edit.

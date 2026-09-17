# Devin

T3 Code runs [Devin](https://devin.ai) through its ACP interface (`devin acp`).
Devin manages its own models and credentials — T3 Code uses whatever account
the Devin CLI is signed in with.

Devin support is experimental and off by default.

## Set up Devin

Install Devin on the machine that runs the T3 Code server — see
[Devin's CLI docs](https://docs.devin.ai/cli). Then sign in from a terminal on
that machine:

```bash
devin auth login
```

On a headless server without a browser, use the manual token flow:

```bash
devin auth login --force-manual-token-flow
```

Sign-in is interactive; it cannot run inside T3 Code, and T3 Code never
launches Devin's browser sign-in flow itself. Until it completes, the Devin
provider card shows that login is required.

In **Settings → Providers**, enable Devin. If the `devin` binary is not on the
server's `PATH`, set **Binary path** to its location (for example
`~/.local/bin/devin`).

## Models

The model picker's **Devin configured model** entry keeps whatever model Devin
is configured with. Entries below it are the models Devin advertises for the
signed-in account: Cognition's `swe-*`, `fusion-*`, and related models group
under **Devin**, while `claude-*`, `gpt-*`, and other vendor models group under
their provider. Choosing one switches the model inside the running session.

Reasoning effort is embedded in Devin's model ids (`-low`, `-high`, `-max`),
so there is no separate effort picker.

## Permission modes

T3 Code's interaction modes map to Devin's session modes:

| T3 Code mode                  | Devin mode            |
| ----------------------------- | --------------------- |
| Supervised, Auto-accept edits | `accept-edits` (Code) |
| Auto                          | `smart`               |
| Full access                   | `bypass`              |

The composer's Plan toggle switches the session into Devin's `plan` mode for
that turn, and Build switches it back. Tool approval prompts offer only the
choices Devin actually supports for that action, and "allow for this session"
is remembered per operation.

## Notes

- Threads cannot be rolled back inside Devin — start a new thread instead.
- The composer shows whatever slash commands Devin advertises — `/plan`,
  `/compact`, and the rest — plus T3 Code's own built-ins. `/compact` is the
  compact-conversation command.
- The mobile app drives Devin through the connected server; Devin never runs
  on the phone itself.

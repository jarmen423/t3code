# Hermes

T3 Code runs [Hermes Agent](https://hermes-agent.nousresearch.com) through its ACP
interface. Hermes manages its own model providers and credentials — T3 Code uses
whatever model and account Hermes is configured with.

Hermes support is experimental and off by default.

## Set up Hermes

Install Hermes on the machine that runs the T3 Code server. On Linux or macOS:

```bash
curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash
```

On Windows, run this in PowerShell:

```powershell
iex (irm https://hermes-agent.nousresearch.com/install.ps1)
```

Then configure a model provider in a terminal on that machine:

```bash
hermes setup
```

`hermes setup` is an interactive terminal flow; it cannot run inside T3 Code.
Until it completes, the Hermes provider card shows that setup is required. When
Hermes already has working credentials, T3 Code signs in with them automatically
— there is no separate sign-in button.

In **Settings → Providers**, enable Hermes. If the `hermes` binary is not on the
server's `PATH`, set **Binary path** to its location (for example
`~/.local/bin/hermes`).

## Models

The model picker's **Hermes configured model** entry keeps whatever model
`hermes setup` selected. Entries below it are the models Hermes advertises for
the configured providers, named like `openrouter:...` or `xai-oauth:...`.
Choosing one asks Hermes to switch models inside the running session.

## Permission modes

T3 Code's interaction modes map to Hermes' approval modes:

| T3 Code mode      | Hermes mode    |
| ----------------- | -------------- |
| Supervised, Auto  | `default`      |
| Auto-accept edits | `accept_edits` |
| Full access       | `dont_ask`     |

Tool approval prompts offer only the choices Hermes actually supports for that
action, and "allow for this session" is remembered per operation.

## Notes

- Threads cannot be rolled back inside Hermes — start a new thread instead.
- `/compress` is available as the compact-conversation command.
- The mobile app drives Hermes through the connected server; Hermes never runs
  on the phone itself.

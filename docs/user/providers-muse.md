# Muse Code

T3 Code runs [Muse Code](https://meta-models.github.io/muse-code-sdk/) through
`muse-acp-bridge`, a small adapter that speaks ACP over stdio. Muse manages its
own credentials — T3 Code uses whatever account `muse login` signed in on the
server machine.

Muse support is experimental and off by default.

## Set up Muse Code

Install Muse Code and `muse-acp-bridge` on the machine that runs the T3 Code
server, then sign in from a terminal on that machine:

```bash
muse login
```

`muse login` is an interactive terminal flow; it cannot run inside T3 Code.
Until it completes, the Muse Code provider card shows that setup is required.
Once the host is signed in, T3 Code picks that up automatically — there is no
separate sign-in button.

In **Settings → Providers**, enable Muse Code. If the `muse-acp-bridge` binary
is not on the server's `PATH`, set **Binary path** to its location (for example
`~/.local/bin/muse-acp-bridge`).

## Models

The model picker's **Muse configured model** entry keeps whatever model Muse
Code is configured with. Entries below it are the models the bridge advertises,
such as `muse-spark-1.3`. Models also share a **Reasoning** picker with levels
from `none` up to `ultra`; changing it applies immediately to the running
session.

## Permission modes

T3 Code's interaction modes map to Muse's session modes:

| T3 Code mode      | Muse mode |
| ----------------- | --------- |
| Supervised, Plan  | `ask`     |
| Auto              | `ask`     |
| Auto-accept edits | `ask`     |
| Full access       | `auto`    |

T3 Code never selects Muse's `yolo` mode: it also suppresses Muse's structured
questions, which permission modes are not meant to prevent. Auto-accept edits
therefore runs the session in `ask` and answers only file-change approvals
(edits, deletions, and moves) by itself — commands, reads, and anything Muse
labels otherwise still ask, and structured questions are always surfaced. Full
access runs in `auto`, which allows tools to proceed while questions stay
available.

If the bridge advertises no mode that can enforce the requested level (for
example only `auto` and `yolo` while Supervised is requested), starting or
continuing a turn fails instead of running with a more permissive mode than
asked for.

Tool approval prompts offer only the choices Muse actually supports for that
action, and "allow for this session" is remembered per operation.

## Structured questions

Muse can ask structured questions — scope pickers and short forms — while it
works. They appear as T3 Code's question cards, with a free-text answer always
allowed alongside the offered choices. Dismissing a card cancels the question
on the Muse side rather than guessing an answer.

## Notes

- Threads cannot be rolled back inside Muse — start a new thread instead.
- The composer shows whatever slash commands Muse advertises — `/compact`,
  `/models`, `/effort`, `/status`, and the rest — plus T3 Code's own built-ins.
  `/compact` is the compact-conversation command.
- The mobile app drives Muse through the connected server; Muse never runs on
  the phone itself.

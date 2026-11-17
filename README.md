# ruminate

The session thinks in the background and answers as itself: no subagent report to relay, no context growth.

Unlike a fork agent:

- **No relay.** The ruminator's answer *is* the session's next turn. There is no tool result for the main session to read, keep in context and rephrase.
- **You talk to it.** What you type while it works goes to the ruminator, as if to the session.
- **You start it.** Prefix a prompt with `~`: your words reach it as you wrote them, not as the main session's retelling in a delegation prompt.
- **Catch-up is literal.** With `~~~` the ruminator gets the conversation since, as it happened, not a summary the main session chose to write.
- **It is a session of its own**, which you can open and carry on yourself.

A fork agent is still the better fit for parallel work: it runs while you keep talking, while a ruminator holds the session until it answers.

Claude can also call the `ruminate` tool itself, e.g. to read and think in a free turn and keep only the conclusion. The main session waits while the ruminator works; Esc cancels it.

Nothing is lost: each answer starts with `ruminated at <id>`, the ruminator's own session, with everything it read and tried. You can open it (`claude --resume`, the id begins its transcript's name), and Claude knows it is there: it can ask it again with `~~` instead of redoing the work.

## Install

```
/plugin install ruminate --marketplace rafa-capilla/claude-code-ruminate
```

Needs the `claude` CLI and `python3` (for `merge`).

## Use

| Prompt | Tool mode | What it does |
| --- | --- | --- |
| `~ text` | `new` | Fork the whole session and answer `text` there. |
| `~~ text` | `again` | Resume the last ruminator on its own thread. |
| `~~~ text` | `merge` | Same, after pasting in what happened here since. |

## Options

- `disableInRuminator`: plugins the ruminator starts with switched off, comma-separated (`name@marketplace`). Use it for plugins that would act on their own there, like a messaging listener.

## Examples

| | Prompt | What happens |
| --- | --- | --- |
| User | `~ read the three papers in ./refs, which drag model fits our falling ball?` | A ruminator forks the whole session and reads all three. |
| Claude | `ruminated at 5d38d8d3` The first one: linear drag, valid for small, slow objects. | Only the answer lands here: the papers never enter this context. |
| User | `~~ does the second one contradict it?` | The same ruminator picks up where it left off, papers already read. |
| Claude | `ruminated at 5d38d8d3` No, it covers larger, faster ones, where drag goes with v². | Nothing was read twice. |
| User | `by the way, it's a tennis ball dropped from a balcony` | Plain conversation in the main session. The ruminator sees none of it. |
| Claude | Then it will pick up some speed. | New relevant context, and the ruminator doesn't have it yet. |
| User | `~~~ does your conclusion still hold?` | The same ruminator, with that conversation pasted into its thread first. |
| Claude | `ruminated at 5d38d8d3` No: a tennis ball at that speed is well into quadratic drag, so the second one fits. | It answers knowing what was said here. |

## When to use which

- **`~`** for anything where you only need the conclusion: reading papers, a long log, a codebase survey. It starts from your session as it is, so its whole history is read from the prompt cache.
- **`~~`** to follow up on what the ruminator already read. Its own thread is cached too, so nothing is read or paid twice.
- **`~~~`** only when the ruminator must know something said here since. What is pasted in comes after its own work, so it is written to the cache as new: worth it when the ruminator read a lot and the conversation since is short; otherwise start a fresh `~`.

Not for work where you need the detail in front of you, like editing code together: there, the reading belongs in the main session.

## License

Apache-2.0

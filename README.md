# pi-tps-meter

Tokens per second meter for [pi CLI](https://pi.dev) with sparkline visualization.

## Install

```bash
pi install npm:pi-tps-meter
```

## Features

**During streaming** — a smooth, animated gauge that fills with live speed
(1/8-cell resolution, auto-scaled to your session's peak):
```
⠹ ▕███████▋···▏ 47 tps
```

**After a message** — a min-max normalized sparkline of your last 12 messages
(newest on the right) plus aggregate stats:
```
▁▄▇▅▂▁▇█▅▃▆▇ 42 tps · μ 39 · p95 61
```

**With subagents running** ([`@gotgenes/pi-subagents`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents)
and other in-process subagent cores) — one merged total across the parent and
every live agent, so N concurrent agents read as a single number:
```
⠹ ▕████████▊··▏ Σ 168 tps · 3a
```

**Color coding:**
- 🟢 Green: >50 tps (fast)
- 🟡 Yellow: 20-50 tps (medium)
- 🔴 Red: <20 tps (slow)

## Subagents

Children run in the parent's process but get a no-op `ctx.ui`, so a child can
never draw. This extension therefore splits the work:

- a **child session** only reports its live counters (tokens, first-token time)
  into a process-wide hub, keyed by session id. It allocates no timer and never
  calls `setStatus`;
- the **UI-owning session** is the only renderer. While any agent is live it
  paints one merged total — its own rate plus Σ of every agent's rate — marked
  with `Σ` and the live agent count (`· 3a`). When everything has settled it
  paints the usual sparkline/avg/μ/p95 readout, prefixed with `Σ` once subagent
  messages are part of that series.

Two constants at the top of `extensions/tps-meter.ts` tune it:

| Constant | Default | Effect |
| --- | --- | --- |
| `MERGE_AGENTS` | `true` | Fold concurrent agent throughput into the footer total. `false` = parent-only readout, children do nothing at all. |
| `MERGE_STATS` | `true` | Fold settled subagent messages into the sparkline / avg / μ / p95 series. `false` = the series stays parent-only. |

Notes:

- Agent rate while a message is still streaming is the char/4 estimate; each
  settled message uses the provider's real `message.usage.output`, in children
  as well as in the parent.
- An agent counts toward the total while it has a message open, and its tokens
  are dropped the moment that message settles, so a finished agent never keeps
  inflating the sum. Agents that vanish without a shutdown event are reaped
  after 30s of silence.
- Session state lives in the factory closure, never at module scope. Pi caches
  an extension module per cwd, so a child in the same cwd re-runs the factory
  against the **same** module instance — module-level counters would be shared
  with children (an agent spawn used to reset the parent's μ/p95/sparkline, and
  concurrent children's tokens were folded into one "last message wins"
  counter).
- If a package excludes this extension from children (pi-subagents'
  `excludedExtensionPackages`), the parent readout simply stops merging — no
  error, no per-agent numbers.
- **Performance:** the per-delta path stays allocation-free and clock-free (a
  string-length add plus a couple of field writes on a pre-bound object — no
  `Map` lookup, no `Date.now()`; activity stamps refresh every 16th delta).
  Children run no timer at all, and the parent aggregates a handful of agents
  at 5 Hz, so the added cost is well below the footer repaint it already does.

## Accuracy

- Uses the provider's **real** output token count (`message.usage.output`); the
  char/4 estimate is only a fallback for providers that don't report usage
- Rate is measured from the **first token**, so time-to-first-token (network/queue
  latency) doesn't drag down the reported tps
- Tracks **thinking tokens** (`thinking_delta`) alongside text, so models with
  extended thinking report accurate generation speed

## Stats

- **avg**: rolling 60-second window (resets older samples)
- **μ**: all-time mean across the session
- **p95**: 95th percentile, all-time (up to 500 samples)

## Optimizations

- Only the UI-owning session runs a timer (single shared 200ms interval), torn
  down on `message_end`, `agent_end`, and `session_shutdown` (no orphan timer
  across `/reload`; abort/empty messages restore the last final readout instead
  of freezing the live gauge)
- Fixed-size circular buffers (no allocations in the streaming repaint path)
- Memoized sparkline (rebuilt once per message, not on every tick)
- Insertion sort for p95 (cold path, runs once per message for ≤500 elements)

## Author

Venkata Sai Chirasani

## License

MIT

# pi-tps-meter

Tokens per second meter for [pi CLI](https://pi.dev) with time-to-first-token,
sparkline visualization, and subagent aggregation.

## Install

```bash
pi install npm:pi-tps-meter
```

## Features

**While waiting for the first token** — τ starts counting the instant the request
leaves, i.e. from pi's first "working" frame, so the wait is visible *while it
happens* instead of looking like a stall:
```
⠹ ▕···········▏ τ1.4s
```

**During streaming** — a smooth, animated gauge that fills with live speed
(1/8-cell resolution, auto-scaled to your session's peak), with the locked τ:
```
⠹ ▕███████▋···▏ 47 tps · τ0.8s
```

**After a message** — a min-max normalized sparkline of your last 12 messages
(newest on the right) plus aggregate stats and the mean τ:
```
▁▄▇▅▂▁▇█▅▃▆▇ 42 tps · μ 39 · p95 61 · τ0.9s
```

**With subagents running** ([`@gotgenes/pi-subagents`](https://github.com/gotgenes/pi-packages/tree/main/packages/pi-subagents)
and other in-process subagent cores) — one merged total across the parent and
every live agent, so N concurrent agents read as a single number:
```
⠹ ▕████████▊··▏ Σ 168 tps · 3a · τ0.8s
```

**Color coding** (τ uses its own scale — a wait is not a rate):

| | tps | τ |
| --- | --- | --- |
| 🟢 Green | >50 tps | <1s |
| 🟡 Yellow | 20–50 tps | 1–3s |
| 🔴 Red | <20 tps | ≥3s |

## Time to first token (τ)

Two numbers describe a response, and they fail in opposite directions: τ is how
long you sit there with nothing on screen, tps is how fast it then arrives.

- **Anchor** is `turn_start`, the event pi emits *before* it assembles the
  request. So τ covers the whole end-to-end wait the user feels — context
  assembly, provider queueing, prompt prefill, reasoning preamble — not just the
  assistant message's own streaming window. If a message arrives with no turn
  boundary before it, the anchor falls back to `message_start`.
- **The bar ticks from `turn_start`, not from the assistant message.** That gap
  is the longest and least forgiving part of the wait and it produces no events
  at all: waiting for `message_start` left the footer frozen for exactly the
  seconds τ exists to expose, and then τ popped in already reading 14s.
- **First token** is the first non-empty `text_delta`, `thinking_delta`, or
  `toolcall_delta`. Metadata events (`*_start`, empty deltas) do not stop the
  wait. A reasoning model's thinking counts as an answer arriving, which is what
  you actually observe.
- **Live vs settled**: while a request is in flight the bar shows the *current*
  turn's τ counting up, then locking; the settled readout shows the *mean* τ
  across the session, next to μ and p95. Same split the tps number already used.
- **Buffered replay guard**: a rate above 1000 tps is the upstream flushing a
  finished answer, not decoding it — 1000 tokens in 0.9s would otherwise read as
  an impossible 1147 tps. Such samples still contribute their τ, because the
  wait was real.
- The guard is an **absolute rate ceiling, never a comparison against τ**. An
  earlier version dropped any decode shorter than half the TTFT; with a 53s wait
  that silently discarded every turn shorter than 26s of generation, leaving a
  footer that showed only `τ52.9s`. A long τ is usually hidden reasoning (many
  providers do not stream thinking deltas) and says nothing about how fast the
  answer then decodes.

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

A child that is still waiting for its first token has no rate to report, so the
parent shows the longest such wait as τ rather than `Σ0.0 tps`. Settled agent
messages fold their τ into the parent's mean as well.

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
  inflating the sum. This session's own rate is likewise only counted while its
  own message streams: a settled parent contributes nothing to a merged total
  that only the agents are still driving.
- An agent that has produced **no token yet** is waiting, not stalled — reasoning
  models routinely take minutes to say anything observable — so it is reaped on a
  much longer timeout (`AGENT_WAIT_REAP_MS`, 10 min) than one that went quiet
  mid-stream (`AGENT_REAP_MS`, 30s). Its wait is published at its `turn_start`,
  so the parent's bar shows a subagent's cold start too, not just its tokens.
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
  latency) doesn't drag down the reported tps — that latency is reported as τ
  instead of being thrown away
- Tracks **thinking tokens** (`thinking_delta`) alongside text and tool-call
  arguments, so models with extended thinking report accurate generation speed

## Stats

- **avg**: rolling 60-second window (resets older samples)
- **μ**: all-time mean across the session
- **p95**: 95th percentile, all-time (up to 500 samples)
- **τ**: mean time-to-first-token across the session, from its own series
  (tps and τ histories are maintained independently, so a turn whose rate was
  rejected still contributes its wait)

## Optimizations

- Only the UI-owning session runs a timer (single shared 200ms interval), torn
  down on `message_end`, `agent_end`, and `session_shutdown` (no orphan timer
  across `/reload`; abort/empty messages restore the last final readout instead
  of freezing the live gauge)
- Fixed-size circular buffers (no allocations in the streaming repaint path)
- Memoized sparkline (rebuilt once per message, not on every tick)
- Insertion sort for p95 (cold path, runs once per message for ≤500 elements)

## Test

```bash
npm test
```

`tps-sim.test.ts` drives the extension through pi's real event sequence with a
mocked `ExtensionAPI`/ctx, a controllable clock, and instrumented timers — 59
assertions over the token math, τ anchoring, the pre-message wait window, the
buffered-replay guard, real-usage-vs-fallback, abort cleanup, sparkline
memoization, merged-total accounting, and subagent isolation.

Known limitation: two UI-owning sessions in the same cwd share one hub, and the
`wake` slot in it — only the most recently started one is repainted when a
subagent starts or stops. Both still fold settled samples in via the sink set.

## Author

Venkata Sai Chirasani

## License

MIT

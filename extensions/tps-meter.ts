/**
 * TPS Meter v5 — Tokens Per Second, Time-To-First-Token, Sparkline, Subagents
 *
 * Footer display:
 *   Waiting for τ:      ⠹ ▕···········▏ τ1.4s
 *   Streaming:          ⠹ ▕███████▋···▏ 47 tps · τ0.8s
 *   With N agents live: ⠹ ▕████████▊··▏ Σ 168 tps · 3a · τ0.8s
 *   Complete:           ▁▄▇▅▂▁▇█▅▃▆▇ 42 tps · μ 39 · p95 61 · τ0.9s
 *   Complete, merged:   ▁▄▇▅▂▁▇█▅▃▆▇ Σ 42 tps · μ 39 · p95 61 · τ0.9s
 *
 * Features:
 *   - Time-to-first-token (τ): counts up while the request is in flight so the
 *     wait is visible *while it happens*, locks on the first delta, and averages
 *     into the settled readout alongside μ/p95
 *   - Live sub-cell gauge (1/8-cell resolution) that fills as you stream
 *   - Min-max normalized sparkline (▁▂▃▄▅▆▇█) so the trend's shape is readable
 *   - Color-coded by speed (green fast / yellow mid / red slow)
 *   - Animated spinner during streaming
 *   - Rolling 60s window for avg, all-time for μ and p95
 *
 * Subagents (@gotgenes/pi-subagents and friends):
 *   - Children inherit packages, so this extension loads in every child session
 *     too. Children run in this process but get a no-op `ctx.ui`, so they cannot
 *     draw anything — they only *report* their live counters into a process-wide
 *     hub (Symbol.for keyed global). The UI-owning session is the only renderer:
 *     it sums its own rate with every live agent's rate, so N concurrent agents
 *     show one merged total.
 *   - Session state lives in the factory closure, never at module scope: pi
 *     caches an extension module per cwd, so a child in the same cwd re-runs the
 *     factory against the *same* module instance. Module-level counters would be
 *     shared with children (a spawn used to wipe the parent's μ/p95/sparkline,
 *     and concurrent children's tokens were summed into one "last message wins"
 *     counter). The closure is per session, so that cannot happen.
 *
 * Accuracy:
 *   - Uses the provider's real output token count (message.usage.output) for
 *     every settled message, parent or child; char/4 estimate is only the live
 *     fallback while a message is still streaming
 *   - Rate measured from first token (excludes time-to-first-token latency)
 *   - TTFT is anchored at `turn_start` — the event pi emits *before* the request
 *     is assembled — so it is the end-to-end wait the user actually feels, not
 *     just the time spent inside the provider call. Falls back to the assistant
 *     `message_start` if no turn boundary preceded the message.
 *   - Buffered-replay guard: a decode rate above MAX_PLAUSIBLE_TPS is the
 *     provider flushing a finished answer, not decoding it (1000 tokens in 0.9s
 *     would read as an impossible 1147 tps). Such samples still contribute their
 *     TTFT but are dropped from the tps series. The guard is an absolute rate
 *     ceiling, never a comparison against TTFT — a long wait is usually hidden
 *     reasoning and must not disqualify the decode that follows it.
 *
 * Performance:
 *   - The per-delta path stays allocation-free and clock-free: one string-length
 *     add plus a couple of field writes on a pre-bound object (no Map lookup, no
 *     Date.now() — activity stamps refresh every ACTIVITY_EVERY deltas)
 *   - Only the UI-owning session runs a timer; children never allocate a timer
 *     and never call setStatus
 *   - Fixed ring buffers; memoized sparkline (rebuilt once per message)
 *   - Single shared 200ms timer, torn down on message_end, agent_end, and
 *     session_shutdown (no orphan timer across /reload)
 *   - Abort/empty messages restore the last final readout instead of leaving a
 *     stale live gauge frozen in the footer
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// --- Config ---
const WINDOW_SIZE = 60;
const WINDOW_MS = 60_000;
const STREAM_INTERVAL_MS = 200;
const SPARK_LEN = 12;
const ALLTIME_CAP = 500;
const FAST = 50;
const MED = 20;

/**
 * TTFT color thresholds (green under TTFT_FAST_MS, red at/above TTFT_MED_MS).
 * Generous compared to the tps scale: a second to first token is normal, and the
 * point of the readout is to flag the pathological multi-second waits.
 */
const TTFT_FAST_MS = 1_000;
const TTFT_MED_MS = 3_000;
/**
 * Shortest decode window that carries a usable rate signal. Below this the
 * denominator is noise (first-token jitter, a single flushed chunk).
 */
const MIN_DECODE_MS = 200;
/**
 * Fastest rate an autoregressive decoder can actually sustain. Anything above
 * this is a buffered flush wearing a decoder's clothes, not a real measurement.
 *
 * Deliberately an absolute ceiling rather than a comparison against TTFT: a long
 * TTFT is usually a hidden reasoning phase (providers that do not stream thinking
 * deltas) and says nothing about the decode window, so relating the two throws
 * away perfectly good samples.
 */
const MAX_PLAUSIBLE_TPS = 1_000;

/** Fold concurrent subagent throughput into this session's footer total. */
const MERGE_AGENTS = true;
/** Also fold settled subagent messages into the sparkline / avg / μ / p95 series. */
const MERGE_STATS = true;
/** Drop an agent from the hub once it has produced no delta for this long. */
const AGENT_REAP_MS = 30_000;
/**
 * Same idea for an agent that has not produced a single token yet — except that
 * a session with no tokens is not stalled, it is *waiting*, and reasoning models
 * routinely take longer than AGENT_REAP_MS to say anything observable. Reaping on
 * the short timeout silently dropped such an agent from the merged view for the
 * whole rest of its stream.
 */
const AGENT_WAIT_REAP_MS = 600_000;/** Deltas between activity-stamp refreshes and hub re-attach checks. */
const ACTIVITY_EVERY = 16;

// --- Sparkline chars (8 vertical levels) ---
const BLOCKS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];

// --- Horizontal partial blocks for the live gauge (1/8th-cell resolution) ---
// index = eighths of a cell that are filled (0 = empty .. 7 = ▉); 8 = full "█"
const HBLOCKS = [" ", "▏", "▎", "▍", "▌", "▋", "▊", "▉"];
const GAUGE_LEN = 11; // gauge width in cells
const GAUGE_FLOOR = 40; // tps that reads as a "full-ish" bar before we have history
const TRACK = "·"; // faint empty-track glyph (less janky than blank space)

// ============================
// Process-wide hub
// ============================

/**
 * What one non-UI session reports about its current message.
 *
 * Mutated in place by its owning session and read by the UI session's tick, so
 * the hot path is a few field writes — no lookups, no allocation.
 */
interface AgentLive {
  /**
   * Request anchor: the turn's `turn_start` timestamp (end-to-end TTFT), or the
   * assistant `message_start` when no turn boundary preceded the message.
   */
  startMs: number;
  /** First delta of the current message; 0 until one arrives. */
  firstTokenMs: number;
  /** Characters seen in the current message (estimate source). */
  chars: number;
  /** Estimated tokens of the current message; 0 = no token yet this message. */
  tokens: number;
  /**
   * True between a message's start and its settle. Keeps the renderer ticking
   * through time-to-first-token, when there is nothing to measure yet.
   */
  streaming: boolean;
  /** Last activity stamp, refreshed every ACTIVITY_EVERY deltas. */
  lastActiveMs: number;
}

/** A settled (completed) message, published to every UI-owning session. */
interface SettledSample {
  /** Decode rate; 0 when the sample was rejected as buffered replay. */
  tps: number;
  tokens: number;
  /** End-to-end TTFT of that message in ms; 0 when the first token never came. */
  ttftMs: number;
}

interface Hub {
  /** Live counters keyed by child session id. */
  live: Map<string, AgentLive>;
  /** UI-owning sessions; each folds samples into its own series. */
  sinks: Set<(sample: SettledSample) => void>;
  /** Nudges the UI session to repaint when a child starts/stops streaming. */
  wake: (() => void) | undefined;
}

const HUB_KEY = Symbol.for("pi-tps-meter:hub:v1");

/**
 * The hub is a `Symbol.for`-keyed global rather than a module-level value
 * because pi's extension cache is keyed by cwd: two sessions in the same cwd
 * share this module's scope (and would share a plain variable), while a child
 * relocated to a worktree re-evaluates the module and would get a fresh one.
 * The global is the only rendezvous that holds in both cases.
 */
function hub(): Hub {
  const g = globalThis as unknown as Record<symbol, Hub | undefined>;
  let h = g[HUB_KEY];
  if (!h) {
    h = { live: new Map(), sinks: new Set(), wake: undefined };
    g[HUB_KEY] = h;
  }
  return h;
}

// ============================
// Per-session series (stats)
// ============================

interface Series {
  win: Float64Array;
  winLen: number;
  winHead: number;
  at: Float64Array;
  atLen: number;
  atHead: number;
  atSum: number;
  spark: Float64Array;
  sparkLen: number;
  sparkHead: number;
  sparkMax: number;
  sparkCache: string;
  sparkDirty: boolean;
  sparkTheme: unknown;
  /** Samples in this series that came from another session (subagents). */
  merged: number;
}

function newSeries(): Series {
  return {
    win: new Float64Array(WINDOW_SIZE * 2),
    winLen: 0,
    winHead: 0,
    at: new Float64Array(ALLTIME_CAP),
    atLen: 0,
    atHead: 0,
    atSum: 0,
    spark: new Float64Array(SPARK_LEN),
    sparkLen: 0,
    sparkHead: 0,
    sparkMax: 1,
    sparkCache: "",
    sparkDirty: true,
    sparkTheme: null,
    merged: 0,
  };
}

function resetSeries(s: Series): void {
  s.winLen = 0;
  s.winHead = 0;
  s.atLen = 0;
  s.atHead = 0;
  s.atSum = 0;
  s.sparkLen = 0;
  s.sparkHead = 0;
  s.sparkMax = 1;
  s.sparkCache = "";
  s.sparkDirty = true;
  s.sparkTheme = null;
  s.merged = 0;
}

// ============================
// Helpers
// ============================

function now(): number {
  return Date.now();
}

function tokEst(ch: number): number {
  return (ch >>> 2) + ((ch & 3) > 0 ? 1 : 0);
}

/** Instantaneous rate; 0 until there is enough signal to be meaningful. */
function rate(tokens: number, refMs: number, nowMs: number): number {
  const elapsed = (nowMs - refMs) / 1000;
  return elapsed > 0.3 ? tokens / elapsed : 0;
}

/**
 * Is a decode window a believable generation rate?
 *
 * Two rejections, both about a denominator that carries no signal:
 *   - shorter than MIN_DECODE_MS: first-token jitter dominates the quotient.
 *   - the implied rate exceeds MAX_PLAUSIBLE_TPS: the upstream held the finished
 *     answer and flushed it, so the elapsed time is not the generation time
 *     (1000 tokens in 0.9s reads as "1147 tps").
 *
 * Note what is deliberately *not* checked: the ratio between decode time and
 * TTFT. A slow first token (hidden reasoning, a cold prompt, a busy provider) is
 * orthogonal to how fast the answer then decodes, and rejecting short decodes
 * after long waits silently discarded every legitimate turn from a reasoning
 * model — leaving a footer that showed only τ.
 *
 * The TTFT itself stays trustworthy in both rejected cases — only the rate is
 * dropped, and the wait is still recorded.
 */
function tpsTrustworthy(decodeMs: number, tokens: number): boolean {
  if (decodeMs < MIN_DECODE_MS) return false;
  return tokens / (decodeMs / 1000) <= MAX_PLAUSIBLE_TPS;
}

function fmt(v: number): string {
  if (v < 10) return v.toFixed(1);
  if (v < 100) return v.toFixed(0);
  return `${Math.round(v)}`;
}

/** Milliseconds as a compact human latency: `840ms`, `1.4s`, `12.6s`. */
function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/** Push a sample onto the rolling + all-time buffers, leaving the sparkline alone. */
function statPush(s: Series, v: number): void {
  const b = s.winHead * 2;
  s.win[b] = v;
  s.win[b + 1] = now();
  s.winHead = (s.winHead + 1) % WINDOW_SIZE;
  if (s.winLen < WINDOW_SIZE) s.winLen++;

  s.atSum += v;
  if (s.atLen >= ALLTIME_CAP) s.atSum -= s.at[s.atHead];
  s.at[s.atHead] = v;
  s.atHead = (s.atHead + 1) % ALLTIME_CAP;
  if (s.atLen < ALLTIME_CAP) s.atLen++;
}

function seriesPush(s: Series, tps: number): void {
  statPush(s, tps);

  // Sparkline
  s.spark[s.sparkHead] = tps;
  s.sparkHead = (s.sparkHead + 1) % SPARK_LEN;
  if (s.sparkLen < SPARK_LEN) s.sparkLen++;
  if (tps > s.sparkMax) s.sparkMax = tps;
  // Decay max slowly so the sparkline adapts
  if (s.sparkMax > 10) s.sparkMax *= 0.99;
  s.sparkDirty = true;
}

function seriesAvg(s: Series): number {
  if (s.winLen === 0) return 0;
  const cutoff = now() - WINDOW_MS;
  let sum = 0;
  let n = 0;
  const oldest = s.winLen < WINDOW_SIZE ? 0 : s.winHead;
  for (let i = 0; i < s.winLen; i++) {
    const b = ((oldest + i) % WINDOW_SIZE) * 2;
    if (s.win[b + 1] < cutoff) continue;
    sum += s.win[b];
    n++;
  }
  return n === 0 ? 0 : sum / n;
}

function seriesMean(s: Series): number {
  return s.atLen === 0 ? 0 : s.atSum / s.atLen;
}

function seriesP95(s: Series): number {
  if (s.atLen === 0) return 0;
  const tmp = new Float64Array(s.atLen);
  const oldest = s.atLen < ALLTIME_CAP ? 0 : s.atHead;
  for (let i = 0; i < s.atLen; i++) tmp[i] = s.at[(oldest + i) % ALLTIME_CAP];
  // Insertion sort (cold path, ≤500 elements)
  for (let i = 1; i < tmp.length; i++) {
    const v = tmp[i];
    let j = i - 1;
    while (j >= 0 && tmp[j] > v) {
      tmp[j + 1] = tmp[j];
      j--;
    }
    tmp[j + 1] = v;
  }
  return tmp[Math.ceil(tmp.length * 0.95) - 1] || 0;
}

// ============================
// Rendering
// ============================

function sparkline(s: Series, theme: any): string {
  // Sparkline data only changes once per message (seriesPush), so memoize the
  // rendered string instead of re-allocating + recoloring on every 200ms tick.
  // Invalidate if the active theme changed (user switched themes mid-session).
  if (theme !== s.sparkTheme) {
    s.sparkDirty = true;
    s.sparkTheme = theme;
  }
  if (!s.sparkDirty) return s.sparkCache;

  if (s.sparkLen === 0) {
    s.sparkCache = theme.fg("dim", "▁".repeat(SPARK_LEN));
    s.sparkDirty = false;
    return s.sparkCache;
  }

  // Read ring buffer in order (oldest first)
  const vals = new Float64Array(SPARK_LEN);
  const oldest = s.sparkLen < SPARK_LEN ? 0 : s.sparkHead;
  for (let i = 0; i < s.sparkLen; i++) {
    vals[i] = s.spark[(oldest + i) % SPARK_LEN];
  }

  // Min-max normalize over the window so the trend's *shape* is visible.
  // (Normalizing by max alone squashes 40/42/45 into a flat top — the old jank.)
  let mn = Infinity;
  let mx = 0;
  for (let i = 0; i < s.sparkLen; i++) {
    const v = vals[i];
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const range = mx - mn;

  // Pad the left so a partial window is right-aligned (newest at the right edge).
  const pad = SPARK_LEN - s.sparkLen;
  let result = pad > 0 ? theme.fg("dim", TRACK.repeat(pad)) : "";

  for (let i = 0; i < s.sparkLen; i++) {
    const v = vals[i];
    // Flat series -> mid-height bar; otherwise spread across the full 0..7 range.
    const norm =
      range < 1e-6
        ? mx > 0
          ? 4
          : 0
        : Math.min(7, Math.max(0, Math.round(((v - mn) / range) * 7)));
    const ch = BLOCKS[norm];

    // Color each bar by absolute speed (green fast / yellow mid / red slow).
    let colored: string;
    if (v >= FAST) colored = theme.fg("success", ch);
    else if (v >= MED) colored = theme.fg("warning", ch);
    else colored = theme.fg("error", ch);

    result += colored;
  }
  s.sparkCache = result;
  s.sparkDirty = false;
  return result;
}

function gauge(tps: number, scaleMax: number, theme: any): string {
  // Auto-scale to the session peak with a sane floor, so the bar is stable
  // (no wild rescaling) yet still meaningful across slow and fast models.
  // `scaleMax` also carries the peak merged total, so an agent burst does not
  // peg the bar at full for the rest of the session.
  const scale = Math.max(scaleMax, GAUGE_FLOOR);
  let frac = scale > 0 ? tps / scale : 0;
  if (frac < 0) frac = 0;
  if (frac > 1) frac = 1;

  const eighths = Math.round(frac * GAUGE_LEN * 8);
  const full = (eighths / 8) | 0;
  const rem = eighths % 8;

  let fill = "█".repeat(full);
  let used = full;
  if (full < GAUGE_LEN && rem > 0) {
    fill += HBLOCKS[rem];
    used++;
  }
  const track = TRACK.repeat(GAUGE_LEN - used);

  return (
    theme.fg("dim", "▕") +
    speedColor(tps, fill, theme) +
    theme.fg("dim", track + "▏")
  );
}

// --- Spinner ---

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function speedColor(tps: number, text: string, theme: any): string {
  if (tps >= FAST) return theme.fg("success", text);
  if (tps >= MED) return theme.fg("warning", text);
  return theme.fg("error", text);
}

/**
 * Latency color: a wait is judged on its own scale, not the tps one. Green as
 * soon as the model starts talking quickly, red once you are clearly waiting on
 * a slow provider, a cold prompt, or a long reasoning preamble.
 */
function ttftColor(ms: number, text: string, theme: any): string {
  if (ms < TTFT_FAST_MS) return theme.fg("success", text);
  if (ms < TTFT_MED_MS) return theme.fg("warning", text);
  return theme.fg("error", text);
}

/** Live TTFT: `ms` counts up while waiting, then locks at the real value. */
interface LiveTtft {
  ms: number;
  /** True until the first token lands — there is no rate to show yet. */
  waiting: boolean;
}

/** What the subagents currently report, folded into one snapshot. */
interface AgentAgg {
  /** Σ of the measurable agent rates. */
  sum: number;
  /** How many agents contribute to `sum`. */
  count: number;
  /** How many have a request or a message open. */
  active: number;
  /**
   * Largest τ among active agents: the locked value for one that has produced a
   * token, a live count for one that has not. 0 when nothing is running.
   */
  ttftMs: number;
}

/**
 * Live readout: this session's rate plus the running agents' rates.
 * `agents` is the hub snapshot folded in by MERGE_AGENTS.
 * `glyph` is this session's spinner frame (see the per-session phase in the
 * factory — a module-level counter would interleave two UI sessions in one cwd).
 * `ttft` is null when nothing is in flight anywhere.
 */
function renderLive(
  s: Series,
  scaleMax: number,
  own: number,
  agents: AgentAgg,
  glyph: string,
  ttft: LiveTtft | null,
  theme: any,
): string {
  const merged = agents.count > 0;
  const tps = own + agents.sum;

  const sp = theme.fg("accent", glyph);
  const scale = Math.max(s.sparkMax, scaleMax);
  // Only show the live-agent count when it is not already implied by Σ.
  const liveTail = agents.active > 0 ? ` ${theme.fg("dim", `· ${agents.active}a`)}` : "";

  // Nothing measurable to draw yet — the first token has not landed, or it just
  // did and `rate()` has not seen enough elapsed time. Show the wait itself
  // instead of a `0.0 tps` that reads as a stall. A flat empty gauge plus a
  // counting τ says "requested, no answer yet" far better than a zero. When an
  // agent is already producing a usable rate, the merged total is the more
  // useful reading, so that case falls through to the normal branch.
  if (ttft && !merged && (ttft.waiting || tps === 0)) {
    const t = theme.fg("dim", "τ") + ttftColor(ttft.ms, fmtMs(ttft.ms), theme);
    return `${sp} ${gauge(0, scale, theme)} ${t}${liveTail}`;
  }

  const g = gauge(tps, scale, theme);
  const lead = merged ? theme.fg("dim", "Σ") : "";
  const num = speedColor(tps, fmt(tps), theme);
  const unit = theme.fg("dim", "tps");
  const t = ttft ? ` ${theme.fg("dim", "· τ")}${ttftColor(ttft.ms, fmtMs(ttft.ms), theme)}` : "";
  return `${sp} ${g} ${lead}${num} ${unit}${liveTail}${t}`;
}

function renderFinal(s: Series, ttf: Series, theme: any): string {
  const mu = seriesMean(s);
  // The rolling window is empty after a minute of idling, and averaging nothing
  // used to yield 0 — so an abort (or any repaint) after a pause made the
  // headline read `0.0 tps` for a session with a perfectly good history, and
  // that string then became `lastFinal`, sticking until the next message.
  // Fall back to the mean: the settled readout describes the session, it must
  // never claim a rate of zero that nothing is actually producing.
  const windowAvg = seriesAvg(s);
  const avg = windowAvg > 0 ? windowAvg : mu;
  // Mean TTFT sits next to μ/p95 as the same kind of number: a session summary.
  // (Live shows the current turn's τ; settled shows the average of all turns.)
  const meanTtft = seriesMean(ttf);
  const t = meanTtft > 0
    ? ` ${theme.fg("dim", "· τ")}${ttftColor(meanTtft, fmtMs(meanTtft), theme)}`
    : "";

  if (mu === 0) {
    // No usable rate at all (every sample rejected, or nothing settled yet) —
    // but a measured wait is still a real data point, so do not throw it away.
    return meanTtft > 0
      ? `${theme.fg("dim", "τ")}${ttftColor(meanTtft, fmtMs(meanTtft), theme)}`
      : "";
  }

  const p95 = seriesP95(s);
  const sp = sparkline(s, theme);
  // Σ marks a series that also contains subagent messages (MERGE_STATS).
  const lead = s.merged > 0 ? theme.fg("dim", "Σ ") : "";
  const a = speedColor(avg, fmt(avg), theme);
  const sep = theme.fg("dim", "·");
  const m = `${theme.fg("dim", "μ")} ${speedColor(mu, fmt(mu), theme)}`;
  const p = `${theme.fg("dim", "p95")} ${speedColor(p95, fmt(p95), theme)}`;
  const label = theme.fg("dim", "tps");

  return `${sp} ${lead}${a} ${label} ${sep} ${m} ${sep} ${p}${t}`;
}

// ============================
// Extension
// ============================

/** Child session id, used as the hub key. Always present in a real session. */
function sessionId(ctx: any): string {
  try {
    return ctx?.sessionManager?.getSessionId?.() ?? "local";
  } catch {
    return "local";
  }
}

export default function tpsMeter(pi: ExtensionAPI): void {
  const H = hub();
  /** Children only report; with both merge features off they do nothing at all. */
  const childReports = MERGE_AGENTS || MERGE_STATS;

  // --- per-session state ---------------------------------------------------
  // The factory runs once per session. Module scope may be shared with sibling
  // sessions (pi caches a module per cwd), so anything belonging to *this*
  // session lives here and nowhere else.
  const series = newSeries();
  /** Parallel series for time-to-first-token (ms), so τ has its own mean. */
  const ttftSeries = newSeries();
  let ownsUI = true;
  let ctxRef: any = null;
  let sid = "";
  let entry: AgentLive | null = null;
  let streaming = false;
  /** Request anchor: `turn_start` when known, else the assistant message start. */
  let streamStartMs = 0;
  /** Unconsumed `turn_start` timestamp for the request that has not landed yet. */
  let turnAnchorMs = 0;
  let firstTokenMs = 0;
  let streamChars = 0;
  let streamTokens = 0;
  let deltaCount = 0;
  let aggMax = GAUGE_FLOOR;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let lastFinal = "";
  /**
   * Spinner phase, owned by this session. At module scope two UI sessions in the
   * same cwd share the module instance (pi caches per cwd), so their frames would
   * interleave and one session's session_start would reset the other's.
   */
  let spinPhase = 0;
  function spin(): string {
    const g = SPIN[spinPhase];
    spinPhase = (spinPhase + 1) % SPIN.length;
    return g;
  }

  // --- hub wiring (UI-owning session only) ---------------------------------

  /** A settled message landed somewhere in the tree; fold it in and repaint. */
  const sink = (sample: SettledSample): void => {
    if (!ownsUI) return;
    if (MERGE_STATS) {
      // A rejected rate (buffered replay) still carries a valid TTFT.
      if (sample.tps > 0) {
        seriesPush(series, sample.tps);
        series.merged++;
      }
      if (sample.ttftMs > 0) statPush(ttftSeries, sample.ttftMs);
    }
    paint();
  };

  /** Nudge from a child: start the ticker so the merged total is visible. */
  function wake(): void {
    if (!ownsUI || !MERGE_AGENTS) return;
    startTick();
    paint();
  }

  function startTick(): void {
    if (tickTimer || !ownsUI) return;
    tickTimer = setInterval(paint, STREAM_INTERVAL_MS);
  }

  function stopTick(): void {
    if (tickTimer) {
      clearInterval(tickTimer);
      tickTimer = null;
    }
  }

  /**
   * Aggregate of every live agent: `sum` is Σ of the measurable rates, `count`
   * how many agents contribute to it, `active` how many have a request or message
   * open (which is what keeps the renderer's timer alive), `ttftMs` the largest
   * wait among them.
   */
  function agentState(nowMs: number): AgentAgg {
    let sum = 0;
    let count = 0;
    let active = 0;
    let ttftMs = 0;
    for (const [key, e] of H.live) {
      // Three states, three timeouts: waiting on a first token (legitimately
      // slow for a reasoning model), producing tokens (silence means stalled),
      // and idle after a settle (leftover, drop it quickly).
      const limit = e.streaming && e.tokens === 0 ? AGENT_WAIT_REAP_MS : AGENT_REAP_MS;
      if (nowMs - e.lastActiveMs > limit) {
        H.live.delete(key); // owner died without a shutdown event
        continue;
      }
      if (!e.streaming && e.tokens === 0) continue;
      active++;
      // Locked τ for an agent that has spoken, live count for one that has not.
      const agentTtft = e.firstTokenMs > 0 ? e.firstTokenMs - e.startMs : nowMs - e.startMs;
      if (agentTtft > ttftMs) ttftMs = agentTtft;
      if (e.tokens === 0) continue;
      const r = rate(e.tokens, e.firstTokenMs > 0 ? e.firstTokenMs : e.startMs, nowMs);
      if (r > 0) {
        sum += r;
        count++;
      }
    }
    return { sum, count, active, ttftMs };
  }

  /**
   * TTFT to put on the live bar: this session's own request if it has one, else
   * the longest-running agent's (so a subagent's cold start does not read as
   * `0.0 tps`).
   *
   * The pending window — `turn_start` fired, no assistant message yet — counts
   * too. That is the longest and least forgiving part of the wait (request
   * assembly + provider queueing + prefill) and none of it produces events, so
   * if the bar did not tick here τ would appear late, already large.
   */
  function liveTtft(nowMs: number, agents: AgentAgg): LiveTtft | null {
    if (streaming && streamStartMs > 0) {
      if (firstTokenMs > 0) return { ms: firstTokenMs - streamStartMs, waiting: false };
      return { ms: nowMs - streamStartMs, waiting: true };
    }
    if (pending()) return { ms: nowMs - turnAnchorMs, waiting: true };
    if (agents.ttftMs > 0) return { ms: agents.ttftMs, waiting: true };
    return null;
  }

  /**
   * A request is in flight but has no assistant message yet: `turn_start` landed
   * and nothing has consumed its anchor. No message, no deltas — but this is
   * precisely the wait τ is about, so it has to be rendered.
   */
  function pending(): boolean {
    return turnAnchorMs > 0;
  }

  /** Single render entry point: live while anything streams, else settled final. */
  function paint(): void {
    if (!ownsUI || !ctxRef) return;
    const nowMs = now();
    const agents: AgentAgg = MERGE_AGENTS
      ? agentState(nowMs)
      : { sum: 0, count: 0, active: 0, ttftMs: 0 };
    // Own rate exists only while this session's own message streams. Falling back
    // to the last message's counters after it settles kept dividing its tokens by
    // an ever-growing window, so a phantom rate decayed into the merged total
    // while only the agents were actually producing.
    const own = streaming
      ? rate(streamTokens, firstTokenMs > 0 ? firstTokenMs : streamStartMs, nowMs)
      : 0;

    if (streaming || pending() || agents.active > 0) {
      const total = own + agents.sum;
      if (total > aggMax) aggMax = total;
      else if (aggMax > GAUGE_FLOOR) aggMax *= 0.995; // slow decay, like sparkMax
      ctxRef.ui.setStatus(
        "tps",
        renderLive(series, aggMax, own, agents, spin(), liveTtft(nowMs, agents), ctxRef.ui.theme),
      );
      startTick();
      return;
    }

    const txt = renderFinal(series, ttftSeries, ctxRef.ui.theme);
    if (txt) lastFinal = txt;
    ctxRef.ui.setStatus("tps", txt || lastFinal || undefined);
    stopTick();
  }

  // --- child session reporting ---------------------------------------------

  function ensureEntry(): AgentLive {
    const existing = H.live.get(sid);
    if (existing) return existing;
    const e: AgentLive = {
      startMs: now(),
      firstTokenMs: 0,
      chars: 0,
      tokens: 0,
      streaming: false,
      lastActiveMs: now(),
    };
    H.live.set(sid, e);
    return e;
  }

  /** Clear the live counters of this session's agent entry (idle, not removed). */
  function idleEntry(): void {
    if (!entry) return;
    entry.tokens = 0;
    entry.chars = 0;
    entry.firstTokenMs = 0;
    entry.streaming = false;
    entry.lastActiveMs = now();
  }

  // --- events ---------------------------------------------------------------

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    ownsUI = ctx.hasUI ?? true;

    if (!ownsUI) {
      if (!childReports) return;
      sid = sessionId(ctx);
      entry = ensureEntry();
      H.wake?.();
      return;
    }

    // Parent: private series reset, and become the hub's renderer.
    resetSeries(series);
    resetSeries(ttftSeries);
    streaming = false;
    streamStartMs = 0;
    turnAnchorMs = 0;
    firstTokenMs = 0;
    streamChars = 0;
    streamTokens = 0;
    deltaCount = 0;
    aggMax = GAUGE_FLOOR;
    lastFinal = "";
    spinPhase = 0;
    stopTick();
    H.sinks.add(sink);
    H.wake = wake;
    ctxRef.ui.setStatus("tps", undefined);
  });

  // `turn_start` is emitted before pi assembles the request, so anchoring TTFT
  // here measures the wait the user actually sits through — including prompt
  // assembly and any provider-side queueing — instead of only the assistant
  // message's own streaming window. The anchor is consumed by the next assistant
  // `message_start` (one turn = one model request = one assistant message).
  //
  // The ticker starts here, not at `message_start`: message_start only fires once
  // the provider starts streaming, so waiting for it would keep the bar frozen
  // for exactly the seconds τ is supposed to expose, and τ would then pop in at
  // whatever value it had already accumulated.
  pi.on("turn_start", async (event, ctx) => {
    const ts = typeof event.timestamp === "number" && event.timestamp > 0 ? event.timestamp : now();
    turnAnchorMs = ts;

    if (!ownsUI) {
      if (!childReports) return;
      // Publish the wait immediately. Waiting for message_start left the parent's
      // merged view blind to a subagent's whole pre-message window — the same gap
      // the UI session had before it started ticking from turn_start.
      sid ||= sessionId(ctx);
      entry = ensureEntry();
      entry.startMs = ts;
      entry.firstTokenMs = 0;
      entry.chars = 0;
      entry.tokens = 0;
      entry.streaming = true;
      entry.lastActiveMs = now();
      H.wake?.();
      return;
    }

    startTick();
  });

  pi.on("message_start", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    ctxRef ??= ctx;

    // Consume the turn anchor (one turn = one model request = one assistant
    // message); fall back to now if this message had no turn boundary.
    const anchor = turnAnchorMs > 0 ? turnAnchorMs : now();
    turnAnchorMs = 0;

    if (!ownsUI) {
      if (!childReports) return;
      sid ||= sessionId(ctx);
      entry = ensureEntry();
      entry.startMs = anchor;
      entry.firstTokenMs = 0;
      entry.chars = 0;
      entry.tokens = 0;
      entry.streaming = true;
      entry.lastActiveMs = now();
      deltaCount = 0;
      H.wake?.();
      return;
    }

    streamStartMs = anchor;
    firstTokenMs = 0;
    streamChars = 0;
    streamTokens = 0;
    deltaCount = 0;
    streaming = true;
    startTick();
  });

  pi.on("message_update", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (!event.assistantMessageEvent) return;
    const evt = event.assistantMessageEvent;
    // Count tool-call argument generation too: writing long files / commands
    // streams their content as `toolcall_delta` tokens, which otherwise look
    // like 0 TPS. text/thinking already count; toolcall was the missing branch.
    if (evt.type !== "text_delta" && evt.type !== "thinking_delta" && evt.type !== "toolcall_delta") {
      return;
    }
    const d = evt.delta as string;
    if (!d) return;

    if (!ownsUI) {
      if (!childReports) return;
      if (!entry) {
        sid ||= sessionId(ctx);
        entry = ensureEntry();
      }
      if (entry.firstTokenMs === 0) entry.firstTokenMs = now();
      entry.chars += d.length;
      entry.tokens = tokEst(entry.chars);
      // Hot path stays a couple of field writes: no clock, no map lookup on
      // every delta. The stamp and the re-attach check run every Nth delta.
      if ((++deltaCount & (ACTIVITY_EVERY - 1)) === 0) {
        entry.lastActiveMs = now();
        if (H.live.get(sid) !== entry) H.live.set(sid, entry); // reaped -> re-attach
      }
      return;
    }

    if (firstTokenMs === 0) firstTokenMs = now();
    streamChars += d.length;
    streamTokens = tokEst(streamChars);
  });

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    ctxRef ??= ctx;

    if (!ownsUI) {
      if (!childReports) return;
      if (!entry) {
        sid ||= sessionId(ctx);
        entry = ensureEntry();
      }
      // Prefer the provider's real output token count; fall back to the char
      // estimate only when usage is unavailable (e.g. some local providers).
      const realOut = event.message?.usage?.output;
      const tokens = typeof realOut === "number" && realOut > 0 ? realOut : entry.tokens;
      const ref = entry.firstTokenMs > 0 ? entry.firstTokenMs : entry.startMs;
      const decodeMs = now() - ref;
      // TTFT is measured against the request anchor, not the first delta, so it
      // stays valid even when the decode rate is rejected below.
      const ttftMs = entry.firstTokenMs > 0 ? entry.firstTokenMs - entry.startMs : 0;
      idleEntry();
      if (MERGE_STATS && (tokens > 0 || ttftMs > 0)) {
        const rate =
          tokens > 0 && tpsTrustworthy(decodeMs, tokens) ? tokens / (decodeMs / 1000) : 0;
        const sample: SettledSample = { tps: rate, tokens, ttftMs };
        for (const fn of H.sinks) fn(sample);
      }
      H.wake?.();
      return;
    }

    streaming = false;
    const realOut = event.message?.usage?.output;
    const tokens = typeof realOut === "number" && realOut > 0 ? realOut : streamTokens;
    const ref = firstTokenMs > 0 ? firstTokenMs : streamStartMs;
    const decodeMs = now() - ref;
    const ttftMs = firstTokenMs > 0 ? firstTokenMs - streamStartMs : 0;

    // A wait with no answer is still a data point: record the TTFT even when the
    // rate is unusable (tiny/empty response, buffered replay).
    if (ttftMs > 0) statPush(ttftSeries, ttftMs);
    // Tiny/empty responses carry no rate signal — keep the previous final
    // readout instead of leaving a stale live gauge in the footer.
    if (tokens > 0 && tpsTrustworthy(decodeMs, tokens)) {
      seriesPush(series, tokens / (decodeMs / 1000));
    }
    paint();
  });

  // Safety net: if a stream is aborted (Esc/Ctrl-C) or errors, message_end may
  // not fire for that message — agent_end always does. Repaint so a stale live
  // gauge isn't left frozen in the footer. Idempotent after a normal completion.
  pi.on("agent_end", async (_event, ctx) => {
    ctxRef ??= ctx;

    if (!ownsUI) {
      if (!childReports) return;
      idleEntry();
      turnAnchorMs = 0;
      H.wake?.();
      return;
    }

    // Drop an anchor whose assistant message never arrived (abort during the
    // wait); otherwise `pending()` would keep the bar live forever.
    streaming = false;
    turnAnchorMs = 0;
    paint();
  });

  // Tear down on /reload, /new, /resume, /fork, quit. Without this, a reload
  // mid-stream would orphan the old interval: the fresh module scope can't reach
  // it, so it would keep repainting the footer with a stale ctx indefinitely.
  pi.on("session_shutdown", async () => {
    stopTick();
    turnAnchorMs = 0;
    if (ownsUI) {
      H.sinks.delete(sink);
      if (H.wake === wake) H.wake = undefined;
    } else if (sid) {
      H.live.delete(sid);
      entry = null;
      // Let the renderer settle back to its own readout right away instead of
      // waiting for the next tick to notice the agent is gone.
      H.wake?.();
    }
  });
}

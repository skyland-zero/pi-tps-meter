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
 *   - Buffered-replay guard: a long TTFT followed by a flood of tokens is the
 *     provider flushing the whole answer at once, not a decode rate (22s TTFT
 *     then 1000 tokens in 0.9s would read as an impossible 1147 tps). Such
 *     samples still contribute their TTFT but are dropped from the tps series.
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

/** Fold concurrent subagent throughput into this session's footer total. */
const MERGE_AGENTS = true;
/** Also fold settled subagent messages into the sparkline / avg / μ / p95 series. */
const MERGE_STATS = true;
/** Drop an agent from the hub once it has produced no delta for this long. */
const AGENT_REAP_MS = 30_000;
/** Deltas between activity-stamp refreshes and hub re-attach checks. */
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
 *   - shorter than half a long TTFT: the classic gateway-buffered replay, where
 *     the upstream holds the finished answer and flushes it in one burst. The
 *     numerator is real but the elapsed time is not the generation time, so the
 *     quotient is fiction (22s TTFT + 1000 tokens in 0.9s = "1147 tps").
 *
 * The TTFT itself stays trustworthy in both cases — only the rate is dropped.
 */
function tpsTrustworthy(decodeMs: number, ttftMs: number): boolean {
  if (decodeMs < MIN_DECODE_MS) return false;
  return !(ttftMs >= TTFT_FAST_MS && decodeMs < ttftMs * 0.5);
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
let spinI = 0;
function spin(): string {
  const s = SPIN[spinI];
  spinI = (spinI + 1) % SPIN.length;
  return s;
}

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

/**
 * Live readout: this session's rate, or the merged total when agents are running.
 * `agentSum`/`agentCount` are the live subagents folded in by MERGE_AGENTS.
 * `ttft` is null when this session has no request of its own in flight (a child
 * may still be streaming into the merged total).
 */
function renderLive(
  s: Series,
  scaleMax: number,
  own: number,
  agentSum: number,
  agentCount: number,
  ttft: LiveTtft | null,
  theme: any,
): string {
  const merged = agentCount > 0;
  const tps = merged ? own + agentSum : own;

  const sp = theme.fg("accent", spin());
  const scale = Math.max(s.sparkMax, scaleMax);

  // Nothing measurable to draw yet — either the first token has not landed, or
  // it just did and `rate()` has not seen enough elapsed time. Show the wait
  // itself instead of a `0.0 tps` that reads as a stall. A flat empty gauge plus
  // a counting τ says "requested, no answer yet" far better than a zero. When a
  // subagent is already producing, the merged rate is the more useful reading,
  // so that case falls through to the normal branch with τ appended.
  if (ttft && agentCount === 0 && (ttft.waiting || tps === 0)) {
    const t = theme.fg("dim", "τ") + ttftColor(ttft.ms, fmtMs(ttft.ms), theme);
    return `${sp} ${gauge(0, scale, theme)} ${t}`;
  }

  const g = gauge(tps, scale, theme);
  const lead = merged ? theme.fg("dim", "Σ") : "";
  const num = speedColor(tps, fmt(tps), theme);
  const unit = theme.fg("dim", "tps");
  const tail = merged ? ` ${theme.fg("dim", `· ${agentCount}a`)}` : "";
  const t = ttft ? ` ${theme.fg("dim", "· τ")}${ttftColor(ttft.ms, fmtMs(ttft.ms), theme)}` : "";
  return `${sp} ${g} ${lead}${num} ${unit}${tail}${t}`;
}

function renderFinal(s: Series, ttf: Series, theme: any): string {
  const avg = seriesAvg(s);
  const mu = seriesMean(s);
  // Mean TTFT sits next to μ/p95 as the same kind of number: a session summary.
  // (Live shows the current turn's τ; settled shows the average of all turns.)
  const meanTtft = seriesMean(ttf);
  const t = meanTtft > 0
    ? ` ${theme.fg("dim", "· τ")}${ttftColor(meanTtft, fmtMs(meanTtft), theme)}`
    : "";

  if (avg === 0 && mu === 0) {
    // No usable rate (every sample rejected, or nothing settled yet) — but a
    // measured wait is still a real data point, so do not throw it away.
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
   * how many agents contribute to it, `active` how many have a message open
   * (which is what keeps the renderer's timer alive), `waitMs` the longest wait
   * among agents that have not produced a token yet (0 when none is waiting).
   */
  function agentState(nowMs: number): {
    sum: number;
    count: number;
    active: number;
    waitMs: number;
  } {
    let sum = 0;
    let count = 0;
    let active = 0;
    let waitMs = 0;
    for (const [key, e] of H.live) {
      if (nowMs - e.lastActiveMs > AGENT_REAP_MS) {
        H.live.delete(key); // owner died without a shutdown event
        continue;
      }
      if (!e.streaming && e.tokens === 0) continue;
      active++;
      if (e.tokens === 0) {
        // Waiting on a first token: report the wait, not a rate of zero.
        const w = nowMs - e.startMs;
        if (w > waitMs) waitMs = w;
        continue;
      }
      const r = rate(e.tokens, e.firstTokenMs > 0 ? e.firstTokenMs : e.startMs, nowMs);
      if (r > 0) {
        sum += r;
        count++;
      }
    }
    return { sum, count, active, waitMs };
  }

  /**
   * TTFT to put on the live bar: this session's own request if it has one, else
   * a waiting agent's (so a subagent's cold start does not read as `0.0 tps`).
   */
  function liveTtft(nowMs: number, agentWaitMs: number): LiveTtft | null {
    if (streaming && streamStartMs > 0) {
      if (firstTokenMs > 0) return { ms: firstTokenMs - streamStartMs, waiting: false };
      return { ms: nowMs - streamStartMs, waiting: true };
    }
    if (agentWaitMs > 0) return { ms: agentWaitMs, waiting: true };
    return null;
  }

  /** Single render entry point: live while anything streams, else settled final. */
  function paint(): void {
    if (!ownsUI || !ctxRef) return;
    const nowMs = now();
    const agents = MERGE_AGENTS
      ? agentState(nowMs)
      : { sum: 0, count: 0, active: 0, waitMs: 0 };
    const own = rate(streamTokens, firstTokenMs > 0 ? firstTokenMs : streamStartMs, nowMs);

    if (streaming || agents.active > 0) {
      const total = own + agents.sum;
      if (total > aggMax) aggMax = total;
      else if (aggMax > GAUGE_FLOOR) aggMax *= 0.995; // slow decay, like sparkMax
      ctxRef.ui.setStatus(
        "tps",
        renderLive(
          series,
          aggMax,
          own,
          agents.sum,
          agents.count,
          liveTtft(nowMs, agents.waitMs),
          ctxRef.ui.theme,
        ),
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
    spinI = 0;
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
  pi.on("turn_start", async (event) => {
    const ts = typeof event.timestamp === "number" && event.timestamp > 0 ? event.timestamp : now();
    turnAnchorMs = ts;
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
    spinI = 0;
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
        const rate = tpsTrustworthy(decodeMs, ttftMs) && tokens > 0 ? tokens / (decodeMs / 1000) : 0;
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
    if (tokens > 0 && tpsTrustworthy(decodeMs, ttftMs)) {
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
      H.wake?.();
      return;
    }

    streaming = false;
    paint();
  });

  // Tear down on /reload, /new, /resume, /fork, quit. Without this, a reload
  // mid-stream would orphan the old interval: the fresh module scope can't reach
  // it, so it would keep repainting the footer with a stale ctx indefinitely.
  pi.on("session_shutdown", async () => {
    stopTick();
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

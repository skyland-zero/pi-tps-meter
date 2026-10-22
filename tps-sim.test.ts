/**
 * Offline simulation harness for the TPS meter extension.
 *
 * Drives the extension through pi's real event sequence with a mocked
 * ExtensionAPI + ctx, controllable clock, and instrumented timers — so we can
 * assert the token math, TTFT handling, real-usage-vs-fallback, abort cleanup,
 * and sparkline memoization deterministically without a network call.
 *
 * Run: node tps-sim.test.ts   (Node 23 strips the type-only import)
 */
import tpsMeter from "./extensions/tps-meter.ts";

declare const process: { exit(code?: number): never };

// --- controllable clock ---
let T = 0;
const realNow = Date.now;
Date.now = () => T;

// --- instrumented timers (no real timers; count active) ---
let activeTimers = 0;
let lastIntervalCb: (() => void) | null = null;
// @ts-ignore - override globals for the test
globalThis.setInterval = ((cb: () => void) => {
  activeTimers++;
  lastIntervalCb = cb;
  return { id: activeTimers } as any;
}) as any;
// @ts-ignore
globalThis.clearInterval = ((_h: any) => {
  if (activeTimers > 0) activeTimers--;
  lastIntervalCb = null;
}) as any;

// --- mock pi + ctx ---
type Handler = (event: any, ctx: any) => any;
const handlers = new Map<string, Handler>();
const statuses: Record<string, string | undefined> = {};
const pi = { on: (name: string, h: Handler) => handlers.set(name, h) } as any;
const ctx = {
  ui: {
    theme: { fg: (_c: string, s: string) => s }, // strip color for plain assertions
    setStatus: (k: string, v: string | undefined) => {
      statuses[k] = v;
    },
  },
} as any;

const fire = (name: string, event: any) => handlers.get(name)?.(event, ctx);
const asst = (extra: any = {}) => ({ message: { role: "assistant", ...extra } });

// --- tiny assert ---
let failures = 0;
function ok(cond: boolean, label: string, detail = "") {
  const tag = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`[${tag}] ${label}${detail ? `  — ${detail}` : ""}`);
}
function approx(a: number, b: number, eps = 0.01) {
  return Math.abs(a - b) <= eps;
}
function num(s: string | undefined): number {
  const m = (s ?? "").match(/-?\d+(\.\d+)?/g);
  return m ? Number(m[0]) : NaN;
}

tpsMeter(pi);

// ============================================================
// Test 1: real usage.output is used, rate excludes TTFT
// ============================================================
T = 1000;
fire("message_start", asst());
ok(activeTimers === 1, "timer started on message_start", `active=${activeTimers}`);

T = 1300; // 300ms TTFT before first token
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
T = 2300; // 1.0s of generation after first token
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "x".repeat(40) },
});
// message_end at T=2300 with REAL 50 output tokens => 50 / (2300-1300)/1000 = 50 tps
fire("message_end", asst({ usage: { output: 50 } }));
ok(activeTimers === 0, "timer cleared on message_end", `active=${activeTimers}`);
{
  const v = num(statuses["tps"]);
  ok(approx(v, 50), "real tokens + TTFT-excluded rate = 50 tps", `got ${v} (${statuses["tps"]})`);
}

// ============================================================
// Test 2: fallback to char estimate when usage is absent
// chars=400 -> tokEst = ceil(400/4)=100 tokens over 2.0s = 50 tps
// ============================================================
fire("session_start", {});
// NB: `NaN !== NaN` is always true, so the old form of this check could never
// fail — assert the real condition instead.
ok(statuses["tps"] === undefined, "session_start clears status", `status=${statuses["tps"]}`);
T = 5000;
fire("message_start", asst());
T = 5000; // first token immediately
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "y".repeat(400) },
});
T = 7000; // 2.0s later
fire("message_end", asst()); // no usage field
{
  const v = num(statuses["tps"]);
  ok(approx(v, 50), "char/4 fallback when usage missing = 50 tps", `got ${v} (${statuses["tps"]})`);
}

// ============================================================
// Test 3: abort safety net — agent_end tears down a live timer
// ============================================================
fire("session_start", {});
T = 9000;
fire("message_start", asst());
ok(activeTimers === 1, "timer running mid-stream", `active=${activeTimers}`);
fire("agent_end", {});
ok(activeTimers === 0, "agent_end stops runaway timer on abort", `active=${activeTimers}`);

// ============================================================
// Test 4: tiny/empty responses are ignored (no noise samples)
// ============================================================
fire("session_start", {});
T = 11000;
fire("message_start", asst());
T = 11000;
fire("message_end", asst({ usage: { output: 0 } })); // zero tokens
ok(statuses["tps"] === undefined, "zero-token message produces no sample", `status=${statuses["tps"]}`);

// ============================================================
// Test 5: sparkline memoization — no work between message ends
// ============================================================
fire("session_start", {});
// feed a few completed messages so sparkline has data, then tick repeatedly
for (let i = 0; i < 3; i++) {
  T = 20000 + i * 2000;
  fire("message_start", asst());
  T += 0; // first token now
  fire("message_update", { ...asst(), assistantMessageEvent: { type: "text_delta", delta: "z".repeat(200) } });
  T += 1000;
  fire("message_end", asst({ usage: { output: 30 + i * 20 } }));
}
// Start a new stream and tick the live timer many times; sparkline is static
T = 30000;
fire("message_start", asst());
// `as any` defeats TS narrowing: the reassignments happen inside the
// setInterval override closure, which control-flow analysis can't see.
const liveCb: (() => void) | null = lastIntervalCb as any;
let crashed = false;
try {
  for (let i = 0; i < 50; i++) {
    T += 200;
    liveCb?.();
  }
} catch (e) {
  crashed = true;
  console.log("tick error:", (e as Error).message);
}
ok(!crashed && typeof statuses["tps"] === "string", "live ticks render without crashing", `status=${statuses["tps"]}`);
fire("agent_end", {});

// ============================================================
// Test 6: abort mid-stream restores the last final readout
// (regression: used to leave a frozen live gauge in the footer)
// ============================================================
fire("session_start", {});
T = 40000;
fire("message_start", asst());
fire("message_update", { ...asst(), assistantMessageEvent: { type: "text_delta", delta: "w".repeat(400) } });
T = 41000;
fire("message_end", asst({ usage: { output: 50 } })); // 50 tps final
const final1 = statuses["tps"];
ok(typeof final1 === "string" && final1.includes("μ"), "baseline final rendered", `status=${final1}`);
// Start a new stream and let the live timer paint once
T = 42000;
fire("message_start", asst());
T = 42500;
fire("message_update", { ...asst(), assistantMessageEvent: { type: "text_delta", delta: "w".repeat(40) } });
T = 42700;
(lastIntervalCb as any)?.();
const live = statuses["tps"];
ok(live !== final1, "live gauge painted mid-stream", `live=${live}`);
// Abort: no message_end, only agent_end
fire("agent_end", {});
ok(statuses["tps"] === final1, "agent_end restores last final after abort", `status=${statuses["tps"]}`);
ok(activeTimers === 0, "timer stopped on abort", `active=${activeTimers}`);

// ============================================================
// Test 7: session_shutdown tears down a live timer (no orphan
// interval surviving a /reload mid-stream)
// ============================================================
fire("session_start", {});
T = 50000;
fire("message_start", asst());
ok(activeTimers === 1, "timer running before shutdown", `active=${activeTimers}`);
fire("session_shutdown", {});
ok(activeTimers === 0, "session_shutdown stops live timer", `active=${activeTimers}`);

// ============================================================
// Test 8: zero-token message mid-session restores last final
// (regression: used to leave a frozen live gauge)
// ============================================================
fire("session_start", {});
T = 60000;
fire("message_start", asst());
fire("message_update", { ...asst(), assistantMessageEvent: { type: "text_delta", delta: "v".repeat(400) } });
T = 61000;
fire("message_end", asst({ usage: { output: 50 } }));
const final2 = statuses["tps"];
T = 62000;
fire("message_start", asst());
T = 62300;
(lastIntervalCb as any)?.(); // live gauge painted mid-stream
T = 62350;
fire("message_end", asst({ usage: { output: 0 } })); // zero tokens -> ignored sample
ok(statuses["tps"] === final2, "zero-token message restores last final", `status=${statuses["tps"]}`);

// ============================================================
// Subagent aggregation (multi-session): a child session reports its
// live counters into the process-wide hub, and the UI-owning session
// renders one merged total.
//
// Regression guard for the shared-module trap: children in the same cwd
// re-run this factory against the *same* module instance, so any state at
// module scope is shared with them (a spawn used to wipe the parent's
// μ/p95/sparkline and fold child tokens into the parent's counters).
// ============================================================

/** Build an independent pi instance + ctx for one session. */
function mkSession(hasUI: boolean, sid: string) {
  const hmap = new Map<string, Handler>();
  const status: Record<string, string | undefined> = {};
  const api = { on: (name: string, h: Handler) => hmap.set(name, h) } as any;
  const c = {
    hasUI,
    sessionManager: { getSessionId: () => sid },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (k: string, v: string | undefined) => {
        status[k] = v;
      },
    },
  } as any;
  return { api, c, status, fire: (name: string, event: any) => hmap.get(name)?.(event, c) };
}

// Park the single-session harness so it stops owning the hub's sink/wake slot.
fire("session_shutdown", {});

const parent = mkSession(true, "parent-1");
const child = mkSession(false, "child-1");
tpsMeter(parent.api);
tpsMeter(child.api);

// ============================================================
// Test 9: a subagent spawning must not disturb the parent readout
// (regression: module-scope state made children wipe the parent's series)
// ============================================================
parent.fire("session_start", {});
T = 70000;
parent.fire("message_start", asst());
parent.fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "p".repeat(400) },
});
T = 71000;
parent.fire("message_end", asst({ usage: { output: 50 } })); // 50 tps
const pFinal = parent.status["tps"];
ok(typeof pFinal === "string" && pFinal.includes("μ"), "parent baseline final rendered", `status=${pFinal}`);
child.fire("session_start", {}); // <- agent spawn
ok(
  parent.status["tps"] === pFinal,
  "child session_start leaves the parent series intact",
  `status=${parent.status["tps"]}`,
);

// ============================================================
// Test 10: concurrent parent + agent streams merge into one total
// own:    20 est tokens over 0.5s =  40 tps
// agent: 100 est tokens over 0.4s = 250 tps
// total:                           290 tps · 1a
// ============================================================
T = 72000;
parent.fire("message_start", asst());
T = 72100;
parent.fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "p".repeat(80) },
});
child.fire("message_start", asst());
T = 72200;
child.fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "c".repeat(400) },
});
T = 72600;
(lastIntervalCb as any)?.();
{
  const live = parent.status["tps"] ?? "";
  const total = num(live);
  ok(live.includes("Σ"), "merged live line marks the aggregate", `live=${live}`);
  ok(live.includes("· 1a"), "merged live line counts live agents", `live=${live}`);
  ok(approx(total, 290, 1), "total = parent rate + agent rate", `got ${total} (${live})`);
}

// ============================================================
// Test 11: parent settles while the agent still streams
// (the merged total must keep ticking, and must stop later)
// ============================================================
T = 73000;
parent.fire("message_end", asst({ usage: { output: 40 } }));
ok(activeTimers === 1, "timer stays up while an agent streams", `active=${activeTimers}`);
{
  const live = parent.status["tps"] ?? "";
  ok(live.includes("Σ") && live.includes("· 1a"), "readout stays merged after the parent settles", `live=${live}`);
}

// ============================================================
// Test 12: a settled agent message folds into the parent's series
// and the child never paints to its own (no-op) UI
// ============================================================
T = 74000;
child.fire("message_end", asst({ usage: { output: 200 } })); // 200 / 1.8s = 111.1 tps
ok(activeTimers === 0, "no agents left: parent timer stopped", `active=${activeTimers}`);
{
  const merged = parent.status["tps"] ?? "";
  ok(merged.includes("Σ") && merged.includes("μ"), "merged sample marked in the settled readout", `status=${merged}`);
  ok(child.status["tps"] === undefined, "child never paints to its no-op UI", `child=${child.status["tps"]}`);
}

// ============================================================
// Test 13: an agent stream wakes the parent renderer, and the agent's
// shutdown removes it from the hub
// ============================================================
child.fire("session_start", {});
child.fire("message_start", asst());
T = 75000;
child.fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "c".repeat(40) },
});
ok(activeTimers === 1, "an agent stream wakes the parent renderer", `active=${activeTimers}`);
T = 75600;
(lastIntervalCb as any)?.();
ok((parent.status["tps"] ?? "").includes("· 1a"), "merged line while the agent runs", `status=${parent.status["tps"]}`);
child.fire("session_shutdown", {});
ok(activeTimers === 0, "agent shutdown stops the parent renderer", `active=${activeTimers}`);
ok(!(parent.status["tps"] ?? "").includes("· 1a"), "readout settles back with no agents live", `status=${parent.status["tps"]}`);
parent.fire("session_shutdown", {});

// ============================================================
// Time-to-first-token (τ)
// ============================================================

// ============================================================
// Test 14: TTFT is anchored at turn_start, so it covers the whole
// end-to-end wait (prompt assembly included), not just the
// assistant message's own streaming window.
// turn_start=99000 -> first delta @103500 => τ = 4.5s
// decode 103500 -> 108500 = 5.0s, 250 tokens => 50 tps
// ============================================================
fire("session_start", {});
T = 100000;
fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 99000 });
fire("message_start", asst());
T = 103500;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "q".repeat(400) },
});
T = 108500;
fire("message_end", asst({ usage: { output: 250 } }));
{
  const st = statuses["tps"] ?? "";
  const v = num(st);
  ok(st.includes("τ4.5s"), "τ measured from turn_start (end-to-end)", `status=${st}`);
  ok(approx(v, 50), "decode rate still starts at the first token, not turn_start", `got ${v} (${st})`);
}

// ============================================================
// Test 14b: a long τ (hidden reasoning / slow provider) must NOT
// disqualify the decode that follows it.
// Regression: the guard used to reject any decode shorter than
// half the TTFT, so a τ above ~2x the generation time discarded
// every sample and the footer showed only `τ52.9s` — no tps.
// τ = 52.9s, decode 3.0s, 150 tokens => 50 tps: perfectly normal
// ============================================================
fire("session_start", {});
T = 146000;
fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 146000 });
T = 198900; // 52.9s before the model says anything observable
fire("message_start", asst());
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "thinking_delta", delta: "t".repeat(40) },
});
T = 201900; // 3.0s of decoding, 150 real tokens
fire("message_end", asst({ usage: { output: 150 } }));
{
  const st = statuses["tps"] ?? "";
  const v = num(st);
  ok(st.includes("tps"), "long τ still yields a tps sample", `status=${st}`);
  ok(st.includes("τ52.9s"), "long τ is reported honestly", `status=${st}`);
  ok(approx(v, 50), "decode rate after a long τ is 50 tps", `got ${v} (${st})`);
}

// ============================================================
// Test 15: while waiting for the first token the bar counts τ up
// and shows no tps at all (regression: used to read `0.0 tps`,
// which looked like a stall)
// ============================================================
fire("session_start", {});
T = 200000;
fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 200000 });
fire("message_start", asst());
T = 201000;
(lastIntervalCb as any)?.();
{
  const live = statuses["tps"] ?? "";
  ok(live.includes("τ1.0s"), "waiting bar counts τ up", `live=${live}`);
  ok(!live.includes("tps"), "waiting bar shows no rate", `live=${live}`);
}
T = 203500;
(lastIntervalCb as any)?.();
ok((statuses["tps"] ?? "").includes("τ3.5s"), "τ keeps counting during the wait", `live=${statuses["tps"]}`);
// first token lands -> τ locks and the rate readout appears next to it
T = 204000;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "r".repeat(400) },
});
T = 206000;
(lastIntervalCb as any)?.();
{
  const live = statuses["tps"] ?? "";
  ok(live.includes("tps") && live.includes("τ4.0s"), "first token locks τ and starts the rate", `live=${live}`);
}
fire("agent_end", {});

// ============================================================
// Test 16: buffered replay is rejected from the tps series but
// its TTFT is still recorded.
// 22s wait, then 1000 tokens flushed in 0.9s would read as 1147 tps
// ============================================================
fire("session_start", {});
T = 300000;
fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 300000 });
fire("message_start", asst());
T = 322000;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "b".repeat(4000) },
});
T = 322900;
fire("message_end", asst({ usage: { output: 1000 } }));
{
  const st = statuses["tps"] ?? "";
  ok(!st.includes("tps"), "buffered replay contributes no tps sample", `status=${st}`);
  ok(st.includes("τ22.0s"), "buffered replay still records its TTFT", `status=${st}`);
}
// …and a normal message afterwards is unaffected
T = 330000;
fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 330000 });
fire("message_start", asst());
T = 331000;
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "n".repeat(400) },
});
T = 333000;
fire("message_end", asst({ usage: { output: 50 } }));
{
  const st = statuses["tps"] ?? "";
  ok(st.includes("tps"), "a normal turn still produces a sample", `status=${st}`);
  ok(st.includes("τ11.5s"), "τ mean covers both turns", `status=${st}`);
}

// ============================================================
// Test 17: a subagent's TTFT folds into the parent's τ mean
// ============================================================
const p2 = mkSession(true, "parent-2");
const c2 = mkSession(false, "child-2");
tpsMeter(p2.api);
tpsMeter(c2.api);
T = 400000;
p2.fire("session_start", {});
c2.fire("session_start", {});
c2.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 400000 });
T = 401000;
c2.fire("message_start", asst());
T = 405000; // 5.0s TTFT (400000 -> 405000)
c2.fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "s".repeat(400) },
});
T = 411000; // 6.0s decode, 100 real tokens => 16.7 tps
c2.fire("message_end", asst({ usage: { output: 100 } }));
{
  const st = p2.status["tps"] ?? "";
  ok(st.includes("Σ"), "agent sample marks the parent series", `status=${st}`);
  ok(st.includes("τ5.0s"), "agent TTFT folds into the parent τ mean", `status=${st}`);
}
c2.fire("session_shutdown", {});
p2.fire("session_shutdown", {});

// ============================================================
// Test 18: τ is rendered during the pre-message window.
// turn_start -> assistant message_start is the longest part of the
// wait and produces no events at all. The ticker used to start at
// message_start, so the bar stayed frozen while pi showed its own
// "working" spinner, then τ appeared already large (τ14.2s).
// ============================================================
fire("session_start", {});
T = 500000;
fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 500000 });
ok(activeTimers === 1, "ticker starts at turn_start, not message_start", `active=${activeTimers}`);
T = 506000;
(lastIntervalCb as any)?.();
{
  const live = statuses["tps"] ?? "";
  ok(live.includes("τ6.0s"), "τ visible while pi is still 'working'", `live=${live}`);
  ok(!live.includes("tps"), "no rate yet in the pre-message window", `live=${live}`);
}
T = 514200;
// This is where the old build first painted: τ would have popped in at 14.2s.
fire("message_start", asst());
(lastIntervalCb as any)?.();
{
  const live = statuses["tps"] ?? "";
  ok(live.includes("τ14.2s"), "τ keeps the turn_start anchor across message_start", `live=${live}`);
}
T = 514400; // first token at +14.4s from turn_start
fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "u".repeat(400) },
});
T = 514500;
(lastIntervalCb as any)?.();
ok((statuses["tps"] ?? "").includes("τ14.4s"), "first token locks the full τ", `live=${statuses["tps"]}`);
// Abort mid-wait: a pending anchor must not keep the bar live forever.
fire("session_start", {});
T = 600000;
fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 600000 });
ok(activeTimers === 1, "pending turn keeps the ticker up", `active=${activeTimers}`);
T = 603000;
fire("agent_end", {}); // aborted before any assistant message
ok(activeTimers === 0, "abort during the wait stops the ticker", `active=${activeTimers}`);
ok(!(statuses["tps"] ?? "").includes("τ"), "abort during the wait leaves no stuck τ", `status=${statuses["tps"]}`);

// ============================================================
// Review findings
// ============================================================

const p3 = mkSession(true, "parent-3");
const c3 = mkSession(false, "child-3");
tpsMeter(p3.api);
tpsMeter(c3.api);

// ============================================================
// Test 19: a settled parent must not keep contributing its last
// message's rate to the merged total.
// own was computed from the previous message's tokens against a
// window that keeps growing, so a phantom rate decayed into the
// Σ while only the agent was actually producing.
// parent: 20 est tokens over 0.5s = 40 tps (then it settles)
// agent: 100 est tokens over 0.4s = 250 tps
// expected after the parent settles: Σ250 tps, not Σ290/147
// ============================================================
T = 800000;
p3.fire("session_start", {});
c3.fire("session_start", {});
p3.fire("message_start", asst());
T = 800100;
p3.fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "p".repeat(80) },
});
c3.fire("message_start", asst());
T = 800200;
c3.fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "c".repeat(400) },
});
T = 800600;
(lastIntervalCb as any)?.();
ok(approx(num(p3.status["tps"]), 290, 1), "both streaming: total includes both", `live=${p3.status["tps"]}`);
T = 801000;
p3.fire("message_end", asst({ usage: { output: 40 } })); // parent done, agent still going
(lastIntervalCb as any)?.();
{
  // agent alone: 100 est tokens / 0.8s = 125 tps. A phantom parent rate pushes
  // this to ~147.
  const v = num(p3.status["tps"]);
  ok(approx(v, 125, 1), "settled parent contributes no rate to the merge", `got ${v} (${p3.status["tps"]})`);
}

// ============================================================
// Test 20: the parent must see a subagent's PRE-message wait.
// Same bug class as test 18, one level down: a child that has
// fired turn_start but has no assistant message yet was not even
// counted as active, so the parent's bar stayed blank.
// ============================================================
c3.fire("message_end", asst({ usage: { output: 100 } }));
T = 810000;
c3.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 810000 });
T = 814000;
(lastIntervalCb as any)?.();
{
  const live = p3.status["tps"] ?? "";
  ok(live.includes("τ4.0s"), "parent sees a subagent's pre-message wait", `live=${live}`);
}

// ============================================================
// Test 21: a subagent whose first token takes longer than the reap
// timeout must not be dropped mid-stream. AGENT_REAP_MS exists to
// catch a dead owner; a session with no tokens is waiting, not dead
// — and reasoning models can wait minutes.
// ============================================================
T = 840000; // 30s after the child's turn_start, still no token
(lastIntervalCb as any)?.();
{
  const live = p3.status["tps"] ?? "";
  ok(live.includes("τ30.0s"), "a 30s first-token wait is not reaped", `live=${live}`);
}
T = 841000;
c3.fire("message_start", asst());
c3.fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "c".repeat(400) },
});
T = 843000;
(lastIntervalCb as any)?.();
ok((p3.status["tps"] ?? "").includes("tps"), "the agent's stream still reaches the parent", `live=${p3.status["tps"]}`);
c3.fire("agent_end", {});
p3.fire("agent_end", {});
c3.fire("session_shutdown", {});
p3.fire("session_shutdown", {});

// ============================================================
// Test 22: the spinner phase is per-session. It used to live at
// module scope, so two UI sessions in the same cwd (same module
// instance — pi caches per cwd) interleaved frames, and one
// session's session_start reset the other's animation.
// ============================================================
const u1 = mkSession(true, "ui-1");
const u2 = mkSession(true, "ui-2");
tpsMeter(u1.api);
tpsMeter(u2.api);
T = 900000;
u1.fire("session_start", {});
u2.fire("session_start", {});
T = 901000;
u1.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 901000 });
(lastIntervalCb as any)?.();
const g1 = (u1.status["tps"] ?? "")[0];
// A fresh session's first frame must be the first glyph, not wherever the
// shared counter had got to.
T = 902000;
u2.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 902000 });
(lastIntervalCb as any)?.();
const g2 = (u2.status["tps"] ?? "")[0];
ok(g1 === "⠋" && g2 === "⠋", "spinner phase is per session", `u1=${g1} u2=${g2}`);
u1.fire("session_shutdown", {});
u2.fire("session_shutdown", {});

// ============================================================
// Test 23: an agent that has its first token but no measurable
// rate yet must read as its τ, not `0.0 tps` — the same rule the
// session applies to itself. It also has to say `· 1a`, or a
// subagent's wait is indistinguishable from your own.
// ============================================================
const p4 = mkSession(true, "parent-4");
const c4 = mkSession(false, "child-4");
tpsMeter(p4.api);
tpsMeter(c4.api);
T = 1_000_000;
p4.fire("session_start", {});
c4.fire("session_start", {});
c4.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1_000_000 });
c4.fire("message_start", asst());
T = 1_001_000;
c4.fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "c".repeat(400) },
});
T = 1_001_200; // only 200ms of signal — `rate()` has nothing usable yet
(lastIntervalCb as any)?.();
{
  const live = p4.status["tps"] ?? "";
  ok(!live.includes("0.0 tps"), "early agent tokens do not read as 0.0 tps", `live=${live}`);
  ok(live.includes("τ1.0s") && live.includes("· 1a"), "the agent's τ and count are shown", `live=${live}`);
}
T = 1_004_000; // now the rate is measurable
(lastIntervalCb as any)?.();
{
  const live = p4.status["tps"] ?? "";
  ok(live.includes("Σ") && live.includes("tps"), "a measurable agent rate takes over", `live=${live}`);
  ok(live.includes("τ1.0s"), "the agent's locked τ rides along", `live=${live}`);
}

// ============================================================
// Test 24: an agent that produced tokens and then went silent is
// reaped (its owner died without a shutdown event) — but only on
// the short timeout, and only when its live rate would otherwise
// keep inflating the merged total.
// ============================================================
T = 1_020_000;
(lastIntervalCb as any)?.();
ok((p4.status["tps"] ?? "").includes("· 1a"), "silent-but-recent agent is still live", `live=${p4.status["tps"]}`);
T = 1_040_000; // 39s of silence, no shutdown event ever arrives
(lastIntervalCb as any)?.();
ok(!(p4.status["tps"] ?? "").includes("· 1a"), "a dead token-producing agent is reaped", `status=${p4.status["tps"]}`);
p4.fire("session_shutdown", {});

// ============================================================
// Test 25: idling past the 60s rolling window must not make the
// settled readout claim `0.0 tps`.
// seriesAvg() returned 0 for an empty window, so any repaint after
// a pause (here: an abort) rendered a rate of zero for a session
// with real history — and that string became lastFinal, sticking.
// ============================================================
const idle = mkSession(true, "idle-1");
tpsMeter(idle.api);
T = 2_000_000;
idle.fire("session_start", {});
idle.fire("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 2_000_000 });
T = 2_000_400;
idle.fire("message_start", asst());
T = 2_000_500;
idle.fire("message_update", {
  ...asst(),
  assistantMessageEvent: { type: "text_delta", delta: "i".repeat(800) },
});
T = 2_008_000;
idle.fire("message_end", asst({ usage: { output: 400 } }));
const settled = idle.status["tps"] ?? "";
ok(approx(num(settled), 53, 1), "baseline settled rate", `status=${settled}`);
// 90s of idling, then a request the user aborts before any token
T = 2_098_000;
idle.fire("turn_start", { type: "turn_start", turnIndex: 1, timestamp: 2_098_000 });
T = 2_118_000;
idle.fire("agent_end", {});
{
  const st = idle.status["tps"] ?? "";
  ok(!st.includes("0.0 tps"), "an empty rolling window does not read as 0.0 tps", `status=${st}`);
  ok(approx(num(st), 53, 1), "it falls back to the session mean", `got ${num(st)} (${st})`);
}
// …and the stale string must not have been recorded as the new lastFinal either
T = 2_200_000;
idle.fire("turn_start", { type: "turn_start", turnIndex: 2, timestamp: 2_200_000 });
T = 2_201_000;
idle.fire("agent_end", {});
ok(!(idle.status["tps"] ?? "").includes("0.0 tps"), "and it does not stick either", `status=${idle.status["tps"]}`);
idle.fire("session_shutdown", {});

// --- restore + summary ---
Date.now = realNow;
console.log("\n" + (failures === 0 ? "ALL TESTS PASSED ✅" : `${failures} TEST(S) FAILED ❌`));
process.exit(failures === 0 ? 0 : 1);

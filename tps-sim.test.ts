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
ok(num(statuses["tps"]) !== num(statuses["tps"]) || statuses["tps"] === undefined, "session_start clears status", `status=${statuses["tps"]}`);
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

// --- restore + summary ---
Date.now = realNow;
console.log("\n" + (failures === 0 ? "ALL TESTS PASSED ✅" : `${failures} TEST(S) FAILED ❌`));
process.exit(failures === 0 ? 0 : 1);

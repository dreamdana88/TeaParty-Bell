import {
  computeJitterMs,
  computeTimerDelayMs,
  decideNextWakeAt,
  MAX_TIMER_DELAY_MS,
} from "./schedulerDecision.js";
import { SCHEDULER_REFERENCE_DEFAULTS } from "./schedulerConfig.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(a, e, l) {
  assert(a === e, `${l}`);
}

console.log("\n=== ForumBump schedulerDecision ===\n");

const config = {
  enabled: true,
  guildId: "111111111111111111",
  forumChannelIds: ["222222222222222222"],
  ...SCHEDULER_REFERENCE_DEFAULTS,
};

{
  const j0 = computeJitterMs(0, 600_000);
  assert(j0.ok && j0.jitterMs === 0, "jitter min 0");
  const j1 = computeJitterMs(0.999999, 600_000);
  assert(j1.ok && j1.jitterMs === 600_000, "jitter max");
  assert(!computeJitterMs(1, 10).ok, "random=1 非法");
  assert(!computeJitterMs(-0.1, 10).ok, "random 负非法");
}

{
  const now = Date.parse("2026-07-28T00:00:00.000Z"); // 08:00 SH
  const d = decideNextWakeAt({
    nowMs: now,
    config,
    state: { successCount: 0, nextEligibleAt: null, paused: false, localDate: "2026-07-28" },
    reason: "ready",
  });
  assertEqual(d.reason, "outside_window", "窗外");
  assertEqual(
    new Date(d.nextWakeAt).toISOString(),
    "2026-07-28T02:00:00.000Z",
    "安排到 10:00",
  );
}

{
  const now = Date.parse("2026-07-28T03:00:00.000Z"); // 11:00 SH
  const d = decideNextWakeAt({
    nowMs: now,
    config,
    state: {
      successCount: 10,
      nextEligibleAt: null,
      paused: false,
      localDate: "2026-07-28",
    },
    reason: "ready",
  });
  assertEqual(d.reason, "daily_limit", "每日上限");
}

{
  const now = Date.parse("2026-07-28T03:00:00.000Z");
  const d = decideNextWakeAt({
    nowMs: now,
    config,
    state: {
      successCount: 0,
      nextEligibleAt: "2026-07-28T04:00:00.000Z",
      paused: false,
      localDate: "2026-07-28",
    },
    reason: "ready",
  });
  assertEqual(d.reason, "cooldown", "冷却中");
}

{
  assertEqual(computeTimerDelayMs(0, MAX_TIMER_DELAY_MS + 1000), MAX_TIMER_DELAY_MS, "长 timer 分段");
}

console.log(`\nForumBump schedulerDecision: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

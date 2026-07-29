/**
 * 自动顶帖间隔纯函数测试。
 */
import {
  computeActiveWindowMinutes,
  computeAutoInterval,
  recomputeNextEligibleAfterConfigChange,
  MIN_AUTO_INTERVAL_MINUTES,
} from "./autoInterval.js";

let passed = 0;
let failed = 0;
function assert(c, l) {
  if (c) { passed++; console.log(`  PASS: ${l}`); }
  else { failed++; console.error(`  FAIL: ${l}`); }
}
function assertEqual(a, e, l) {
  assert(a === e, `${l} (got ${JSON.stringify(a)})`);
}

console.log("\n=== forumBump autoInterval ===\n");

// 08:00–13:00 + 5 → 60 分钟
{
  const r = computeAutoInterval("08:00", "13:00", 5);
  assert(r.ok, "5 次可计算");
  assertEqual(r.windowMinutes, 300, "窗口 300 分钟");
  assertEqual(r.intervalMinutes, 60, "间隔 60 分钟");
  assertEqual(r.intervalMs, 60 * 60_000, "间隔 60min ms");
}

// 08:00–13:00 + 10 → 30 分钟
{
  const r = computeAutoInterval("08:00", "13:00", 10);
  assert(r.ok, "10 次可计算");
  assertEqual(r.intervalMinutes, 30, "间隔 30 分钟");
  assertEqual(r.intervalMs, 30 * 60_000, "间隔 30min ms");
}

// 不足 30 分钟拒绝
{
  // 60 分钟窗口 / 3 = 20 分钟 < 30
  const r = computeAutoInterval("10:00", "11:00", 3);
  assert(!r.ok, "过短间隔拒绝");
  assertEqual(r.errorCode, "DYNAMIC_CONFIG_INTERVAL_TOO_SHORT", "TOO_SHORT");
}

// dailyLimit=1
{
  const r = computeAutoInterval("10:00", "22:00", 1);
  assert(r.ok, "dailyLimit=1 ok");
  assertEqual(r.intervalMinutes, 12 * 60, "全日窗间隔=窗口长");
}

// 非整除时间窗
{
  // 300 / 7 ≈ 42.857 → >= 30 ok
  const r = computeAutoInterval("08:00", "13:00", 7);
  assert(r.ok, "非整除可接受");
  assert(r.exactMinutes > 42 && r.exactMinutes < 43, "exact ~42.86");
  assert(r.intervalMs === Math.floor((300 * 60_000) / 7), "ms floor 精确");
}

// 边界恰好 30
{
  const r = computeAutoInterval("10:00", "15:00", 10); // 300/10=30
  assert(r.ok, "恰好 30 分钟通过");
  assertEqual(r.intervalMinutes, MIN_AUTO_INTERVAL_MINUTES, "min 30");
}

// recompute：已达 dailyLimit
{
  const nowMs = Date.parse("2026-07-28T12:00:00.000Z");
  const r = recomputeNextEligibleAfterConfigChange({
    nowMs,
    config: {
      timezone: "UTC",
      activeStart: "10:00",
      activeEnd: "22:00",
      dailyLimit: 2,
      cooldownMs: 60 * 60_000,
    },
    state: { successCount: 2, lastSuccessAt: "2026-07-28T11:00:00.000Z" },
  });
  assertEqual(r.reason, "daily_limit", "达上限 → 下一日");
  assert(r.nextEligibleAtMs > nowMs, "唤醒在未来");
}

// recompute：窗外
{
  const nowMs = Date.parse("2026-07-28T02:00:00.000Z"); // UTC 02:00 在 10–22 外
  const r = recomputeNextEligibleAfterConfigChange({
    nowMs,
    config: {
      timezone: "UTC",
      activeStart: "10:00",
      activeEnd: "22:00",
      dailyLimit: 5,
      cooldownMs: 60 * 60_000,
    },
    state: { successCount: 0, lastSuccessAt: null },
  });
  assertEqual(r.reason, "outside_window", "窗外");
}

// recompute：今日无成功且窗内 → ready
{
  const nowMs = Date.parse("2026-07-28T12:00:00.000Z");
  const r = recomputeNextEligibleAfterConfigChange({
    nowMs,
    config: {
      timezone: "UTC",
      activeStart: "10:00",
      activeEnd: "22:00",
      dailyLimit: 5,
      cooldownMs: 60 * 60_000,
    },
    state: { successCount: 0, lastSuccessAt: null },
  });
  assertEqual(r.reason, "ready", "无成功可立即检查");
  assertEqual(r.nextEligibleAtMs, nowMs, "next=now");
}

// recompute：今日已有成功 → max(now, last+interval)
{
  const nowMs = Date.parse("2026-07-28T12:00:00.000Z");
  const last = "2026-07-28T11:30:00.000Z";
  const interval = 60 * 60_000;
  const r = recomputeNextEligibleAfterConfigChange({
    nowMs,
    config: {
      timezone: "UTC",
      activeStart: "10:00",
      activeEnd: "22:00",
      dailyLimit: 5,
      cooldownMs: interval,
    },
    state: { successCount: 1, lastSuccessAt: last },
  });
  assertEqual(r.reason, "cooldown", "有成功走冷却");
  assertEqual(r.nextEligibleAtMs, Date.parse(last) + interval, "last+interval");
}

// 无追赶：last+interval 已过时 → now
{
  const nowMs = Date.parse("2026-07-28T15:00:00.000Z");
  const last = "2026-07-28T11:00:00.000Z";
  const interval = 60 * 60_000;
  const r = recomputeNextEligibleAfterConfigChange({
    nowMs,
    config: {
      timezone: "UTC",
      activeStart: "10:00",
      activeEnd: "22:00",
      dailyLimit: 5,
      cooldownMs: interval,
    },
    state: { successCount: 1, lastSuccessAt: last },
  });
  assertEqual(r.nextEligibleAtMs, nowMs, "过期不追赶，钳到 now");
}

assertEqual(computeActiveWindowMinutes("08:00", "13:00"), 300, "window helper");

console.log(`\n=== autoInterval: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);

/**
 * 自动顶帖间隔与动态额度纯函数测试。
 */
import {
  computeActiveWindowMinutes,
  computeAutoInterval,
  computeMaxDailyLimit,
  recomputeNextEligibleAfterConfigChange,
  validateDailyLimitForWindow,
  MIN_AUTO_INTERVAL_MINUTES,
  ABSOLUTE_DAILY_LIMIT_MAX,
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
  assertEqual(r.maxDailyLimit, 10, "08–13 max=10");
}

// 08:00–13:00 + 10 通过；11 拒绝
{
  const r10 = computeAutoInterval("08:00", "13:00", 10);
  assert(r10.ok, "08–13 额度 10 通过");
  assertEqual(r10.intervalMinutes, 30, "间隔 30 分钟");

  const r11 = computeAutoInterval("08:00", "13:00", 11);
  assert(!r11.ok, "08–13 额度 11 拒绝");
  assertEqual(r11.errorCode, "DYNAMIC_CONFIG_INTERVAL_TOO_SHORT", "TOO_SHORT");
  assertEqual(r11.maxDailyLimit, 10, "提示 max=10");
  assert(r11.safeMessage.includes("最多支持 10 次"), "中文 max 提示");
}

// 10:00–22:00 + 24 通过；25 拒绝
{
  const max = computeMaxDailyLimit("10:00", "22:00");
  assert(max.ok, "10–22 max ok");
  assertEqual(max.maxDailyLimit, 24, "720/30=24");
  assertEqual(max.windowMinutes, 720, "720 分钟");

  assert(computeAutoInterval("10:00", "22:00", 24).ok, "额度 24 通过");
  const r25 = computeAutoInterval("10:00", "22:00", 25);
  assert(!r25.ok, "额度 25 拒绝");
  assertEqual(r25.maxDailyLimit, 24, "max 24");
}

// 08:00–23:00 + 30 通过；超过 30 永远拒绝
{
  const max = computeMaxDailyLimit("08:00", "23:00");
  assert(max.ok, "08–23 max ok");
  assertEqual(max.maxDailyLimit, 30, "900min 钳到 30");
  assert(computeAutoInterval("08:00", "23:00", 30).ok, "额度 30 通过");

  const r31 = computeAutoInterval("08:00", "23:00", 31);
  assert(!r31.ok, "超过 30 拒绝");
  assertEqual(r31.safeMessage, "每日额度最多为 30 次。", "绝对上限文案");
  assertEqual(ABSOLUTE_DAILY_LIMIT_MAX, 30, "常量 30");
}

// dailyLimit=1
{
  const r = computeAutoInterval("10:00", "22:00", 1);
  assert(r.ok, "dailyLimit=1 ok");
  assertEqual(r.intervalMinutes, 12 * 60, "全日窗间隔=窗口长");
}

// 非整小时活跃时间 floor
{
  // 08:00–13:15 = 315 分钟 → floor(315/30)=10
  const max = computeMaxDailyLimit("08:00", "13:15");
  assertEqual(max.maxDailyLimit, 10, "315/30 floor=10");
  assert(computeAutoInterval("08:00", "13:15", 10).ok, "非整点 10 通过");
  assert(!computeAutoInterval("08:00", "13:15", 11).ok, "非整点 11 拒绝");
}

// 非整除时间窗
{
  const r = computeAutoInterval("08:00", "13:00", 7);
  assert(r.ok, "非整除可接受");
  assert(r.exactMinutes > 42 && r.exactMinutes < 43, "exact ~42.86");
  assert(r.intervalMs === Math.floor((300 * 60_000) / 7), "ms floor 精确");
}

// 边界恰好 30 分钟间隔
{
  const r = computeAutoInterval("10:00", "15:00", 10); // 300/10=30
  assert(r.ok, "恰好 30 分钟通过");
  assertEqual(r.intervalMinutes, MIN_AUTO_INTERVAL_MINUTES, "min 30");
}

// validateDailyLimitForWindow 与 compute 一致
{
  const v = validateDailyLimitForWindow("10:00", "22:00", 24);
  assert(v.ok, "validate 24 ok");
  const bad = validateDailyLimitForWindow("10:00", "22:00", 25);
  assert(!bad.ok, "validate 25 fail");
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
  const nowMs = Date.parse("2026-07-28T02:00:00.000Z");
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

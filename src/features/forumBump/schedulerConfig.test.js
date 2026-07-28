import {
  SCHEDULER_REFERENCE_DEFAULTS,
  validateSchedulerConfig,
} from "./schedulerConfig.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}

console.log("\n=== ForumBump schedulerConfig ===\n");

const base = {
  enabled: true,
  guildId: "111111111111111111",
  forumChannelIds: ["222222222222222222", "222222222222222222"],
  ...SCHEDULER_REFERENCE_DEFAULTS,
};

{
  const c = validateSchedulerConfig(base);
  assert(c.forumChannelIds.length === 1, "forum 去重");
  assert(c.dailyLimit === 10, "dailyLimit");
}

for (const [cfg, label] of [
  [{ ...base, enabled: "yes" }, "enabled 非 boolean"],
  [{ ...base, guildId: "x" }, "非法 guild"],
  [{ ...base, forumChannelIds: [] }, "空 forum"],
  [{ ...base, silenceDays: 0 }, "silence 0"],
  [{ ...base, dailyLimit: 0 }, "dailyLimit 0"],
  [{ ...base, timezone: "Not/AZone" }, "非法时区"],
  [{ ...base, activeStart: "22:00", activeEnd: "10:00" }, "跨午夜"],
  [{ ...base, activeStart: "10:00", activeEnd: "10:00" }, "起止相等"],
]) {
  try {
    validateSchedulerConfig(cfg);
    assert(false, label);
  } catch (e) {
    assert(e.code === "SCHEDULER_CONFIG_INVALID", label);
  }
}

console.log(`\nForumBump schedulerConfig: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

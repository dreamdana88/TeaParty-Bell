import {
  isDiscordSnowflake,
  resolveActivityTime,
  snowflakeToTimestampMs,
} from "./activityTime.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label} (got ${JSON.stringify(actual)})`);
}

console.log("\n=== ForumBump activityTime ===\n");

assert(isDiscordSnowflake("1423941620847480982"), "合法 snowflake");
assert(!isDiscordSnowflake("abc"), "非法 snowflake");
assert(!isDiscordSnowflake(""), "空字符串");

{
  const id = "1531539984471818262";
  const ts = snowflakeToTimestampMs(id);
  assert(typeof ts === "number" && ts > 0, "snowflake 解析为正数");
  const r = resolveActivityTime({ lastMessageId: id, archiveTimestamp: 1 });
  assertEqual(r.activitySource, "last_message_snowflake", "优先 lastMessageId");
  assertEqual(r.activityAt, ts, "activityAt = snowflake 时间");
}

{
  // lastMessageId 时间早于 archiveTimestamp → 仍用 lastMessageId
  const oldMsg = "1429163615671423037"; // ~2025-10-18
  const laterArchive = 1785217986919; // ~2026-07-28
  const r = resolveActivityTime({ lastMessageId: oldMsg, archiveTimestamp: laterArchive });
  assertEqual(r.activitySource, "last_message_snowflake", "不得 max 到 archive");
  assertEqual(r.activityAt, snowflakeToTimestampMs(oldMsg), "结果仍是 lastMessageId 时间");
  assert(r.activityAt < laterArchive, "activityAt 早于 archiveTimestamp");
}

{
  const r = resolveActivityTime({ lastMessageId: null, archiveTimestamp: 1_700_000_000_000 });
  assertEqual(r.activitySource, "archive_timestamp_fallback", "缺失 lastMessageId → fallback");
  assertEqual(r.activityAt, 1_700_000_000_000, "archive 时间");
}

{
  const r = resolveActivityTime({ lastMessageId: "not-a-snowflake", archiveTimestamp: 1_700_000_000_000 });
  assertEqual(r.activitySource, "archive_timestamp_fallback", "非法 lastMessageId → fallback");
}

{
  const r = resolveActivityTime({ lastMessageId: null, archiveTimestamp: null });
  assertEqual(r.activitySource, "uncertain", "双缺失 → uncertain");
  assertEqual(r.activityAt, null, "activityAt null");
}

{
  const r = resolveActivityTime({ lastMessageId: "bad", archiveTimestamp: "also-bad" });
  assertEqual(r.activitySource, "uncertain", "双非法 → uncertain");
}

console.log(`\nForumBump activityTime: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

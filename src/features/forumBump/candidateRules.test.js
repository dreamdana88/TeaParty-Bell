import { ChannelType } from "discord.js";
import {
  countSkipReasons,
  evaluateThreadCandidate,
  sortCandidates,
  SKIP_REASONS,
} from "./candidateRules.js";
import { snowflakeToTimestampMs } from "./activityTime.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label} (got ${JSON.stringify(actual)})`);
}

const GUILD = "111111111111111111";
const FORUM = "222222222222222222";
const NOW = 1_800_000_000_000;

function baseThread(overrides = {}) {
  // 40 天前的消息 snowflake 近似：用固定已知旧 id 时间
  const oldId = "1429163615671423037";
  return {
    id: "333333333333333333",
    type: ChannelType.PublicThread,
    guildId: GUILD,
    parentId: FORUM,
    name: "post",
    archived: false,
    locked: false,
    pinned: false,
    lastMessageId: oldId,
    archiveTimestamp: NOW - 10 * 86400000,
    appliedTags: [],
    ...overrides,
  };
}

function perms(ok = true) {
  return {
    viewChannel: ok,
    sendMessagesInThreads: ok,
  };
}

console.log("\n=== ForumBump candidateRules ===\n");

{
  const r = evaluateThreadCandidate(baseThread(), {
    guildId: GUILD,
    forumChannelId: FORUM,
    silenceDays: 30,
    nowMs: NOW,
    permissions: perms(true),
  });
  assertEqual(r.eligible, true, "达到沉默门槛可入选");
  assert(r.silenceDaysExact > 30, "silenceDaysExact > 30");
}

{
  // 刚好等于：activityAt = NOW - 30d
  const activityAt = NOW - 30 * 86400000;
  // 构造 snowflake 不便，直接测：用 archive fallback 通过 mock lastMessageId 非法
  const r = evaluateThreadCandidate(baseThread({
    lastMessageId: null,
    archiveTimestamp: activityAt,
  }), {
    guildId: GUILD,
    forumChannelId: FORUM,
    silenceDays: 30,
    nowMs: NOW,
    permissions: perms(true),
  });
  assertEqual(r.eligible, true, "刚好等于沉默门槛可入选");
}

{
  const recentId = "1531539984471818262"; // 2026-07-28
  const r = evaluateThreadCandidate(baseThread({ lastMessageId: recentId }), {
    guildId: GUILD,
    forumChannelId: FORUM,
    silenceDays: 30,
    nowMs: snowflakeToTimestampMs(recentId) + 1000,
    permissions: perms(true),
  });
  assertEqual(r.eligible, false, "未达到沉默门槛");
  assertEqual(r.skipReason, SKIP_REASONS.NOT_SILENT_ENOUGH, "NOT_SILENT_ENOUGH");
}

{
  const r = evaluateThreadCandidate(baseThread({ locked: true }), {
    guildId: GUILD, forumChannelId: FORUM, silenceDays: 30, nowMs: NOW, permissions: perms(),
  });
  assertEqual(r.skipReason, SKIP_REASONS.THREAD_LOCKED, "locked");
}

{
  const r = evaluateThreadCandidate(baseThread({ pinned: true }), {
    guildId: GUILD, forumChannelId: FORUM, silenceDays: 30, nowMs: NOW, permissions: perms(),
  });
  assertEqual(r.skipReason, SKIP_REASONS.THREAD_PINNED, "pinned");
}

{
  const r = evaluateThreadCandidate(baseThread({ appliedTags: ["tag-x"] }), {
    guildId: GUILD, forumChannelId: FORUM, silenceDays: 30, nowMs: NOW,
    excludedTagIds: ["tag-x"], permissions: perms(),
  });
  assertEqual(r.skipReason, SKIP_REASONS.EXCLUDED_TAG, "excluded tag");
}

{
  const r = evaluateThreadCandidate(baseThread(), {
    guildId: GUILD, forumChannelId: FORUM, silenceDays: 30, nowMs: NOW,
    permissions: { viewChannel: false, sendMessagesInThreads: true },
  });
  assertEqual(r.skipReason, SKIP_REASONS.BOT_MISSING_PERMISSION, "缺 ViewChannel");
}

{
  const r = evaluateThreadCandidate(baseThread(), {
    guildId: GUILD, forumChannelId: FORUM, silenceDays: 30, nowMs: NOW,
    permissions: { viewChannel: true, sendMessagesInThreads: false },
  });
  assertEqual(r.skipReason, SKIP_REASONS.BOT_MISSING_PERMISSION, "缺 SendMessagesInThreads");
}

{
  const r = evaluateThreadCandidate(baseThread(), {
    guildId: GUILD, forumChannelId: FORUM, silenceDays: 30, nowMs: NOW,
    permissions: { viewChannel: null, sendMessagesInThreads: null },
  });
  assertEqual(r.skipReason, SKIP_REASONS.BOT_PERMISSION_UNCERTAIN, "权限不确定");
}

{
  const r = evaluateThreadCandidate(baseThread({ lastMessageId: null, archiveTimestamp: null }), {
    guildId: GUILD, forumChannelId: FORUM, silenceDays: 30, nowMs: NOW, permissions: perms(),
  });
  assertEqual(r.skipReason, SKIP_REASONS.ACTIVITY_UNCERTAIN, "activity uncertain");
}

{
  const r = evaluateThreadCandidate(baseThread({ archived: true }), {
    guildId: GUILD, forumChannelId: FORUM, silenceDays: 30, nowMs: NOW, permissions: perms(),
  });
  assertEqual(r.eligible, true, "已归档可入选");
}

{
  const r = evaluateThreadCandidate(baseThread({ archived: false }), {
    guildId: GUILD, forumChannelId: FORUM, silenceDays: 30, nowMs: NOW, permissions: perms(),
  });
  assertEqual(r.eligible, true, "活跃但长期沉默可入选");
}

{
  const r = evaluateThreadCandidate(baseThread({ type: ChannelType.PrivateThread }), {
    guildId: GUILD, forumChannelId: FORUM, silenceDays: 30, nowMs: NOW, permissions: perms(),
  });
  assertEqual(r.skipReason, SKIP_REASONS.THREAD_WRONG_TYPE, "PrivateThread");
}

// 排序
{
  const a = { threadId: "2", activityAt: 100, eligible: true };
  const b = { threadId: "1", activityAt: 100, eligible: true };
  const c = { threadId: "9", activityAt: 50, eligible: true };
  const sorted = sortCandidates([a, b, c]);
  assertEqual(sorted[0].threadId, "9", "最久活动优先");
  assertEqual(sorted[1].threadId, "1", "相同 activityAt 时 threadId 升序");
  assertEqual(sorted[2].threadId, "2", "threadId 第二");
}

{
  const input1 = sortCandidates([
    { threadId: "b", activityAt: 10 },
    { threadId: "a", activityAt: 10 },
  ]);
  const input2 = sortCandidates([
    { threadId: "a", activityAt: 10 },
    { threadId: "b", activityAt: 10 },
  ]);
  assertEqual(input1[0].threadId, input2[0].threadId, "输入顺序不同输出稳定");
}

{
  const records = [
    { eligible: false, skipReason: SKIP_REASONS.THREAD_PINNED },
    { eligible: false, skipReason: SKIP_REASONS.THREAD_LOCKED },
    { eligible: true },
  ];
  const counts = countSkipReasons(records);
  assertEqual(counts.pinned, 1, "pinned 计数");
  assertEqual(counts.locked, 1, "locked 计数");
}

console.log(`\nForumBump candidateRules: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

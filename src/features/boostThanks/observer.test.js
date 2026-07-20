/**
 * observer.js 单元测试（Phase 2）。
 *
 * 使用最小 mock 对象模拟 discord.js Message，
 * 不依赖真实 Discord 连接。
 *
 * 运行：node src/features/boostThanks/observer.test.js
 */

import { extractBoostObservation } from "./observer.js";
import { isBoostMessageType, BOOST_MESSAGE_TYPES } from "./constants.js";
import { MessageType } from "discord.js";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.error(`  FAIL: ${label}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual === expected) {
    passed++;
    console.log(`  PASS: ${label} (${JSON.stringify(expected)})`);
  } else {
    failed++;
    console.error(`  FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertNotNull(value, label) {
  if (value !== null && value !== undefined) {
    passed++;
    console.log(`  PASS: ${label} — not null`);
  } else {
    failed++;
    console.error(`  FAIL: ${label} — was ${value}`);
  }
}

/**
 * 创建 mock Message 对象，仅包含 observer 所需字段。
 */
function makeMockMessage(overrides = {}) {
  return {
    id: overrides.id ?? "1234567890",
    type: overrides.type ?? MessageType.Default,
    system: overrides.system ?? false,
    guildId: overrides.guildId ?? "111111111111",
    channelId: overrides.channelId ?? "222222222222",
    author: overrides.author === null ? null : {
      id: overrides.author?.id ?? "333333333333",
      username: overrides.author?.username ?? "TestUser",
    },
    member: overrides.member === undefined
      ? { displayName: "TestDisplay" }
      : overrides.member,
    createdTimestamp: overrides.createdTimestamp ?? 1700000000000,
    partial: overrides.partial ?? false,
  };
}

// ============================================================
// Test Suite
// ============================================================

console.log("\n=== 测试 1：BOOST_MESSAGE_TYPES 常量 ===\n");

assert(BOOST_MESSAGE_TYPES.has(8), "包含 GuildBoost (8)");
assert(BOOST_MESSAGE_TYPES.has(9), "包含 GuildBoostTier1 (9)");
assert(BOOST_MESSAGE_TYPES.has(10), "包含 GuildBoostTier2 (10)");
assert(BOOST_MESSAGE_TYPES.has(11), "包含 GuildBoostTier3 (11)");
assert(BOOST_MESSAGE_TYPES.size === 4, "共 4 种 Boost 类型");
assert(!BOOST_MESSAGE_TYPES.has(0), "不包含 Default (0)");
assert(!BOOST_MESSAGE_TYPES.has(7), "不包含 UserJoin (7)");

console.log("\n=== 测试 2：isBoostMessageType 函数 ===\n");

assert(isBoostMessageType(8) === true, "type 8 → true");
assert(isBoostMessageType(9) === true, "type 9 → true");
assert(isBoostMessageType(10) === true, "type 10 → true");
assert(isBoostMessageType(11) === true, "type 11 → true");
assert(isBoostMessageType(0) === false, "type 0 → false");
assert(isBoostMessageType(7) === false, "type 7 → false");
assert(isBoostMessageType(1) === false, "type 1 → false");
assert(isBoostMessageType(12) === false, "type 12 → false");

console.log("\n=== 测试 3：普通消息不应触发 ===\n");

const normalMsg = makeMockMessage({ type: MessageType.Default });
const result1 = extractBoostObservation(normalMsg);
assert(result1 === null, "Default 消息返回 null");

const replyMsg = makeMockMessage({ type: MessageType.Reply, system: false });
const result1b = extractBoostObservation(replyMsg);
assert(result1b === null, "Reply 消息返回 null");

console.log("\n=== 测试 4：每个 Boost 类型都能正确识别 ===\n");

for (const typeNum of [8, 9, 10, 11]) {
  const msg = makeMockMessage({ type: typeNum, system: true });
  const obs = extractBoostObservation(msg);
  assertNotNull(obs, `type ${typeNum} 返回非 null`);
  if (obs) {
    assertEqual(obs.messageType, typeNum, `  messageType = ${typeNum}`);
    assertEqual(obs.messageId, "1234567890", "  messageId");
    assertEqual(obs.authorId, "333333333333", "  authorId");
    assertEqual(obs.authorUsername, "TestUser", "  authorUsername");
  }
}

console.log("\n=== 测试 5：非 Boost 系统消息不误触发 ===\n");

const nonBoostSystemTypes = [
  MessageType.UserJoin,         // 7
  MessageType.ChannelPinnedMessage, // 6
  MessageType.ChannelNameChange,    // 4
  MessageType.ThreadCreated,        // 18
];

for (const typeNum of nonBoostSystemTypes) {
  const msg = makeMockMessage({ type: typeNum, system: true });
  const obs = extractBoostObservation(msg);
  assert(obs === null, `系统消息 type ${typeNum} (${MessageType[typeNum]}) → null`);
}

console.log("\n=== 测试 6：member 缺失时不崩溃 ===\n");

const noMemberMsg = makeMockMessage({ type: 8, system: true, member: null });
const obsNoMember = extractBoostObservation(noMemberMsg);
assertNotNull(obsNoMember, "member=null 时仍返回对象");
assertEqual(obsNoMember.memberDisplayName, null, "memberDisplayName = null");

const noMember2Msg = makeMockMessage({ type: 8, system: true });
delete noMember2Msg.member;
const obsNoMember2 = extractBoostObservation(noMember2Msg);
assertNotNull(obsNoMember2, "member 字段缺失时仍返回对象");
assertEqual(obsNoMember2.memberDisplayName, null, "memberDisplayName = null (字段缺失)");

console.log("\n=== 测试 7：author 缺失时不崩溃 ===\n");

const noAuthorMsg = makeMockMessage({ type: 9, system: true, author: null });
const obsNoAuthor = extractBoostObservation(noAuthorMsg);
assertNotNull(obsNoAuthor, "author=null 时仍返回对象");
assertEqual(obsNoAuthor.authorId, null, "authorId = null");
assertEqual(obsNoAuthor.authorUsername, null, "authorUsername = null");

console.log("\n=== 测试 8：partial message 行为（observer 层不处理 partial，由调用方过滤）===\n");

const partialMsg = makeMockMessage({ type: 8, system: true, partial: true });
const obsPartial = extractBoostObservation(partialMsg);
// observer 本身不负责过滤 partial，仅提取数据
assertNotNull(obsPartial, "partial 消息仍能提取数据（observer 不负责过滤）");

console.log("\n=== 测试 9：日志不含敏感字段 ===\n");
// observer 只输出观察数据对象，不含 token 等敏感字段
const boostMsg = makeMockMessage({ type: 8, system: true });
const obs = extractBoostObservation(boostMsg);
const obsKeys = Object.keys(obs);
const sensitiveKeys = ["token", "apiKey", "api_key", "authorization", "password", "secret"];
for (const sk of sensitiveKeys) {
  assert(!obsKeys.includes(sk), `观察数据不含敏感字段 "${sk}"`);
}
// authorId/authorUsername 不包含密钥信息
assert(!obs.authorUsername?.includes("token"), "authorUsername 不含 token 字样");

// ============================================================
// Summary
// ============================================================

console.log(`\n========================================`);
console.log(`测试结果：${passed} passed, ${failed} failed`);
console.log(`========================================\n`);

if (failed > 0) {
  process.exit(1);
}

/**
 * observer.js / normalizer.js / aggregator.js 测试（Phase 2–3）。
 *
 * 使用最小 mock 对象模拟 discord.js Message，
 * 不依赖真实 Discord 连接。
 *
 * 运行：node src/features/boostThanks/observer.test.js
 */

import { EventEmitter } from "events";
import { extractBoostObservation, setupBoostObserver } from "./observer.js";
import { normalizeObservation } from "./normalizer.js";
import { createAggregator } from "./aggregator.js";
import { isBoostMessageType, isCountableBoostType, BOOST_MESSAGE_TYPES, COUNTABLE_BOOST_TYPES } from "./constants.js";
import { MessageType, Events } from "discord.js";

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

console.log("\n=== 测试 1b：COUNTABLE_BOOST_TYPES 常量 ===\n");

assert(COUNTABLE_BOOST_TYPES.has(8), "包含 GuildBoost (8)");
assert(!COUNTABLE_BOOST_TYPES.has(9), "不包含 Tier1 (9)");
assert(!COUNTABLE_BOOST_TYPES.has(10), "不包含 Tier2 (10)");
assert(!COUNTABLE_BOOST_TYPES.has(11), "不包含 Tier3 (11)");
assertEqual(COUNTABLE_BOOST_TYPES.size, 1, "仅 1 种可计数类型");

console.log("\n=== 测试 2：isBoostMessageType / isCountableBoostType 函数 ===\n");

assert(isBoostMessageType(8) === true, "type 8 → true");
assert(isBoostMessageType(9) === true, "type 9 → true");
assert(isBoostMessageType(10) === true, "type 10 → true");
assert(isBoostMessageType(11) === true, "type 11 → true");
assert(isBoostMessageType(0) === false, "type 0 → false");
assert(isBoostMessageType(7) === false, "type 7 → false");
assert(isBoostMessageType(1) === false, "type 1 → false");
assert(isBoostMessageType(12) === false, "type 12 → false");

// isCountableBoostType
assert(isCountableBoostType(8) === true, "isCountable: type 8 → true");
assert(isCountableBoostType(9) === false, "isCountable: type 9 → false");
assert(isCountableBoostType(10) === false, "isCountable: type 10 → false");
assert(isCountableBoostType(11) === false, "isCountable: type 11 → false");
assert(isCountableBoostType(0) === false, "isCountable: type 0 → false");

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
    assert(
      typeof obs.messageTypeName === "string" && obs.messageTypeName.startsWith("GuildBoost"),
      `  messageTypeName 以 GuildBoost 开头 (got: ${obs.messageTypeName})`
    );
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
// 测试 10：normalizeObservation
// ============================================================

console.log("\n=== 测试 10：normalizeObservation 标准化 ===\n");

{
  // 10a: 完整数据正确转换
  const obs = {
    messageId: "msg_001",
    messageType: 8,
    messageTypeName: "GuildBoost",
    guildId: "g1",
    channelId: "ch_sys",
    authorId: "u1",
    authorUsername: "TestUser",
    memberDisplayName: "TestDisplay",
    createdTimestamp: 1700000000000,
    system: true,
  };
  const evt = normalizeObservation(obs);
  assertNotNull(evt, "完整观察数据返回非 null");
  assertEqual(evt.eventType, "boost", "  eventType = boost");
  assertEqual(evt.eventId, "msg_001", "  eventId");
  assertEqual(evt.userId, "u1", "  userId");
  assertEqual(evt.username, "TestUser", "  username");
  assertEqual(evt.displayName, "TestDisplay", "  displayName");
  assertEqual(evt.guildId, "g1", "  guildId");
  assertEqual(evt.sourceChannelId, "ch_sys", "  sourceChannelId");
  assertEqual(evt.timestamp, 1700000000000, "  timestamp");
  assertEqual(evt.boostCount, 1, "  boostCount 初始 = 1");
  assertEqual(evt.eventIds.length, 1, "  eventIds 长度 = 1");
  assertEqual(evt.eventIds[0], "msg_001", "  eventIds[0]");
}

{
  // 10b: 缺失 userId（关键字段）→ null
  const noUserId = {
    messageId: "msg",
    messageType: 8,
    authorId: null,
    authorUsername: null,
    guildId: "g",
    channelId: "c",
    memberDisplayName: null,
    createdTimestamp: 1,
  };
  const evt = normalizeObservation(noUserId);
  assertEqual(evt, null, "缺失 authorId 时返回 null");
}

{
  // 10c: 缺失 eventId（关键字段）→ null
  const noEventId = {
    messageId: null,
    messageType: 8,
    authorId: "u1",
    authorUsername: "Test",
    guildId: "g",
    channelId: "c",
    memberDisplayName: "Disp",
    createdTimestamp: 1,
  };
  const evt = normalizeObservation(noEventId);
  assertEqual(evt, null, "缺失 eventId（messageId=null）时返回 null");
}

{
  // 10d: 缺失 guildId（关键字段）→ null
  const noGuildId = {
    messageId: "msg",
    messageType: 8,
    authorId: "u1",
    authorUsername: "Test",
    guildId: null,
    channelId: "c",
    memberDisplayName: "Disp",
    createdTimestamp: 1,
  };
  const evt = normalizeObservation(noGuildId);
  assertEqual(evt, null, "缺失 guildId 时返回 null");
}

{
  // 10e: 缺失 timestamp（关键字段，null）→ null
  const noTimestamp = {
    messageId: "msg",
    messageType: 8,
    authorId: "u1",
    authorUsername: "Test",
    guildId: "g",
    channelId: "c",
    memberDisplayName: "Disp",
    createdTimestamp: null,
  };
  const evt = normalizeObservation(noTimestamp);
  assertEqual(evt, null, "缺失 timestamp（null）时返回 null");
}

{
  // 10f: timestamp 为 0 → null（Discord snowflake 时间戳不会是 0）
  const zeroTimestamp = {
    messageId: "msg",
    messageType: 8,
    authorId: "u1",
    authorUsername: "Test",
    guildId: "g",
    channelId: "c",
    memberDisplayName: "Disp",
    createdTimestamp: 0,
  };
  const evt = normalizeObservation(zeroTimestamp);
  assertEqual(evt, null, "timestamp=0 时返回 null");
}

{
  // 10g: 缺失 displayName → 不崩溃，设为 null
  const noDisplay = {
    messageId: "msg",
    messageType: 8,
    authorId: "u1",
    authorUsername: "Test",
    guildId: "g",
    channelId: "c",
    memberDisplayName: null,
    createdTimestamp: 1,
  };
  const evt = normalizeObservation(noDisplay);
  assertNotNull(evt, "displayName=null 时仍返回对象");
  assertEqual(evt.displayName, null, "  displayName = null");
}

{
  // 10h: 缺失 username → 不崩溃，设为 null
  const noUsername = {
    messageId: "msg",
    messageType: 8,
    authorId: "u1",
    authorUsername: null,
    guildId: "g",
    channelId: "c",
    memberDisplayName: "Disp",
    createdTimestamp: 1,
  };
  const evt = normalizeObservation(noUsername);
  assertNotNull(evt, "username=null 时仍返回对象");
  assertEqual(evt.username, null, "  username = null");
}

{
  // 10i: sourceChannelId 为 null → 允许（非关键字段）
  const noChannel = {
    messageId: "msg",
    messageType: 8,
    authorId: "u1",
    authorUsername: "Test",
    guildId: "g",
    channelId: null,
    memberDisplayName: "Disp",
    createdTimestamp: 1,
  };
  const evt = normalizeObservation(noChannel);
  assertNotNull(evt, "sourceChannelId=null 时仍返回对象");
  assertEqual(evt.sourceChannelId, null, "  sourceChannelId = null");
}

// ============================================================
// 测试 11：createAggregator 聚合
// ============================================================

console.log("\n=== 测试 11：createAggregator 聚合 ===\n");

function makeBoostEvent(overrides = {}) {
  return {
    eventType: "boost",
    eventId: overrides.eventId ?? "evt_001",
    userId: overrides.userId ?? "u1",
    username: overrides.username ?? "TestUser",
    displayName: overrides.displayName ?? "TestDisplay",
    guildId: overrides.guildId ?? "g1",
    sourceChannelId: overrides.sourceChannelId ?? "ch_sys",
    timestamp: overrides.timestamp ?? Date.now(),
    boostCount: 1,
    eventIds: [overrides.eventId ?? "evt_001"],
  };
}

// --- 11a: 单个 Boost → boostCount=1 ---
{
  const results = [];
  const agg = createAggregator({ boostAggregationWindowMs: 10 });
  agg.onAggregate((evt) => results.push(evt));

  agg.accept(makeBoostEvent({ eventId: "e1" }));

  assertEqual(results.length, 0, "窗口未结束前不输出");

  await new Promise(r => setTimeout(r, 30));
  assertEqual(results.length, 1, "窗口结束后输出 1 条");
  assertEqual(results[0].boostCount, 1, "boostCount = 1");
  assertEqual(results[0].eventIds.length, 1, "eventIds 长度 = 1");
  agg.destroy();
}

// --- 11b: 同一用户连续 2 次 Boost → boostCount=2 ---
{
  const results = [];
  const agg = createAggregator({ boostAggregationWindowMs: 10 });
  agg.onAggregate((evt) => results.push(evt));

  agg.accept(makeBoostEvent({ eventId: "e1" }));
  await new Promise(r => setTimeout(r, 5));
  agg.accept(makeBoostEvent({ eventId: "e2" }));

  await new Promise(r => setTimeout(r, 30));
  assertEqual(results.length, 1, "连续 2 次仅输出 1 条");
  assertEqual(results[0].boostCount, 2, "boostCount = 2");
  assertEqual(results[0].eventIds.length, 2, "eventIds 长度 = 2");
  assertEqual(results[0].eventIds[0], "e1", "eventIds[0] = e1");
  assertEqual(results[0].eventIds[1], "e2", "eventIds[1] = e2");
  agg.destroy();
}

// --- 11c: 同一用户连续 3 次 Boost → boostCount=3 ---
{
  const results = [];
  const agg = createAggregator({ boostAggregationWindowMs: 10 });
  agg.onAggregate((evt) => results.push(evt));

  agg.accept(makeBoostEvent({ eventId: "e1" }));
  await new Promise(r => setTimeout(r, 3));
  agg.accept(makeBoostEvent({ eventId: "e2" }));
  await new Promise(r => setTimeout(r, 3));
  agg.accept(makeBoostEvent({ eventId: "e3" }));

  await new Promise(r => setTimeout(r, 30));
  assertEqual(results.length, 1, "连续 3 次仅输出 1 条");
  assertEqual(results[0].boostCount, 3, "boostCount = 3");
  assertEqual(results[0].eventIds.length, 3, "eventIds 长度 = 3");
  agg.destroy();
}

// --- 11d: 不同用户同时 Boost → 分别产生独立聚合 ---
{
  const results = [];
  const agg = createAggregator({ boostAggregationWindowMs: 10 });
  agg.onAggregate((evt) => results.push(evt));

  agg.accept(makeBoostEvent({ eventId: "e1", userId: "u1", username: "UserA" }));
  agg.accept(makeBoostEvent({ eventId: "e2", userId: "u2", username: "UserB" }));

  await new Promise(r => setTimeout(r, 30));
  assertEqual(results.length, 2, "不同用户各自输出 1 条");
  // 按 userId 排序确认
  results.sort((a, b) => a.userId.localeCompare(b.userId));
  assertEqual(results[0].boostCount, 1, "u1 boostCount = 1");
  assertEqual(results[1].boostCount, 1, "u2 boostCount = 1");
  agg.destroy();
}

// --- 11e: 同一用户在不同服务器 → 分别处理 ---
{
  const results = [];
  const agg = createAggregator({ boostAggregationWindowMs: 10 });
  agg.onAggregate((evt) => results.push(evt));

  agg.accept(makeBoostEvent({ eventId: "e1", guildId: "g1" }));
  agg.accept(makeBoostEvent({ eventId: "e2", guildId: "g2" }));

  await new Promise(r => setTimeout(r, 30));
  assertEqual(results.length, 2, "不同服务器各自输出 1 条");
  agg.destroy();
}

// --- 11f: 新 Boost 到来 → 窗口重置 ---
{
  const results = [];
  const agg = createAggregator({ boostAggregationWindowMs: 50 });
  agg.onAggregate((evt) => results.push(evt));

  agg.accept(makeBoostEvent({ eventId: "e1" }));
  await new Promise(r => setTimeout(r, 20)); // 还没到 50ms
  agg.accept(makeBoostEvent({ eventId: "e2" }));
  await new Promise(r => setTimeout(r, 20)); // 从 e2 起重新计时，还没到 50ms

  // 此时不应有输出，因为从 e2 起才过了 20ms
  assertEqual(results.length, 0, "新事件重置窗口后不应提前输出");

  await new Promise(r => setTimeout(r, 60)); // 等待 e2 的窗口结束
  assertEqual(results.length, 1, "窗口最终输出 1 条");
  assertEqual(results[0].boostCount, 2, "boostCount = 2");
  agg.destroy();
}

// --- 11g: 窗口结束 → 状态清理 ---
{
  const results = [];
  const agg = createAggregator({ boostAggregationWindowMs: 10 });
  agg.onAggregate((evt) => results.push(evt));

  agg.accept(makeBoostEvent({ eventId: "e1" }));
  await new Promise(r => setTimeout(r, 30));
  assertEqual(results.length, 1, "第一次输出");

  // 同一用户再次 Boost → 应作为新聚合重新开始
  agg.accept(makeBoostEvent({ eventId: "e2" }));
  await new Promise(r => setTimeout(r, 30));
  assertEqual(results.length, 2, "第二次 Boost 应作为新聚合");
  assertEqual(results[1].boostCount, 1, "新聚合 boostCount = 1");
  agg.destroy();
}

// --- 11h: destroy → 清理待处理计时器无泄漏 ---
{
  const results = [];
  const agg = createAggregator({ boostAggregationWindowMs: 60000 });
  agg.onAggregate((evt) => results.push(evt));

  agg.accept(makeBoostEvent());
  agg.destroy();

  // 窗口超大但 destroy 后不应泄漏
  await new Promise(r => setTimeout(r, 50));
  assertEqual(results.length, 0, "destroy 后无回调（计时器已清理）");
}

// --- 11i: 空聚合器 destroy 不崩溃 ---
{
  const agg = createAggregator({ boostAggregationWindowMs: 10000 });
  // 无任何 accept 就 destroy
  agg.destroy();
  assert(true, "空聚合器 destroy 不崩溃");
}

// ============================================================
// 测试 12：setupBoostObserver Phase 3 集成
// ============================================================

console.log("\n=== 测试 12：setupBoostObserver Phase 3 集成 ===\n");

/**
 * Mock Client：继承 EventEmitter，模拟 discord.js Client 的 on() 行为
 */
class MockClient extends EventEmitter {
  constructor() {
    super();
  }
}

/**
 * Mock Logger：记录 info 调用次数和参数
 */
function makeMockLogger() {
  const calls = [];
  return {
    calls,
    info(msg, data) { calls.push({ level: "info", msg, data }); },
    debug(msg, data) { calls.push({ level: "debug", msg, data }); },
    warn(msg, data) { calls.push({ level: "warn", msg, data }); },
    error(msg, data) { calls.push({ level: "error", msg, data }); },
  };
}

const SHORT_WINDOW = { boostAggregationWindowMs: 10 };

// --- 12a: 注册后，可计数 Boost (type 8) 触发 observer + aggregator 日志 ---
{
  const mockClient = new MockClient();
  const mockLogger = makeMockLogger();
  const cleanup = setupBoostObserver(mockClient, mockLogger, SHORT_WINDOW);

  mockClient.emit(Events.MessageCreate, makeMockMessage({ type: 8, system: true }));

  const observerLogs = mockLogger.calls.filter(
    c => c.level === "info" && c.msg?.includes("[BoostObserver] 收到可计数 Boost")
  );
  assertEqual(observerLogs.length, 1, "type 8 触发 [BoostObserver] 收到可计数 Boost");
  assert(observerLogs[0].data?.boostCount === 1, "observer data 中 boostCount = 1");

  // 等待聚合输出
  await new Promise(r => setTimeout(r, 30));
  const aggLogs = mockLogger.calls.filter(
    c => c.level === "info" && c.msg?.includes("[BoostAggregator] 聚合完成")
  );
  assertEqual(aggLogs.length, 1, "聚合完成后触发 [BoostAggregator] 聚合完成");
  assertEqual(aggLogs[0].data.boostCount, 1, "聚合结果 boostCount = 1");
  cleanup.destroy();
}

// --- 12b: 注册后，普通消息不触发观察日志 ---
{
  const mockClient = new MockClient();
  const mockLogger = makeMockLogger();
  setupBoostObserver(mockClient, mockLogger, SHORT_WINDOW);

  const normalMsg = makeMockMessage({ type: MessageType.Default, system: false });
  mockClient.emit(Events.MessageCreate, normalMsg);

  const boostLogs = mockLogger.calls.filter(c => c.level === "info" && c.msg?.includes("[BoostObserver]"));
  assertEqual(boostLogs.length, 0, "普通 type 0 消息不触发 [BoostObserver] 日志");
}

// --- 12c: 非 Boost 系统消息不触发 ---
{
  const mockClient = new MockClient();
  const mockLogger = makeMockLogger();
  setupBoostObserver(mockClient, mockLogger, SHORT_WINDOW);

  const joinMsg = makeMockMessage({ type: MessageType.UserJoin, system: true });
  mockClient.emit(Events.MessageCreate, joinMsg);

  const boostLogs = mockLogger.calls.filter(c => c.level === "info" && c.msg?.includes("[BoostObserver]"));
  assertEqual(boostLogs.length, 0, "UserJoin (type 7) 系统消息不触发 [BoostObserver]");
}

// --- 12d: partial 消息不触发 ---
{
  const mockClient = new MockClient();
  const mockLogger = makeMockLogger();
  setupBoostObserver(mockClient, mockLogger, SHORT_WINDOW);

  const partialMsg = makeMockMessage({ type: 8, system: true, partial: true });
  mockClient.emit(Events.MessageCreate, partialMsg);

  const boostLogs = mockLogger.calls.filter(c => c.level === "info" && c.msg?.includes("[BoostObserver]"));
  assertEqual(boostLogs.length, 0, "partial Boost 消息不触发 [BoostObserver]");
}

// --- 12e: Tier 类型 (9/10/11) 触发观察日志但视为 Tier 通知 ---
for (const typeNum of [9, 10, 11]) {
  const mockClient = new MockClient();
  const mockLogger = makeMockLogger();
  setupBoostObserver(mockClient, mockLogger, SHORT_WINDOW);

  const msg = makeMockMessage({ type: typeNum, system: true });
  mockClient.emit(Events.MessageCreate, msg);

  const tierLogs = mockLogger.calls.filter(
    c => c.level === "info" && c.msg?.includes("[BoostObserver] 收到 Tier 通知")
  );
  assertEqual(tierLogs.length, 1, `Tier type ${typeNum} 触发 [BoostObserver] 收到 Tier 通知`);

  // 不应触发聚合
  const aggLogs = mockLogger.calls.filter(
    c => c.level === "info" && c.msg?.includes("[BoostAggregator]")
  );
  assertEqual(aggLogs.length, 0, `Tier type ${typeNum} 不触发 [BoostAggregator]`);
}

// --- 12f: 混合消息仅可计数 Boost 进入聚合 ---
{
  const mockClient = new MockClient();
  const mockLogger = makeMockLogger();
  const cleanup = setupBoostObserver(mockClient, mockLogger, SHORT_WINDOW);

  mockClient.emit(Events.MessageCreate, makeMockMessage({ type: MessageType.Default, system: false }));
  mockClient.emit(Events.MessageCreate, makeMockMessage({ type: 8, system: true }));
  mockClient.emit(Events.MessageCreate, makeMockMessage({ type: MessageType.UserJoin, system: true }));
  mockClient.emit(Events.MessageCreate, makeMockMessage({ type: 9, system: true }));
  mockClient.emit(Events.MessageCreate, makeMockMessage({ type: 10, system: true }));

  const observerCountable = mockLogger.calls.filter(
    c => c.level === "info" && c.msg?.includes("[BoostObserver] 收到可计数 Boost")
  );
  assertEqual(observerCountable.length, 1, "仅 type 8 触发可计数日志");

  const observerTier = mockLogger.calls.filter(
    c => c.level === "info" && c.msg?.includes("[BoostObserver] 收到 Tier 通知")
  );
  assertEqual(observerTier.length, 2, "type 9,10 触发 2 条 Tier 通知");

  await new Promise(r => setTimeout(r, 30));
  const aggLogs = mockLogger.calls.filter(
    c => c.level === "info" && c.msg?.includes("[BoostAggregator]")
  );
  assertEqual(aggLogs.length, 1, "仅 1 条聚合（type 8）");
  assertEqual(aggLogs[0].data.boostCount, 1, "聚合结果 boostCount = 1");
  cleanup.destroy();
}

// --- 12g: 缺失关键字段的 Boost 记录 warn 并跳过 ---
{
  const mockClient = new MockClient();
  const mockLogger = makeMockLogger();
  setupBoostObserver(mockClient, mockLogger, SHORT_WINDOW);

  mockClient.emit(Events.MessageCreate, makeMockMessage({ type: 8, system: true, author: null }));

  const warnLogs = mockLogger.calls.filter(c => c.level === "warn");
  assert(warnLogs.length >= 1, "缺失关键字段时产生 warn 日志");
  const warnMsg = warnLogs[0]?.msg ?? "";
  assert(warnMsg.includes("缺少关键字段"), "warn 日志提示缺少关键字段");
  const aggLogs = mockLogger.calls.filter(c => c.msg?.includes("[BoostAggregator]"));
  assertEqual(aggLogs.length, 0, "不进入聚合");
}

// ============================================================
// 测试 13：onAggregated 回调错误捕获（Phase 6 Review Fix）
// ============================================================

console.log("\n=== 测试 13a：onAggregated 同步抛错被捕获 ===\n");
{
  const mockClient = new MockClient();
  const mockLogger = makeMockLogger();
  let callbackCalled = false;
  const onAggregated = () => {
    callbackCalled = true;
    throw new Error("同步回调失败");
  };
  setupBoostObserver(mockClient, mockLogger, SHORT_WINDOW, onAggregated);

  mockClient.emit(Events.MessageCreate, makeMockMessage({ type: 8, system: true }));

  await new Promise(r => setTimeout(r, 30));

  assert(callbackCalled, "回调被调用");
  const errLogs = mockLogger.calls.filter(c => c.level === "error");
  const cbErrLogs = errLogs.filter(c => (c.msg ?? "").includes("回调失败"));
  assert(cbErrLogs.length >= 1, "产生回调失败错误日志");
}

console.log("\n=== 测试 13b：onAggregated 异步 reject 被捕获 ===\n");
{
  const mockClient = new MockClient();
  const mockLogger = makeMockLogger();
  let callbackCalled = false;
  const onAggregated = async () => {
    callbackCalled = true;
    throw new Error("异步回调 reject");
  };
  setupBoostObserver(mockClient, mockLogger, SHORT_WINDOW, onAggregated);

  mockClient.emit(Events.MessageCreate, makeMockMessage({ type: 8, system: true }));

  // 等待 microtask + Promise 链完成
  await new Promise(r => setTimeout(r, 30));

  assert(callbackCalled, "异步回调被调用");
  const errLogs = mockLogger.calls.filter(c => c.level === "error");
  const cbErrLogs = errLogs.filter(c => (c.msg ?? "").includes("回调失败"));
  assert(cbErrLogs.length >= 1, "产生回调失败错误日志（异步 reject）");
}

console.log("\n=== 测试 13c：onAggregated 回调抛错不中断 observer 主流程 ===\n");
{
  const mockClient = new MockClient();
  const mockLogger = makeMockLogger();
  let callCount = 0;
  const onAggregated = () => {
    callCount++;
    throw new Error("每次必崩");
  };
  setupBoostObserver(mockClient, mockLogger, SHORT_WINDOW, onAggregated);

  // 发送两次 Boost
  mockClient.emit(Events.MessageCreate, makeMockMessage({ type: 8, system: true }));
  await new Promise(r => setTimeout(r, 30));
  mockClient.emit(Events.MessageCreate, makeMockMessage({ type: 8, system: true, id: "msg_second" }));
  await new Promise(r => setTimeout(r, 30));

  // 两次回调都应被调用（主流程未中断）
  assert(callCount >= 2, "两次回调均被调用（主流程未因错误中断）");
  const errLogs = mockLogger.calls.filter(c => c.level === "error");
  const cbErrLogs = errLogs.filter(c => (c.msg ?? "").includes("回调失败"));
  assert(cbErrLogs.length >= 2, "每次失败均记录错误日志");

  // 验证聚合仍正常运行
  const aggLogs = mockLogger.calls.filter(c => (c.msg ?? "").includes("[BoostAggregator]"));
  assert(aggLogs.length >= 2, "聚合日志正常（observer 主流程不受影响）");
}

// ============================================================
// 测试 14：Guild 白名单过滤（Phase 9）
// ============================================================

console.log("\n=== 测试 14：Guild 白名单过滤 ===\n");

const TARGET_GUILD = "target_guild_123";
const OTHER_GUILD = "other_guild_456";

// --- 14a: 目标 Guild type 8 → 正常进入处理（observer + aggregator）---
{
  const mockClient = new MockClient();
  const mockLogger = makeMockLogger();
  const cleanup = setupBoostObserver(mockClient, mockLogger, SHORT_WINDOW, undefined, TARGET_GUILD);

  mockClient.emit(Events.MessageCreate, makeMockMessage({
    type: 8, system: true, guildId: TARGET_GUILD
  }));

  const boostLogs = mockLogger.calls.filter(
    c => c.level === "info" && c.msg?.includes("[BoostObserver] 收到可计数 Boost")
  );
  assertEqual(boostLogs.length, 1, "14a: 目标 Guild type 8 → 触发可计数日志");
  assertEqual(boostLogs[0].data.guildId, TARGET_GUILD, "14a: guildId 正确");

  await new Promise(r => setTimeout(r, 30));
  const aggLogs = mockLogger.calls.filter(
    c => c.level === "info" && c.msg?.includes("[BoostAggregator]")
  );
  assert(aggLogs.length >= 1, "14a: 目标 Guild → 触发聚合");
  cleanup.destroy();
}

// --- 14b: 非目标 Guild type 8 → 完全忽略 ---
{
  const mockClient = new MockClient();
  const mockLogger = makeMockLogger();
  const cleanup = setupBoostObserver(mockClient, mockLogger, SHORT_WINDOW, undefined, TARGET_GUILD);

  mockClient.emit(Events.MessageCreate, makeMockMessage({
    type: 8, system: true, guildId: OTHER_GUILD
  }));

  const allBoostLogs = mockLogger.calls.filter(
    c => c.level === "info" && c.msg?.includes("[BoostObserver]")
  );
  assertEqual(allBoostLogs.length, 0, "14b: 非目标 Guild type 8 → 无 BoostObserver 日志");

  await new Promise(r => setTimeout(r, 30));
  const aggLogs = mockLogger.calls.filter(
    c => c.level === "info" && c.msg?.includes("[BoostAggregator]")
  );
  assertEqual(aggLogs.length, 0, "14b: 非目标 Guild type 8 → 不触发聚合");
  cleanup.destroy();
}

// --- 14c: 非目标 Guild type 9 → 完全忽略（不记录 Tier 通知）---
{
  const mockClient = new MockClient();
  const mockLogger = makeMockLogger();
  const cleanup = setupBoostObserver(mockClient, mockLogger, SHORT_WINDOW, undefined, TARGET_GUILD);

  mockClient.emit(Events.MessageCreate, makeMockMessage({
    type: 9, system: true, guildId: OTHER_GUILD
  }));

  const tierLogs = mockLogger.calls.filter(
    c => c.level === "info" && c.msg?.includes("收到 Tier 通知")
  );
  assertEqual(tierLogs.length, 0, "14c: 非目标 Guild type 9 → 无 Tier 通知日志");

  const allBoostLogs = mockLogger.calls.filter(
    c => c.msg?.includes("[BoostObserver]")
  );
  assertEqual(allBoostLogs.length, 0, "14c: 非目标 Guild type 9 → 完全无 BoostObserver 日志");
  cleanup.destroy();
}

// --- 14d: 非目标 Guild type 10 → 完全忽略 ---
{
  const mockClient = new MockClient();
  const mockLogger = makeMockLogger();
  const cleanup = setupBoostObserver(mockClient, mockLogger, SHORT_WINDOW, undefined, TARGET_GUILD);

  mockClient.emit(Events.MessageCreate, makeMockMessage({
    type: 10, system: true, guildId: OTHER_GUILD
  }));

  const allBoostLogs = mockLogger.calls.filter(
    c => c.msg?.includes("[BoostObserver]")
  );
  assertEqual(allBoostLogs.length, 0, "14d: 非目标 Guild type 10 → 完全忽略");
  cleanup.destroy();
}

// --- 14e: 非目标 Guild type 11 → 完全忽略 ---
{
  const mockClient = new MockClient();
  const mockLogger = makeMockLogger();
  const cleanup = setupBoostObserver(mockClient, mockLogger, SHORT_WINDOW, undefined, TARGET_GUILD);

  mockClient.emit(Events.MessageCreate, makeMockMessage({
    type: 11, system: true, guildId: OTHER_GUILD
  }));

  const allBoostLogs = mockLogger.calls.filter(
    c => c.msg?.includes("[BoostObserver]")
  );
  assertEqual(allBoostLogs.length, 0, "14e: 非目标 Guild type 11 → 完全忽略");
  cleanup.destroy();
}

// --- 14f: 非目标 Guild → 不调用 onAggregated 回调 ---
{
  const mockClient = new MockClient();
  const mockLogger = makeMockLogger();
  let callbackCalled = false;
  const onAggregated = () => { callbackCalled = true; };
  const cleanup = setupBoostObserver(mockClient, mockLogger, SHORT_WINDOW, onAggregated, TARGET_GUILD);

  mockClient.emit(Events.MessageCreate, makeMockMessage({
    type: 8, system: true, guildId: OTHER_GUILD
  }));

  await new Promise(r => setTimeout(r, 30));
  assert(!callbackCalled, "14f: 非目标 Guild → onAggregated 未被调用");
  cleanup.destroy();
}

// --- 14g: 目标 Guild type 8 → onAggregated 正常调用 ---
{
  const mockClient = new MockClient();
  const mockLogger = makeMockLogger();
  let callbackCalled = false;
  const onAggregated = () => { callbackCalled = true; };
  const cleanup = setupBoostObserver(mockClient, mockLogger, SHORT_WINDOW, onAggregated, TARGET_GUILD);

  mockClient.emit(Events.MessageCreate, makeMockMessage({
    type: 8, system: true, guildId: TARGET_GUILD
  }));

  await new Promise(r => setTimeout(r, 30));
  assert(callbackCalled, "14g: 目标 Guild type 8 → onAggregated 正常调用");
  cleanup.destroy();
}

// --- 14h: 不传 targetGuildId → 向后兼容（所有 Guild 都处理）---
{
  const mockClient = new MockClient();
  const mockLogger = makeMockLogger();
  const cleanup = setupBoostObserver(mockClient, mockLogger, SHORT_WINDOW);

  mockClient.emit(Events.MessageCreate, makeMockMessage({
    type: 8, system: true, guildId: OTHER_GUILD
  }));

  const boostLogs = mockLogger.calls.filter(
    c => c.level === "info" && c.msg?.includes("[BoostObserver] 收到可计数 Boost")
  );
  assertEqual(boostLogs.length, 1, "14h: 无 targetGuildId → 非目标 Guild 也处理（向后兼容）");

  await new Promise(r => setTimeout(r, 30));
  const aggLogs = mockLogger.calls.filter(
    c => c.level === "info" && c.msg?.includes("[BoostAggregator]")
  );
  assert(aggLogs.length >= 1, "14h: 无 targetGuildId → 聚合正常");
  cleanup.destroy();
}

// ============================================================
// Summary
// ============================================================

console.log(`\n========================================`);
console.log(`测试结果：${passed} passed, ${failed} failed`);
console.log(`========================================\n`);

if (failed > 0) {
  process.exit(1);
}

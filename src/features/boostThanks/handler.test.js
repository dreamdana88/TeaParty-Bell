/**
 * handler.js 自动测试（Phase 6）。
 *
 * 使用 Mock AI + Mock sender，不连接真实 Discord。
 *
 * 运行：node src/features/boostThanks/handler.test.js
 */

import { EventEmitter } from "events";
import { createBoostThanksHandler } from "./handler.js";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  if (actual === expected) { passed++; console.log(`  PASS: ${label} (${JSON.stringify(expected)})`); }
  else { failed++; console.error(`  FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}
function assertIncludes(haystack, needle, label) {
  if (haystack.includes(needle)) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label} — "${haystack}" does not include "${needle}"`); }
}

// ---- Mock 工具 ----
function makeMockAi(response) {
  return { generateText: async () => response };
}
function makeThrowingAi(msg) {
  return { generateText: async () => { throw new Error(msg); } };
}

function makeMockSender() {
  const calls = [];
  return {
    calls,
    sendMessage: async (client, channelId, content) => {
      calls.push({ client, channelId, content });
      return { id: "mock_msg_id", content };
    },
  };
}

function makeThrowingSender(msg) {
  return {
    sendMessage: async () => { throw new Error(msg); },
  };
}

function makeMockLogger() {
  const calls = [];
  return {
    calls,
    info: (msg, data) => calls.push({ level: "info", msg, data }),
    error: (msg, data) => calls.push({ level: "error", msg, data }),
    warn: (msg, data) => calls.push({ level: "warn", msg, data }),
    debug: () => {},
  };
}

const TEST_CONFIG = {
  discordThanksChannelId: "999999999999",
  deepseekApiKey: "sk-test-mock",
};

const MOCK_CLIENT = new EventEmitter(); // 作为 mock client 传递

const TEST_EVENT = {
  eventType: "boost",
  eventId: "evt_test",
  userId: "1426581758194876577",
  username: "TestUser",
  displayName: "TestDisplay",
  guildId: "888888888888",
  sourceChannelId: "777777777777",
  timestamp: 1700000000000,
  boostCount: 2,
  eventIds: ["msg_1", "msg_2"],
};

// ============================================================
console.log("\n=== 测试 1：正常链路 — AI + Title + Send ===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("这是AI生成的感谢正文✨"),
    senderOverride: mockSender.sendMessage,
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, true, "返回 true");
  assertEqual(mockSender.calls.length, 1, "sender 被调用 1 次");
  assertEqual(mockSender.calls[0].channelId, "999999999999", "使用正确 channelId");

  const content = mockSender.calls[0].content;
  assertIncludes(content, "<:heart_red:1456223334067867689>", "含 heart_red Emoji");
  assertIncludes(content, "<@1426581758194876577>", "含用户 Mention");
  assertIncludes(content, "两个助力", "含正确 boostCount 标题");
  assertIncludes(content, "这是AI生成的感谢正文✨", "含 AI 正文");
  assertIncludes(content, "\n\n", "标题与正文之间空行");

  // 验证成功日志
  const successLogs = mockLogger.calls.filter(c => c.msg && c.msg.includes("已发送"));
  assertEqual(successLogs.length, 1, "发送成功日志存在");
  assertEqual(successLogs[0].data.channelId, "999999999999", "成功日志含 channelId");
  assertEqual(successLogs[0].data.userId, TEST_EVENT.userId, "成功日志含 userId");
  assertEqual(successLogs[0].data.boostCount, 2, "成功日志含 boostCount");
  assert(!successLogs[0].data.error, "成功日志无 error 字段");
  // 不泄露 token
  assert(!content.includes("sk-test"), "消息不含 API Key");
  assert(!content.includes("Bearer"), "消息不含 Bearer");
}

console.log("\n=== 测试 2：AI 失败 → sender 不被调用 ===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeThrowingAi("DeepSeek 500 error"),
    senderOverride: mockSender.sendMessage,
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, false, "返回 false");
  assertEqual(mockSender.calls.length, 0, "sender 未被调用");

  const errLogs = mockLogger.calls.filter(c => c.level === "error");
  assert(errLogs.length >= 1, "产生错误日志");
  assertIncludes(errLogs[0].msg, "AI 正文生成失败", "错误日志提示 AI 失败");
  assertIncludes(errLogs[0].data.error, "DeepSeek 500", "错误日志含原因");
}

console.log("\n=== 测试 3：sender 失败 ===\n");
{
  const mockLogger = makeMockLogger();
  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("ok"),
    senderOverride: makeThrowingSender("Missing Access").sendMessage,
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, false, "返回 false");

  const errLogs = mockLogger.calls.filter(c => c.level === "error");
  assert(errLogs.length >= 1, "产生错误日志");
  assertIncludes(errLogs[0].msg, "发送失败", "错误日志提示发送失败");
}

console.log("\n=== 测试 4：非法 event 不崩溃 ===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("ok"),
    senderOverride: mockSender.sendMessage,
  });

  // userId 非法 → buildTitle 抛出 → handler 内部捕获
  const badEvent = { ...TEST_EVENT, userId: "abc" };
  const result = await handler.handleBoostEvent(badEvent);
  assertEqual(result, false, "userId 非法 → 返回 false");
  assertEqual(mockSender.calls.length, 0, "sender 未被调用");

  const errLogs = mockLogger.calls.filter(c => c.level === "error");
  assert(errLogs.length >= 1, "产生错误日志");
}

console.log("\n=== 测试 5：sender 只调用一次 ===\n");
{
  const mockSender = makeMockSender();
  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: makeMockLogger(),
    aiOverride: makeMockAi("正文"),
    senderOverride: mockSender.sendMessage,
  });

  await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(mockSender.calls.length, 1, "sender 只调用一次");
}

console.log("\n=== 测试 6：不使用固定兜底文案 ===\n");
{
  const mockSender = makeMockSender();
  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: makeMockLogger(),
    aiOverride: makeThrowingAi("fail"),
    senderOverride: mockSender.sendMessage,
  });

  await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(mockSender.calls.length, 0, "AI 失败时完全不发送");
  // 如果用了兜底文案，sender 会有调用 — 此处验证为 0
}

console.log("\n=== 测试 7：消息不含 API Key ===\n");
{
  const mockSender = makeMockSender();
  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: makeMockLogger(),
    aiOverride: makeMockAi("ok"),
    senderOverride: mockSender.sendMessage,
  });

  await handler.handleBoostEvent(TEST_EVENT);
  if (mockSender.calls.length > 0) {
    const content = mockSender.calls[0].content;
    assert(!content.includes("sk-test-mock"), "消息不含 mock Key");
  }
}

console.log("\n=== 测试 8：单次 Boost 标题正确（send 路径验证）===\n");
{
  const mockSender = makeMockSender();
  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: makeMockLogger(),
    aiOverride: makeMockAi("ok"),
    senderOverride: mockSender.sendMessage,
  });

  const singleEvent = { ...TEST_EVENT, boostCount: 1 };
  await handler.handleBoostEvent(singleEvent);
  assertIncludes(mockSender.calls[0].content, "投喂的助力", "单次 Boost 标题正确");
}

console.log("\n=== 测试 9：感谢频道 ID 正确使用 ===\n");
{
  const mockSender = makeMockSender();
  const customConfig = { ...TEST_CONFIG, discordThanksChannelId: "111111111111" };
  const handler = createBoostThanksHandler({
    config: customConfig,
    client: MOCK_CLIENT,
    logger: makeMockLogger(),
    aiOverride: makeMockAi("ok"),
    senderOverride: mockSender.sendMessage,
  });

  await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(mockSender.calls[0].channelId, "111111111111", "使用自定义 channelId");
}

// ============================================================
console.log(`\n========================================`);
console.log(`测试结果：${passed} passed, ${failed} failed`);
console.log(`========================================\n`);
if (failed > 0) process.exit(1);

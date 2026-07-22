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

console.log("\n=== 测试 10：TEST_MODE=true → 完整生成预览，不真实发送 ===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const testModeConfig = { ...TEST_CONFIG, testMode: true };
  const handler = createBoostThanksHandler({
    config: testModeConfig,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("这是TEST_MODE下的AI正文🧪"),
    senderOverride: mockSender.sendMessage,
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, true, "TEST_MODE 返回 true");
  assertEqual(mockSender.calls.length, 0, "TEST_MODE sender 调用次数为 0");

  // 验证预览日志
  const testModeLogs = mockLogger.calls.filter(c => c.msg && c.msg.includes("TEST_MODE"));
  assertEqual(testModeLogs.length, 1, "产生 TEST_MODE 跳过发送日志");
  assert(testModeLogs[0].data.content, "日志含完整 content");
  assertIncludes(testModeLogs[0].data.content, "这是TEST_MODE下的AI正文🧪", "预览含 AI 正文");
  assertIncludes(testModeLogs[0].data.content, "两个助力", "预览含正确标题");
  assertIncludes(testModeLogs[0].data.content, "<@1426581758194876577>", "预览含用户 Mention");
  assertEqual(testModeLogs[0].data.targetChannelId, "999999999999", "日志记录目标 channelId");
  assertEqual(testModeLogs[0].data.userId, TEST_EVENT.userId, "日志含 userId");
  assertEqual(testModeLogs[0].data.boostCount, 2, "日志含 boostCount");

  // 验证 AI 确实被调用（产生的预览日志包含 AI 正文即证明 AI 执行了）
  // 验证标题被构造（预览含标题即证明）
  // 验证消息被拼装（预览含完整 content 即证明）
}

console.log("\n=== 测试 11：TEST_MODE=false → 正常发送路径继续成立 ===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const prodConfig = { ...TEST_CONFIG, testMode: false };
  const handler = createBoostThanksHandler({
    config: prodConfig,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("正常发送路径正文✅"),
    senderOverride: mockSender.sendMessage,
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, true, "testMode=false 返回 true");
  assertEqual(mockSender.calls.length, 1, "testMode=false sender 被调用 1 次");
  assertIncludes(mockSender.calls[0].content, "正常发送路径正文✅", "消息含 AI 正文");

  // 验证没有 TEST_MODE 跳过日志
  const testModeLogs = mockLogger.calls.filter(c => c.msg && c.msg.includes("TEST_MODE"));
  assertEqual(testModeLogs.length, 0, "testMode=false 无 TEST_MODE 日志");

  // 验证有成功发送日志
  const successLogs = mockLogger.calls.filter(c => c.msg && c.msg.includes("已发送"));
  assertEqual(successLogs.length, 1, "testMode=false 产生成功发送日志");
}

// ============================================================
// Phase 7：Reaction 集成测试
// ============================================================

// ---- Phase 7 Mock 工具 ----
function makeMockEmojiProvider(emojis) {
  let fetchCount = 0;
  return {
    fetchCount: () => fetchCount,
    fetchEmojis: async () => { fetchCount++; return emojis; },
  };
}
function makeThrowingEmojiProvider(msg) {
  return { fetchEmojis: async () => { throw new Error(msg); } };
}
function makeMockReactionSender() {
  const calls = [];
  return {
    calls,
    addReactions: async (message, emojis, logger) => {
      calls.push({ messageId: message.id, emojiCount: emojis.length, emojis });
      return { successCount: emojis.length, failCount: 0, failures: [] };
    },
  };
}
function makePartialFailingReactionSender(failIndexes) {
  const calls = [];
  const failSet = new Set(failIndexes);
  return {
    calls,
    addReactions: async (message, emojis, logger) => {
      let successCount = 0;
      let failCount = 0;
      const failures = [];
      for (let i = 0; i < emojis.length; i++) {
        if (failSet.has(i)) {
          failCount++;
          failures.push({ emojiId: emojis[i].id, emojiName: emojis[i].name, error: "mock fail" });
        } else {
          successCount++;
        }
      }
      calls.push({ messageId: message.id, emojiCount: emojis.length });
      return { successCount, failCount, failures };
    },
  };
}

console.log("\n=== 测试 12：消息发送成功 + Reactions 全部成功 ===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const pool = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, name: `emoji${i}` }));
  const mockProvider = makeMockEmojiProvider(pool);
  const mockReactionSender = makeMockReactionSender();

  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("正文"),
    senderOverride: mockSender.sendMessage,
    emojiProvider: mockProvider,
    reactionSenderOverride: mockReactionSender.addReactions,
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, true, "返回 true");
  assertEqual(mockSender.calls.length, 1, "sender 调用 1 次");
  assertEqual(mockProvider.fetchCount(), 1, "emojiProvider.fetchEmojis 调用 1 次");
  assertEqual(mockReactionSender.calls.length, 1, "reactionSender 调用 1 次");

  // 验证选择了 8～10 个 Emoji
  const emojiCount = mockReactionSender.calls[0].emojiCount;
  assert(emojiCount >= 8, `选择数 ≥ 8 (${emojiCount})`);
  assert(emojiCount <= 10, `选择数 ≤ 10 (${emojiCount})`);

  // 验证 Reaction 完成日志
  const reactionLogs = mockLogger.calls.filter(c => c.msg && c.msg.includes("Reactions 添加完成"));
  assertEqual(reactionLogs.length, 1, "产生 Reaction 完成日志");
  assertEqual(reactionLogs[0].data.reactionSuccess, emojiCount, "successCount 正确");
  assertEqual(reactionLogs[0].data.reactionFail, 0, "failCount = 0");

  // 成功发送日志仍然存在
  const successLogs = mockLogger.calls.filter(c => c.msg && c.msg.includes("已发送"));
  assertEqual(successLogs.length, 1, "消息发送成功日志仍存在");
}

console.log("\n=== 测试 13：消息发送成功 + Emoji 获取失败 → 消息仍视为成功 ===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const mockReactionSender = makeMockReactionSender();

  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("正文"),
    senderOverride: mockSender.sendMessage,
    emojiProvider: makeThrowingEmojiProvider("Emoji API 故障"),
    reactionSenderOverride: mockReactionSender.addReactions,
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, true, "返回 true（消息发送成功）");
  assertEqual(mockSender.calls.length, 1, "sender 调用 1 次");
  assertEqual(mockReactionSender.calls.length, 0, "reactionSender 未调用");

  // 产生 Reaction 异常日志
  const errLogs = mockLogger.calls.filter(c => c.level === "error");
  const reactionErrLogs = errLogs.filter(c => (c.msg ?? "").includes("Reaction 流程异常"));
  assert(reactionErrLogs.length >= 1, "产生 Reaction 异常日志（消息已正常发送）");

  // 成功发送日志仍然存在
  const successLogs = mockLogger.calls.filter(c => c.msg && c.msg.includes("已发送"));
  assertEqual(successLogs.length, 1, "消息发送成功日志仍存在");
}

console.log("\n=== 测试 14：消息发送成功 + Emoji 池为空 → 跳过 Reaction ===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const mockReactionSender = makeMockReactionSender();

  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("正文"),
    senderOverride: mockSender.sendMessage,
    emojiProvider: makeMockEmojiProvider([]),
    reactionSenderOverride: mockReactionSender.addReactions,
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, true, "返回 true");
  assertEqual(mockSender.calls.length, 1, "sender 调用 1 次");
  assertEqual(mockReactionSender.calls.length, 0, "reactionSender 未调用");

  // 产生 Emoji 为空警告
  const warns = mockLogger.calls.filter(c => c.level === "warn");
  const emptyWarn = warns.filter(c => (c.msg ?? "").includes("Emoji 为空"));
  assert(emptyWarn.length >= 1, "产生 Emoji 为空警告");
}

console.log("\n=== 测试 15：消息发送成功 + 部分 Reaction 失败 → 不重新发送 ===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const pool = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, name: `emoji${i}` }));
  const mockProvider = makeMockEmojiProvider(pool);
  const mockReactionSender = makePartialFailingReactionSender([2, 5]);

  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("正文"),
    senderOverride: mockSender.sendMessage,
    emojiProvider: mockProvider,
    reactionSenderOverride: mockReactionSender.addReactions,
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, true, "返回 true（消息发送成功）");
  assertEqual(mockSender.calls.length, 1, "sender 仍只调用 1 次（无重新发送）");

  // Reaction 完成日志含失败数
  const reactionLogs = mockLogger.calls.filter(c => c.msg && c.msg.includes("Reactions 添加完成"));
  assertEqual(reactionLogs.length, 1, "产生 Reaction 完成日志");
  assert(reactionLogs[0].data.reactionFail >= 2, "failCount ≥ 2");
}

console.log("\n=== 测试 16：消息发送成功 + 全部 Reaction 失败 → 仍返回 true ===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const pool = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, name: `emoji${i}` }));
  const mockProvider = makeMockEmojiProvider(pool);
  const allFailing = makePartialFailingReactionSender([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("正文"),
    senderOverride: mockSender.sendMessage,
    emojiProvider: mockProvider,
    reactionSenderOverride: allFailing.addReactions,
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, true, "返回 true（消息发送成功）");
  assertEqual(mockSender.calls.length, 1, "sender 调用 1 次（无重复发送）");
}

console.log("\n=== 测试 17：AI 失败 → 不发送消息 → 不添加 Reaction ===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const pool = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, name: `emoji${i}` }));
  const mockProvider = makeMockEmojiProvider(pool);
  const mockReactionSender = makeMockReactionSender();

  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeThrowingAi("AI fail"),
    senderOverride: mockSender.sendMessage,
    emojiProvider: mockProvider,
    reactionSenderOverride: mockReactionSender.addReactions,
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, false, "返回 false");
  assertEqual(mockSender.calls.length, 0, "sender 未调用");
  assertEqual(mockProvider.fetchCount(), 0, "emojiProvider 未调用");
  assertEqual(mockReactionSender.calls.length, 0, "reactionSender 未调用");
}

console.log("\n=== 测试 18：消息发送失败 → 不添加 Reaction ===\n");
{
  const mockLogger = makeMockLogger();
  const pool = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, name: `emoji${i}` }));
  const mockProvider = makeMockEmojiProvider(pool);
  const mockReactionSender = makeMockReactionSender();

  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("正文"),
    senderOverride: makeThrowingSender("send fail").sendMessage,
    emojiProvider: mockProvider,
    reactionSenderOverride: mockReactionSender.addReactions,
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, false, "返回 false");
  assertEqual(mockReactionSender.calls.length, 0, "reactionSender 未调用");
}

console.log("\n=== 测试 19：TEST_MODE=true → sender=0 + reaction=0 ===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const pool = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, name: `emoji${i}` }));
  const mockProvider = makeMockEmojiProvider(pool);
  const mockReactionSender = makeMockReactionSender();
  const testModeConfig = { ...TEST_CONFIG, testMode: true };

  const handler = createBoostThanksHandler({
    config: testModeConfig,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("TEST_MODE 正文"),
    senderOverride: mockSender.sendMessage,
    emojiProvider: mockProvider,
    reactionSenderOverride: mockReactionSender.addReactions,
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, true, "返回 true");
  assertEqual(mockSender.calls.length, 0, "sender 未调用");
  assertEqual(mockReactionSender.calls.length, 0, "reactionSender 未调用");

  // 验证 TEST_MODE 预览日志含正文
  const testModeLogs = mockLogger.calls.filter(c => c.msg && c.msg.includes("TEST_MODE"));
  assert(testModeLogs.length >= 1, "TEST_MODE 日志存在");
  assertIncludes(testModeLogs[0].data.content, "TEST_MODE 正文", "预览含 AI 正文");
}

console.log("\n=== 测试 20：无 emojiProvider → Reaction 静默跳过（向后兼容）===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();

  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("正文"),
    senderOverride: mockSender.sendMessage,
    // 不传 emojiProvider
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, true, "返回 true");
  assertEqual(mockSender.calls.length, 1, "sender 调用 1 次");
  // 无 Reaction 相关日志
  const reactionLogs = mockLogger.calls.filter(c => (c.msg ?? "").includes("Reaction"));
  assertEqual(reactionLogs.length, 0, "无 Reaction 相关日志（静默跳过）");
}

console.log("\n=== 测试 21：小池（不足 8 个）→ 全部选择，不报错 ===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const pool = [{ id: "a", name: "aa" }, { id: "b", name: "bb" }, { id: "c", name: "cc" }];
  const mockProvider = makeMockEmojiProvider(pool);
  const mockReactionSender = makeMockReactionSender();

  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("正文"),
    senderOverride: mockSender.sendMessage,
    emojiProvider: mockProvider,
    reactionSenderOverride: mockReactionSender.addReactions,
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, true, "返回 true");
  assertEqual(mockReactionSender.calls[0].emojiCount, 3, "全部选择（3 个）");
  // 无警告
  const warns = mockLogger.calls.filter(c => c.level === "warn");
  const emptyWarns = warns.filter(c => (c.msg ?? "").includes("Emoji 为空"));
  assertEqual(emptyWarns.length, 0, "池虽小但不为空，无空池警告");
}

// ============================================================
console.log(`\n========================================`);
console.log(`测试结果：${passed} passed, ${failed} failed`);
console.log(`========================================\n`);
if (failed > 0) process.exit(1);

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
// Phase 7 Review Fix：REACTION_COUNT 边界测试
// ============================================================

console.log("\n=== 测试 22：REACTION_COUNT=8 → 确定性选择 8 个 ===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const pool = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, name: `emoji${i}` }));
  const mockProvider = makeMockEmojiProvider(pool);
  const mockReactionSender = makeMockReactionSender();
  const config8 = { ...TEST_CONFIG, reactionCount: 8 };

  const handler = createBoostThanksHandler({
    config: config8,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("正文"),
    senderOverride: mockSender.sendMessage,
    emojiProvider: mockProvider,
    reactionSenderOverride: mockReactionSender.addReactions,
  });

  await handler.handleBoostEvent(TEST_EVENT);
  // maxCount=min(8,20)=8, minCount=min(8,8)=8 → count 恒为 8
  assertEqual(mockReactionSender.calls[0].emojiCount, 8, "REACTION_COUNT=8 → 选择 8 个");
}

console.log("\n=== 测试 23：REACTION_COUNT=9 → 选择 8～9 个 ===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const pool = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, name: `emoji${i}` }));
  const mockProvider = makeMockEmojiProvider(pool);
  const mockReactionSender = makeMockReactionSender();
  const config9 = { ...TEST_CONFIG, reactionCount: 9 };

  const handler = createBoostThanksHandler({
    config: config9,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("正文"),
    senderOverride: mockSender.sendMessage,
    emojiProvider: mockProvider,
    reactionSenderOverride: mockReactionSender.addReactions,
  });

  await handler.handleBoostEvent(TEST_EVENT);
  const count = mockReactionSender.calls[0].emojiCount;
  assert(count >= 8, `REACTION_COUNT=9 → ≥ 8 (${count})`);
  assert(count <= 9, `REACTION_COUNT=9 → ≤ 9 (${count})`);
}

console.log("\n=== 测试 24：REACTION_COUNT=20 → 钳制为 10 内 ===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const pool = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, name: `emoji${i}` }));
  const mockProvider = makeMockEmojiProvider(pool);
  const mockReactionSender = makeMockReactionSender();
  const configClamp = { ...TEST_CONFIG, reactionCount: 20 };

  const handler = createBoostThanksHandler({
    config: configClamp,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("正文"),
    senderOverride: mockSender.sendMessage,
    emojiProvider: mockProvider,
    reactionSenderOverride: mockReactionSender.addReactions,
  });

  await handler.handleBoostEvent(TEST_EVENT);
  const count = mockReactionSender.calls[0].emojiCount;
  assert(count >= 8, `REACTION_COUNT=20 钳制后 ≥ 8 (${count})`);
  assert(count <= 10, `REACTION_COUNT=20 钳制后 ≤ 10 (${count})`);
}

console.log("\n=== 测试 25：REACTION_COUNT=0 → 安全处理（钳制为 8）===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const pool = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, name: `emoji${i}` }));
  const mockProvider = makeMockEmojiProvider(pool);
  const mockReactionSender = makeMockReactionSender();
  const configZero = { ...TEST_CONFIG, reactionCount: 0 };

  const handler = createBoostThanksHandler({
    config: configZero,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("正文"),
    senderOverride: mockSender.sendMessage,
    emojiProvider: mockProvider,
    reactionSenderOverride: mockReactionSender.addReactions,
  });

  await handler.handleBoostEvent(TEST_EVENT);
  // 0 < 8 → 钳制为 8 → 确定性选择 8
  assertEqual(mockReactionSender.calls[0].emojiCount, 8, "REACTION_COUNT=0 钳制为 8");
}

console.log("\n=== 测试 26：REACTION_COUNT=-5 → 安全处理 ===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const pool = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, name: `emoji${i}` }));
  const mockProvider = makeMockEmojiProvider(pool);
  const mockReactionSender = makeMockReactionSender();
  const configNeg = { ...TEST_CONFIG, reactionCount: -5 };

  const handler = createBoostThanksHandler({
    config: configNeg,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("正文"),
    senderOverride: mockSender.sendMessage,
    emojiProvider: mockProvider,
    reactionSenderOverride: mockReactionSender.addReactions,
  });

  await handler.handleBoostEvent(TEST_EVENT);
  const count = mockReactionSender.calls[0].emojiCount;
  // -5 → 钳制为 8 → 确定性选择 8
  assertEqual(count, 8, `REACTION_COUNT=-5 钳制为 8 (${count})`);
}

console.log("\n=== 测试 27：REACTION_COUNT 未设置（默认 10）===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const pool = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, name: `emoji${i}` }));
  const mockProvider = makeMockEmojiProvider(pool);
  const mockReactionSender = makeMockReactionSender();
  const configNoRC = { ...TEST_CONFIG };
  delete configNoRC.reactionCount; // 模拟未设置

  const handler = createBoostThanksHandler({
    config: configNoRC,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("正文"),
    senderOverride: mockSender.sendMessage,
    emojiProvider: mockProvider,
    reactionSenderOverride: mockReactionSender.addReactions,
  });

  await handler.handleBoostEvent(TEST_EVENT);
  const count = mockReactionSender.calls[0].emojiCount;
  assert(count >= 8, `未设置 → ≥ 8 (${count})`);
  assert(count <= 10, `未设置 → ≤ 10 (${count})`);
}

// ============================================================
// Phase 8：持久化 + 去重 + 状态机测试
// ============================================================

import { generateAggregateKey } from "../../storage/boostThanksStore.js";

// ---- Phase 8 Mock 工具 ----

function makeMockStore(initialRecords) {
  const records = new Map(initialRecords?.map((r) => [r.aggregateKey, { ...r }]) ?? []);
  const inFlight = new Map();
  const calls = [];

  function _recordCall(method, aggregateKey, data) {
    calls.push({ method, aggregateKey, data });
  }

  return {
    calls,
    _getRecords: () => records,

    claimEvent: async (aggregateKey, metadata) => {
      _recordCall("claimEvent", aggregateKey, metadata);
      if (inFlight.has(aggregateKey)) return null;
      const existing = records.get(aggregateKey);
      if (existing && ["sent", "uncertain", "test_skipped"].includes(existing.status)) {
        return null;
      }
      if (existing) return null;

      // Partial conflict check (mirrors real store behavior)
      const newSet = new Set(metadata.eventIds);
      for (const [key, rec] of records) {
        const existingSet = new Set(rec.eventIds);
        const intersection = [...newSet].filter((id) => existingSet.has(id));
        if (intersection.length > 0 && intersection.length < Math.max(newSet.size, existingSet.size)) {
          return null;
        }
      }

      const record = {
        aggregateKey,
        eventIds: metadata.eventIds,
        guildId: metadata.guildId,
        userId: metadata.userId,
        boostCount: metadata.boostCount,
        status: "processing",
        attemptCount: 0,
      };
      records.set(aggregateKey, record);
      inFlight.set(aggregateKey, true);
      return record;
    },
    getRecord: (aggregateKey) => records.get(aggregateKey),
    markProcessing: async (aggregateKey) => {
      _recordCall("markProcessing", aggregateKey);
      const r = records.get(aggregateKey);
      if (r) r.status = "processing";
    },
    markSending: async (aggregateKey) => {
      _recordCall("markSending", aggregateKey);
      const r = records.get(aggregateKey);
      if (r) r.status = "sending";
    },
    markSent: async (aggregateKey, { messageId, channelId } = {}) => {
      _recordCall("markSent", aggregateKey, { messageId, channelId });
      const r = records.get(aggregateKey);
      if (r) { r.status = "sent"; r.messageId = messageId; r.channelId = channelId; r.sentAt = Date.now(); }
    },
    markFailedPreSend: async (aggregateKey, { error, errorStage } = {}) => {
      _recordCall("markFailedPreSend", aggregateKey, { error, errorStage });
      const r = records.get(aggregateKey);
      if (r) { r.status = "failed_pre_send"; r.attemptCount = (r.attemptCount ?? 0) + 1; r.lastError = error; r.lastErrorStage = errorStage; }
    },
    markUncertain: async (aggregateKey, reason) => {
      _recordCall("markUncertain", aggregateKey, reason);
      const r = records.get(aggregateKey);
      if (r) { r.status = "uncertain"; r.lastError = reason; }
    },
    markTestSkipped: async (aggregateKey) => {
      _recordCall("markTestSkipped", aggregateKey);
      const r = records.get(aggregateKey);
      if (r) r.status = "test_skipped";
    },
    listRecoverable: () => [...records.values()].filter((r) => r.status === "processing" || r.status === "failed_pre_send"),
    getAllRecords: () => new Map(records),
    close: async () => {},
  };
}

// ---- Phase 8 测试 ----

console.log("\n=== 测试 28：正常链路 → 完整状态机（processing → sending → sent）===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const mockStore = makeMockStore();
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
    store: mockStore,
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, true, "返回 true");

  // 验证状态机调用
  const claimCalls = mockStore.calls.filter((c) => c.method === "claimEvent");
  assertEqual(claimCalls.length, 1, "claimEvent 调用 1 次");
  assertEqual(claimCalls[0].data.guildId, TEST_EVENT.guildId, "claimEvent 含 guildId");
  assertEqual(claimCalls[0].data.userId, TEST_EVENT.userId, "claimEvent 含 userId");
  assertEqual(claimCalls[0].data.boostCount, 2, "claimEvent 含 boostCount");

  const sendingCalls = mockStore.calls.filter((c) => c.method === "markSending");
  assertEqual(sendingCalls.length, 1, "markSending 调用 1 次");

  const sentCalls = mockStore.calls.filter((c) => c.method === "markSent");
  assertEqual(sentCalls.length, 1, "markSent 调用 1 次");
  assertEqual(sentCalls[0].data.messageId, "mock_msg_id", "markSent 含 messageId");
  assertEqual(sentCalls[0].data.channelId, "999999999999", "markSent 含 channelId");

  // markSent 在 Reaction 之前（调用顺序验证）
  const sentIdx = mockStore.calls.findIndex((c) => c.method === "markSent");
  assert(sentIdx >= 0, "markSent 存在");

  // 最终记录状态
  const agKey = generateAggregateKey(TEST_EVENT.eventIds);
  const finalRecord = mockStore.getRecord(agKey);
  assertEqual(finalRecord.status, "sent", "最终状态为 sent");

  // sender 仍只调用一次
  assertEqual(mockSender.calls.length, 1, "sender 调用 1 次");
  // Reaction 正常添加
  assertEqual(mockReactionSender.calls.length, 1, "reactionSender 调用 1 次");
}

console.log("\n=== 测试 29：重复事件 → 跳过，不调用 AI、不发送 ===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const mockStore = makeMockStore();

  // 预置已 sent 的记录
  const agKey = generateAggregateKey(TEST_EVENT.eventIds);
  mockStore._getRecords().set(agKey, {
    aggregateKey: agKey,
    eventIds: TEST_EVENT.eventIds,
    status: "sent",
    messageId: "old_msg",
  });

  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("不应该被调用"),
    senderOverride: mockSender.sendMessage,
    store: mockStore,
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, true, "重复事件返回 true（静默跳过）");
  assertEqual(mockSender.calls.length, 0, "sender 未被调用");
  assertEqual(mockStore.calls.filter((c) => c.method === "markSending").length, 0, "markSending 未被调用");
  assertEqual(mockStore.calls.filter((c) => c.method === "markSent").length, 0, "markSent 未被调用");

  // 跳过日志
  const skipLogs = mockLogger.calls.filter((c) => c.msg && c.msg.includes("已被处理"));
  assert(skipLogs.length >= 1, "产生跳过日志");
}

console.log("\n=== 测试 30：并发调用相同事件 → 只发送一次（claim 互斥）===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const mockStore = makeMockStore();

  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("正文"),
    senderOverride: mockSender.sendMessage,
    store: mockStore,
  });

  const [r1, r2] = await Promise.all([
    handler.handleBoostEvent(TEST_EVENT),
    handler.handleBoostEvent(TEST_EVENT),
  ]);
  // 一个成功发送，一个跳过
  const successCount = [r1, r2].filter((r) => r === true).length;
  assertEqual(successCount, 2, "两者都返回 true（一个发送，一个跳过）");
  assertEqual(mockSender.calls.length, 1, "sender 只调用 1 次（无重复发送）");
}

console.log("\n=== 测试 31：AI 失败 → markFailedPreSend → 可恢复 ===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const mockStore = makeMockStore();

  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeThrowingAi("AI down"),
    senderOverride: mockSender.sendMessage,
    store: mockStore,
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, false, "AI 失败 → 返回 false");
  assertEqual(mockSender.calls.length, 0, "sender 未调用");

  const failedCalls = mockStore.calls.filter((c) => c.method === "markFailedPreSend");
  assertEqual(failedCalls.length, 1, "markFailedPreSend 调用 1 次");
  assertEqual(failedCalls[0].data.error, "AI down", "错误信息已记录");
  assertEqual(failedCalls[0].data.errorStage, "ai", "错误阶段 = ai");

  const agKey = generateAggregateKey(TEST_EVENT.eventIds);
  const record = mockStore.getRecord(agKey);
  assertEqual(record.status, "failed_pre_send", "状态 = failed_pre_send");
  assertEqual(record.attemptCount, 1, "attemptCount = 1");

  // markSending / markSent 未被调用
  assertEqual(mockStore.calls.filter((c) => c.method === "markSending").length, 0, "markSending 未调用");
  assertEqual(mockStore.calls.filter((c) => c.method === "markSent").length, 0, "markSent 未调用");
}

console.log("\n=== 测试 32：title 构造失败 → markFailedPreSend ===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const mockStore = makeMockStore();

  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("ok"),
    senderOverride: mockSender.sendMessage,
    store: mockStore,
  });

  const badEvent = { ...TEST_EVENT, userId: "abc" };
  const result = await handler.handleBoostEvent(badEvent);
  assertEqual(result, false, "title 失败 → 返回 false");
  assertEqual(mockSender.calls.length, 0, "sender 未调用");

  const failedCalls = mockStore.calls.filter((c) => c.method === "markFailedPreSend");
  assertEqual(failedCalls.length, 1, "markFailedPreSend 调用 1 次");
  assertEqual(failedCalls[0].data.errorStage, "title", "错误阶段 = title");
}

console.log("\n=== 测试 33：Discord send 失败 → markUncertain（非 failed_pre_send）===\n");
{
  const mockLogger = makeMockLogger();
  const mockStore = makeMockStore();

  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("ok"),
    senderOverride: makeThrowingSender("Missing Access").sendMessage,
    store: mockStore,
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, false, "send 失败 → 返回 false");

  // 发送前应标记了 sending
  const sendingCalls = mockStore.calls.filter((c) => c.method === "markSending");
  assertEqual(sendingCalls.length, 1, "markSending 调用 1 次（发送前）");

  // 发送失败后标记 uncertain（非 failed_pre_send）——关键安全修复
  const uncertainCalls = mockStore.calls.filter((c) => c.method === "markUncertain");
  assertEqual(uncertainCalls.length, 1, "markUncertain 调用 1 次");
  assert(uncertainCalls[0].data.includes("discord_send_error"), "reason 为 discord_send_error");

  // markFailedPreSend 绝不应被调用
  const failedCalls = mockStore.calls.filter((c) => c.method === "markFailedPreSend");
  assertEqual(failedCalls.length, 0, "markFailedPreSend 未被调用（send 后绝不回退）");

  // markSent 不应被调用
  assertEqual(mockStore.calls.filter((c) => c.method === "markSent").length, 0, "markSent 未调用");

  const agKey = generateAggregateKey(TEST_EVENT.eventIds);
  const record = mockStore.getRecord(agKey);
  assertEqual(record.status, "uncertain", "状态 = uncertain（不是 failed_pre_send）");
}

console.log("\n=== 测试 34：Reaction 失败 → 仍保持 sent（不重新发送）===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const mockStore = makeMockStore();
  const pool = Array.from({ length: 20 }, (_, i) => ({ id: `e${i}`, name: `emoji${i}` }));
  const mockProvider = makeMockEmojiProvider(pool);
  // 所有 Reaction 都失败
  const allFailing = makePartialFailingReactionSender([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("正文"),
    senderOverride: mockSender.sendMessage,
    emojiProvider: mockProvider,
    reactionSenderOverride: allFailing.addReactions,
    store: mockStore,
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, true, "返回 true");
  assertEqual(mockSender.calls.length, 1, "sender 调用 1 次");

  // 状态仍为 sent
  const agKey = generateAggregateKey(TEST_EVENT.eventIds);
  const record = mockStore.getRecord(agKey);
  assertEqual(record.status, "sent", "Reaction 失败后状态仍为 sent");

  // markSent 在 markFailedPreSend 之前（或没有 markFailedPreSend）
  const failedPreSendCalls = mockStore.calls.filter((c) => c.method === "markFailedPreSend");
  assertEqual(failedPreSendCalls.length, 0, "Reaction 失败不调用 markFailedPreSend");
}

console.log("\n=== 测试 35：TEST_MODE → markTestSkipped → 终态 ===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const mockStore = makeMockStore();
  const testModeConfig = { ...TEST_CONFIG, testMode: true };

  const handler = createBoostThanksHandler({
    config: testModeConfig,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("TEST_MODE 正文"),
    senderOverride: mockSender.sendMessage,
    store: mockStore,
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, true, "返回 true");
  assertEqual(mockSender.calls.length, 0, "sender 未调用");

  const testSkippedCalls = mockStore.calls.filter((c) => c.method === "markTestSkipped");
  assertEqual(testSkippedCalls.length, 1, "markTestSkipped 调用 1 次");

  const agKey = generateAggregateKey(TEST_EVENT.eventIds);
  const record = mockStore.getRecord(agKey);
  assertEqual(record.status, "test_skipped", "状态 = test_skipped");

  // 以后不会补发：再次 claim 返回 null
  const r2 = await mockStore.claimEvent(agKey, {
    eventIds: TEST_EVENT.eventIds,
    guildId: TEST_EVENT.guildId,
    userId: TEST_EVENT.userId,
    boostCount: TEST_EVENT.boostCount,
  });
  assertEqual(r2, null, "test_skipped → claim 返回 null（不会补发）");
}

console.log("\n=== 测试 36：eventIds 部分冲突 → 拒绝发送 ===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const mockStore = makeMockStore();

  // 预置 ["msg_1", "msg_2"] → 部分重叠
  const existingKey = generateAggregateKey(["msg_1", "msg_2"]);
  mockStore._getRecords().set(existingKey, {
    aggregateKey: existingKey,
    eventIds: ["msg_1", "msg_2"],
    status: "sent",
    messageId: "old_msg",
  });

  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("正文"),
    senderOverride: mockSender.sendMessage,
    store: mockStore,
  });

  // 新事件含 "msg_2"（重叠）+ "msg_3"（新）
  const conflictEvent = { ...TEST_EVENT, eventIds: ["msg_2", "msg_3"] };
  const result = await handler.handleBoostEvent(conflictEvent);
  assertEqual(result, true, "返回 true（静默跳过）");
  assertEqual(mockSender.calls.length, 0, "sender 未调用（拒绝发送）");
}

// ============================================================
// Phase 8 Review Fix：状态机安全测试
// ============================================================

function makeThrowingMarkSentStore() {
  const base = makeMockStore();
  const origMarkSent = base.markSent;
  base.markSent = async (aggregateKey, opts) => {
    base.calls.push({ method: "markSent", aggregateKey, data: opts });
    throw new Error("disk full");
  };
  return base;
}

function makeStoreThatThrowsOnBoth(throwOnMarkSent) {
  // Returns a store where markSent throws; markUncertain may or may not throw
  const base = makeMockStore();
  const origMarkSent = base.markSent;
  base.markSent = async (aggregateKey, opts) => {
    base.calls.push({ method: "markSent", aggregateKey, data: opts });
    throw new Error("disk full");
  };
  if (throwOnMarkSent) {
    const origMarkUncertain = base.markUncertain;
    base.markUncertain = async (aggregateKey, reason) => {
      base.calls.push({ method: "markUncertain", aggregateKey, data: reason });
      throw new Error("disk completely dead");
    };
  }
  return base;
}

console.log("\n=== 测试 38：send() 抛错 → 标记 uncertain（不是 failed_pre_send）===\n");
{
  const mockLogger = makeMockLogger();
  const mockStore = makeMockStore();

  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("正文"),
    senderOverride: makeThrowingSender("Network Error").sendMessage,
    store: mockStore,
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, false, "返回 false");

  // markSending 在 send() 前被调用
  const sendingCalls = mockStore.calls.filter((c) => c.method === "markSending");
  assertEqual(sendingCalls.length, 1, "markSending 调用 1 次");

  // 关键断言：send() 失败后标记为 uncertain
  const uncertainCalls = mockStore.calls.filter((c) => c.method === "markUncertain");
  assertEqual(uncertainCalls.length, 1, "markUncertain 调用 1 次");

  // 关键断言：绝不能标记为 failed_pre_send
  const failedPreSendCalls = mockStore.calls.filter((c) => c.method === "markFailedPreSend");
  assertEqual(failedPreSendCalls.length, 0, "markFailedPreSend 未调用（send 后绝不回退）");

  // markSent 也未被调用
  const sentCalls = mockStore.calls.filter((c) => c.method === "markSent");
  assertEqual(sentCalls.length, 0, "markSent 未调用");

  // sender 只调用一次
  const agKey = generateAggregateKey(TEST_EVENT.eventIds);
  const record = mockStore.getRecord(agKey);
  assertEqual(record.status, "uncertain", "最终状态 = uncertain");
}

console.log("\n=== 测试 39：send() 成功但 markSent 持久化失败 → uncertain（绝不回退 failed_pre_send）===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const mockStore = makeThrowingMarkSentStore();

  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("正文"),
    senderOverride: mockSender.sendMessage,
    store: mockStore,
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  // 消息已发送成功，即使 markSent 失败也返回 true
  assertEqual(result, true, "消息已发送 → 返回 true");

  // sender 被调用了
  assertEqual(mockSender.calls.length, 1, "sender 调用 1 次（消息已真实发送）");

  // markSent 被尝试调用
  const sentCalls = mockStore.calls.filter((c) => c.method === "markSent");
  assertEqual(sentCalls.length, 1, "markSent 被尝试调用");

  // 关键断言：markSent 失败后尝试 markUncertain
  const uncertainCalls = mockStore.calls.filter((c) => c.method === "markUncertain");
  assert(uncertainCalls.length >= 1, "markSent 失败后尝试 markUncertain");

  // 关键断言：绝不标记为 failed_pre_send
  const failedPreSendCalls = mockStore.calls.filter((c) => c.method === "markFailedPreSend");
  assertEqual(failedPreSendCalls.length, 0, "markFailedPreSend 未调用");

  const agKey = generateAggregateKey(TEST_EVENT.eventIds);
  const record = mockStore.getRecord(agKey);
  assert(record.status !== "failed_pre_send", "状态不是 failed_pre_send");
}

console.log("\n=== 测试 40：send() 成功 markSent 和 markUncertain 都失败 → 保留 sending（不崩溃）===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const mockStore = makeStoreThatThrowsOnBoth(true);

  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("正文"),
    senderOverride: mockSender.sendMessage,
    store: mockStore,
  });

  // 不应崩溃
  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, true, "不崩溃，返回 true");

  // 产生严重错误日志
  const errorLogs = mockLogger.calls.filter((c) => c.level === "error");
  const persistErrors = errorLogs.filter((c) => (c.msg ?? "").includes("连 uncertain 持久化也失败"));
  assert(persistErrors.length >= 1, "产生 uncertain 持久化也失败的严重错误日志");
}

console.log("\n=== 测试 41：outer catch 中 sendAttempted=true → 标记 uncertain（非 failed_pre_send）===\n");
{
  const mockLogger = makeMockLogger();
  const mockStore = makeMockStore();

  // 用特殊 sender：调用 send 成功后立即抛出一个意外异常，模拟 send 后的 outer catch
  let sendCalled = false;
  const trickySender = {
    sendMessage: async (client, channelId, content) => {
      sendCalled = true;
      const msg = { id: "msg_x", content };
      // 模拟 send 成功后发生意外异常（如内存中的引用错误）
      throw new Error("Unexpected post-send crash");
    },
  };

  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("正文"),
    senderOverride: trickySender.sendMessage,
    store: mockStore,
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, false, "返回 false");
  assert(sendCalled, "sender 被调用");

  // 关键：标记为 uncertain 而不是 failed_pre_send
  const uncertainCalls = mockStore.calls.filter((c) => c.method === "markUncertain");
  assertEqual(uncertainCalls.length, 1, "markUncertain 调用 1 次（outer catch sendAttempted=true）");

  const failedPreSendCalls = mockStore.calls.filter((c) => c.method === "markFailedPreSend");
  assertEqual(failedPreSendCalls.length, 0, "markFailedPreSend 未调用（sendAttempted=true 不回退）");

  const agKey = generateAggregateKey(TEST_EVENT.eventIds);
  const record = mockStore.getRecord(agKey);
  assertEqual(record.status, "uncertain", "状态 = uncertain");
}

console.log("\n=== 测试 42：AI 失败（sendAttempted=false）→ 仍标记 failed_pre_send（可安全重试）===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();
  const mockStore = makeMockStore();

  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeThrowingAi("AI 500"),
    senderOverride: mockSender.sendMessage,
    store: mockStore,
  });

  const result = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(result, false, "返回 false");
  assertEqual(mockSender.calls.length, 0, "sender 未调用（sendAttempted 未设）");

  // 发送前失败 → 标记 failed_pre_send（可安全重试）
  const failedPreSendCalls = mockStore.calls.filter((c) => c.method === "markFailedPreSend");
  assertEqual(failedPreSendCalls.length, 1, "markFailedPreSend 调用 1 次（发送前可重试）");

  const uncertainCalls = mockStore.calls.filter((c) => c.method === "markUncertain");
  assertEqual(uncertainCalls.length, 0, "markUncertain 未调用");

  const agKey = generateAggregateKey(TEST_EVENT.eventIds);
  const record = mockStore.getRecord(agKey);
  assertEqual(record.status, "failed_pre_send", "状态 = failed_pre_send");
}

console.log("\n=== 测试 37：无 store → handleBoostEvent 仍正常工作（向后兼容）===\n");
{
  const mockSender = makeMockSender();
  const mockLogger = makeMockLogger();

  const handler = createBoostThanksHandler({
    config: TEST_CONFIG,
    client: MOCK_CLIENT,
    logger: mockLogger,
    aiOverride: makeMockAi("正文"),
    senderOverride: mockSender.sendMessage,
    // 不传 store
  });

  // 第一次
  const r1 = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(r1, true, "第一次返回 true");
  assertEqual(mockSender.calls.length, 1, "第一次 sender 调用 1 次");

  // 第二次（无 store → 无去重 → 仍然发送）
  const r2 = await handler.handleBoostEvent(TEST_EVENT);
  assertEqual(r2, true, "无 store 时第二次也返回 true");
  assertEqual(mockSender.calls.length, 2, "无 store 时 sender 再调一次（无持久化去重）");
}

// ============================================================
console.log(`\n========================================`);
console.log(`测试结果：${passed} passed, ${failed} failed`);
console.log(`========================================\n`);
if (failed > 0) process.exit(1);

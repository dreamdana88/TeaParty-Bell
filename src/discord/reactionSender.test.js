/**
 * reactionSender.js 自动测试（Phase 7）。
 *
 * Mock Discord Message.react()，不连接真实 Discord。
 *
 * 运行：node src/discord/reactionSender.test.js
 */

import { addReactions } from "./reactionSender.js";

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

// ---- Mock 工具 ----

function makeMockEmoji(id, name) {
  return { id, name };
}

function makeMockMessage() {
  const reactCalls = [];
  return {
    reactCalls,
    react: async (emoji) => {
      reactCalls.push({ emoji });
      return { id: "mock_reaction" };
    },
  };
}

function makeMockLogger() {
  const calls = [];
  return {
    calls,
    info: (msg, data) => calls.push({ level: "info", msg, data }),
    warn: (msg, data) => calls.push({ level: "warn", msg, data }),
    error: (msg, data) => calls.push({ level: "error", msg, data }),
    debug: () => {},
  };
}

// ============================================================
console.log("\n=== 测试 1：所有 Reaction 成功 ===\n");
{
  const message = makeMockMessage();
  const emojis = [makeMockEmoji("1", "a"), makeMockEmoji("2", "b"), makeMockEmoji("3", "c")];
  const result = await addReactions(message, emojis);
  assertEqual(result.successCount, 3, "3 个成功");
  assertEqual(result.failCount, 0, "0 个失败");
  assertEqual(result.failures.length, 0, "failures 为空");
  assertEqual(message.reactCalls.length, 3, "react 被调用 3 次");
}

console.log("\n=== 测试 2：部分 Reaction 失败后继续 ===\n");
{
  const reactCalls = [];
  const message = {
    reactCalls,
    react: async (emojiId) => {
      reactCalls.push({ emojiId });
      // addReactions 传入 emoji.id（字符串），不是 emoji 对象
      if (emojiId === "fail_me") throw new Error("reaction failed");
      return {};
    },
  };
  const emojis = [
    makeMockEmoji("1", "good1"),
    makeMockEmoji("fail_me", "bad"),
    makeMockEmoji("3", "good3"),
  ];
  const logger = makeMockLogger();
  const result = await addReactions(message, emojis, logger);
  assertEqual(result.successCount, 2, "2 个成功");
  assertEqual(result.failCount, 1, "1 个失败");
  assertEqual(result.failures.length, 1, "failures 含 1 条");
  assertEqual(result.failures[0].emojiId, "fail_me", "失败记录含 emojiId");
  assertEqual(result.failures[0].emojiName, "bad", "失败记录含 emojiName");
  assertEqual(reactCalls.length, 3, "所有 3 个 react 都被调用（失败不中断）");
  // logger.warn 被调用
  const warns = logger.calls.filter(c => c.level === "warn");
  assert(warns.length >= 1, "产生 warn 日志");
}

console.log("\n=== 测试 3：全部失败 → 不抛出，返回失败数 ===\n");
{
  const message = {
    reactCalls: [],
    react: async () => { throw new Error("all fail"); },
  };
  const emojis = [makeMockEmoji("1", "a"), makeMockEmoji("2", "b")];
  const result = await addReactions(message, emojis);
  assertEqual(result.successCount, 0, "0 个成功");
  assertEqual(result.failCount, 2, "2 个失败");
  assertEqual(result.failures.length, 2, "failures 含 2 条");
}

console.log("\n=== 测试 4：顺序执行（非并发）===\n");
{
  const order = [];
  const message = {
    reactCalls: [],
    react: async (emojiId) => {
      order.push(emojiId);
      return {};
    },
  };
  const emojis = [
    makeMockEmoji("first", "a"),
    makeMockEmoji("second", "b"),
    makeMockEmoji("third", "c"),
  ];
  await addReactions(message, emojis);
  assertEqual(order.join(","), "first,second,third", "按输入顺序执行");
}

console.log("\n=== 测试 5：空 Emoji 数组直接返回 ===\n");
{
  const message = makeMockMessage();
  const result = await addReactions(message, []);
  assertEqual(result.successCount, 0, "0 个成功");
  assertEqual(result.failCount, 0, "0 个失败");
  assertEqual(message.reactCalls.length, 0, "react 未被调用");
}

console.log("\n=== 测试 6：无 logger 时单个失败不崩溃 ===\n");
{
  const message = {
    reactCalls: [],
    react: async () => { throw new Error("fail"); },
  };
  const emojis = [makeMockEmoji("1", "a")];
  // 不传 logger
  const result = await addReactions(message, emojis);
  assertEqual(result.failCount, 1, "失败被记录");
}

console.log("\n=== 测试 7：emoji 无 id 属性时使用自身 ===\n");
{
  const reactCalls = [];
  const message = {
    reactCalls,
    react: async (emoji) => {
      reactCalls.push({ emoji });
      return {};
    },
  };
  const emojis = ["🎉", "❤️"];
  const result = await addReactions(message, emojis);
  assertEqual(result.successCount, 2, "2 个成功");
  // 验证传入了字符串本身（因为无 .id）
  assertEqual(reactCalls[0].emoji, "🎉", "传入字符串 emoji");
}

// ============================================================
console.log(`\n========================================`);
console.log(`测试结果：${passed} passed, ${failed} failed`);
console.log(`========================================\n`);
if (failed > 0) process.exit(1);

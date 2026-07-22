/**
 * applicationEmojis.js 自动测试（Phase 7）。
 *
 * Mock client.application.emojis.fetch()，不连接真实 Discord。
 *
 * 运行：node src/resources/applicationEmojis.test.js
 */

import { createApplicationEmojiProvider } from "./applicationEmojis.js";

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

function makeMockEmoji(id, name, animated = false) {
  return { id, name, animated };
}

function makeMockClient(emojis, shouldThrow = false) {
  let fetchCount = 0;
  return {
    fetchCount: () => fetchCount,
    application: {
      emojis: {
        fetch: async () => {
          fetchCount++;
          if (shouldThrow) throw new Error("Discord API error");
          const map = new Map();
          for (const e of emojis) map.set(e.id, e);
          return map;
        },
      },
    },
  };
}

// ============================================================
console.log("\n=== 测试 1：首次 fetchEmojis 返回全部 Emoji ===\n");
{
  const mockClient = makeMockClient([
    makeMockEmoji("111", "heart"),
    makeMockEmoji("222", "star"),
    makeMockEmoji("333", "fire"),
  ]);
  const provider = createApplicationEmojiProvider(mockClient);

  const result = await provider.fetchEmojis();
  assertEqual(result.length, 3, "返回 3 个 Emoji");
  assertEqual(mockClient.fetchCount(), 1, "fetch 被调用 1 次");
}

console.log("\n=== 测试 2：第二次调用返回缓存，不重新请求 ===\n");
{
  const mockClient = makeMockClient([
    makeMockEmoji("111", "heart"),
  ]);
  const provider = createApplicationEmojiProvider(mockClient);

  const r1 = await provider.fetchEmojis();
  assertEqual(mockClient.fetchCount(), 1, "第一次 fetch 调用 1 次");

  const r2 = await provider.fetchEmojis();
  assertEqual(mockClient.fetchCount(), 1, "第二次 fetch 仍为 1 次（命中缓存）");
  assert(r1 === r2, "两次返回同一引用（缓存命中）");
}

console.log("\n=== 测试 3：getCached 初次为 null，fetch 后返回缓存 ===\n");
{
  const mockClient = makeMockClient([makeMockEmoji("111", "heart")]);
  const provider = createApplicationEmojiProvider(mockClient);

  assertEqual(provider.getCached(), null, "未 fetch 时 getCached 返回 null");
  await provider.fetchEmojis();
  assert(provider.getCached() !== null, "fetch 后 getCached 非 null");
  assertEqual(provider.getCached().length, 1, "getCached 返回 1 个 Emoji");
}

console.log("\n=== 测试 4：clearCache 后重新 fetch ===\n");
{
  const mockClient = makeMockClient([makeMockEmoji("111", "heart")]);
  const provider = createApplicationEmojiProvider(mockClient);

  await provider.fetchEmojis();
  assertEqual(mockClient.fetchCount(), 1, "首次 fetch");

  provider.clearCache();
  assertEqual(provider.getCached(), null, "clearCache 后 getCached = null");

  await provider.fetchEmojis();
  assertEqual(mockClient.fetchCount(), 2, "clearCache 后重新 fetch");
}

console.log("\n=== 测试 5：fetch 失败返回 null，不缓存错误结果 ===\n");
{
  const mockClient = makeMockClient([], true); // shouldThrow
  const provider = createApplicationEmojiProvider(mockClient);

  const result = await provider.fetchEmojis();
  assertEqual(result, null, "fetch 失败返回 null");
  assertEqual(provider.getCached(), null, "失败不缓存（getCached = null）");
}

console.log("\n=== 测试 6：fetch 失败后，下一次 fetch 重新尝试 ===\n");
{
  let shouldFail = true;
  const mockClient = {
    application: {
      emojis: {
        fetch: async () => {
          if (shouldFail) throw new Error("fail");
          const map = new Map();
          map.set("111", makeMockEmoji("111", "heart"));
          return map;
        },
      },
    },
  };
  const provider = createApplicationEmojiProvider(mockClient);

  const r1 = await provider.fetchEmojis();
  assertEqual(r1, null, "第一次失败");

  shouldFail = false;
  const r2 = await provider.fetchEmojis();
  assert(r2 !== null, "第二次成功");
  assertEqual(r2.length, 1, "第二次返回 1 个");
}

console.log("\n=== 测试 7：空集合正常返回 [] ===\n");
{
  const mockClient = makeMockClient([]);
  const provider = createApplicationEmojiProvider(mockClient);

  const result = await provider.fetchEmojis();
  assert(Array.isArray(result), "返回数组");
  assertEqual(result.length, 0, "空集合返回 []");
}

// ============================================================
console.log(`\n========================================`);
console.log(`测试结果：${passed} passed, ${failed} failed`);
console.log(`========================================\n`);
if (failed > 0) process.exit(1);

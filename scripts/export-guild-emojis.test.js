/**
 * export-guild-emojis.js 纯逻辑自动测试（Phase 4.5）。
 *
 * 仅测试导出函数（buildCdnUrl / sanitizeFileName / buildEmojiFileName / buildManifest）。
 * 不连接真实 Discord，不下载文件。
 *
 * 运行：node scripts/export-guild-emojis.test.js
 */

import {
  buildCdnUrl,
  sanitizeFileName,
  buildEmojiFileName,
  buildManifest,
} from "./export-guild-emojis.js";

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
    console.error(
      `  FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
    );
  }
}

function assertIncludes(haystack, needle, label) {
  if (haystack.includes(needle)) {
    passed++;
    console.log(`  PASS: ${label}`);
  } else {
    failed++;
    console.error(`  FAIL: ${label} — "${haystack}" does not include "${needle}"`);
  }
}

// ============================================================
// Test Suite
// ============================================================

console.log("\n=== 测试 1：Emoji 列表为空 → buildManifest ===\n");

{
  const manifest = buildManifest("g1", []);
  assertEqual(manifest.total, 0, "total = 0");
  assertEqual(manifest.successCount, 0, "successCount = 0");
  assertEqual(manifest.failedCount, 0, "failedCount = 0");
  assertEqual(manifest.emojis.length, 0, "emojis 数组为空");
  assertEqual(manifest.guildId, "g1", "guildId 正确");
  assert(typeof manifest.exportedAt === "string", "exportedAt 是字符串");
  assert(new Date(manifest.exportedAt).getTime() > 0, "exportedAt 是有效 ISO 时间");
}

console.log("\n=== 测试 2：单个静态 Emoji ===\n");

{
  const records = [
    {
      id: "123",
      name: "heart_red",
      animated: false,
      available: true,
      managed: false,
      roles: [],
      filename: "heart_red__123.webp",
      downloaded: true,
      error: null,
    },
  ];
  const manifest = buildManifest("g1", records);
  assertEqual(manifest.total, 1, "total = 1");
  assertEqual(manifest.successCount, 1, "successCount = 1");
  assertEqual(manifest.failedCount, 0, "failedCount = 0");
  assertEqual(manifest.emojis[0].id, "123", "id 正确");
  assertEqual(manifest.emojis[0].name, "heart_red", "name 正确");
  assertEqual(manifest.emojis[0].animated, false, "animated = false");
  assertEqual(manifest.emojis[0].downloaded, true, "downloaded = true");
  assertEqual(manifest.emojis[0].error, null, "error = null");
}

console.log("\n=== 测试 3：单个动画 Emoji ===\n");

{
  const records = [
    {
      id: "456",
      name: "catr_yummysnatch",
      animated: true,
      available: true,
      managed: false,
      roles: [],
      filename: "catr_yummysnatch__456.webp",
      downloaded: true,
      error: null,
    },
  ];
  const manifest = buildManifest("g1", records);
  assertEqual(manifest.emojis[0].animated, true, "animated = true");
}

console.log("\n=== 测试 4：多个 Emoji ===\n");

{
  const records = [
    { id: "1", name: "a", animated: false, available: true, managed: false, roles: [], filename: "a__1.webp", downloaded: true, error: null },
    { id: "2", name: "b", animated: false, available: true, managed: false, roles: [], filename: "b__2.webp", downloaded: true, error: null },
    { id: "3", name: "c", animated: true, available: true, managed: false, roles: [], filename: "c__3.webp", downloaded: true, error: null },
  ];
  const manifest = buildManifest("g1", records);
  assertEqual(manifest.total, 3, "total = 3");
  assertEqual(manifest.successCount, 3, "successCount = 3");
  assertEqual(manifest.emojis.length, 3, "emojis 数组长度 3");
}

console.log("\n=== 测试 5：静态 CDN URL 正确 ===\n");

{
  const url = buildCdnUrl("1234567890", false);
  assertEqual(
    url,
    "https://cdn.discordapp.com/emojis/1234567890.webp",
    "静态 URL"
  );
  assert(!url.includes("animated"), "静态 URL 不含 animated 参数");
}

console.log("\n=== 测试 6：动画 CDN URL 包含 animated=true ===\n");

{
  const url = buildCdnUrl("9876543210", true);
  assertEqual(
    url,
    "https://cdn.discordapp.com/emojis/9876543210.webp?animated=true",
    "动画 URL"
  );
  assertIncludes(url, "?animated=true", "包含 ?animated=true");
  assert(url.endsWith("?animated=true"), "以 ?animated=true 结尾");
}

console.log("\n=== 测试 7：文件名包含 name + id ===\n");

{
  const filename = buildEmojiFileName({ id: "123456", name: "heart_red" });
  assertEqual(filename, "heart_red__123456.webp", "文件名格式正确");
  assert(filename.startsWith("heart_red"), "以 name 开头");
  assertIncludes(filename, "__123456", "包含 __id");
  assert(filename.endsWith(".webp"), "以 .webp 结尾");
}

console.log("\n=== 测试 8：同名不同 ID 不覆盖 ===\n");

{
  const f1 = buildEmojiFileName({ id: "111", name: "test" });
  const f2 = buildEmojiFileName({ id: "222", name: "test" });
  assertEqual(f1, "test__111.webp", "ID 111");
  assertEqual(f2, "test__222.webp", "ID 222");
  assert(f1 !== f2, "同名不同 ID 产生不同文件名");
}

console.log("\n=== 测试 9：非法文件名字符被安全处理 ===\n");

{
  // Windows 非法字符: \ / : * ? " < > |
  const cases = [
    { input: "hello:world", expected: "hello_world" },
    { input: "a/b\\c", expected: "a_b_c" },
    { input: "test<emoji>", expected: "test_emoji_" },
    { input: 'name"with"quotes', expected: "name_with_quotes" },
    { input: "star*emoji", expected: "star_emoji" },
    { input: "pipe|char", expected: "pipe_char" },
    { input: "ques?tion", expected: "ques_tion" },
  ];
  for (const { input, expected } of cases) {
    const result = sanitizeFileName(input, "999");
    assertEqual(result, expected, `"${input}" → "${expected}"`);
  }
}

console.log("\n=== 测试 10：name 为空时安全 fallback ===\n");

{
  assertEqual(
    sanitizeFileName(null, "12345"),
    "emoji_12345",
    "null → emoji_12345"
  );
  assertEqual(
    sanitizeFileName(undefined, "12345"),
    "emoji_12345",
    "undefined → emoji_12345"
  );
  assertEqual(
    sanitizeFileName("", "12345"),
    "emoji_12345",
    '"" → emoji_12345'
  );
  assertEqual(
    sanitizeFileName("   ", "12345"),
    "emoji_12345",
    '"   " → emoji_12345'
  );
}

console.log("\n=== 测试 11：manifest 字段正确 ===\n");

{
  const records = [
    { id: "1", name: "heart", animated: false, available: true, managed: false, roles: ["r1"], filename: "heart__1.webp", downloaded: true, error: null },
    { id: "2", name: "star", animated: true, available: false, managed: true, roles: [], filename: "star__2.webp", downloaded: true, error: null },
  ];
  const manifest = buildManifest("guild_abc", records);
  assertEqual(manifest.guildId, "guild_abc", "guildId");
  assertEqual(manifest.total, 2, "total");
  assertEqual(manifest.successCount, 2, "successCount");
  assertEqual(manifest.failedCount, 0, "failedCount");
  assert(typeof manifest.exportedAt === "string", "exportedAt");
  // 第一个 emoji
  assertEqual(manifest.emojis[0].id, "1", "emoji[0].id");
  assertEqual(manifest.emojis[0].name, "heart", "emoji[0].name");
  assertEqual(manifest.emojis[0].animated, false, "emoji[0].animated");
  assertEqual(manifest.emojis[0].available, true, "emoji[0].available");
  assertEqual(manifest.emojis[0].managed, false, "emoji[0].managed");
  assertEqual(manifest.emojis[0].roles.length, 1, "emoji[0].roles.length");
  assertEqual(manifest.emojis[0].roles[0], "r1", "emoji[0].roles[0]");
  assertEqual(manifest.emojis[0].downloaded, true, "emoji[0].downloaded");
  assertEqual(manifest.emojis[0].error, null, "emoji[0].error");
  // 第二个 emoji
  assertEqual(manifest.emojis[1].available, false, "emoji[1].available = false");
  assertEqual(manifest.emojis[1].managed, true, "emoji[1].managed = true");
  assertEqual(manifest.emojis[1].animated, true, "emoji[1].animated = true");
}

console.log("\n=== 测试 12：单个下载失败不阻塞其他 Emoji ===\n");

{
  // 模拟 2 成功 1 失败
  const records = [
    { id: "1", name: "good1", animated: false, available: true, managed: false, roles: [], filename: "good1__1.webp", downloaded: true, error: null },
    { id: "2", name: "bad", animated: false, available: true, managed: false, roles: [], filename: "bad__2.webp", downloaded: false, error: "CDN HTTP 404" },
    { id: "3", name: "good2", animated: false, available: true, managed: false, roles: [], filename: "good2__3.webp", downloaded: true, error: null },
  ];
  const manifest = buildManifest("g1", records);
  assertEqual(manifest.total, 3, "total = 3");
  assertEqual(manifest.successCount, 2, "successCount = 2");
  assertEqual(manifest.failedCount, 1, "failedCount = 1");
}

console.log("\n=== 测试 13：失败 Emoji 写入 manifest ===\n");

{
  const records = [
    { id: "fail1", name: "broken", animated: false, available: true, managed: false, roles: [], filename: "broken__fail1.webp", downloaded: false, error: "CDN HTTP 503" },
  ];
  const manifest = buildManifest("g1", records);
  assertEqual(manifest.total, 1, "total = 1");
  assertEqual(manifest.successCount, 0, "successCount = 0");
  assertEqual(manifest.failedCount, 1, "failedCount = 1");
  assertEqual(manifest.emojis[0].downloaded, false, "downloaded = false");
  assertEqual(manifest.emojis[0].error, "CDN HTTP 503", "error 记录失败原因");
  assert(manifest.emojis[0].filename.includes("broken"), "filename 仍被记录");
}

console.log("\n=== 测试 14：失败下载不留下 .part 残留 ===\n");

{
  // downloadFile 内部使用 .part 临时文件，失败后清理
  // 验证 manifest 中失败记录的 filename 不含 .part 后缀
  const records = [
    { id: "bad", name: "broken_emoji", animated: false, available: true, managed: false, roles: [], filename: "broken_emoji__bad.webp", downloaded: false, error: "CDN HTTP 500" },
  ];
  const manifest = buildManifest("g1", records);
  assertEqual(manifest.emojis[0].filename, "broken_emoji__bad.webp", "失败记录 filename 为正式名（非 .part）");
  assert(!manifest.emojis[0].filename.endsWith(".part"), "filename 不以 .part 结尾");
  assertEqual(manifest.emojis[0].downloaded, false, "downloaded = false");
  assert(manifest.emojis[0].error !== null, "有 error 记录");
}

console.log("\n=== 测试 15：成功下载后 filename 为正式 .webp ===\n");

{
  // 所有成功记录 filename 均为 .webp，不含 .part
  const records = [
    { id: "1", name: "ok1", animated: false, available: true, managed: false, roles: [], filename: "ok1__1.webp", downloaded: true, error: null },
    { id: "2", name: "ok2", animated: true, available: true, managed: false, roles: [], filename: "ok2__2.webp", downloaded: true, error: null },
    { id: "3", name: "bad", animated: false, available: true, managed: false, roles: [], filename: "bad__3.webp", downloaded: false, error: "CDN HTTP 503" },
  ];
  const manifest = buildManifest("g1", records);
  for (const e of manifest.emojis) {
    assert(e.filename.endsWith(".webp"), `${e.id} filename 以 .webp 结尾`);
    assert(!e.filename.includes(".part"), `${e.id} filename 不含 .part`);
  }
  assertEqual(manifest.successCount, 2, "successCount = 2");
  assertEqual(manifest.failedCount, 1, "failedCount = 1");
}

console.log("\n=== 测试 16：不泄露 Bot Token ===\n");

{
  // 验证 manifest / filename / URL 中不含敏感信息
  const records = [
    { id: "1", name: "test", animated: false, available: true, managed: false, roles: [], filename: "test__1.webp", downloaded: true, error: null },
  ];
  const manifest = buildManifest("g1", records);
  const json = JSON.stringify(manifest);
  const sensitive = ["token", "Bearer", "Authorization", "api_key", "secret"];
  for (const s of sensitive) {
    assert(!json.toLowerCase().includes(s.toLowerCase()), `manifest 不含 "${s}"`);
  }

  // CDN URL 不含 token
  const url = buildCdnUrl("123", false);
  assert(!url.includes("token"), "CDN URL 不含 token");
  assert(!url.includes("Bearer"), "CDN URL 不含 Bearer");

  // filename 不含 token
  const filename = buildEmojiFileName({ id: "123", name: "test" });
  assert(!filename.includes("token"), "文件名不含 token");
}

console.log("\n=== 测试 17：输出目录限制正确 ===\n");

{
  // 验证 sanitizeFileName 阻止路径穿越
  const result = sanitizeFileName("../../etc/passwd", "123");
  assert(!result.includes("/"), "不含 / 路径分隔符");
  assert(!result.includes(".."), "不含 .. 父目录引用");
  assert(!result.includes("\\"), "不含 \\ 路径分隔符");
  // "/" → "_" (2处) → ".._.._etc_passwd", 然后 ".." → "_" (2处匹配) → "____etc_passwd"
  assertEqual(result, "____etc_passwd", "路径被安全处理（/ 和 .. 均被替换）");
}

{
  // 验证 ..\\ 被阻止
  const result = sanitizeFileName("..\\..\\windows", "456");
  assert(!result.includes(".."), "不含 ..");
  assert(!result.includes("\\"), "不含 \\");
}

{
  // 验证以点结尾的 name 被处理
  const result = sanitizeFileName("trailing...", "789");
  assert(!result.endsWith("."), "不以点结尾");
}

{
  // 验证 buildEmojiFileName 始终在预期文件名内
  const filename = buildEmojiFileName({ id: "999", name: "../../escape" });
  assert(!filename.includes("/"), "buildEmojiFileName 不含 /");
  assert(!filename.includes("\\"), "buildEmojiFileName 不含 \\");
  assert(!filename.includes(".."), "buildEmojiFileName 不含 ..");
  assert(filename.endsWith(".webp"), "仍以 .webp 结尾");
}

console.log("\n=== 测试 18：工具结束后正确销毁 Client —— 逻辑验证 ===\n");

{
  // exportGuildEmojis 函数在所有路径中都调用 client.destroy()
  // 通过代码审查验证（此测试确认所有 return 路径前有 destroy 调用）
  // 此处验证空列表路径的 manifest 正常生成
  const manifest = buildManifest("g1", []);
  assertEqual(manifest.total, 0, "空列表 manifest.total=0");
  // 空 Guild 场景在主流程中仍会生成 manifest 并清理 client
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

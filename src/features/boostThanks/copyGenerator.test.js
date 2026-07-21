/**
 * messageBuilder.js / copyGenerator.js 自动测试（Phase 5 Review Fix）。
 *
 * 使用 Mock AI，不消耗真实 DeepSeek API 额度。
 *
 * 运行：node src/features/boostThanks/copyGenerator.test.js
 */

import { buildTitle, assembleMessage } from "./messageBuilder.js";
import { createCopyGenerator, getPromptPath } from "./copyGenerator.js";

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
async function assertRejects(promiseFn, expectedMsg, label) {
  try { await promiseFn(); failed++; console.error(`  FAIL: ${label} — did not throw`); }
  catch (err) {
    if (err.message.includes(expectedMsg)) { passed++; console.log(`  PASS: ${label}`); }
    else { failed++; console.error(`  FAIL: ${label} — wrong error: ${err.message}`); }
  }
}

// ---- Mock AI ----
function makeMockAi(response) {
  return { generateText: async () => response };
}
/** Capturing mock: records messages + options, returns response */
function makeCapturingMockAi(response, capture) {
  return {
    generateText: async (messages, options) => {
      capture.messages = messages;
      capture.options = options;
      return response;
    },
  };
}

const TEST_CONFIG = { deepseekApiKey: "sk-test-mock" };
const TEST_USER_ID = "1426581758194876577";
const TEST_DISPLAY = "Dreamdana";

// ============================================================
console.log("\n=== 测试 1：单次 Boost 标题完全正确 ===\n");
{
  const title = buildTitle("1426581758194876577", 1);
  assertIncludes(title, "<:heart_red:1456223334067867689>", "包含 heart_red Emoji");
  assertIncludes(title, "<@1426581758194876577>", "包含用户 Mention");
  assertIncludes(title, "投喂的助力", "固定文案「投喂的助力」");
  assert(title.startsWith("# "), "以 #  开头");
}

console.log("\n=== 测试 2：两次 Boost 标题完全正确 ===\n");
{
  const title = buildTitle("999", 2);
  assertIncludes(title, "<@999>", "包含用户 Mention");
  assertIncludes(title, "两个助力", "固定文案「两个助力」");
  assert(!title.includes("投喂"), "不含「投喂」");
}

console.log("\n=== 测试 3：3～99 中文数字 ===\n");
{
  assertIncludes(buildTitle("1", 3), "三个助力", "3→三个");
  assertIncludes(buildTitle("1", 5), "五个助力", "5→五个");
  assertIncludes(buildTitle("1", 10), "十个助力", "10→十个");
  assertIncludes(buildTitle("1", 12), "十二个助力", "12→十二个");
  assertIncludes(buildTitle("1", 23), "二十三个助力", "23→二十三个");
  assertIncludes(buildTitle("1", 99), "九十九个助力", "99→九十九个");
}

console.log("\n=== 测试 4：100+ 使用阿拉伯数字，不出现 undefined ===\n");
{
  assertIncludes(buildTitle("1", 100), "100个助力", "100→100个助力");
  assertIncludes(buildTitle("1", 128), "128个助力", "128→128个助力");
  assertIncludes(buildTitle("1", 999), "999个助力", "999→999个助力");
  // 确保不含 undefined
  for (const n of [100, 128, 500, 999]) {
    const t = buildTitle("1", n);
    assert(!t.includes("undefined"), `${n} 标题不含 undefined`);
  }
}

console.log("\n=== 测试 5：userId 校验加强（纯数字）===\n");
{
  await assertRejects(() => buildTitle("", 1), "纯数字", "空字符串→抛出");
  await assertRejects(() => buildTitle(null, 1), "纯数字", "null→抛出");
  await assertRejects(() => buildTitle("abc", 1), "纯数字", "abc→抛出");
  await assertRejects(() => buildTitle("u_123", 1), "纯数字", "含下划线→抛出");
  await assertRejects(() => buildTitle("12 34", 1), "纯数字", "含空格→抛出");
  // 正常纯数字不抛
  buildTitle("123456789", 1); assert(true, "纯数字 userId 正常");
}

console.log("\n=== 测试 6：assembleMessage 使用双换行 ===\n");
{
  const msg = assembleMessage("# title", "body");
  assert(msg.includes("\n\n"), "包含双换行 \\n\\n");
  assert(!msg.includes("\n\n\n"), "不含三换行");
  assertEqual(msg, "# title\n\nbody", "格式为 title\\n\\nbody");
}

console.log("\n=== 测试 7：AI 只负责正文（不再要求 userId）===\n");
{
  const mockAi = makeMockAi("祝你今天一切顺利✨");
  const gen = createCopyGenerator(TEST_CONFIG, mockAi);
  const body = await gen.generateCopy({ displayName: TEST_DISPLAY, boostCount: 1 });
  assertEqual(body, "祝你今天一切顺利✨", "正文正确返回（无 userId）");
}

console.log("\n=== 测试 8：正文 trim 正确 ===\n");
{
  const gen = createCopyGenerator(TEST_CONFIG, makeMockAi("  \n  前后空白  \n  "));
  const body = await gen.generateCopy({ displayName: TEST_DISPLAY, boostCount: 1 });
  assertEqual(body, "前后空白", "trim");
}

console.log("\n=== 测试 9：空正文明确失败 ===\n");
{
  const gen = createCopyGenerator(TEST_CONFIG, makeMockAi(""));
  await assertRejects(
    () => gen.generateCopy({ displayName: TEST_DISPLAY, boostCount: 1 }),
    "正文为空", "空→抛出");
}

console.log("\n=== 测试 10：whitespace-only 正文明确失败 ===\n");
{
  const gen = createCopyGenerator(TEST_CONFIG, makeMockAi("   \n \t  "));
  await assertRejects(
    () => gen.generateCopy({ displayName: TEST_DISPLAY, boostCount: 1 }),
    "正文为空", "whitespace-only→抛出");
}

console.log("\n=== 测试 11：AI 输出用户 Mention 时拒绝 ===\n");
{
  await assertRejects(
    () => createCopyGenerator(TEST_CONFIG, makeMockAi("感谢 <@123456> 助力")).generateCopy({ displayName: "X", boostCount: 1 }),
    "Discord 用户 Mention", "<@123>→拒绝");
  await assertRejects(
    () => createCopyGenerator(TEST_CONFIG, makeMockAi("<@!987654> 好")).generateCopy({ displayName: "X", boostCount: 1 }),
    "Discord 用户 Mention", "<@!987>→拒绝");
}

console.log("\n=== 测试 12：AI 输出 Role Mention 时拒绝 ===\n");
{
  await assertRejects(
    () => createCopyGenerator(TEST_CONFIG, makeMockAi("通知 <@&456> 一声")).generateCopy({ displayName: "X", boostCount: 1 }),
    "身份组 Mention", "<@&456>→拒绝");
}

console.log("\n=== 测试 13：AI 输出 Channel Mention 时拒绝 ===\n");
{
  await assertRejects(
    () => createCopyGenerator(TEST_CONFIG, makeMockAi("去 <#789> 看看")).generateCopy({ displayName: "X", boostCount: 1 }),
    "频道 Mention", "<#789>→拒绝");
}

console.log("\n=== 测试 14：AI 输出 @everyone 时拒绝 ===\n");
{
  await assertRejects(
    () => createCopyGenerator(TEST_CONFIG, makeMockAi("感谢 @everyone")).generateCopy({ displayName: "X", boostCount: 1 }),
    "@everyone", "@everyone→拒绝");
}

console.log("\n=== 测试 15：AI 输出 @here 时拒绝 ===\n");
{
  await assertRejects(
    () => createCopyGenerator(TEST_CONFIG, makeMockAi("@here 有人在吗")).generateCopy({ displayName: "X", boostCount: 1 }),
    "@everyone", "@here→拒绝");
}

console.log("\n=== 测试 16：AI 输出静态 Emoji 时拒绝 ===\n");
{
  await assertRejects(
    () => createCopyGenerator(TEST_CONFIG, makeMockAi("送你 <:heart_red:123> 哦")).generateCopy({ displayName: "X", boostCount: 1 }),
    "自定义 Emoji", "静态 Emoji→拒绝");
}

console.log("\n=== 测试 17：AI 输出动画 Emoji 时拒绝 ===\n");
{
  await assertRejects(
    () => createCopyGenerator(TEST_CONFIG, makeMockAi("<a:partyparrot:456> 好")).generateCopy({ displayName: "X", boostCount: 1 }),
    "自定义 Emoji", "动画 Emoji→拒绝");
}

console.log("\n=== 测试 18：AI 输出 Markdown 标题时拒绝 ===\n");
{
  for (const level of [1, 2, 3]) {
    const prefix = "#".repeat(level);
    await assertRejects(
      () => createCopyGenerator(TEST_CONFIG, makeMockAi(`${prefix} 标题\n正文`)).generateCopy({ displayName: "X", boostCount: 1 }),
      "Markdown 标题", `${prefix} 标题→拒绝`);
  }
}

console.log("\n=== 测试 19：displayName 缺失时仍可生成 ===\n");
{
  const gen = createCopyGenerator(TEST_CONFIG, makeMockAi("新朋友你好！🎉"));
  const body = await gen.generateCopy({ displayName: null, boostCount: 1 });
  assert(body.length > 0, "生成非空正文");
}

console.log("\n=== 测试 20：boostCount 非法时明确失败 ===\n");
{
  await assertRejects(() => buildTitle("1", 0), "正整", "buildTitle=0→抛出");
  await assertRejects(() => buildTitle("1", -1), "正整", "buildTitle=-1→抛出");
  await assertRejects(() => buildTitle("1", 1.5), "正整", "buildTitle=1.5→抛出");
  const gen = createCopyGenerator(TEST_CONFIG, makeMockAi("x"));
  await assertRejects(() => gen.generateCopy({ boostCount: 0 }), "正整", "generateCopy=0→抛出");
}

console.log("\n=== 测试 21：100 Unicode 字符允许 ===\n");
{
  const exactly100 = "啊".repeat(100); // 100 emoji chars
  const gen = createCopyGenerator(TEST_CONFIG, makeMockAi(exactly100));
  const body = await gen.generateCopy({ displayName: TEST_DISPLAY, boostCount: 1 });
  assertEqual(Array.from(body).length, 100, "100 字符允许");
}

console.log("\n=== 测试 22：101 Unicode 字符拒绝 ===\n");
{
  const gen = createCopyGenerator(TEST_CONFIG, makeMockAi("啊".repeat(101)));
  await assertRejects(
    () => gen.generateCopy({ displayName: TEST_DISPLAY, boostCount: 1 }),
    "过长", "101 字符→拒绝");
}

console.log("\n=== 测试 23：Emoji Unicode 长度计算正确 ===\n");
{
  // Emoji 可能占多个 UTF-16 code units，但 Array.from 正确计数为 1
  const textWithEmoji = "你好✨🎉世界";
  assertEqual(Array.from(textWithEmoji).length, 6, "Array.from 正确计数字符（含 Emoji）");
  const gen = createCopyGenerator(TEST_CONFIG, makeMockAi(textWithEmoji));
  const body = await gen.generateCopy({ displayName: TEST_DISPLAY, boostCount: 1 });
  assertEqual(body, textWithEmoji, "含 Emoji 正文通过");
}

console.log("\n=== 测试 24：无 interest 时不伪造兴趣 ===\n");
{
  const capture = {};
  const gen = createCopyGenerator(TEST_CONFIG, makeCapturingMockAi("ok", capture));
  await gen.generateCopy({ displayName: TEST_DISPLAY, boostCount: 1 });
  const userContent = capture.messages[1].content;
  assert(!userContent.includes("兴趣"), "不传 interest 时不含「兴趣」字段");
}

console.log("\n=== 测试 25：capturing mock 验证 messages 和 options ===\n");
{
  const capture = {};
  const gen = createCopyGenerator(TEST_CONFIG, makeCapturingMockAi("ok", capture));
  await gen.generateCopy({ displayName: "Dreamdana", boostCount: 2, interest: "星露谷" });

  const msgs = capture.messages;
  const opts = capture.options;

  // messages 验证
  assert(msgs.length === 2, "messages 长度 = 2");
  assertEqual(msgs[0].role, "system", "system role");
  assert(msgs[0].content.length > 0, "system content 非空");
  assertEqual(msgs[1].role, "user", "user role");
  assertIncludes(msgs[1].content, "Dreamdana", "user content 含 displayName");
  assertIncludes(msgs[1].content, "2个助力", "user content 含 boostCount");
  assertIncludes(msgs[1].content, "星露谷", "user content 含 interest");
  assert(!msgs[1].content.includes(TEST_USER_ID), "user content 不含 userId");
  assert(!msgs[1].content.includes("sk-test"), "user content 不含 API Key");

  // options 验证
  assertEqual(opts.maxTokens, 128, "maxTokens = 128");
  assert(opts.thinking !== undefined, "thinking 已设置");
  assertEqual(opts.thinking.type, "disabled", "thinking = disabled");
}

console.log("\n=== 测试 26：Prompt 文件路径正确 ===\n");
{
  const p = getPromptPath();
  assert(p.replace(/\\/g, "/").endsWith("data/prompts/boost-thanks.md"), "路径正确");
  const { readFileSync } = await import("fs");
  let ok = false;
  try { readFileSync(p, "utf-8"); ok = true; } catch {}
  assert(ok, "文件存在可读");
}

console.log("\n=== 测试 27：不泄露 Token/API Key ===\n");
{
  const title = buildTitle(TEST_USER_ID, 1);
  assert(!title.includes("sk-test"), "标题不含 API Key");
  const msg = assembleMessage(title, "hi");
  assert(!msg.includes("sk-test"), "消息不含 API Key");
  const gen = createCopyGenerator(TEST_CONFIG, makeMockAi("ok"));
  const body = await gen.generateCopy({ displayName: TEST_DISPLAY, boostCount: 1 });
  assert(!body.includes("sk-test"), "正文不含 API Key");
  assert(!body.includes("Bearer"), "正文不含 Bearer");
}

console.log("\n=== 测试 28：Mock AI 注入不绑死 deepseek ===\n");
{
  const gen = createCopyGenerator(TEST_CONFIG, makeMockAi("mock ok"));
  const body = await gen.generateCopy({ displayName: "X", boostCount: 1 });
  assertEqual(body, "mock ok", "Mock AI 正常工作");
}

console.log("\n=== 测试 29：Unicode Emoji 正常通过 ===\n");
{
  const gen = createCopyGenerator(TEST_CONFIG, makeMockAi("祝你今天愉快！✨🎉 一切顺利～"));
  const body = await gen.generateCopy({ displayName: TEST_DISPLAY, boostCount: 1 });
  assert(body.length > 0, "含 Unicode Emoji 通过");
}

// ============================================================
console.log(`\n========================================`);
console.log(`测试结果：${passed} passed, ${failed} failed`);
console.log(`========================================\n`);
if (failed > 0) process.exit(1);

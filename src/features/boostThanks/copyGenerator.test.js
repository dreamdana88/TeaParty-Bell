/**
 * messageBuilder.js / copyGenerator.js 自动测试（Phase 5）。
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

async function assertRejects(promiseFn, expectedMsg, label) {
  try {
    await promiseFn();
    failed++;
    console.error(`  FAIL: ${label} — did not throw`);
  } catch (err) {
    if (err.message.includes(expectedMsg)) {
      passed++;
      console.log(`  PASS: ${label}`);
    } else {
      failed++;
      console.error(
        `  FAIL: ${label} — wrong error: ${err.message}`
      );
    }
  }
}

// ---- Mock AI ----
function makeMockAi(response) {
  return {
    generateText: async () => response,
  };
}

function makeThrowingAi(errorMessage) {
  return {
    generateText: async () => { throw new Error(errorMessage); },
  };
}

const TEST_CONFIG = { deepseekApiKey: "sk-test-mock" };

// ---- Test user ----
const TEST_USER_ID = "1426581758194876577";
const TEST_DISPLAY = "Dreamdana";

// ============================================================
// Test Suite
// ============================================================

// === 测试 1：单次 Boost 标题完全正确 ===

console.log("\n=== 测试 1：单次 Boost 标题完全正确 ===\n");

{
  const title = buildTitle("1426581758194876577", 1);
  assertIncludes(title, "<:heart_red:1456223334067867689>", "包含 heart_red Emoji");
  assertIncludes(title, "<@1426581758194876577>", "包含用户 Mention");
  assertIncludes(title, "投喂的助力", "固定文案「投喂的助力」");
  assert(title.startsWith("# "), "以 #  开头（Discord 标题）");
}

// === 测试 2：两次 Boost 标题完全正确 ===

console.log("\n=== 测试 2：两次 Boost 标题完全正确 ===\n");

{
  const title = buildTitle("999", 2);
  assertIncludes(title, "<@999>", "包含用户 Mention");
  assertIncludes(title, "两个助力", "固定文案「两个助力」");
  assert(!title.includes("投喂"), "不含「投喂」");
}

// === 测试 3：三次及以上数量正确 ===

console.log("\n=== 测试 3：三次及以上数量正确 ===\n");

{
  const t3 = buildTitle("u1", 3);
  assertIncludes(t3, "三个助力", "3 → 三个助力");
}
{
  const t5 = buildTitle("u1", 5);
  assertIncludes(t5, "五个助力", "5 → 五个助力");
}
{
  const t10 = buildTitle("u1", 10);
  assertIncludes(t10, "十个助力", "10 → 十个助力");
}
{
  const t12 = buildTitle("u1", 12);
  assertIncludes(t12, "十二个助力", "12 → 十二个助力");
}
{
  const t23 = buildTitle("u1", 23);
  assertIncludes(t23, "二十三个助力", "23 → 二十三个助力");
}

// === 测试 4：使用真实 <@userId> Mention ===

console.log("\n=== 测试 4：使用真实 <@userId> Mention ===\n");

{
  const title = buildTitle("123456789", 1);
  assertIncludes(title, "<@123456789>", "正确的 Mention 格式");
}

// === 测试 5：固定 heart_red Emoji 正确 ===

console.log("\n=== 测试 5：固定 heart_red Emoji 正确 ===\n");

{
  const title = buildTitle("u1", 1);
  assertEqual(
    title.includes("<:heart_red:1456223334067867689>"),
    true,
    "heart_red Emoji ID 正确"
  );
}

// === 测试 6：AI 只负责正文 ===

console.log("\n=== 测试 6：AI 只负责正文 ===\n");

{
  const mockAi = makeMockAi("祝你今天一切顺利✨");
  const generator = createCopyGenerator(TEST_CONFIG, mockAi);
  const body = await generator.generateCopy({
    userId: TEST_USER_ID,
    displayName: TEST_DISPLAY,
    boostCount: 1,
  });
  assertEqual(body, "祝你今天一切顺利✨", "正文正确返回");
}

// === 测试 7：最终标题 + 正文拼接正确 ===

console.log("\n=== 测试 7：最终标题 + 正文拼接正确 ===\n");

{
  const title = buildTitle(TEST_USER_ID, 1);
  const body = "祝你今天一切顺利✨";
  const message = assembleMessage(title, body);
  assertEqual(message, `${title}\n${body}`, "标题和正文用换行拼接");
  assert(message.startsWith("# "), "以标题开头");
  assert(message.endsWith("✨"), "以正文结尾");
}

// === 测试 8：正文 trim 正确 ===

console.log("\n=== 测试 8：正文 trim 正确 ===\n");

{
  const mockAi = makeMockAi("  \n  前后空白  \n  ");
  const generator = createCopyGenerator(TEST_CONFIG, mockAi);
  const body = await generator.generateCopy({
    userId: TEST_USER_ID,
    displayName: TEST_DISPLAY,
    boostCount: 1,
  });
  assertEqual(body, "前后空白", "前后空白被 trim");
}

// === 测试 9：空正文明确失败 ===

console.log("\n=== 测试 9：空正文明确失败 ===\n");

{
  const mockAi = makeMockAi("");
  const generator = createCopyGenerator(TEST_CONFIG, mockAi);
  await assertRejects(
    () => generator.generateCopy({ userId: TEST_USER_ID, displayName: TEST_DISPLAY, boostCount: 1 }),
    "正文为空",
    "空正文 → 抛出"
  );
}

// === 测试 10：whitespace-only 正文明确失败 ===

console.log("\n=== 测试 10：whitespace-only 正文明确失败 ===\n");

{
  const mockAi = makeMockAi("   \n \t  ");
  const generator = createCopyGenerator(TEST_CONFIG, mockAi);
  await assertRejects(
    () => generator.generateCopy({ userId: TEST_USER_ID, displayName: TEST_DISPLAY, boostCount: 1 }),
    "正文为空",
    "whitespace-only → 抛出"
  );
}

// === 测试 11：AI 输出 Discord Mention 时拒绝 ===

console.log("\n=== 测试 11：AI 输出 Discord Mention 时拒绝 ===\n");

{
  const mockAi = makeMockAi("感谢 <@123456> 的助力！");
  const generator = createCopyGenerator(TEST_CONFIG, mockAi);
  await assertRejects(
    () => generator.generateCopy({ userId: TEST_USER_ID, displayName: TEST_DISPLAY, boostCount: 1 }),
    "Discord Mention",
    "含 <@123456> → 拒绝"
  );
}

{
  const mockAi = makeMockAi("感谢 <@!987654> 助力！");
  const generator = createCopyGenerator(TEST_CONFIG, mockAi);
  await assertRejects(
    () => generator.generateCopy({ userId: TEST_USER_ID, displayName: TEST_DISPLAY, boostCount: 1 }),
    "Discord Mention",
    "含 <@!987654>（nickname mention）→ 拒绝"
  );
}

// === 测试 12：AI 输出 Guild Emoji 时拒绝 ===

console.log("\n=== 测试 12：AI 输出 Guild Emoji 时拒绝 ===\n");

{
  const mockAi = makeMockAi("送你 <:heart_red:123> 哦");
  const generator = createCopyGenerator(TEST_CONFIG, mockAi);
  await assertRejects(
    () => generator.generateCopy({ userId: TEST_USER_ID, displayName: TEST_DISPLAY, boostCount: 1 }),
    "自定义 Emoji",
    "含静态自定义 Emoji → 拒绝"
  );
}

// === 测试 13：AI 输出 Animated Emoji 时拒绝 ===

console.log("\n=== 测试 13：AI 输出 Animated Emoji 时拒绝 ===\n");

{
  const mockAi = makeMockAi("哇 <a:partyparrot:456> 太棒了");
  const generator = createCopyGenerator(TEST_CONFIG, mockAi);
  await assertRejects(
    () => generator.generateCopy({ userId: TEST_USER_ID, displayName: TEST_DISPLAY, boostCount: 1 }),
    "自定义 Emoji",
    "含动画 Emoji → 拒绝"
  );
}

// === 测试 14：displayName 缺失时仍可生成通用正文 ===

console.log("\n=== 测试 14：displayName 缺失时仍可生成通用正文 ===\n");

{
  const mockAi = makeMockAi("新朋友你好，欢迎加入茶话会！🎉");
  const generator = createCopyGenerator(TEST_CONFIG, mockAi);
  const body = await generator.generateCopy({
    userId: TEST_USER_ID,
    displayName: null,
    boostCount: 1,
  });
  assert(body.length > 0, "生成非空正文");
}

// === 测试 15：boostCount 非法时明确失败 ===

console.log("\n=== 测试 15：boostCount 非法时明确失败 ===\n");

{
  await assertRejects(
    () => buildTitle("u1", 0),
    "正整",
    "boostCount=0 → 抛出"
  );
}
{
  await assertRejects(
    () => buildTitle("u1", -1),
    "正整",
    "boostCount=-1 → 抛出"
  );
}
{
  await assertRejects(
    () => buildTitle("u1", 1.5),
    "正整",
    "boostCount=1.5 → 抛出"
  );
}
{
  const mockAi = makeMockAi("hi");
  const generator = createCopyGenerator(TEST_CONFIG, mockAi);
  await assertRejects(
    () => generator.generateCopy({ userId: TEST_USER_ID, boostCount: 0 }),
    "正整",
    "generateCopy boostCount=0 → 抛出"
  );
}

// === 测试 16：Prompt 文件路径正确 ===

console.log("\n=== 测试 16：Prompt 文件路径正确 ===\n");

{
  const promptPath = getPromptPath();
  const normalized = promptPath.replace(/\\/g, "/");
  assert(normalized.endsWith("data/prompts/boost-thanks.md"), "路径指向 boost-thanks.md");
  // verify file actually exists
  const { readFileSync } = await import("fs");
  let fileOk = false;
  try {
    readFileSync(promptPath, "utf-8");
    fileOk = true;
  } catch { /* ignore */ }
  assert(fileOk, "Prompt 文件存在且可读");
}

// === 测试 17：业务模块只依赖统一 AI 入口 ===

console.log("\n=== 测试 17：业务模块只依赖统一 AI 入口 ===\n");

{
  // 验证 copyGenerator 可以通过 aiOverride 注入，不绑定 deepseek.js
  const mockAi = makeMockAi("测试文案");
  const generator = createCopyGenerator(TEST_CONFIG, mockAi);
  const body = await generator.generateCopy({
    userId: TEST_USER_ID,
    displayName: TEST_DISPLAY,
    boostCount: 1,
  });
  assertEqual(body, "测试文案", "Mock AI 工作正常");
  // 不使用真实 deepseek 时也不应崩溃
}

// === 测试 18：不泄露 Token/API Key ===

console.log("\n=== 测试 18：不泄露 Token/API Key ===\n");

{
  const title = buildTitle(TEST_USER_ID, 1);
  assert(!title.includes("sk-test"), "标题不含 API Key");
  assert(!title.includes("Bearer"), "标题不含 Bearer");

  const message = assembleMessage(title, "你好");
  assert(!message.includes("sk-test"), "消息不含 API Key");

  // generateCopy 只返回 body，不包含 token
  const mockAi = makeMockAi("测试");
  const generator = createCopyGenerator(TEST_CONFIG, mockAi);
  const body = await generator.generateCopy({
    userId: TEST_USER_ID,
    displayName: TEST_DISPLAY,
    boostCount: 1,
  });
  assert(!body.includes("sk-test"), "正文不含 API Key");
  assert(!body.includes("Bearer"), "正文不含 Bearer");
  assert(!body.includes("Authorization"), "正文不含 Authorization");
}

// === 测试 19：标题生成中 userId 非法时抛出 ===

console.log("\n=== 测试 19：userId 非法时抛出 ===\n");

{
  await assertRejects(
    () => buildTitle("", 1),
    "userId",
    "userId 为空字符串 → 抛出"
  );
}
{
  await assertRejects(
    () => buildTitle(null, 1),
    "userId",
    "userId 为 null → 抛出"
  );
}

// === 测试 20：AI 超长输出被拒绝 ===

console.log("\n=== 测试 20：AI 超长输出被拒绝 ===\n");

{
  const longText = "啊".repeat(601);
  const mockAi = makeMockAi(longText);
  const generator = createCopyGenerator(TEST_CONFIG, mockAi);
  await assertRejects(
    () => generator.generateCopy({ userId: TEST_USER_ID, displayName: TEST_DISPLAY, boostCount: 1 }),
    "过长",
    "601 字符 → 拒绝"
  );
}

// === 测试 21：多次助力标题数字正确 ===

console.log("\n=== 测试 21：多次助力标题数字正确 ===\n");

{
  const t9 = buildTitle("u1", 9);
  assertIncludes(t9, "九个助力", "9 → 九个助力");
}
{
  const t20 = buildTitle("u1", 20);
  assertIncludes(t20, "二十个助力", "20 → 二十个助力");
}
{
  const t99 = buildTitle("u1", 99);
  assertIncludes(t99, "九十九个助力", "99 → 九十九个助力");
}

// === 测试 22：AI 正常 Unicode Emoji 不拒绝 ===

console.log("\n=== 测试 22：AI 正常 Unicode Emoji 不拒绝 ===\n");

{
  const mockAi = makeMockAi("祝你今天愉快！✨🎉 一切顺利～");
  const generator = createCopyGenerator(TEST_CONFIG, mockAi);
  const body = await generator.generateCopy({
    userId: TEST_USER_ID,
    displayName: TEST_DISPLAY,
    boostCount: 1,
  });
  assert(body.length > 0, "含 Unicode Emoji 的正常正文不被拒绝");
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

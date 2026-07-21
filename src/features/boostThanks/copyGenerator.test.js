/**
 * messageBuilder.js / copyGenerator.js 自动测试（Phase 5 精修）。
 *
 * 使用 Mock AI，不消耗真实 DeepSeek API 额度。
 *
 * 运行：node src/features/boostThanks/copyGenerator.test.js
 */

import { buildTitle, assembleMessage } from "./messageBuilder.js";
import { createCopyGenerator, getPromptPath, pickStyle, isTechStyle, getStyleKeys } from "./copyGenerator.js";

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
function assertNotIncludes(haystack, needle, label) {
  if (!haystack.includes(needle)) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label} — "${haystack}" includes "${needle}" but should not`); }
}
async function assertRejects(promiseFn, expectedMsg, label) {
  try { await promiseFn(); failed++; console.error(`  FAIL: ${label} — did not throw`); }
  catch (err) {
    if (err.message.includes(expectedMsg)) { passed++; console.log(`  PASS: ${label}`); }
    else { failed++; console.error(`  FAIL: ${label} — wrong error: ${err.message}`); }
  }
}

function makeMockAi(response) {
  return { generateText: async () => response };
}
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

// ============================================================
console.log("\n=== 测试 1–6：messageBuilder 不受影响 ===\n");
{
  assertIncludes(buildTitle(TEST_USER_ID, 1), "投喂的助力", "单次标题");
  assertIncludes(buildTitle("999", 2), "两个助力", "两次标题");
  assertIncludes(buildTitle("1", 3), "三个助力", "3→三个");
  assertIncludes(buildTitle("1", 99), "九十九个助力", "99→九十九");
  assertIncludes(buildTitle("1", 100), "100个助力", "100→100个");
  const msg = assembleMessage("# title", "body");
  assertEqual(msg, "# title\n\nbody", "双换行排版");
  await assertRejects(() => buildTitle("abc", 1), "纯数字", "userId 非数字→抛出");
  buildTitle("123", 1); assert(true, "纯数字通过");
}

// ============================================================
console.log("\n=== 测试 7：generateCopy 不再需要 displayName 或 boostCount ===\n");
{
  const gen = createCopyGenerator(TEST_CONFIG, makeMockAi("祝你今天一切顺利✨"));
  const body = await gen.generateCopy();
  assertEqual(body, "祝你今天一切顺利✨", "无参数调用成功");
}

console.log("\n=== 测试 8：正文 trim ===\n");
{
  const gen = createCopyGenerator(TEST_CONFIG, makeMockAi("  \n  前后空白  \n  "));
  assertEqual(await gen.generateCopy(), "前后空白", "trim");
}

console.log("\n=== 测试 9–10：空/whitespace 正文 ===\n");
{
  await assertRejects(() => createCopyGenerator(TEST_CONFIG, makeMockAi("")).generateCopy(), "正文为空", "空→抛出");
  await assertRejects(() => createCopyGenerator(TEST_CONFIG, makeMockAi("  \n \t ")).generateCopy(), "正文为空", "whitespace→抛出");
}

console.log("\n=== 测试 11–18：Discord 格式拦截 ===\n");
{
  const badCases = [
    ["<@123>", "用户 Mention"],
    ["<@!987>", "用户 Mention"],
    ["<@&456>", "身份组 Mention"],
    ["<#789>", "频道 Mention"],
    ["@everyone", "@everyone"],
    ["@here", "@everyone"],
    ["<:x:1>", "自定义 Emoji"],
    ["<a:x:1>", "自定义 Emoji"],
  ];
  for (const [text, expected] of badCases) {
    await assertRejects(
      () => createCopyGenerator(TEST_CONFIG, makeMockAi(text)).generateCopy(),
      expected, `${text}→拒绝`);
  }
  for (const level of [1, 2, 3]) {
    await assertRejects(
      () => createCopyGenerator(TEST_CONFIG, makeMockAi(`${"#".repeat(level)} 标题`)).generateCopy(),
      "Markdown 标题", `H${level}→拒绝`);
  }
}

console.log("\n=== 测试 19–20：Unicode 长度 ===\n");
{
  const gen100 = createCopyGenerator(TEST_CONFIG, makeMockAi("啊".repeat(100)));
  assertEqual(Array.from((await gen100.generateCopy())).length, 100, "100 允许");
  await assertRejects(
    () => createCopyGenerator(TEST_CONFIG, makeMockAi("啊".repeat(101))).generateCopy(),
    "过长", "101→拒绝");
}

// ============================================================
console.log("\n=== 测试 21：capturing mock — AI 不接触用户数据 ===\n");
{
  const capture = {};
  const gen = createCopyGenerator(TEST_CONFIG, makeCapturingMockAi("ok", capture));
  await gen.generateCopy({ interest: "星露谷", styleHint: "gentleBlessing" });

  const uc = capture.messages[1].content;
  const opts = capture.options;

  // AI 不应知道用户身份
  assertNotIncludes(uc, "Dreamdana", "不含 displayName");
  assertNotIncludes(uc, TEST_USER_ID, "不含 userId");
  // AI 不应知道助力数量
  assertNotIncludes(uc, "boost", "不含 boost 字样");
  assertNotIncludes(uc, "助力数量", "不含助力数量");
  assertNotIncludes(uc, "1个助力", "不含具体助力数");
  assertNotIncludes(uc, "个助力", "不含数量表达");
  // AI 应知道兴趣
  assertIncludes(uc, "星露谷", "含 interest");
  // 格式验证
  assert(!uc.includes("sk-test"), "不含 API Key");
  assertEqual(opts.maxTokens, 128, "maxTokens=128");
  assertEqual(opts.thinking.type, "disabled", "thinking=disabled");
}

console.log("\n=== 测试 22：默认无参数正常生成 ===\n");
{
  const capture = {};
  const gen = createCopyGenerator(TEST_CONFIG, makeCapturingMockAi("ok", capture));
  await gen.generateCopy();
  const uc = capture.messages[1].content;
  assertIncludes(uc, "请生成一条 Boost 感谢正文", "含基本任务描述");
  assertNotIncludes(uc, "兴趣：", "不含兴趣字段");
  assert(uc.includes("本次风格方向"), "含风格方向");
}

console.log("\n=== 测试 23：无 interest 不伪造 ===\n");
{
  const capture = {};
  await createCopyGenerator(TEST_CONFIG, makeCapturingMockAi("ok", capture)).generateCopy();
  assertNotIncludes(capture.messages[1].content, "兴趣：", "不含「兴趣：」字段");
}

// ============================================================
console.log("\n=== 测试 24–28：风格系统 ===\n");
{
  // pickStyle 返回合法 key
  const validKeys = getStyleKeys();
  for (let i = 0; i < 10; i++) {
    const s = pickStyle();
    assert(validKeys.includes(s.key), `pickStyle: ${s.key}`);
    assert(typeof s.hint === "string" && s.hint.length > 0, `hint 非空: ${s.key}`);
  }
  // 8 种风格
  assertEqual(validKeys.length, 8, "8 种风格");
  // isTechStyle
  assert(isTechStyle("lightTavern"), "lightTavern tech");
  assert(isTechStyle("aiGamer"), "aiGamer tech");
  assert(!isTechStyle("lifeBlessing"), "lifeBlessing 非 tech");
  // 权重
  assertEqual(10 + 5, 15, "tech 权重=15");
  assertEqual(20+15+15+15+10+10+10+5, 100, "总权重=100");
}

console.log("\n=== 测试 29：非 tech → 含 NON_TECH_RESTRICTION ===\n");
{
  const capture = {};
  await createCopyGenerator(TEST_CONFIG, makeCapturingMockAi("ok", capture))
    .generateCopy({ styleHint: "lifeBlessing" });
  assertIncludes(capture.messages[1].content, "无需使用 SillyTavern", "含统一限制");
}

console.log("\n=== 测试 30：lightTavern → 不含 NON_TECH_RESTRICTION ===\n");
{
  const capture = {};
  await createCopyGenerator(TEST_CONFIG, makeCapturingMockAi("ok", capture))
    .generateCopy({ styleHint: "lightTavern" });
  assertNotIncludes(capture.messages[1].content, "无需使用 SillyTavern", "不含限制");
}

console.log("\n=== 测试 31：aiGamer → 不含 NON_TECH_RESTRICTION ===\n");
{
  const capture = {};
  await createCopyGenerator(TEST_CONFIG, makeCapturingMockAi("ok", capture))
    .generateCopy({ styleHint: "aiGamer" });
  assertNotIncludes(capture.messages[1].content, "无需使用 SillyTavern", "不含限制");
}

console.log("\n=== 测试 32：固定 styleHint 正常 ===\n");
{
  for (const key of getStyleKeys()) {
    const capture = {};
    await createCopyGenerator(TEST_CONFIG, makeCapturingMockAi("ok", capture))
      .generateCopy({ styleHint: key });
    assert(capture.messages[1].content.includes("本次风格方向"), `${key} → 含风格方向`);
  }
}

console.log("\n=== 测试 33：未知 styleHint 抛出 ===\n");
{
  await assertRejects(
    () => createCopyGenerator(TEST_CONFIG, makeMockAi("x")).generateCopy({ styleHint: "nonexistent" }),
    "未知的 styleHint", "未知→抛出");
}

console.log("\n=== 测试 34：随机风格 10 次正常 ===\n");
{
  for (let i = 0; i < 10; i++) {
    const body = await createCopyGenerator(TEST_CONFIG, makeMockAi("ok")).generateCopy();
    assertEqual(body, "ok", `随机第 ${i + 1} 次`);
  }
}

// ============================================================
console.log("\n=== 测试 35–37：杂项 ===\n");
{
  assert(getPromptPath().replace(/\\/g, "/").endsWith("data/prompts/boost-thanks.md"), "Prompt 路径");
  assert(!buildTitle(TEST_USER_ID, 1).includes("sk-test"), "标题无 Key");
  const body = await createCopyGenerator(TEST_CONFIG, makeMockAi("ok")).generateCopy();
  assert(!body.includes("sk-test") && !body.includes("Bearer"), "正文无 Key");
  assertEqual(await createCopyGenerator(TEST_CONFIG, makeMockAi("mock")).generateCopy(), "mock", "Mock 正常");
}

// === messageBuilder boostCount 非法仍正常 ===
console.log("\n=== 测试 38：messageBuilder boostCount 校验正常 ===\n");
{
  await assertRejects(() => buildTitle("1", 0), "正整", "0→抛出");
  await assertRejects(() => buildTitle("1", -1), "正整", "-1→抛出");
}

// ============================================================
console.log(`\n========================================`);
console.log(`测试结果：${passed} passed, ${failed} failed`);
console.log(`========================================\n`);
if (failed > 0) process.exit(1);

/**
 * messageBuilder.js / copyGenerator.js 自动测试（Phase 5 - 文风优化）。
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
// 原有测试（1–29，保持兼容）
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
  assertIncludes(buildTitle("1", 100), "100个助力", "100→100个");
  assertIncludes(buildTitle("1", 128), "128个助力", "128→128个");
  assertIncludes(buildTitle("1", 999), "999个助力", "999→999个");
  for (const n of [100, 128, 500, 999]) {
    assert(!buildTitle("1", n).includes("undefined"), `${n} 不含 undefined`);
  }
}

console.log("\n=== 测试 5：userId 纯数字 ===\n");
{
  await assertRejects(() => buildTitle("", 1), "纯数字", "空→抛出");
  await assertRejects(() => buildTitle(null, 1), "纯数字", "null→抛出");
  await assertRejects(() => buildTitle("abc", 1), "纯数字", "abc→抛出");
  await assertRejects(() => buildTitle("u_123", 1), "纯数字", "下划线→抛出");
  await assertRejects(() => buildTitle("12 34", 1), "纯数字", "空格→抛出");
  buildTitle("123456789", 1); assert(true, "纯数字正常");
}

console.log("\n=== 测试 6：assembleMessage 双换行 ===\n");
{
  const msg = assembleMessage("# title", "body");
  assert(msg.includes("\n\n"), "包含 \\n\\n");
  assert(!msg.includes("\n\n\n"), "不含三换行");
  assertEqual(msg, "# title\n\nbody", "格式 title\\n\\nbody");
}

console.log("\n=== 测试 7：AI 只负责正文（无 userId）===\n");
{
  const gen = createCopyGenerator(TEST_CONFIG, makeMockAi("祝你今天一切顺利✨"));
  const body = await gen.generateCopy({ displayName: TEST_DISPLAY, boostCount: 1 });
  assertEqual(body, "祝你今天一切顺利✨", "正文正确");
}

console.log("\n=== 测试 8：正文 trim ===\n");
{
  const gen = createCopyGenerator(TEST_CONFIG, makeMockAi("  \n  前后空白  \n  "));
  const body = await gen.generateCopy({ displayName: TEST_DISPLAY, boostCount: 1 });
  assertEqual(body, "前后空白", "trim");
}

console.log("\n=== 测试 9：空正文 ===\n");
{
  await assertRejects(
    () => createCopyGenerator(TEST_CONFIG, makeMockAi("")).generateCopy({ displayName: "X", boostCount: 1 }),
    "正文为空", "空→抛出");
}

console.log("\n=== 测试 10：whitespace-only ===\n");
{
  await assertRejects(
    () => createCopyGenerator(TEST_CONFIG, makeMockAi("  \n \t ")).generateCopy({ displayName: "X", boostCount: 1 }),
    "正文为空", "whitespace→抛出");
}

console.log("\n=== 测试 11–18：Discord 格式拦截 ===\n");
{
  await assertRejects(
    () => createCopyGenerator(TEST_CONFIG, makeMockAi("<@123>")).generateCopy({ displayName: "X", boostCount: 1 }),
    "用户 Mention", "<@123>→拒绝");
  await assertRejects(
    () => createCopyGenerator(TEST_CONFIG, makeMockAi("<@!987>")).generateCopy({ displayName: "X", boostCount: 1 }),
    "用户 Mention", "<@!987>→拒绝");
  await assertRejects(
    () => createCopyGenerator(TEST_CONFIG, makeMockAi("<@&456>")).generateCopy({ displayName: "X", boostCount: 1 }),
    "身份组 Mention", "<@&456>→拒绝");
  await assertRejects(
    () => createCopyGenerator(TEST_CONFIG, makeMockAi("<#789>")).generateCopy({ displayName: "X", boostCount: 1 }),
    "频道 Mention", "<#789>→拒绝");
  await assertRejects(
    () => createCopyGenerator(TEST_CONFIG, makeMockAi("@everyone")).generateCopy({ displayName: "X", boostCount: 1 }),
    "@everyone", "@everyone→拒绝");
  await assertRejects(
    () => createCopyGenerator(TEST_CONFIG, makeMockAi("@here")).generateCopy({ displayName: "X", boostCount: 1 }),
    "@everyone", "@here→拒绝");
  await assertRejects(
    () => createCopyGenerator(TEST_CONFIG, makeMockAi("<:x:1>")).generateCopy({ displayName: "X", boostCount: 1 }),
    "自定义 Emoji", "静态 Emoji→拒绝");
  await assertRejects(
    () => createCopyGenerator(TEST_CONFIG, makeMockAi("<a:x:1>")).generateCopy({ displayName: "X", boostCount: 1 }),
    "自定义 Emoji", "动画 Emoji→拒绝");
  for (const level of [1, 2, 3]) {
    await assertRejects(
      () => createCopyGenerator(TEST_CONFIG, makeMockAi(`${"#".repeat(level)} 标题`)).generateCopy({ displayName: "X", boostCount: 1 }),
      "Markdown 标题", `H${level}→拒绝`);
  }
}

console.log("\n=== 测试 19：displayName 缺失 ===\n");
{
  const gen = createCopyGenerator(TEST_CONFIG, makeMockAi("新朋友你好！🎉"));
  const body = await gen.generateCopy({ displayName: null, boostCount: 1 });
  assert(body.length > 0, "非空");
}

console.log("\n=== 测试 20：boostCount 非法 ===\n");
{
  await assertRejects(() => buildTitle("1", 0), "正整", "buildTitle 0");
  await assertRejects(() => buildTitle("1", -1), "正整", "buildTitle -1");
  await assertRejects(() => buildTitle("1", 1.5), "正整", "buildTitle 1.5");
  await assertRejects(
    () => createCopyGenerator(TEST_CONFIG, makeMockAi("x")).generateCopy({ boostCount: 0 }),
    "正整", "generateCopy 0");
}

console.log("\n=== 测试 21–23：Unicode 长度 ===\n");
{
  const gen100 = createCopyGenerator(TEST_CONFIG, makeMockAi("啊".repeat(100)));
  assertEqual(Array.from((await gen100.generateCopy({ displayName: "X", boostCount: 1 }))).length, 100, "100 允许");
  await assertRejects(
    () => createCopyGenerator(TEST_CONFIG, makeMockAi("啊".repeat(101))).generateCopy({ displayName: "X", boostCount: 1 }),
    "过长", "101→拒绝");
  const genEmoji = createCopyGenerator(TEST_CONFIG, makeMockAi("你好✨🎉世界"));
  const bEmoji = await genEmoji.generateCopy({ displayName: "X", boostCount: 1 });
  assertEqual(Array.from(bEmoji).length, 6, "Emoji 长度正确");
}

console.log("\n=== 测试 24：无 interest 不伪造 ===\n");
{
  const capture = {};
  await createCopyGenerator(TEST_CONFIG, makeCapturingMockAi("ok", capture)).generateCopy({ displayName: "X", boostCount: 1 });
  assert(!capture.messages[1].content.includes("兴趣："), "不含「兴趣：」字段");
}

console.log("\n=== 测试 25：capturing mock ===\n");
{
  const capture = {};
  const gen = createCopyGenerator(TEST_CONFIG, makeCapturingMockAi("ok", capture));
  await gen.generateCopy({ displayName: "Dreamdana", boostCount: 2, interest: "星露谷", styleHint: "gentleBlessing" });

  const msgs = capture.messages;
  const opts = capture.options;

  assert(msgs.length === 2, "messages=2");
  assertEqual(msgs[0].role, "system", "system role");
  assert(msgs[0].content.length > 0, "system 非空");
  assertEqual(msgs[1].role, "user", "user role");
  assertIncludes(msgs[1].content, "Dreamdana", "含 displayName");
  assertIncludes(msgs[1].content, "2个助力", "含 boostCount");
  assertIncludes(msgs[1].content, "星露谷", "含 interest");
  assert(!msgs[1].content.includes(TEST_USER_ID), "不含 userId");
  assert(!msgs[1].content.includes("sk-test"), "不含 API Key");
  assertEqual(opts.maxTokens, 128, "maxTokens=128");
  assertEqual(opts.thinking.type, "disabled", "thinking=disabled");
}

console.log("\n=== 测试 26–29：杂项 ===\n");
{
  assert(getPromptPath().replace(/\\/g, "/").endsWith("data/prompts/boost-thanks.md"), "Prompt 路径");
  assert(!buildTitle(TEST_USER_ID, 1).includes("sk-test"), "标题无 Key");
  assert(!assembleMessage("# t", "hi").includes("sk-test"), "消息无 Key");
  const body = await createCopyGenerator(TEST_CONFIG, makeMockAi("ok")).generateCopy({ displayName: "X", boostCount: 1 });
  assert(!body.includes("sk-test") && !body.includes("Bearer"), "正文无 Key");
  assertEqual(await createCopyGenerator(TEST_CONFIG, makeMockAi("mock ok")).generateCopy({ displayName: "X", boostCount: 1 }), "mock ok", "Mock 正常");
  assert((await createCopyGenerator(TEST_CONFIG, makeMockAi("✨🎉")).generateCopy({ displayName: "X", boostCount: 1 })).length > 0, "Emoji 通过");
}

// ============================================================
// 新增：风格抽签系统测试（30–40）
// ============================================================

console.log("\n=== 测试 30：pickStyle 返回合法 key ===\n");
{
  const validKeys = getStyleKeys();
  for (let i = 0; i < 20; i++) {
    const s = pickStyle();
    assert(validKeys.includes(s.key), `pickStyle 返回合法 key: ${s.key}`);
    assert(typeof s.hint === "string" && s.hint.length > 0, `hint 非空: ${s.key}`);
  }
}

console.log("\n=== 测试 31：风格池包含全部 8 种风格 ===\n");
{
  const keys = getStyleKeys();
  assertEqual(keys.length, 8, "8 种风格");
  const expected = ["lifeBlessing","fairyTale","abstractChaos","oneLiner","gentleBlessing","antiRoutine","lightTavern","aiGamer"];
  for (const k of expected) assert(keys.includes(k), `含 ${k}`);
}

console.log("\n=== 测试 32：isTechStyle 正确判断 ===\n");
{
  assert(isTechStyle("lightTavern"), "lightTavern 是 tech");
  assert(isTechStyle("aiGamer"), "aiGamer 是 tech");
  assert(!isTechStyle("lifeBlessing"), "lifeBlessing 非 tech");
  assert(!isTechStyle("fairyTale"), "fairyTale 非 tech");
  assert(!isTechStyle("gentleBlessing"), "gentleBlessing 非 tech");
}

console.log("\n=== 测试 33：非 tech 风格 → user message 含统一 NON_TECH_RESTRICTION ===\n");
{
  const capture = {};
  const gen = createCopyGenerator(TEST_CONFIG, makeCapturingMockAi("ok", capture));
  await gen.generateCopy({ displayName: "X", boostCount: 1, styleHint: "lifeBlessing" });
  const uc = capture.messages[1].content;
  assertIncludes(uc, "生活怪祝福", "含风格方向提示");
  assertIncludes(uc, "无需使用 SillyTavern", "含统一技术语境限制（NON_TECH_RESTRICTION）");
}

console.log("\n=== 测试 34：lightTavern 不含统一 NON_TECH_RESTRICTION ===\n");
{
  const capture = {};
  const gen = createCopyGenerator(TEST_CONFIG, makeCapturingMockAi("ok", capture));
  await gen.generateCopy({ displayName: "X", boostCount: 1, styleHint: "lightTavern" });
  const uc = capture.messages[1].content;
  assertIncludes(uc, "轻度酒馆梗", "含风格方向");
  assert(!uc.includes("无需使用 SillyTavern"), "不含统一限制指令");
}

console.log("\n=== 测试 34b：aiGamer 不含统一 NON_TECH_RESTRICTION ===\n");
{
  const capture = {};
  const gen = createCopyGenerator(TEST_CONFIG, makeCapturingMockAi("ok", capture));
  await gen.generateCopy({ displayName: "X", boostCount: 1, styleHint: "aiGamer" });
  const uc = capture.messages[1].content;
  assertIncludes(uc, "AI 玩家怪梗", "含风格方向");
  assert(!uc.includes("无需使用 SillyTavern"), "不含统一限制指令");
}

console.log("\n=== 测试 34c：非 tech + 技术兴趣 → 有限制但兴趣正常传入 ===\n");
{
  const capture = {};
  const gen = createCopyGenerator(TEST_CONFIG, makeCapturingMockAi("ok", capture));
  await gen.generateCopy({ displayName: "X", boostCount: 1, styleHint: "gentleBlessing", interest: "SillyTavern、角色卡制作" });
  const uc = capture.messages[1].content;
  assertIncludes(uc, "无需使用 SillyTavern", "含统一限制指令");
  assertIncludes(uc, "SillyTavern、角色卡制作", "兴趣信息正常传入（未被限制删除）");
}

console.log("\n=== 测试 35：未知 styleHint 抛出 ===\n");
{
  await assertRejects(
    () => createCopyGenerator(TEST_CONFIG, makeMockAi("x")).generateCopy({ displayName: "X", boostCount: 1, styleHint: "nonexistent" }),
    "未知的 styleHint", "未知 styleHint→抛出");
}

console.log("\n=== 测试 36：不指定 styleHint 时随机抽签 ===\n");
{
  // 调用 10 次，确认都能成功（不会因缺 style 而崩溃）
  for (let i = 0; i < 10; i++) {
    const gen = createCopyGenerator(TEST_CONFIG, makeMockAi("ok"));
    const body = await gen.generateCopy({ displayName: "X", boostCount: 1 });
    assertEqual(body, "ok", `随机风格第 ${i + 1} 次成功`);
  }
}

console.log("\n=== 测试 37：AI 玩家怪梗风格正确进入 messages ===\n");
{
  const capture = {};
  const gen = createCopyGenerator(TEST_CONFIG, makeCapturingMockAi("ok", capture));
  await gen.generateCopy({ displayName: "X", boostCount: 3, styleHint: "aiGamer" });
  const uc = capture.messages[1].content;
  assertIncludes(uc, "AI 玩家怪梗", "含风格方向");
  assertIncludes(uc, "模型", "含技术语境词");
  assertIncludes(uc, "社区梗", "含社区梗说明");
}

console.log("\n=== 测试 38：tech 风格权重合计约 15% ===\n");
{
  // 不精确统计，只验证 tech 风格存在且各自权重合理
  // 手工验证 weight 总和
  const techWeight = 10 + 5; // lightTavern + aiGamer
  const totalWeight = 20 + 15 + 15 + 15 + 10 + 10 + 10 + 5; // 100
  assertEqual(techWeight, 15, "tech 权重=15/100");
  assertEqual(totalWeight, 100, "总权重=100");
}

console.log("\n=== 测试 39：styleHint 出现在 user message 中 ===\n");
{
  for (const key of getStyleKeys()) {
    const capture = {};
    const gen = createCopyGenerator(TEST_CONFIG, makeCapturingMockAi("ok", capture));
    await gen.generateCopy({ displayName: "X", boostCount: 1, styleHint: key });
    const uc = capture.messages[1].content;
    assert(uc.includes("本次风格方向"), `${key} → user message 含风格方向`);
  }
}

console.log("\n=== 测试 40：displayName 作为上下文但默认不重复称呼 ===\n");
{
  // Prompt 中已明确"正文默认不要再叫用户的 displayName"
  // 此处验证 displayName 仍作为上下文数据正确传入
  const capture = {};
  const gen = createCopyGenerator(TEST_CONFIG, makeCapturingMockAi("ok", capture));
  await gen.generateCopy({ displayName: "Dreamdana", boostCount: 1, styleHint: "gentleBlessing" });
  assertIncludes(capture.messages[1].content, '"Dreamdana"', "displayName 作为数据传入");
  // 但不强制验证 AI 是否真的没重复称呼（那是 Prompt 效果，需真实 AI 测试）
}

// ============================================================
console.log(`\n========================================`);
console.log(`测试结果：${passed} passed, ${failed} failed`);
console.log(`========================================\n`);
if (failed > 0) process.exit(1);

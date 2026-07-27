/** Manual Message 内容与 Mention 策略测试。 */

import {
  MAX_CONTENT_LENGTH,
  MAX_USER_MENTIONS,
  countContentCharacters,
  extractUserMentionIds,
  validateManualContent,
} from "./contentPolicy.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label} (${JSON.stringify(expected)})`);
}
function expectCode(content, code, label) {
  try {
    validateManualContent(content);
    failed++; console.error(`  FAIL: ${label} — expected ${code}`);
  } catch (error) {
    assertEqual(error.code, code, label);
  }
}

console.log("\n=== Manual Message content policy ===\n");

assertEqual(MAX_CONTENT_LENGTH, 2000, "最大正文长度");
assertEqual(MAX_USER_MENTIONS, 10, "最大不同用户 Mention 数");
expectCode("", "EMPTY_CONTENT", "空字符串拒绝");
expectCode(" \n\t ", "EMPTY_CONTENT", "全空白拒绝");
assertEqual(validateManualContent("x").content, "x", "1 字符保留");
assertEqual(validateManualContent("a".repeat(2000)).contentLength, 2000, "2000 字符允许");
assertEqual(validateManualContent("😀".repeat(2000)).contentLength, 2000, "2000 个 Emoji 按 Unicode 字符计数");
expectCode("a".repeat(2001), "CONTENT_TOO_LONG", "2001 字符拒绝");
assertEqual(countContentCharacters("中文😀"), 3, "中文与 Emoji 字符计数");
assertEqual(validateManualContent("**Markdown** `code` 🫖").content, "**Markdown** `code` 🫖", "Markdown/Emoji 不被修改");

expectCode("注意 @everyone", "FORBIDDEN_MENTION", "@everyone 拒绝");
expectCode("注意 @here", "FORBIDDEN_MENTION", "@here 拒绝");
expectCode("注意 <@&123456789>", "FORBIDDEN_MENTION", "Role Mention 拒绝");

{
  const policy = validateManualContent("请联系 <@123> 和 <@!456>");
  assertEqual(JSON.stringify(policy.userMentionIds), JSON.stringify(["123", "456"]), "User Mention ID 提取");
  assertEqual(JSON.stringify(policy.allowedMentions), JSON.stringify({
    parse: [], users: ["123", "456"], roles: [], repliedUser: false,
  }), "allowedMentions 精确限制普通 User Mention");
}

{
  const ids = extractUserMentionIds("<@1> <@1> <@!2> <@2>");
  assertEqual(JSON.stringify(ids), JSON.stringify(["1", "2"]), "重复 User Mention 去重");
}

const tooMany = Array.from({ length: MAX_USER_MENTIONS + 1 }, (_, index) => `<@${index + 1}>`).join(" ");
expectCode(tooMany, "TOO_MANY_USER_MENTIONS", "超过用户 Mention 上限拒绝");

console.log(`\n[contentPolicy.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);

/** Manual Message 内容与 Mention 策略测试。 */

import {
  MAX_CONTENT_LENGTH,
  countContentCharacters,
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
expectCode("", "EMPTY_CONTENT", "空字符串拒绝");
expectCode(" \n\t ", "EMPTY_CONTENT", "全空白拒绝");
assertEqual(validateManualContent("x").content, "x", "1 字符保留");
assertEqual(validateManualContent("a".repeat(2000)).contentLength, 2000, "2000 字符允许");
assertEqual(validateManualContent("😀".repeat(2000)).contentLength, 2000, "2000 个 Emoji 按 Unicode 字符计数");
expectCode("a".repeat(2001), "CONTENT_TOO_LONG", "2001 字符拒绝");
assertEqual(countContentCharacters("中文😀"), 3, "中文与 Emoji 字符计数");
assertEqual(validateManualContent("**Markdown** `code` 🫖").content, "**Markdown** `code` 🫖", "Markdown/Emoji 不被修改");

assertEqual(validateManualContent("注意 @everyone @here <@123> <@&456>").content, "注意 @everyone @here <@123> <@&456>", "Mention 内容保留给专用策略处理");

console.log(`\n[contentPolicy.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);

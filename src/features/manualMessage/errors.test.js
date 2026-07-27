/** Manual Message Error 模型测试。 */

import {
  MANUAL_MESSAGE_SOURCES,
  ManualMessageError,
  createManualMessageError,
  getSafeMessage,
} from "./errors.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label} (${JSON.stringify(expected)})`);
}

console.log("\n=== Manual Message errors ===\n");

{
  const cause = new Error("internal detail");
  const error = createManualMessageError("WRONG_GUILD", cause);
  assert(error instanceof ManualMessageError, "创建 ManualMessageError");
  assertEqual(error.code, "WRONG_GUILD", "code");
  assertEqual(error.safeMessage, "只能在目标服务器发言。", "safeMessage");
  assert(error.cause === cause, "保留 cause 供内部诊断");
  assert(!error.safeMessage.includes("internal detail"), "safeMessage 不包含内部原因");
}

{
  const error = createManualMessageError("INVALID_ACTOR");
  assertEqual(error.safeMessage, "无法确认人工发言操作者身份。", "INVALID_ACTOR 安全文案");
}

{
  assertEqual(getSafeMessage("CHANNEL_FETCH_FAILED"), "获取目标频道失败。", "CHANNEL_FETCH_FAILED 安全文案");
  assertEqual(getSafeMessage("TARGET_MESSAGE_FETCH_FAILED"), "获取目标消息失败。", "TARGET_MESSAGE_FETCH_FAILED 安全文案");
}

assertEqual(MANUAL_MESSAGE_SOURCES.length, 3, "来源数量");
assert(MANUAL_MESSAGE_SOURCES.includes("discord_slash"), "允许 discord_slash");
assert(MANUAL_MESSAGE_SOURCES.includes("discord_context_menu"), "允许 discord_context_menu");
assert(MANUAL_MESSAGE_SOURCES.includes("hermes"), "预留 hermes");
assert(getSafeMessage("NOT_A_REAL_CODE") === "人工发言失败。", "未知 code 使用通用安全文案");

console.log(`\n[errors.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);

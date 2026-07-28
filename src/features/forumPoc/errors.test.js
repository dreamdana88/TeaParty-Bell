import {
  ForumPocError,
  createForumPocError,
  getSafeMessage,
  isForumPocError,
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

console.log("\n=== ForumPoc errors ===\n");

{
  const err = createForumPocError("NOT_DEVELOPMENT");
  assert(isForumPocError(err), "isForumPocError 识别 ForumPocError");
  assertEqual(err.code, "NOT_DEVELOPMENT", "code");
  assertEqual(err.safeMessage, getSafeMessage("NOT_DEVELOPMENT"), "safeMessage 一致");
  assert(!err.safeMessage.includes("token"), "safeMessage 无 token");
}

{
  const cause = new Error("secret stack internals");
  const err = new ForumPocError("SEND_FAILED", undefined, cause);
  assertEqual(err.cause, cause, "cause 保留");
  assertEqual(err.message, err.safeMessage, "message 使用 safeMessage");
}

for (const code of [
  "NOT_DEVELOPMENT",
  "TEST_MODE_REQUIRED",
  "GUILD_CONFIRMATION_REQUIRED",
  "GUILD_CONFIRMATION_MISMATCH",
  "WRONG_GUILD",
  "THREAD_NOT_FOUND",
  "WRONG_THREAD_TYPE",
  "NOT_FORUM_THREAD",
  "THREAD_LOCKED",
  "BOT_MISSING_PERMISSION",
  "SEND_FAILED",
  "DELETE_FAILED",
  "INSPECT_FAILED",
  "SNAPSHOT_FAILED",
  "INVALID_ARGUMENT",
]) {
  const msg = getSafeMessage(code);
  assert(typeof msg === "string" && msg.length > 0, `safeMessage 存在: ${code}`);
}

assert(!isForumPocError(new Error("x")), "普通 Error 不是 ForumPocError");

console.log(`\nForumPoc errors: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

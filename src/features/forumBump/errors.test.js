import {
  ForumBumpError,
  createForumBumpError,
  getSafeMessage,
  isForumBumpError,
} from "./errors.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label}`);
}

console.log("\n=== ForumBump errors ===\n");

{
  const err = createForumBumpError("NOT_DEVELOPMENT", undefined, { forumId: "1" });
  assert(isForumBumpError(err), "isForumBumpError");
  assertEqual(err.code, "NOT_DEVELOPMENT", "code");
  assertEqual(err.context.forumId, "1", "context 安全字段");
  assert(!JSON.stringify(err.safeMessage).includes("token"), "safeMessage 无 token");
}

for (const code of [
  "NOT_DEVELOPMENT", "TEST_MODE_REQUIRED", "GUILD_CONFIRMATION_REQUIRED",
  "GUILD_CONFIRMATION_MISMATCH", "FORUM_REQUIRED", "INVALID_FORUM_ID",
  "INVALID_SILENCE_DAYS", "INVALID_DISPLAY_LIMIT", "INVALID_EXCLUDED_TAG_ID",
  "FORUM_NOT_FOUND", "WRONG_GUILD", "NOT_FORUM_CHANNEL", "BOT_MISSING_VIEW_CHANNEL",
  "ACTIVE_THREADS_FETCH_FAILED", "ARCHIVED_THREADS_FETCH_FAILED",
  "ARCHIVED_PAGINATION_STALLED", "ACTIVITY_TIME_INVALID", "SCAN_FAILED",
]) {
  assert(typeof getSafeMessage(code) === "string" && getSafeMessage(code).length > 0, `msg ${code}`);
}

assert(!isForumBumpError(new Error("x")), "普通 Error 否");
assert(new ForumBumpError("SCAN_FAILED") instanceof Error, "继承 Error");

console.log(`\nForumBump errors: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

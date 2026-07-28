import {
  createInitialState,
  createStateError,
  isForumBumpStateError,
  validateState,
} from "./stateSchema.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label}`);
}

console.log("\n=== ForumBump stateSchema ===\n");

const base = createInitialState("2026-07-28");
assertEqual(base.version, 1, "initial version");
assertEqual(base.revision, 0, "initial revision");
assertEqual(base.successCount, 0, "initial count");
assertEqual(base.paused, false, "initial paused");
assertEqual(base.inFlight, null, "initial inFlight");

assert(validateState(base).localDate === "2026-07-28", "validate ok");

function expectInvalid(data, code, label) {
  try {
    validateState(data);
    assert(false, label);
  } catch (error) {
    assert(isForumBumpStateError(error) && error.code === code, label);
  }
}

expectInvalid(null, "STATE_INVALID", "null");
expectInvalid([], "STATE_INVALID", "array root");
expectInvalid({ ...base, version: 2 }, "STATE_VERSION_UNSUPPORTED", "未知 version");
expectInvalid({ ...base, revision: -1 }, "STATE_INVALID", "负 revision");
expectInvalid({ ...base, localDate: "2026-13-01" }, "STATE_INVALID", "非法 localDate");
expectInvalid({ ...base, successCount: -3 }, "STATE_INVALID", "负 successCount");
expectInvalid({ ...base, lastSuccessAt: "not-iso" }, "STATE_INVALID", "非法 ISO");
expectInvalid({ ...base, lastSuccessAt: "2026-07-28" }, "STATE_INVALID", "纯日期拒绝");
expectInvalid({ ...base, lastSuccessAt: "2026-07-28T08:00:00+08:00" }, "STATE_INVALID", "非 Z 时区偏移拒绝");
expectInvalid({ ...base, lastSuccessAt: "2026-07-28T08:00:00Z" }, "STATE_INVALID", "无毫秒拒绝");
expectInvalid({ ...base, lastSuccessAt: "2026-02-30T08:00:00.000Z" }, "STATE_INVALID", "无效日期拒绝");

{
  const ok = {
    ...base,
    lastSuccessAt: "2026-07-28T08:00:00.000Z",
    nextEligibleAt: "2026-07-28T08:40:00.000Z",
  };
  assert(validateState(ok).lastSuccessAt === "2026-07-28T08:00:00.000Z", "标准 UTC ISO 接受");
}
expectInvalid({ ...base, paused: false, pauseReason: "X" }, "STATE_INVALID", "paused=false + reason");
expectInvalid({ ...base, paused: true, pauseReason: null }, "STATE_INVALID", "paused=true 无 reason");
expectInvalid({ ...base, paused: true, pauseReason: "" }, "STATE_INVALID", "空 pauseReason");
expectInvalid({ ...base, extra: 1 }, "STATE_INVALID", "未知顶层字段");
expectInvalid({
  ...base,
  inFlight: {
    operationId: "op1",
    guildId: "111111111111111111",
    forumChannelId: "222222222222222222",
    threadId: "333333333333333333",
    phase: "nope",
    sentMessageId: null,
    startedAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  },
}, "STATE_INVALID", "非法 phase");

expectInvalid({
  ...base,
  inFlight: {
    operationId: "op1",
    guildId: "111111111111111111",
    forumChannelId: "222222222222222222",
    threadId: "333333333333333333",
    phase: "before_send",
    sentMessageId: "444444444444444444",
    startedAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  },
}, "STATE_INVALID", "before_send 带 messageId");

expectInvalid({
  ...base,
  inFlight: {
    operationId: "op1",
    guildId: "111111111111111111",
    forumChannelId: "222222222222222222",
    threadId: "333333333333333333",
    phase: "after_send",
    sentMessageId: null,
    startedAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  },
}, "STATE_INVALID", "after_send 缺 messageId");

expectInvalid({
  ...base,
  inFlight: {
    operationId: "op1",
    guildId: "bad",
    forumChannelId: "222222222222222222",
    threadId: "333333333333333333",
    phase: "before_send",
    sentMessageId: null,
    startedAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
  },
}, "STATE_INVALID", "非法 Snowflake");

expectInvalid({
  ...base,
  inFlight: {
    operationId: "op1",
    guildId: "111111111111111111",
    forumChannelId: "222222222222222222",
    threadId: "333333333333333333",
    phase: "before_send",
    sentMessageId: null,
    startedAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    secret: true,
  },
}, "STATE_INVALID", "未知 inFlight 字段");

try {
  createInitialState("bad");
  assert(false, "createInitial 非法日期");
} catch (error) {
  assert(error.code === "STATE_ARGUMENT_INVALID", "createInitial 非法日期");
}

assert(createStateError("STATE_NOT_FOUND").safeMessage.length > 0, "safeMessage");

console.log(`\nForumBump stateSchema: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

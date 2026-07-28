import { createInitialState } from "./stateSchema.js";
import {
  beginInFlightTransition,
  classifyRecovery,
  completeSuccessTransition,
  markMessageDeletedTransition,
  markMessageSentTransition,
  pauseTransition,
  resumeTransition,
  rolloverLocalDateTransition,
} from "./stateTransitions.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label}`);
}

const G = "111111111111111111";
const F = "222222222222222222";
const T = "333333333333333333";
const M = "444444444444444444";
const TS = "2026-07-28T08:00:00.000Z";
const TS2 = "2026-07-28T08:05:00.000Z";
const TS3 = "2026-07-28T08:40:00.000Z";

console.log("\n=== ForumBump stateTransitions ===\n");

let state = createInitialState("2026-07-28");

{
  const r = beginInFlightTransition(state, {
    operationId: "op-1",
    guildId: G,
    forumChannelId: F,
    threadId: T,
    startedAt: TS,
  });
  assert(r.ok, "begin ok");
  assertEqual(r.state.inFlight.phase, "before_send", "phase before_send");
  state = r.state;
}

{
  const r = beginInFlightTransition(state, {
    operationId: "op-2",
    guildId: G,
    forumChannelId: F,
    threadId: T,
    startedAt: TS,
  });
  assertEqual(r.errorCode, "STATE_INFLIGHT_EXISTS", "已有 inFlight 拒绝 begin");
}

{
  const paused = pauseTransition(createInitialState("2026-07-28"), { reason: "X" }).state;
  const r = beginInFlightTransition(paused, {
    operationId: "op",
    guildId: G,
    forumChannelId: F,
    threadId: T,
    startedAt: TS,
  });
  assertEqual(r.errorCode, "STATE_PAUSED", "paused 拒绝 begin");
}

{
  const r = markMessageSentTransition(state, {
    operationId: "op-1",
    sentMessageId: M,
    sentAt: TS2,
  });
  assert(r.ok, "mark sent ok");
  assertEqual(r.state.inFlight.phase, "after_send", "after_send");
  assertEqual(r.state.inFlight.sentMessageId, M, "message id");
  state = r.state;
}

{
  const r = markMessageSentTransition(state, {
    operationId: "wrong",
    sentMessageId: M,
    sentAt: TS2,
  });
  assertEqual(r.errorCode, "STATE_INFLIGHT_MISMATCH", "错误 operationId");
}

{
  const r = markMessageDeletedTransition(state, {
    operationId: "op-1",
    deletedAt: TS2,
  });
  assert(r.ok, "mark deleted ok");
  assertEqual(r.state.inFlight.phase, "after_delete", "after_delete");
  state = r.state;
}

{
  const r = completeSuccessTransition(state, {
    operationId: "op-1",
    localDate: "2026-07-28",
    successAt: TS2,
    nextEligibleAt: TS3,
  });
  assert(r.ok, "complete success");
  assertEqual(r.state.successCount, 1, "count +1");
  assertEqual(r.state.inFlight, null, "inFlight cleared");
  assertEqual(r.state.lastSuccessAt, TS2, "lastSuccessAt");
  assertEqual(r.state.nextEligibleAt, TS3, "nextEligibleAt");
  state = r.state;
}

{
  // 跨日 complete：先造 after_delete
  let s = createInitialState("2026-07-28");
  s = beginInFlightTransition(s, {
    operationId: "op",
    guildId: G, forumChannelId: F, threadId: T, startedAt: TS,
  }).state;
  s = markMessageSentTransition(s, {
    operationId: "op", sentMessageId: M, sentAt: TS2,
  }).state;
  s = markMessageDeletedTransition(s, {
    operationId: "op", deletedAt: TS2,
  }).state;
  const r = completeSuccessTransition(s, {
    operationId: "op",
    localDate: "2026-07-29",
    successAt: TS2,
    nextEligibleAt: TS3,
  });
  assertEqual(r.state.localDate, "2026-07-29", "跨日日期");
  assertEqual(r.state.successCount, 1, "跨日先归零再 +1");
}

{
  let s = createInitialState("2026-07-28");
  s = beginInFlightTransition(s, {
    operationId: "op", guildId: G, forumChannelId: F, threadId: T, startedAt: TS,
  }).state;
  s = markMessageSentTransition(s, {
    operationId: "op", sentMessageId: M, sentAt: TS2,
  }).state;
  s = markMessageDeletedTransition(s, {
    operationId: "op", deletedAt: TS2,
  }).state;
  const r = completeSuccessTransition(s, {
    operationId: "op",
    localDate: "2026-07-28",
    successAt: TS3,
    nextEligibleAt: TS2, // 早于 successAt
  });
  assertEqual(r.errorCode, "STATE_ARGUMENT_INVALID", "nextEligibleAt 早于 successAt");
}

{
  // completeSuccess 日期回退不得重置额度
  let s = createInitialState("2026-07-28");
  s = beginInFlightTransition(s, {
    operationId: "op", guildId: G, forumChannelId: F, threadId: T, startedAt: TS,
  }).state;
  s = markMessageSentTransition(s, {
    operationId: "op", sentMessageId: M, sentAt: TS2,
  }).state;
  s = markMessageDeletedTransition(s, {
    operationId: "op", deletedAt: TS2,
  }).state;
  s.successCount = 5;
  const before = s.successCount;
  const r = completeSuccessTransition(s, {
    operationId: "op",
    localDate: "2026-07-27",
    successAt: TS2,
    nextEligibleAt: TS3,
  });
  assertEqual(r.errorCode, "STATE_DATE_ROLLBACK", "completeSuccess 日期回退");
  assertEqual(s.successCount, before, "回退不改原状态额度");
  assertEqual(r.state, null, "失败无 next state");
}

// rollover
{
  let s = createInitialState("2026-07-28");
  s.successCount = 5;
  s.nextEligibleAt = TS3;
  s = pauseTransition(s, { reason: "HOLD" }).state;
  s = beginInFlightTransition({ ...s, paused: false, pauseReason: null }, {
    operationId: "x", guildId: G, forumChannelId: F, threadId: T, startedAt: TS,
  }).state;
  // re-pause after inflight
  s = pauseTransition(s, { reason: "HOLD" }).state;
  const same = rolloverLocalDateTransition(s, { localDate: "2026-07-28" });
  assertEqual(same.changed, false, "同日 no-op");
  const future = rolloverLocalDateTransition(s, { localDate: "2026-07-29" });
  assert(future.ok, "未来日期 rollover");
  assertEqual(future.state.successCount, 0, "计数归零");
  assertEqual(future.state.nextEligibleAt, TS3, "保留冷却");
  assertEqual(future.state.paused, true, "保留 paused");
  assert(future.state.inFlight != null, "保留 inFlight");
  const back = rolloverLocalDateTransition(s, { localDate: "2026-07-27" });
  assertEqual(back.errorCode, "STATE_DATE_ROLLBACK", "日期回退拒绝");
}

// pause/resume
{
  let s = createInitialState("2026-07-28");
  s = beginInFlightTransition(s, {
    operationId: "op", guildId: G, forumChannelId: F, threadId: T, startedAt: TS,
  }).state;
  s = pauseTransition(s, { reason: "DELETE_FAILED" }).state;
  assertEqual(s.paused, true, "paused");
  assert(s.inFlight != null, "pause 保留 inFlight");
  const resumeFail = resumeTransition(s);
  assertEqual(resumeFail.errorCode, "STATE_RECOVERY_REQUIRED", "有 inFlight 拒绝 resume");
  s.inFlight = null;
  const resumeOk = resumeTransition(s);
  assert(resumeOk.ok, "无 inFlight resume");
  assertEqual(resumeOk.state.paused, false, "unpaused");
  assertEqual(resumeOk.state.pauseReason, null, "reason null");
}

// recovery classify
{
  const clean = classifyRecovery(createInitialState("2026-07-28"));
  assertEqual(clean.recoveryStatus, "clean", "clean");

  let s = createInitialState("2026-07-28");
  s = beginInFlightTransition(s, {
    operationId: "op", guildId: G, forumChannelId: F, threadId: T, startedAt: TS,
  }).state;
  assertEqual(classifyRecovery(s).recoveryStatus, "manual_review_required", "before_send");

  s = markMessageSentTransition(s, {
    operationId: "op", sentMessageId: M, sentAt: TS2,
  }).state;
  assertEqual(classifyRecovery(s).recoveryStatus, "cleanup_required", "after_send");
  assertEqual(classifyRecovery(s).cleanupRequired, true, "cleanup true");

  s = markMessageDeletedTransition(s, {
    operationId: "op", deletedAt: TS2,
  }).state;
  assertEqual(classifyRecovery(s).recoveryStatus, "reconciliation_required", "after_delete");
}

// 恒定体积：100 次 complete 后字段固定
{
  let s = createInitialState("2026-07-28");
  for (let i = 0; i < 100; i += 1) {
    s = beginInFlightTransition(s, {
      operationId: `op-${i}`,
      guildId: G, forumChannelId: F, threadId: T, startedAt: TS,
    }).state;
    s = markMessageSentTransition(s, {
      operationId: `op-${i}`, sentMessageId: M, sentAt: TS2,
    }).state;
    s = markMessageDeletedTransition(s, {
      operationId: `op-${i}`, deletedAt: TS2,
    }).state;
    s = completeSuccessTransition(s, {
      operationId: `op-${i}`,
      localDate: "2026-07-28",
      successAt: TS2,
      nextEligibleAt: TS3,
    }).state;
  }
  const keys = Object.keys(s).sort().join(",");
  assertEqual(
    keys,
    "inFlight,lastSuccessAt,localDate,nextEligibleAt,pauseReason,paused,revision,successCount,version",
    "无 history 字段",
  );
  assertEqual(s.successCount, 100, "100 次成功");
  assertEqual(s.inFlight, null, "无残留 inFlight");
}

console.log(`\nForumBump stateTransitions: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

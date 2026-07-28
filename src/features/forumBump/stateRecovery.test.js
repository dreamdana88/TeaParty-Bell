import { createInitialState } from "./stateSchema.js";
import { planStartupRecovery } from "./stateRecovery.js";
import {
  beginInFlightTransition,
  markMessageDeletedTransition,
  markMessageSentTransition,
  pauseTransition,
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

console.log("\n=== ForumBump stateRecovery ===\n");

{
  const plan = planStartupRecovery(createInitialState("2026-07-28"));
  assertEqual(plan.recoveryStatus, "clean", "clean");
  assertEqual(plan.changed, false, "clean 不改状态");
  assertEqual(plan.cleanupRequired, false, "clean no cleanup");
}

{
  let s = createInitialState("2026-07-28");
  s = beginInFlightTransition(s, {
    operationId: "op", guildId: G, forumChannelId: F, threadId: T, startedAt: TS,
  }).state;
  const plan = planStartupRecovery(s);
  assertEqual(plan.recoveryStatus, "manual_review_required", "before_send");
  assertEqual(plan.changed, true, "需要 pause");
  assertEqual(plan.nextState.paused, true, "paused");
  assertEqual(plan.nextState.pauseReason, "INFLIGHT_BEFORE_SEND", "reason");
  assert(plan.nextState.inFlight != null, "保留 inFlight");
}

{
  let s = createInitialState("2026-07-28");
  s = beginInFlightTransition(s, {
    operationId: "op", guildId: G, forumChannelId: F, threadId: T, startedAt: TS,
  }).state;
  s = markMessageSentTransition(s, {
    operationId: "op", sentMessageId: M, sentAt: TS,
  }).state;
  const plan = planStartupRecovery(s);
  assertEqual(plan.recoveryStatus, "cleanup_required", "after_send");
  assertEqual(plan.cleanupRequired, true, "cleanup true");
  assertEqual(plan.nextState.pauseReason, "INFLIGHT_MESSAGE_MAY_EXIST", "msg may exist");
}

{
  let s = createInitialState("2026-07-28");
  s = beginInFlightTransition(s, {
    operationId: "op", guildId: G, forumChannelId: F, threadId: T, startedAt: TS,
  }).state;
  s = markMessageSentTransition(s, {
    operationId: "op", sentMessageId: M, sentAt: TS,
  }).state;
  s = markMessageDeletedTransition(s, {
    operationId: "op", deletedAt: TS,
  }).state;
  const plan = planStartupRecovery(s);
  assertEqual(plan.recoveryStatus, "reconciliation_required", "after_delete");
  assertEqual(plan.cleanupRequired, false, "no cleanup");
  assertEqual(plan.nextState.pauseReason, "INFLIGHT_SUCCESS_RECONCILIATION_REQUIRED", "reconcile");
}

{
  let s = createInitialState("2026-07-28");
  s = beginInFlightTransition(s, {
    operationId: "op", guildId: G, forumChannelId: F, threadId: T, startedAt: TS,
  }).state;
  s = pauseTransition(s, { reason: "ADMIN_HOLD" }).state;
  const plan = planStartupRecovery(s);
  assertEqual(plan.changed, false, "已有 pause 不覆盖");
  assertEqual(plan.nextState.pauseReason, "ADMIN_HOLD", "保留管理员原因");
  assertEqual(plan.recoveryStatus, "manual_review_required", "仍返回分类");
}

console.log(`\nForumBump stateRecovery: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

import {
  mapCycleResultToIncidentKey,
  buildSafeAlertDetails,
  createForumBumpAlertHandler,
} from "./runtimeAlerts.js";

let passed = 0;
let failed = 0;
function assert(c, l) {
  if (c) { passed++; console.log(`  PASS: ${l}`); }
  else { failed++; console.error(`  FAIL: ${l}`); }
}
function assertEqual(a, e, l) {
  assert(a === e, `${l} (got ${JSON.stringify(a)})`);
}

console.log("\n=== runtimeAlerts ===\n");

assertEqual(mapCycleResultToIncidentKey({ status: "no_candidate" }), null, "no_candidate 不告警");
assertEqual(mapCycleResultToIncidentKey({ status: "cooldown" }), null, "cooldown 不告警");
assertEqual(mapCycleResultToIncidentKey({ status: "dry_run_candidate" }), null, "dry_run 不告警");
assertEqual(mapCycleResultToIncidentKey({ status: "cleanup_required" }), "forum_bump_cleanup_required", "cleanup");
assertEqual(mapCycleResultToIncidentKey({ status: "reconciliation_required" }), "forum_bump_reconciliation_required", "recon");
assertEqual(mapCycleResultToIncidentKey({ status: "state_failed" }), "forum_bump_state_unavailable", "state");
assertEqual(mapCycleResultToIncidentKey({ status: "unexpected_failed" }), "forum_bump_scheduler_unexpected_failed", "unexpected");
assertEqual(mapCycleResultToIncidentKey({ status: "halted" }), "forum_bump_scheduler_halted", "halted");

{
  const d = buildSafeAlertDetails({
    status: "cleanup_required",
    errorCode: "DELETE_FAILED",
    sentMessageId: "444444444444444444",
  });
  assertEqual(d.sentMessageId, "444444444444444444", "DELETE 含 sentMessageId");
  assert(!JSON.stringify(d).includes("stack"), "无 stack");
}

{
  const calls = [];
  const handler = createForumBumpAlertHandler({
    alertNotifier: {
      notifyFailure: async (k, m, det) => { calls.push({ k, m, det }); },
      notifyRecovery: async (k) => { calls.push({ recovery: k }); },
    },
    guildId: "111111111111111111",
  });
  await handler.handleCycleResult({ status: "cleanup_required", errorCode: "DELETE_FAILED", sentMessageId: "1" });
  assertEqual(calls[0].k, "forum_bump_cleanup_required", "failure key");
  await handler.handleCycleResult({ status: "no_candidate" });
  assertEqual(calls.length, 1, "no_candidate 不增加");
}

console.log(`\nruntimeAlerts: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

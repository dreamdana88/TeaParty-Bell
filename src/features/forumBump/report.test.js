import { buildScanReport } from "./report.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label}`);
}

console.log("\n=== ForumBump report ===\n");

const records = [
  {
    eligible: true,
    threadId: "2",
    threadName: "newer",
    forumChannelId: "f1",
    archived: false,
    activityAt: 200,
    activitySource: "last_message_snowflake",
    silenceDaysExact: 40,
    lastMessageId: "m2",
    archiveTimestamp: 1,
    appliedTagIds: [],
    skipReason: null,
  },
  {
    eligible: true,
    threadId: "1",
    threadName: "older",
    forumChannelId: "f1",
    archived: true,
    activityAt: 100,
    activitySource: "last_message_snowflake",
    silenceDaysExact: 50,
    lastMessageId: "m1",
    archiveTimestamp: 1,
    appliedTagIds: ["t"],
    skipReason: null,
  },
  {
    eligible: false,
    threadId: "3",
    skipReason: "THREAD_PINNED",
    activityAt: 50,
  },
];

const report = buildScanReport({
  guildId: "g",
  forumIds: ["f1", "f2"],
  silenceDays: 30,
  excludedTagIds: ["tag"],
  skipPinned: true,
  displayLimit: 1,
  durationMs: 12,
  forumSummaries: [
    {
      forumId: "f1",
      forumName: "Forum One",
      activeFetchedCount: 1,
      archivedFetchedCount: 2,
      archivedPageCount: 1,
      rawThreadCount: 3,
      deduplicatedThreadCount: 3,
      eligibleCount: 2,
      uncertainCount: 0,
    },
  ],
  allRecords: records,
  clock: { now: () => 1_700_000_000_000 },
});

assertEqual(report.operation, "forum-scan", "operation");
assertEqual(report.dryRun, true, "dryRun");
assertEqual(report.summary.totalForums, 2, "totalForums");
assertEqual(report.summary.eligibleCount, 2, "eligible 完整统计");
assertEqual(report.summary.displayedCandidateCount, 1, "展示裁剪");
assertEqual(report.candidates.length, 1, "candidates 长度=displayLimit");
assertEqual(report.candidates[0].threadId, "1", "展示最久优先");
assertEqual(report.candidates[0].rank, 1, "rank 1");
assertEqual(report.summary.skipReasonCounts.pinned, 1, "跳过 pinned 计数");
assertEqual(report.summary.oldestActivityAt, 50, "oldest 含非候选");
assertEqual(report.summary.newestEligibleActivityAt, 200, "newest eligible");

const blob = JSON.stringify(report);
assert(!blob.includes("TOKEN"), "报告无 Token");
assert(!blob.includes("stack"), "报告无 stack");
assert(!blob.includes("【小G宝"), "报告无消息正文");

console.log(`\nForumBump report: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

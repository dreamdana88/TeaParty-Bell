/**
 * Dry Run 扫描报告生成（纯函数）。
 */

import { countSkipReasons, sortCandidates } from "./candidateRules.js";

/**
 * @param {object} input
 * @returns {object}
 */
export function buildScanReport(input) {
  const {
    guildId,
    forumIds,
    silenceDays,
    excludedTagIds = [],
    skipPinned = true,
    displayLimit = 20,
    durationMs = 0,
    forumSummaries = [],
    allRecords = [],
    clock = { now: () => Date.now() },
  } = input;

  const sortedEligible = sortCandidates(allRecords.filter((r) => r.eligible));
  const displayed = sortedEligible.slice(0, displayLimit);

  const activityAts = allRecords
    .map((r) => r.activityAt)
    .filter((v) => typeof v === "number" && Number.isFinite(v));

  const eligibleActivityAts = sortedEligible
    .map((r) => r.activityAt)
    .filter((v) => typeof v === "number" && Number.isFinite(v));

  const oldestActivityAt = activityAts.length > 0 ? Math.min(...activityAts) : null;
  const newestEligibleActivityAt = eligibleActivityAts.length > 0
    ? Math.max(...eligibleActivityAts)
    : null;

  return {
    operation: "forum-scan",
    dryRun: true,
    timestamp: new Date(clock.now()).toISOString(),
    guildId,
    forumIds: [...forumIds],
    silenceDays,
    excludedTagIds: [...excludedTagIds],
    skipPinned,
    displayLimit,
    durationMs,
    forums: forumSummaries.map((f) => ({ ...f })),
    summary: {
      totalForums: forumIds.length,
      totalThreads: allRecords.length,
      eligibleCount: sortedEligible.length,
      displayedCandidateCount: displayed.length,
      oldestActivityAt,
      newestEligibleActivityAt,
      skipReasonCounts: countSkipReasons(allRecords),
    },
    candidates: displayed.map((record, index) => ({
      rank: index + 1,
      threadId: record.threadId,
      threadName: record.threadName,
      forumChannelId: record.forumChannelId,
      archived: record.archived,
      activityAt: record.activityAt,
      activitySource: record.activitySource,
      silenceDaysExact: record.silenceDaysExact,
      lastMessageId: record.lastMessageId,
      archiveTimestamp: record.archiveTimestamp,
      appliedTagIds: [...(record.appliedTagIds ?? [])],
    })),
  };
}

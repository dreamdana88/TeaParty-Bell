/**
 * Forum 候选资格与稳定排序（纯函数）。
 */

import { ChannelType } from "discord.js";
import { resolveActivityTime } from "./activityTime.js";

export const SKIP_REASONS = Object.freeze({
  THREAD_LOCKED: "THREAD_LOCKED",
  THREAD_PINNED: "THREAD_PINNED",
  THREAD_WRONG_TYPE: "THREAD_WRONG_TYPE",
  THREAD_WRONG_PARENT: "THREAD_WRONG_PARENT",
  THREAD_WRONG_GUILD: "THREAD_WRONG_GUILD",
  BOT_MISSING_PERMISSION: "BOT_MISSING_PERMISSION",
  BOT_PERMISSION_UNCERTAIN: "BOT_PERMISSION_UNCERTAIN",
  EXCLUDED_TAG: "EXCLUDED_TAG",
  ACTIVITY_UNCERTAIN: "ACTIVITY_UNCERTAIN",
  NOT_SILENT_ENOUGH: "NOT_SILENT_ENOUGH",
});

/**
 * @param {object} threadLike
 * @param {object} options
 * @param {string} options.guildId
 * @param {string} options.forumChannelId
 * @param {number} options.silenceDays
 * @param {number} options.nowMs
 * @param {readonly string[]} [options.excludedTagIds]
 * @param {boolean} [options.skipPinned]
 * @param {{ viewChannel: boolean|null, sendMessagesInThreads: boolean|null }|null} [options.permissions]
 * @returns {object} 标准化记录
 */
export function evaluateThreadCandidate(threadLike, options) {
  const {
    guildId,
    forumChannelId,
    silenceDays,
    nowMs,
    excludedTagIds = [],
    skipPinned = true,
    permissions = null,
  } = options;

  const threadId = threadLike?.id ?? threadLike?.threadId ?? null;
  const threadType = threadLike?.type ?? null;
  const archived = threadLike?.archived ?? null;
  const locked = threadLike?.locked === true;
  const pinned = threadLike?.pinned === true
    || threadLike?.flags?.has?.("Pinned") === true
    || threadLike?.flags?.has?.(2) === true
    || (typeof threadLike?.flags?.bitfield === "number" && (threadLike.flags.bitfield & 2) !== 0);

  const appliedTagIds = Array.isArray(threadLike?.appliedTags)
    ? threadLike.appliedTags.map(String)
    : Array.isArray(threadLike?.appliedTagIds)
      ? threadLike.appliedTagIds.map(String)
      : [];

  const activity = resolveActivityTime({
    lastMessageId: threadLike?.lastMessageId ?? null,
    archiveTimestamp: threadLike?.archiveTimestamp ?? null,
  });

  const silenceMsRequired = silenceDays * 86_400_000;
  let silenceMs = null;
  let silenceDaysExact = null;
  if (activity.activityAt != null) {
    silenceMs = Math.max(0, nowMs - activity.activityAt);
    silenceDaysExact = silenceMs / 86_400_000;
  }

  /** @type {string|null} */
  let skipReason = null;

  const recordGuildId = threadLike?.guildId ?? threadLike?.guild?.id ?? null;
  if (recordGuildId && recordGuildId !== guildId) {
    skipReason = SKIP_REASONS.THREAD_WRONG_GUILD;
  }

  const parentId = threadLike?.parentId ?? threadLike?.forumChannelId ?? null;
  if (!skipReason && parentId && parentId !== forumChannelId) {
    skipReason = SKIP_REASONS.THREAD_WRONG_PARENT;
  }

  if (!skipReason && threadType !== ChannelType.PublicThread && threadType !== 11) {
    skipReason = SKIP_REASONS.THREAD_WRONG_TYPE;
  }

  if (!skipReason && locked) {
    skipReason = SKIP_REASONS.THREAD_LOCKED;
  }

  if (!skipReason && skipPinned && pinned) {
    skipReason = SKIP_REASONS.THREAD_PINNED;
  }

  if (!skipReason && permissions) {
    if (permissions.viewChannel === null || permissions.sendMessagesInThreads === null) {
      skipReason = SKIP_REASONS.BOT_PERMISSION_UNCERTAIN;
    } else if (permissions.viewChannel !== true || permissions.sendMessagesInThreads !== true) {
      skipReason = SKIP_REASONS.BOT_MISSING_PERMISSION;
    }
  }

  if (!skipReason && excludedTagIds.length > 0) {
    const excluded = new Set(excludedTagIds.map(String));
    if (appliedTagIds.some((tag) => excluded.has(String(tag)))) {
      skipReason = SKIP_REASONS.EXCLUDED_TAG;
    }
  }

  if (!skipReason && activity.activitySource === "uncertain") {
    skipReason = SKIP_REASONS.ACTIVITY_UNCERTAIN;
  }

  if (!skipReason && activity.activityAt != null && silenceMs < silenceMsRequired) {
    skipReason = SKIP_REASONS.NOT_SILENT_ENOUGH;
  }

  const eligible = skipReason == null;

  return {
    guildId: recordGuildId ?? guildId,
    forumChannelId: parentId ?? forumChannelId,
    threadId,
    threadName: typeof threadLike?.name === "string" ? threadLike.name : null,
    threadType,
    archived,
    locked,
    pinned,
    autoArchiveDuration: threadLike?.autoArchiveDuration ?? null,
    archiveTimestamp: threadLike?.archiveTimestamp ?? null,
    lastMessageId: threadLike?.lastMessageId ?? null,
    messageCount: threadLike?.messageCount ?? null,
    totalMessageSent: threadLike?.totalMessageSent ?? null,
    appliedTagIds,
    activityAt: activity.activityAt,
    activitySource: activity.activitySource,
    silenceMs,
    silenceDaysExact,
    eligible,
    skipReason,
  };
}

/**
 * @param {object[]} records
 * @returns {object[]}
 */
export function sortCandidates(records) {
  return [...records].sort((a, b) => {
    const aAt = a.activityAt ?? Number.POSITIVE_INFINITY;
    const bAt = b.activityAt ?? Number.POSITIVE_INFINITY;
    if (aAt !== bAt) return aAt - bAt;
    const aId = String(a.threadId ?? "");
    const bId = String(b.threadId ?? "");
    if (aId < bId) return -1;
    if (aId > bId) return 1;
    return 0;
  });
}

/**
 * @param {object[]} records
 * @returns {Record<string, number>}
 */
export function countSkipReasons(records) {
  const counts = {
    locked: 0,
    pinned: 0,
    excludedTag: 0,
    missingPermission: 0,
    permissionUncertain: 0,
    activityUncertain: 0,
    notSilentEnough: 0,
    wrongType: 0,
    wrongParent: 0,
    wrongGuild: 0,
    other: 0,
  };

  for (const record of records) {
    if (record.eligible) continue;
    switch (record.skipReason) {
      case SKIP_REASONS.THREAD_LOCKED:
        counts.locked += 1;
        break;
      case SKIP_REASONS.THREAD_PINNED:
        counts.pinned += 1;
        break;
      case SKIP_REASONS.EXCLUDED_TAG:
        counts.excludedTag += 1;
        break;
      case SKIP_REASONS.BOT_MISSING_PERMISSION:
        counts.missingPermission += 1;
        break;
      case SKIP_REASONS.BOT_PERMISSION_UNCERTAIN:
        counts.permissionUncertain += 1;
        break;
      case SKIP_REASONS.ACTIVITY_UNCERTAIN:
        counts.activityUncertain += 1;
        break;
      case SKIP_REASONS.NOT_SILENT_ENOUGH:
        counts.notSilentEnough += 1;
        break;
      case SKIP_REASONS.THREAD_WRONG_TYPE:
        counts.wrongType += 1;
        break;
      case SKIP_REASONS.THREAD_WRONG_PARENT:
        counts.wrongParent += 1;
        break;
      case SKIP_REASONS.THREAD_WRONG_GUILD:
        counts.wrongGuild += 1;
        break;
      default:
        counts.other += 1;
        break;
    }
  }

  return counts;
}

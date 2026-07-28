/**
 * Forum 候选扫描器核心：只读枚举、资格评估、排序。
 *
 * 不发送、不删除、不改 Thread 元数据、不写状态文件。
 */

import { ChannelType, PermissionFlagsBits } from "discord.js";
import { createForumBumpError, isForumBumpError } from "./errors.js";
import { evaluateThreadCandidate, sortCandidates } from "./candidateRules.js";
import { buildScanReport } from "./report.js";

const UNKNOWN_CHANNEL = 10003;
const MISSING_ACCESS = 50001;
const MISSING_PERMISSION = 50013;

/**
 * @param {object} thread
 * @returns {boolean}
 */
function isPinnedThread(thread) {
  if (thread?.pinned === true) return true;
  if (thread?.flags && typeof thread.flags.has === "function") {
    try {
      if (thread.flags.has("Pinned") || thread.flags.has(2)) return true;
    } catch {
      // ignore
    }
  }
  if (typeof thread?.flags?.bitfield === "number" && (thread.flags.bitfield & 2) !== 0) {
    return true;
  }
  return false;
}

/**
 * @param {object} thread
 * @param {object|null} botUser
 * @returns {{ viewChannel: boolean|null, sendMessagesInThreads: boolean|null }}
 */
export function readThreadPermissions(thread, botUser) {
  if (!botUser || typeof thread?.permissionsFor !== "function") {
    return { viewChannel: null, sendMessagesInThreads: null };
  }
  let permissions;
  try {
    permissions = thread.permissionsFor(botUser);
  } catch {
    return { viewChannel: null, sendMessagesInThreads: null };
  }
  if (!permissions || typeof permissions.has !== "function") {
    return { viewChannel: null, sendMessagesInThreads: null };
  }
  try {
    return {
      viewChannel: permissions.has(PermissionFlagsBits.ViewChannel),
      sendMessagesInThreads: permissions.has(PermissionFlagsBits.SendMessagesInThreads),
    };
  } catch {
    return { viewChannel: null, sendMessagesInThreads: null };
  }
}

/**
 * @param {Iterable|Map|Array|object} threadsContainer
 * @returns {object[]}
 */
function toThreadArray(threadsContainer) {
  if (!threadsContainer) return [];
  if (Array.isArray(threadsContainer)) return threadsContainer.filter(Boolean);
  if (typeof threadsContainer.values === "function") {
    return [...threadsContainer.values()].filter(Boolean);
  }
  if (threadsContainer.threads) {
    return toThreadArray(threadsContainer.threads);
  }
  return [];
}

/**
 * 从一页归档结果中取最旧 archiveTimestamp 作为下一页 before 游标。
 * @param {object[]} threads
 * @returns {number|string|null}
 */
export function pickOldestArchiveCursor(threads) {
  let oldest = null;
  for (const thread of threads) {
    const ts = thread?.archiveTimestamp;
    if (typeof ts === "number" && Number.isFinite(ts)) {
      if (oldest == null || ts < oldest) oldest = ts;
    } else if (ts instanceof Date) {
      const ms = ts.getTime();
      if (Number.isFinite(ms) && (oldest == null || ms < oldest)) oldest = ms;
    }
  }
  return oldest;
}

/**
 * @param {object} client
 * @param {string} forumId
 * @param {string} expectedGuildId
 * @param {object|null} botUser
 * @returns {Promise<object>}
 */
export async function validateForumChannel(client, forumId, expectedGuildId, botUser) {
  if (!client?.channels?.fetch) {
    throw createForumBumpError("FORUM_NOT_FOUND", undefined, { forumId });
  }

  let channel;
  try {
    channel = await client.channels.fetch(forumId, { force: true });
  } catch (error) {
    if (error?.code === UNKNOWN_CHANNEL || error?.code === MISSING_ACCESS || error?.code === MISSING_PERMISSION) {
      throw createForumBumpError("FORUM_NOT_FOUND", error, { forumId });
    }
    throw createForumBumpError("FORUM_NOT_FOUND", error, { forumId });
  }

  if (!channel) {
    throw createForumBumpError("FORUM_NOT_FOUND", undefined, { forumId });
  }

  const guildId = channel.guildId ?? channel.guild?.id ?? null;
  if (guildId !== expectedGuildId) {
    throw createForumBumpError("WRONG_GUILD", undefined, { forumId, guildId });
  }

  if (channel.type !== ChannelType.GuildForum) {
    throw createForumBumpError("NOT_FORUM_CHANNEL", undefined, { forumId });
  }

  if (botUser && typeof channel.permissionsFor === "function") {
    let permissions;
    try {
      permissions = channel.permissionsFor(botUser);
    } catch (error) {
      throw createForumBumpError("BOT_MISSING_VIEW_CHANNEL", error, { forumId });
    }
    if (!permissions || typeof permissions.has !== "function" || !permissions.has(PermissionFlagsBits.ViewChannel)) {
      throw createForumBumpError("BOT_MISSING_VIEW_CHANNEL", undefined, { forumId });
    }
  }

  return channel;
}

/**
 * 默认：通过 forum.threads.fetchActive，再按 parentId 过滤。
 * @param {object} forum
 * @returns {Promise<object[]>}
 */
export async function defaultFetchActiveThreads(forum) {
  if (typeof forum?.threads?.fetchActive === "function") {
    const result = await forum.threads.fetchActive();
    return toThreadArray(result).filter((t) => (t.parentId ?? null) === forum.id);
  }
  if (typeof forum?.guild?.channels?.fetchActiveThreads === "function") {
    const result = await forum.guild.channels.fetchActiveThreads();
    return toThreadArray(result).filter((t) => (t.parentId ?? null) === forum.id);
  }
  throw createForumBumpError("ACTIVE_THREADS_FETCH_FAILED", undefined, { forumId: forum?.id });
}

/**
 * 默认：省略 limit，使用 discord.js / API 默认页大小。
 * 依据：ThreadManager.fetchArchived 在未传 limit 时不强制 100；
 * 任务书要求不得未经验证硬编码 100。
 * @param {object} forum
 * @param {{ before?: number|string|null }} [options]
 * @returns {Promise<{ threads: object[], hasMore: boolean }>}
 */
export async function defaultFetchArchivedPage(forum, options = {}) {
  if (typeof forum?.threads?.fetchArchived !== "function") {
    throw createForumBumpError("ARCHIVED_THREADS_FETCH_FAILED", undefined, { forumId: forum?.id });
  }
  const params = { type: "public" };
  if (options.before != null) {
    params.before = options.before;
  }
  const result = await forum.threads.fetchArchived(params);
  const threads = toThreadArray(result).filter((t) => (t.parentId ?? null) === forum.id);
  const hasMore = result?.hasMore === true;
  return { threads, hasMore };
}

/**
 * 完整分页获取公开已归档 threads。
 * @param {object} forum
 * @param {(forum: object, options: object) => Promise<{threads: object[], hasMore: boolean}>} fetchArchivedPage
 * @param {object} [logger]
 * @returns {Promise<{ threads: object[], archivedPageCount: number }>}
 */
export async function fetchAllPublicArchivedThreads(forum, fetchArchivedPage, logger) {
  const all = [];
  const seenThreadIds = new Set();
  const seenCursors = new Set();
  let before = undefined;
  let pageNumber = 0;
  let hasMore = true;

  while (hasMore) {
    pageNumber += 1;
    let page;
    try {
      page = await fetchArchivedPage(forum, before != null ? { before } : {});
    } catch (error) {
      if (isForumBumpError(error)) throw error;
      throw createForumBumpError("ARCHIVED_THREADS_FETCH_FAILED", error, {
        forumId: forum.id,
        pageNumber,
        cursor: before ?? null,
      });
    }

    const pageThreads = Array.isArray(page?.threads) ? page.threads : [];
    hasMore = page?.hasMore === true;

    for (const thread of pageThreads) {
      const id = thread?.id;
      if (!id || seenThreadIds.has(id)) continue;
      seenThreadIds.add(id);
      all.push(thread);
    }

    try {
      logger?.info?.("[ForumBump] archived page", {
        forumId: forum.id,
        pageNumber,
        pageItemCount: pageThreads.length,
        hasMore,
      });
    } catch {
      // ignore
    }

    if (!hasMore) break;

    const nextCursor = pickOldestArchiveCursor(pageThreads);
    if (nextCursor == null) {
      throw createForumBumpError("ARCHIVED_PAGINATION_STALLED", undefined, {
        forumId: forum.id,
        pageNumber,
        cursor: before ?? null,
      });
    }

    const cursorKey = String(nextCursor);
    if (seenCursors.has(cursorKey) || (before != null && String(before) === cursorKey)) {
      throw createForumBumpError("ARCHIVED_PAGINATION_STALLED", undefined, {
        forumId: forum.id,
        pageNumber,
        cursor: cursorKey,
      });
    }
    seenCursors.add(cursorKey);
    before = nextCursor;
  }

  return { threads: all, archivedPageCount: pageNumber };
}

/**
 * @param {object[]} threads
 * @returns {{ unique: object[], rawCount: number, duplicateCount: number }}
 */
export function dedupeThreadsById(threads) {
  const map = new Map();
  let duplicateCount = 0;
  for (const thread of threads) {
    const id = thread?.id;
    if (!id) continue;
    if (map.has(id)) {
      duplicateCount += 1;
      // 优先保留看起来字段更完整的对象
      const prev = map.get(id);
      const prevScore = scoreThreadCompleteness(prev);
      const nextScore = scoreThreadCompleteness(thread);
      if (nextScore >= prevScore) map.set(id, thread);
    } else {
      map.set(id, thread);
    }
  }
  return {
    unique: [...map.values()],
    rawCount: threads.filter((t) => t?.id).length,
    duplicateCount,
  };
}

function scoreThreadCompleteness(thread) {
  let score = 0;
  if (thread?.lastMessageId) score += 2;
  if (thread?.archiveTimestamp != null) score += 1;
  if (thread?.messageCount != null) score += 1;
  if (thread?.totalMessageSent != null) score += 1;
  if (thread?.name) score += 1;
  return score;
}

/**
 * 扫描多个 Forum，生成 dry-run 报告。
 * @param {object} options
 */
export async function scanForumCandidates({
  client,
  guildId,
  forumIds,
  silenceDays,
  excludedTagIds = [],
  skipPinned = true,
  displayLimit = 20,
  logger,
  clock = { now: () => Date.now() },
  fetchActiveThreads = defaultFetchActiveThreads,
  fetchArchivedPage = defaultFetchArchivedPage,
} = {}) {
  if (!client) throw createForumBumpError("SCAN_FAILED");
  if (!guildId) throw createForumBumpError("WRONG_GUILD");
  if (!Array.isArray(forumIds) || forumIds.length === 0) {
    throw createForumBumpError("FORUM_REQUIRED");
  }

  const startedAt = clock.now();
  const botUser = client.user ?? null;
  const forumSummaries = [];
  const allRecords = [];

  // 校验全部 Forum 后再扫描（任一非法整次失败）
  const forums = [];
  for (const forumId of forumIds) {
    const forum = await validateForumChannel(client, forumId, guildId, botUser);
    forums.push(forum);
  }

  for (const forum of forums) {
    try {
      logger?.info?.("[ForumBump] scanning forum", {
        forumId: forum.id,
        forumName: typeof forum.name === "string" ? forum.name : null,
      });
    } catch {
      // ignore
    }

    let activeThreads;
    try {
      activeThreads = await fetchActiveThreads(forum);
    } catch (error) {
      if (isForumBumpError(error)) throw error;
      throw createForumBumpError("ACTIVE_THREADS_FETCH_FAILED", error, { forumId: forum.id });
    }

    const activeAccepted = activeThreads.filter(
      (t) => (t.parentId ?? null) === forum.id
        && (t.type === ChannelType.PublicThread || t.type === 11),
    );

    const archivedResult = await fetchAllPublicArchivedThreads(forum, fetchArchivedPage, logger);
    const archivedAccepted = archivedResult.threads.filter(
      (t) => (t.parentId ?? null) === forum.id
        && (t.type === ChannelType.PublicThread || t.type === 11 || t.type == null),
    );

    const merged = [...activeAccepted, ...archivedAccepted];
    const { unique, rawCount, duplicateCount } = dedupeThreadsById(merged);

    const nowMs = clock.now();
    const forumRecords = [];
    for (const thread of unique) {
      // 归档列表可能缺 type，按 PublicThread 处理（Forum 公开归档帖）
      const normalized = {
        ...thread,
        type: thread.type ?? ChannelType.PublicThread,
        pinned: isPinnedThread(thread),
        guildId: thread.guildId ?? thread.guild?.id ?? guildId,
        parentId: thread.parentId ?? forum.id,
      };
      const permissions = readThreadPermissions(thread, botUser);
      const record = evaluateThreadCandidate(normalized, {
        guildId,
        forumChannelId: forum.id,
        silenceDays,
        nowMs,
        excludedTagIds,
        skipPinned,
        permissions,
      });
      forumRecords.push(record);
      allRecords.push(record);
    }

    const eligibleCount = forumRecords.filter((r) => r.eligible).length;
    const uncertainCount = forumRecords.filter(
      (r) => r.skipReason === "ACTIVITY_UNCERTAIN",
    ).length;

    forumSummaries.push({
      forumId: forum.id,
      forumName: typeof forum.name === "string" ? forum.name : null,
      activeFetchedCount: activeThreads.length,
      activeAcceptedCount: activeAccepted.length,
      archivedFetchedCount: archivedAccepted.length,
      archivedPageCount: archivedResult.archivedPageCount,
      rawThreadCount: rawCount,
      deduplicatedThreadCount: unique.length,
      duplicateCount,
      eligibleCount,
      uncertainCount,
    });
  }

  const durationMs = Math.max(0, clock.now() - startedAt);
  const report = buildScanReport({
    guildId,
    forumIds,
    silenceDays,
    excludedTagIds,
    skipPinned,
    displayLimit,
    durationMs,
    forumSummaries,
    allRecords,
    clock,
  });

  // 附带完整候选排序（供测试统计）；CLI 输出仍以 report.candidates 展示裁剪
  report._allEligibleSorted = sortCandidates(allRecords.filter((r) => r.eligible));

  try {
    logger?.info?.("[ForumBump] scan complete", {
      operation: "forum-scan",
      dryRun: true,
      guildId,
      totalThreads: report.summary.totalThreads,
      eligibleCount: report.summary.eligibleCount,
      durationMs,
    });
  } catch {
    // ignore
  }

  return report;
}

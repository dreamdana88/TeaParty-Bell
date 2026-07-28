/**
 * Forum Thread 安全快照与强制 REST 刷新（环境无关）。
 */

import { ChannelType } from "discord.js";

const UNKNOWN_CHANNEL = 10003;
const MISSING_ACCESS = 50001;
const MISSING_PERMISSION = 50013;
const MISSING_CODES = new Set([UNKNOWN_CHANNEL, MISSING_ACCESS, MISSING_PERMISSION]);

/**
 * @param {object|null|undefined} thread
 * @param {object|null|undefined} parentForum
 * @param {{ now: () => number }} clock
 */
export function captureThreadSnapshot(thread, parentForum, clock) {
  const now = typeof clock?.now === "function" ? clock.now() : Date.now();
  return {
    timestamp: new Date(now).toISOString(),
    guildId: thread?.guildId ?? thread?.guild?.id ?? null,
    forumChannelId: parentForum?.id ?? thread?.parentId ?? null,
    threadId: thread?.id ?? null,
    threadType: thread?.type ?? null,
    threadName: typeof thread?.name === "string" ? thread.name : null,
    archived: thread?.archived ?? null,
    locked: thread?.locked ?? null,
    autoArchiveDuration: thread?.autoArchiveDuration ?? null,
    archiveTimestamp: thread?.archiveTimestamp ?? null,
    lastMessageId: thread?.lastMessageId ?? null,
    messageCount: thread?.messageCount ?? null,
    totalMessageSent: thread?.totalMessageSent ?? null,
    appliedTagIds: Array.isArray(thread?.appliedTags)
      ? [...thread.appliedTags]
      : Array.isArray(thread?.appliedTagIds)
        ? [...thread.appliedTagIds]
        : [],
    defaultSortOrder: parentForum?.defaultSortOrder ?? null,
  };
}

/**
 * @param {object} client
 * @param {string} channelId
 * @param {{ force?: boolean }} [options]
 */
export async function forceFetchChannel(client, channelId, options = {}) {
  const force = options.force !== false;
  if (!client?.channels?.fetch) {
    const err = new Error("channels.fetch unavailable");
    err.code = "THREAD_REFRESH_FAILED";
    throw err;
  }
  try {
    const channel = await client.channels.fetch(channelId, { force });
    if (!channel) {
      const err = new Error("channel not found");
      err.code = "THREAD_NOT_FOUND";
      throw err;
    }
    return channel;
  } catch (error) {
    if (error?.code === "THREAD_NOT_FOUND" || error?.code === "THREAD_REFRESH_FAILED") {
      throw error;
    }
    if (MISSING_CODES.has(error?.code)) {
      const err = new Error("channel not found");
      err.code = "THREAD_NOT_FOUND";
      err.cause = error;
      throw err;
    }
    const err = new Error("thread refresh failed");
    err.code = "THREAD_REFRESH_FAILED";
    err.cause = error;
    throw err;
  }
}

/**
 * 强制刷新 Thread + 父 Forum 并生成快照。
 * @returns {Promise<{ thread: object, parentForum: object|null, snapshot: object }>}
 */
export async function forceRefreshThreadSnapshot(client, threadId, clock) {
  const thread = await forceFetchChannel(client, threadId, { force: true });
  const parentId = thread?.parentId ?? thread?.parent?.id ?? null;
  let parentForum = null;
  if (parentId) {
    try {
      parentForum = await forceFetchChannel(client, parentId, { force: true });
    } catch {
      parentForum = thread?.parent && thread.parent.type === ChannelType.GuildForum
        ? thread.parent
        : null;
    }
  } else if (thread?.parent?.type === ChannelType.GuildForum) {
    parentForum = thread.parent;
  }

  const snapshot = captureThreadSnapshot(thread, parentForum, clock);
  return { thread, parentForum, snapshot };
}

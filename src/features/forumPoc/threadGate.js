/**
 * Forum POC 安全门与 Thread 校验。
 */

import { ChannelType, PermissionFlagsBits } from "discord.js";
import { createForumPocError } from "./errors.js";

const UNKNOWN_CHANNEL_CODE = 10003;
const MISSING_ACCESS_CODE = 50001;
const MISSING_PERMISSION_CODE = 50013;
const MISSING_PERMISSION_CODES = new Set([MISSING_ACCESS_CODE, MISSING_PERMISSION_CODE]);

/**
 * 配置级 Dev-only 门禁（inspect / dry-run / execute 共用）。
 * @param {object} config
 * @param {string|undefined} confirmGuild
 */
export function assertDevConfigGate(config, confirmGuild) {
  if (config?.nodeEnv !== "development") {
    throw createForumPocError("NOT_DEVELOPMENT");
  }
  if (config?.testMode !== true) {
    throw createForumPocError("TEST_MODE_REQUIRED");
  }
  if (!confirmGuild || typeof confirmGuild !== "string" || confirmGuild.trim().length === 0) {
    throw createForumPocError("GUILD_CONFIRMATION_REQUIRED");
  }
  if (confirmGuild !== config.discordGuildId) {
    throw createForumPocError("GUILD_CONFIRMATION_MISMATCH");
  }
}

/**
 * @param {object} channel
 * @returns {string|null}
 */
export function getChannelGuildId(channel) {
  return channel?.guildId ?? channel?.guild?.id ?? null;
}

/**
 * 解析父 Forum 频道。
 * @param {object} thread
 * @param {object} client
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<object|null>}
 */
export async function resolveParentForum(thread, client, options = {}) {
  const force = options.force === true;
  const parentId = thread?.parentId ?? thread?.parent?.id ?? null;

  // 快照路径必须 force REST，禁止只读 thread.parent 缓存。
  if (force) {
    if (!parentId || !client?.channels?.fetch) {
      return null;
    }
    try {
      const parent = await client.channels.fetch(parentId, { force: true });
      return parent ?? null;
    } catch {
      return null;
    }
  }

  if (thread?.parent && thread.parent.type === ChannelType.GuildForum) {
    return thread.parent;
  }
  if (!parentId || !client?.channels?.fetch) {
    return null;
  }
  try {
    const parent = await client.channels.fetch(parentId);
    return parent ?? null;
  } catch {
    return null;
  }
}

/**
 * 获取 Thread 频道。默认 force REST，避免读到陈旧缓存。
 * @param {object} client
 * @param {string} threadId
 * @param {{ force?: boolean }} [options]
 * @returns {Promise<object>}
 */
export async function fetchThreadChannel(client, threadId, options = {}) {
  const force = options.force !== false;
  if (!threadId || typeof threadId !== "string" || threadId.trim().length === 0) {
    throw createForumPocError("INVALID_ARGUMENT");
  }
  if (!client?.channels?.fetch) {
    throw createForumPocError("THREAD_NOT_FOUND");
  }

  let channel;
  try {
    channel = await client.channels.fetch(threadId, { force });
  } catch (error) {
    if (error?.code === UNKNOWN_CHANNEL_CODE || MISSING_PERMISSION_CODES.has(error?.code)) {
      throw createForumPocError("THREAD_NOT_FOUND", error);
    }
    throw createForumPocError("INSPECT_FAILED", error);
  }

  if (!channel) {
    throw createForumPocError("THREAD_NOT_FOUND");
  }
  return channel;
}

/**
 * 强制 REST 刷新 Thread + 父 Forum，并生成快照。
 * 失败时抛出 SNAPSHOT_FAILED / INSPECT_FAILED，不得退回旧对象伪装新快照。
 * @param {object} client
 * @param {string} threadId
 * @param {{ now: () => number }} clock
 * @param {(thread: object, parent: object, clock: object) => object} captureFn
 * @returns {Promise<{ thread: object, parentForum: object, snapshot: object }>}
 */
export async function forceRefreshThreadSnapshot(client, threadId, clock, captureFn) {
  let thread;
  try {
    thread = await fetchThreadChannel(client, threadId, { force: true });
  } catch (error) {
    if (error?.code === "THREAD_NOT_FOUND" || error?.code === "INVALID_ARGUMENT") {
      throw error;
    }
    throw createForumPocError("SNAPSHOT_FAILED", error);
  }

  const parentForum = await resolveParentForum(thread, client, { force: true });
  if (!parentForum || parentForum.type !== ChannelType.GuildForum) {
    throw createForumPocError("SNAPSHOT_FAILED");
  }

  const snapshot = captureFn(thread, parentForum, clock);
  return { thread, parentForum, snapshot };
}

/**
 * 校验目标为配置 Guild 下的 Forum PublicThread。
 * @param {object} thread
 * @param {object} parentForum
 * @param {object} config
 * @param {{ requireUnlocked?: boolean }} [options]
 */
export function assertForumThreadTarget(thread, parentForum, config, options = {}) {
  const { requireUnlocked = false } = options;
  const guildId = getChannelGuildId(thread);
  if (!guildId || guildId !== config.discordGuildId) {
    throw createForumPocError("WRONG_GUILD");
  }
  if (thread.type !== ChannelType.PublicThread) {
    throw createForumPocError("WRONG_THREAD_TYPE");
  }
  if (!parentForum || parentForum.type !== ChannelType.GuildForum) {
    throw createForumPocError("NOT_FORUM_THREAD");
  }
  if (requireUnlocked && thread.locked === true) {
    throw createForumPocError("THREAD_LOCKED");
  }
}

/**
 * 发送前权限：ViewChannel + SendMessagesInThreads。
 * 删除自己的消息不强制 ManageMessages。
 * @param {object} thread
 * @param {object} client
 */
export function assertBotThreadPermissions(thread, client) {
  if (!client?.user || typeof thread?.permissionsFor !== "function") {
    throw createForumPocError("BOT_MISSING_PERMISSION");
  }

  let permissions;
  try {
    permissions = thread.permissionsFor(client.user);
  } catch (error) {
    throw createForumPocError("BOT_MISSING_PERMISSION", error);
  }
  if (!permissions || typeof permissions.has !== "function") {
    throw createForumPocError("BOT_MISSING_PERMISSION");
  }

  const required = [
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessagesInThreads,
  ];
  const missing = required.filter((flag) => !permissions.has(flag));
  if (missing.length > 0) {
    throw createForumPocError("BOT_MISSING_PERMISSION");
  }
}

/**
 * 获取并校验 Forum Thread。
 * @param {object} client
 * @param {object} config
 * @param {string} threadId
 * @param {{ requireUnlocked?: boolean }} [options]
 * @returns {Promise<{ thread: object, parentForum: object }>}
 */
export async function loadValidatedForumThread(client, config, threadId, options = {}) {
  const thread = await fetchThreadChannel(client, threadId, { force: true });
  const parentForum = await resolveParentForum(thread, client, { force: true });
  assertForumThreadTarget(thread, parentForum, config, options);
  return { thread, parentForum };
}

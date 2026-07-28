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
 * 解析父 Forum 频道（可能需 fetch）。
 * @param {object} thread
 * @param {object} client
 * @returns {Promise<object|null>}
 */
export async function resolveParentForum(thread, client) {
  if (thread?.parent && thread.parent.type === ChannelType.GuildForum) {
    return thread.parent;
  }
  const parentId = thread?.parentId ?? null;
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
 * @param {object} client
 * @param {string} threadId
 * @returns {Promise<object>}
 */
export async function fetchThreadChannel(client, threadId) {
  if (!threadId || typeof threadId !== "string" || threadId.trim().length === 0) {
    throw createForumPocError("INVALID_ARGUMENT");
  }
  if (!client?.channels?.fetch) {
    throw createForumPocError("THREAD_NOT_FOUND");
  }

  let channel;
  try {
    channel = await client.channels.fetch(threadId);
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
  const thread = await fetchThreadChannel(client, threadId);
  const parentForum = await resolveParentForum(thread, client);
  assertForumThreadTarget(thread, parentForum, config, options);
  return { thread, parentForum };
}

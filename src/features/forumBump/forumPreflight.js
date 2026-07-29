/**
 * Forum 频道 Preflight（可注入 client，无真实 Discord 依赖）。
 * 检查：存在、Guild、GuildForum、ViewChannel / ReadMessageHistory / SendMessagesInThreads。
 */

import { ChannelType, PermissionFlagsBits } from "discord.js";

/**
 * @param {object} options
 * @param {object} options.client
 * @param {string} options.guildId
 * @param {string[]} options.forumChannelIds
 * @returns {Promise<{ success: boolean, errorCode: string|null, failures: object[] }>}
 */
export async function preflightForumChannels({
  client,
  guildId,
  forumChannelIds,
} = {}) {
  if (!client || typeof client.channels?.fetch !== "function") {
    return {
      success: false,
      errorCode: "DYNAMIC_CONFIG_PREFLIGHT_FAILED",
      failures: [{ errorCode: "PREFLIGHT_CLIENT_INVALID", forumId: null }],
    };
  }
  if (typeof guildId !== "string" || !guildId) {
    return {
      success: false,
      errorCode: "DYNAMIC_CONFIG_PREFLIGHT_FAILED",
      failures: [{ errorCode: "PREFLIGHT_GUILD_INVALID", forumId: null }],
    };
  }
  if (!Array.isArray(forumChannelIds) || forumChannelIds.length === 0) {
    return {
      success: false,
      errorCode: "DYNAMIC_CONFIG_PREFLIGHT_FAILED",
      failures: [{ errorCode: "PREFLIGHT_FORUMS_EMPTY", forumId: null }],
    };
  }

  const failures = [];
  for (const forumId of forumChannelIds) {
    let channel;
    try {
      channel = await client.channels.fetch(forumId, { force: true });
    } catch {
      failures.push({
        forumId,
        errorCode: "FORUM_NOT_FOUND",
        safeMessage: `无法获取 Forum：${forumId}`,
      });
      continue;
    }
    if (!channel) {
      failures.push({
        forumId,
        errorCode: "FORUM_NOT_FOUND",
        safeMessage: `Forum 不存在：${forumId}`,
      });
      continue;
    }
    const channelGuildId = channel.guildId ?? channel.guild?.id;
    if (channelGuildId !== guildId) {
      failures.push({
        forumId,
        errorCode: "WRONG_GUILD",
        safeMessage: `Forum 不属于目标 Guild：${forumId}`,
      });
      continue;
    }
    if (channel.type !== ChannelType.GuildForum) {
      failures.push({
        forumId,
        errorCode: "NOT_FORUM_CHANNEL",
        safeMessage: `频道不是 GuildForum：${forumId}`,
      });
      continue;
    }
    const permissions = typeof channel.permissionsFor === "function"
      ? channel.permissionsFor(client.user)
      : null;
    if (!permissions || typeof permissions.has !== "function") {
      failures.push({
        forumId,
        errorCode: "BOT_MISSING_PERMISSION",
        safeMessage: `无法读取 Forum 权限：${forumId}`,
      });
      continue;
    }
    const need = [
      ["ViewChannel", PermissionFlagsBits.ViewChannel],
      ["ReadMessageHistory", PermissionFlagsBits.ReadMessageHistory],
      ["SendMessagesInThreads", PermissionFlagsBits.SendMessagesInThreads],
    ];
    const missing = [];
    for (const [name, bit] of need) {
      let ok = false;
      try {
        ok = permissions.has(bit) || permissions.has(name);
      } catch {
        ok = false;
      }
      if (!ok) missing.push(name);
    }
    if (missing.length > 0) {
      failures.push({
        forumId,
        errorCode: "BOT_MISSING_PERMISSION",
        missing,
        safeMessage: `Forum 缺少权限：${forumId} → ${missing.join("、")}`,
      });
    }
  }

  if (failures.length > 0) {
    return {
      success: false,
      errorCode: "DYNAMIC_CONFIG_PREFLIGHT_FAILED",
      failures,
    };
  }
  return { success: true, errorCode: null, failures: [] };
}

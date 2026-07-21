/**
 * 统一 Discord 消息发送模块（Phase 6）。
 *
 * 提供公共频道消息发送能力，供各 Feature 复用。
 *
 * 不依赖任何具体 Feature。
 */

import { ChannelType } from "discord.js";

/**
 * 向指定频道发送纯文本消息。
 *
 * @param {import("discord.js").Client} client - 已就绪的 Discord Client
 * @param {string} channelId - 目标频道 ID
 * @param {string} content - 消息内容
 * @returns {Promise<import("discord.js").Message>} 发送成功的 Discord Message
 * @throws {Error} 频道不存在、不可发送、或发送失败时抛出
 */
export async function sendMessage(client, channelId, content) {
  // 1. 获取频道
  let channel;
  try {
    channel = await client.channels.fetch(channelId);
  } catch (err) {
    throw new Error(
      `无法获取目标频道 ${channelId}：${err.message}`
    );
  }

  if (!channel) {
    throw new Error(`目标频道 ${channelId} 不存在`);
  }

  // 2. 校验频道类型
  if (
    channel.type !== ChannelType.GuildText &&
    channel.type !== ChannelType.GuildAnnouncement
  ) {
    throw new Error(
      `目标频道 ${channelId} 不是文本频道（type: ${channel.type}）`
    );
  }

  // 3. 发送
  return channel.send(content);
}

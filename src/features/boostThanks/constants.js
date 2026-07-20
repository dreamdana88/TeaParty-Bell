/**
 * Boost 相关 MessageType 常量。
 *
 * 全部值来自 discord.js MessageType 枚举，
 * 对应 Discord API v10 Message Types：
 * @see {@link https://discord.com/developers/docs/resources/message#message-object-message-types}
 *
 * 禁止在其他文件中散落硬编码数字 8, 9, 10, 11。
 */

import { MessageType } from "discord.js";

/**
 * Boost 相关的 Discord 系统消息类型集合。
 *
 * GuildBoost（8）：    成员助力了服务器
 * GuildBoostTier1（9）：成员助力且服务器达到 Tier 1
 * GuildBoostTier2（10）：成员助力且服务器达到 Tier 2
 * GuildBoostTier3（11）：成员助力且服务器达到 Tier 3
 *
 * 注意：Tier 升级消息与普通 Boost 消息可能同时出现，
 * 真实环境需验证一次 Boost 产生几条相关事件。
 * 在未验证前，全部四种类型均视为潜在 Boost 事件。
 */
export const BOOST_MESSAGE_TYPES = new Set([
  MessageType.GuildBoost,
  MessageType.GuildBoostTier1,
  MessageType.GuildBoostTier2,
  MessageType.GuildBoostTier3,
]);

/**
 * 判断给定 message type 是否属于 Boost 相关类型。
 * @param {number} type - MessageType 数值
 * @returns {boolean}
 */
export function isBoostMessageType(type) {
  return BOOST_MESSAGE_TYPES.has(type);
}

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
 * 全部 Boost 相关的 Discord 系统消息类型集合（Observer 层使用）。
 *
 * GuildBoost（8）：    成员助力服务器（真实验证：可计数）
 * GuildBoostTier1（9）：成员助力且服务器达到 Tier 1（当前仅观察，不计入 boostCount）
 * GuildBoostTier2（10）：成员助力且服务器达到 Tier 2（当前仅观察，不计入 boostCount）
 * GuildBoostTier3（11）：成员助力且服务器达到 Tier 3（当前仅观察，不计入 boostCount）
 */
export const BOOST_MESSAGE_TYPES = new Set([
  MessageType.GuildBoost,
  MessageType.GuildBoostTier1,
  MessageType.GuildBoostTier2,
  MessageType.GuildBoostTier3,
]);

/**
 * 可计入 boostCount 的 Boost 类型（仅经真实验证的 GuildBoost type 8）。
 *
 * Tier 升级消息（9/10/11）当前不得计入 boostCount。
 * 后续经真实环境验证 Tier 消息是否与 type 8 重复后，再决定是否扩展此集合。
 */
export const COUNTABLE_BOOST_TYPES = new Set([
  MessageType.GuildBoost,
]);

/**
 * 判断给定 message type 是否属于 Boost 相关类型（Observer 层使用）。
 * 包含 type 8/9/10/11。
 *
 * @param {number} type - MessageType 数值
 * @returns {boolean}
 */
export function isBoostMessageType(type) {
  return BOOST_MESSAGE_TYPES.has(type);
}

/**
 * 判断给定 message type 是否可计入 boostCount。
 * 当前仅 type 8（GuildBoost）可计数。
 *
 * @param {number} type - MessageType 数值
 * @returns {boolean}
 */
export function isCountableBoostType(type) {
  return COUNTABLE_BOOST_TYPES.has(type);
}

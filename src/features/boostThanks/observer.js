/**
 * Boost 事件观察器（Phase 2）。
 *
 * 职责：
 * - 监听 MESSAGE_CREATE 事件
 * - 筛选 Boost 相关系统消息（type 8/9/10/11）
 * - 提取并输出结构化调试信息
 * - 为真实环境验证收集数据
 *
 * 当前不执行：
 * - 防重复检查
 * - DeepSeek 调用
 * - 感谢消息发送
 * - Reaction 添加
 */

import { Events, MessageType } from "discord.js";
import { isBoostMessageType } from "./constants.js";

/**
 * 从 Message 对象提取 Boost 观察数据。
 *
 * 所有字段必须来自真实事件数据，不可用则明确标为 null。
 *
 * channelId 来自 Discord 系统消息实际所在频道（即服务器的 System Messages Channel）。
 * 该频道与 DISCORD_THANKS_CHANNEL_ID 职责独立：两者可以是同一频道也可以是不同频道。
 *
 * @param {import("discord.js").Message} message - Discord Message 对象
 * @returns {object|null} 观察数据，非 Boost 消息返回 null
 */
export function extractBoostObservation(message) {
  const type = message.type;
  if (!isBoostMessageType(type)) {
    return null;
  }

  // member 字段在 partial GuildMember 下可能不可用
  // 真实环境验证后才能确认无 GuildMembers intent 时的行为
  const memberDisplayName = message.member?.displayName ?? null;

  return {
    messageId: message.id,
    messageType: type,
    messageTypeName: _typeName(type),
    guildId: message.guildId ?? message.guild?.id ?? null,
    channelId: message.channelId ?? null,
    authorId: message.author?.id ?? null,
    authorUsername: message.author?.username ?? null,
    memberDisplayName,
    createdTimestamp: message.createdTimestamp ?? null,
    system: message.system ?? null,
  };
}

/**
 * 向 Client 注册 Boost 观察监听器。
 *
 * @param {import("discord.js").Client} client - Discord Client 实例
 * @param {object} logger - Logger 实例（来自 utils/logger）
 */
export function setupBoostObserver(client, logger) {
  client.on(Events.MessageCreate, (message) => {
    // 1. 忽略部分消息（尚未完整加载的消息）
    if (message.partial) {
      logger.debug("收到 partial message，跳过", { messageId: message.id });
      return;
    }

    // 2. 忽略非系统消息
    if (!message.system) {
      return;
    }

    // 3. 提取观察数据
    const observation = extractBoostObservation(message);
    if (!observation) {
      // 系统消息但不是 Boost 类型（如 UserJoin=7 等），静默忽略
      return;
    }

    // 4. 输出结构化观察日志
    logger.info("[BoostObserver] 检测到疑似 Boost 事件", observation);
  });
}

// ---- 内部工具 ----

/**
 * 将 MessageType 数值转换为可读名称。
 * 从 discord.js MessageType 枚举反向查找。
 */
function _typeName(type) {
  for (const [name, value] of Object.entries(MessageType)) {
    if (value === type && name !== String(type)) return name;
  }
  return `Unknown(${type})`;
}

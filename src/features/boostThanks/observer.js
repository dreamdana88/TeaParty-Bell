/**
 * Boost 事件观察器（Phase 2–6）。
 *
 * 职责：
 * - 监听 MESSAGE_CREATE 事件
 * - 筛选 Boost 相关系统消息（type 8/9/10/11）
 * - 将可计数 Boost（type 8）标准化为 BoostEvent 并送入聚合器
 * - 将 Tier 通知（type 9/10/11）仅做观察日志，不进入聚合
 * - 聚合完成后调用 onAggregated 回调（Phase 6：感谢发送链路）
 *
 * 当前不执行：
 * - Reaction 添加
 * - 防重复持久化
 */

import { Events, MessageType } from "discord.js";
import { isBoostMessageType, isCountableBoostType } from "./constants.js";
import { normalizeObservation } from "./normalizer.js";
import { createAggregator } from "./aggregator.js";

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
 * @param {object} logger - Logger 实例
 * @param {object} config - 完整配置对象（含 boostAggregationWindowMs）
 * @param {Function} [onAggregated] - Phase 6：聚合完成回调 (event) => void
 * @returns {{ destroy: Function }} 返回清理函数供 shutdown 使用
 */
export function setupBoostObserver(client, logger, config, onAggregated) {
  const aggregator = createAggregator(config);

  // 聚合完成回调
  aggregator.onAggregate((finalEvent) => {
    logger.info("[BoostAggregator] 聚合完成", finalEvent);
    if (onAggregated) {
      // fire-and-forget，但捕获同步/异步错误以防 unhandled rejection
      Promise.resolve()
        .then(() => onAggregated(finalEvent))
        .catch((error) => {
          logger.error("[BoostObserver] 聚合完成回调失败", {
            error: error?.message ?? String(error),
            guildId: finalEvent.guildId,
            userId: finalEvent.userId,
          });
        });
    }
  });

  client.on(Events.MessageCreate, (message) => {
    // 1. 忽略部分消息
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
      return;
    }

    // 4. 按消息类型路由
    if (isCountableBoostType(observation.messageType)) {
      // 可计数 Boost（type 8）：标准化 → 聚合
      const boostEvent = normalizeObservation(observation);
      if (!boostEvent) {
        logger.warn("[BoostObserver] 标准化失败（缺少关键字段），跳过", {
          messageId: observation.messageId,
          authorId: observation.authorId,
          guildId: observation.guildId,
          createdTimestamp: observation.createdTimestamp,
        });
        return;
      }
      logger.info("[BoostObserver] 收到可计数 Boost", boostEvent);
      aggregator.accept(boostEvent);
    } else {
      // Tier 通知（type 9/10/11）：仅观察，不进入聚合
      logger.info("[BoostObserver] 收到 Tier 通知（不计入 boostCount）", observation);
    }
  });

  return {
    destroy() {
      aggregator.destroy();
    },
  };
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

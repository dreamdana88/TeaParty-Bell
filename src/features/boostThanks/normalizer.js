/**
 * BoostEvent 标准化器（Phase 3）。
 *
 * 将 observer 提取的原始观察数据转换为统一内部 BoostEvent 结构。
 * 业务层后续不得直接依赖 Discord Message 对象。
 */

/**
 * @typedef {object} BoostEvent
 * @property {string} eventType   - 统一业务类型，当前固定为 "boost"
 * @property {string} eventId     - 来源 Boost 消息 ID（message.id）
 * @property {string} userId      - 助力成员 Discord 用户 ID
 * @property {string|null} username    - Discord 用户名
 * @property {string|null} displayName - 服务器显示名（可 null）
 * @property {string} guildId     - 服务器 ID
 * @property {string} sourceChannelId - Boost 系统消息实际频道
 * @property {number} timestamp   - 事件时间（ms）
 * @property {number} boostCount  - 初始值 1，经聚合后可能大于 1
 * @property {string[]} eventIds  - 合并来源的所有消息 ID
 */

/**
 * 将 Observer 观察数据标准化为 BoostEvent。
 *
 * 各字段来源（已真实环境确认）：
 * - eventId          ← observation.messageId
 * - userId           ← observation.authorId
 * - username         ← observation.authorUsername
 * - displayName      ← observation.memberDisplayName
 * - guildId          ← observation.guildId
 * - sourceChannelId  ← observation.channelId
 * - timestamp        ← observation.createdTimestamp
 *
 * @param {object} observation - extractBoostObservation 的输出
 * @returns {BoostEvent|null} 标准化事件；若缺少 userId 则返回 null
 */
export function normalizeObservation(observation) {
  const userId = observation.authorId;
  if (!userId) {
    // userId 是身份主键，缺失时拒绝进入聚合流程
    return null;
  }

  return {
    eventType: "boost",
    eventId: observation.messageId,
    userId,
    username: observation.authorUsername ?? null,
    displayName: observation.memberDisplayName ?? null,
    guildId: observation.guildId,
    sourceChannelId: observation.channelId,
    timestamp: observation.createdTimestamp,
    boostCount: 1,
    eventIds: [observation.messageId],
  };
}

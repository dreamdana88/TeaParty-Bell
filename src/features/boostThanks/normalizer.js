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
 * @property {string|null} sourceChannelId - Boost 系统消息实际频道（可 null）
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
 * 关键字段（eventId / userId / guildId / timestamp）缺失任意一个
 * 即拒绝标准化，返回 null。displayName、username、sourceChannelId
 * 允许为 null。
 *
 * @param {object} observation - extractBoostObservation 的输出
 * @returns {BoostEvent|null} 标准化事件；缺少关键字段则返回 null
 */
export function normalizeObservation(observation) {
  const eventId = observation.messageId;
  const userId = observation.authorId;
  const guildId = observation.guildId;
  const timestamp = observation.createdTimestamp;

  // 关键字段校验：eventId、userId、guildId、timestamp 均不得缺失
  // userId 是身份主键，timestamp 为 0 视为缺失（Discord snowflake 时间戳不会为 0）
  if (!eventId || !userId || !guildId || !timestamp) {
    return null;
  }

  return {
    eventType: "boost",
    eventId,
    userId,
    username: observation.authorUsername ?? null,
    displayName: observation.memberDisplayName ?? null,
    guildId,
    sourceChannelId: observation.channelId ?? null,
    timestamp,
    boostCount: 1,
    eventIds: [eventId],
  };
}

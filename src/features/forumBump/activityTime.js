/**
 * 最近消息活动时间计算（纯函数）。
 *
 * 产品语义：距离帖子最后一次消息活动已经过去多久。
 *
 * 首选：lastMessageId 的 Snowflake 时间
 * 备用：archiveTimestamp（仅当 lastMessageId 不可用）
 * 禁止：默认 max(lastMessageId, archiveTimestamp)
 */

const SNOWFLAKE_RE = /^\d{17,20}$/;
const DISCORD_EPOCH_MS = 1_420_070_400_000;

/**
 * @param {string|null|undefined} id
 * @returns {boolean}
 */
export function isDiscordSnowflake(id) {
  return typeof id === "string" && SNOWFLAKE_RE.test(id);
}

/**
 * @param {string} snowflake
 * @returns {number|null} 毫秒时间戳
 */
export function snowflakeToTimestampMs(snowflake) {
  if (!isDiscordSnowflake(snowflake)) return null;
  try {
    const ms = Number((BigInt(snowflake) >> 22n) + BigInt(DISCORD_EPOCH_MS));
    if (!Number.isFinite(ms) || ms <= 0) return null;
    return ms;
  } catch {
    return null;
  }
}

/**
 * @param {unknown} value
 * @returns {number|null}
 */
export function normalizeTimestampMs(value) {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    // 兼容秒级时间戳
    return value < 1e12 ? Math.floor(value * 1000) : Math.floor(value);
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) && ms > 0 ? ms : null;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const asNum = Number(value);
    if (Number.isFinite(asNum) && asNum > 0) {
      return asNum < 1e12 ? Math.floor(asNum * 1000) : Math.floor(asNum);
    }
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  }
  return null;
}

/**
 * @param {{ lastMessageId?: string|null, archiveTimestamp?: unknown }} threadLike
 * @returns {{
 *   activityAt: number|null,
 *   activitySource: 'last_message_snowflake'|'archive_timestamp_fallback'|'uncertain',
 * }}
 */
export function resolveActivityTime(threadLike = {}) {
  const lastMessageId = threadLike?.lastMessageId ?? null;
  const fromSnowflake = snowflakeToTimestampMs(
    typeof lastMessageId === "string" ? lastMessageId : lastMessageId != null ? String(lastMessageId) : "",
  );

  if (fromSnowflake != null) {
    return {
      activityAt: fromSnowflake,
      activitySource: "last_message_snowflake",
    };
  }

  const fromArchive = normalizeTimestampMs(threadLike?.archiveTimestamp);
  if (fromArchive != null) {
    return {
      activityAt: fromArchive,
      activitySource: "archive_timestamp_fallback",
    };
  }

  return {
    activityAt: null,
    activitySource: "uncertain",
  };
}

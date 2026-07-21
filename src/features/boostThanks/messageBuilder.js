/**
 * Boost 感谢消息拼装器（Phase 5）。
 *
 * 职责：
 * - 根据 boostCount 生成固定标题
 * - 拼接标题 + AI 正文为最终感谢消息
 *
 * 不负责：
 * - AI 调用
 * - Discord API 调用
 * - Prompt 管理
 */

// ---- 固定资源 ----

/** 服务器固定标题 Emoji */
const HEART_EMOJI = "<:heart_red:1456223334067867689>";

/** userId 校验：纯数字字符串 */
const RE_DIGITS_ONLY = /^\d+$/;

// ---- 标题生成 ----

/**
 * 根据助力次数生成固定标题。
 *
 * @param {string} userId - Discord 用户 ID（纯数字字符串）
 * @param {number} boostCount - 聚合后助力次数（≥1）
 * @returns {string} 固定标题
 * @throws {Error} userId 或 boostCount 非法时抛出
 */
export function buildTitle(userId, boostCount) {
  // userId 校验：string、非空、纯数字
  if (!userId || typeof userId !== "string" || !RE_DIGITS_ONLY.test(userId)) {
    throw new Error("userId 必须为纯数字字符串");
  }
  if (!Number.isInteger(boostCount) || boostCount < 1) {
    throw new Error(
      `boostCount 必须为正整数，收到：${boostCount}`
    );
  }

  const mention = `<@${userId}>`;

  if (boostCount === 1) {
    return `# ${HEART_EMOJI} 感谢 ${mention} 阿咪给茶话会投喂的助力！`;
  }

  if (boostCount === 2) {
    return `# ${HEART_EMOJI} 感谢 ${mention} 阿咪投放的两个助力！`;
  }

  // boostCount >= 3：生成数量文字
  const countText = boostCount <= 99
    ? _toChineseNumber(boostCount)
    : String(boostCount);

  return `# ${HEART_EMOJI} 感谢 ${mention} 阿咪投放的${countText}个助力！`;
}

// ---- 消息拼装 ----

/**
 * 拼装最终感谢消息（标题与正文之间空一行）。
 *
 * @param {string} title - buildTitle 的输出
 * @param {string} body - AI 生成的正文
 * @returns {string} 完整感谢消息
 */
export function assembleMessage(title, body) {
  const trimmedBody = body.trim();
  return `${title}\n\n${trimmedBody}`;
}

// ---- 内部工具 ----

/** 数字转中文（1～99） */
function _toChineseNumber(n) {
  const digits = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九"];
  const tens = ["", "十", "二十", "三十", "四十", "五十", "六十", "七十", "八十", "九十"];

  if (n < 10) return digits[n];
  const ten = Math.floor(n / 10);
  const one = n % 10;
  return tens[ten] + digits[one];
}

/**
 * Discord Reaction 发送模块（Phase 7）。
 *
 * 职责：
 * - 接收已成功发送的 Discord Message
 * - 对消息依次添加 Reaction（顺序执行，不并发）
 * - 单个 Reaction 失败不影响后续
 *
 * 不依赖任何具体 Feature。
 * 不负责随机选择 Emoji、不负责获取 Emoji。
 */

/**
 * 为 Discord 消息依次添加 Reaction。
 *
 * 顺序执行，不并发。任何单个 Reaction 失败不会影响后续，
 * 也不会导致函数抛出异常。
 *
 * @param {import("discord.js").Message} message - 已成功发送的 Discord Message
 * @param {Array<{id: string, name: string}>} emojis - 待添加的 Emoji 列表
 * @param {object} [logger] - Logger 实例（可选），用于记录单个失败
 * @returns {Promise<{successCount: number, failCount: number, failures: Array<{emojiId: string, emojiName: string, error: string}>}>}
 */
export async function addReactions(message, emojis, logger) {
  let successCount = 0;
  let failCount = 0;
  const failures = [];

  if (!Array.isArray(emojis) || emojis.length === 0) {
    return { successCount, failCount, failures };
  }

  for (const emoji of emojis) {
    try {
      // discord.js v14: message.react() 接受 EmojiIdentifierResolvable
      // ApplicationEmoji 对象可直接传入，也可传入 emoji.id
      await message.react(emoji.id ?? emoji);
      successCount++;
    } catch (err) {
      failCount++;
      const failure = {
        emojiId: emoji.id ?? String(emoji),
        emojiName: emoji.name ?? "unknown",
        error: err.message ?? String(err),
      };
      failures.push(failure);
      if (logger) {
        logger.warn("[ReactionSender] 单个 Reaction 失败（继续后续）", failure);
      }
    }
  }

  return { successCount, failCount, failures };
}

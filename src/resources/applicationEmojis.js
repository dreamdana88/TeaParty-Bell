/**
 * Application Emoji 资源层（Phase 7）。
 *
 * 职责：
 * - 获取小G宝自己的 Discord Application Emoji
 * - 缓存结果，避免每次 Reaction 都重新请求
 * - 不负责随机选择、不负责添加 Reaction、不依赖任何 Feature
 *
 * 缓存策略：
 * - 首次 fetchEmojis() 时从 Discord API 获取并缓存
 * - 后续调用返回缓存
 * - clearCache() 强制下次重新获取
 * - Bot 重启后自动重新获取
 */

/**
 * 创建 Application Emoji Provider。
 *
 * @param {import("discord.js").Client} client - 已就绪的 Discord Client
 * @param {object} [logger] - Logger 实例（可选），用于记录 fetch 失败
 * @returns {{ fetchEmojis: Function, getCached: Function, clearCache: Function }}
 */
export function createApplicationEmojiProvider(client, logger) {
  let cache = null;

  /**
   * 获取 Application Emoji 列表。
   *
   * 首次调用从 Discord API 获取并缓存，后续调用返回缓存。
   *
   * @returns {Promise<import("discord.js").ApplicationEmoji[]|null>}
   *   成功返回 Emoji 数组，获取失败返回 null，空集合返回 []
   */
  async function fetchEmojis() {
    if (cache !== null) {
      return cache;
    }

    try {
      const collection = await client.application.emojis.fetch();
      const emojis = [...collection.values()];
      cache = emojis;
      return cache;
    } catch (err) {
      // 获取失败不缓存，下次调用重新尝试
      if (logger) {
        logger.error("[ApplicationEmojiProvider] 获取 Application Emoji 失败", {
          error: err.message ?? String(err),
        });
      }
      return null;
    }
  }

  /**
   * 返回当前缓存的 Emoji（不发起网络请求）。
   *
   * @returns {import("discord.js").ApplicationEmoji[]|null}
   *   未获取过返回 null，已获取返回 Emoji 数组
   */
  function getCached() {
    return cache;
  }

  /**
   * 清除缓存，下次 fetchEmojis() 将重新从 Discord API 获取。
   */
  function clearCache() {
    cache = null;
  }

  return { fetchEmojis, getCached, clearCache };
}

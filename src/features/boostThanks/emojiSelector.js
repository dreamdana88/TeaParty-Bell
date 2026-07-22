/**
 * Emoji 随机不重复选择器（Phase 7）。
 *
 * 纯函数，不依赖任何外部状态或 Discord API。
 *
 * 职责：
 * - 从 Emoji 数组中随机不重复选择指定数量
 * - 不负责获取 Emoji、不负责添加 Reaction
 */

/**
 * 从数组中随机不重复选择指定数量元素。
 *
 * 使用部分 Fisher-Yates 洗牌算法（仅洗牌前 k 个位置）。
 * 不修改原数组。
 *
 * @param {any[]} emojis - Emoji 池（或任意元素数组）
 * @param {number} count - 需要选择的数量
 * @param {Function} [randomFn] - 可注入的随机函数，返回 [0,1)，默认 Math.random
 * @returns {any[]} 选中元素的新数组，长度 ≤ count
 */
export function selectEmojis(emojis, count, randomFn = Math.random) {
  if (!Array.isArray(emojis) || emojis.length === 0) {
    return [];
  }

  const n = emojis.length;
  const k = Math.min(count, n);

  if (k <= 0) {
    return [];
  }

  // 浅拷贝后对前 k 个位置执行 Fisher-Yates
  const result = [...emojis];

  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(randomFn() * (n - i));
    if (i !== j) {
      const tmp = result[i];
      result[i] = result[j];
      result[j] = tmp;
    }
  }

  return result.slice(0, k);
}

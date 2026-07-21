/**
 * 连续助力聚合器（Phase 3）。
 *
 * 支持同一成员短时间内连续投放多个 Boost 时聚合为一个结果。
 *
 * 聚合键：guildId + userId（以 userId 为身份主键，不使用 username/displayName）。
 *
 * 聚合窗口：可配置，默认 15000ms。
 */

/**
 * 创建聚合器实例。
 *
 * @param {{ boostAggregationWindowMs: number }} config
 * @returns {{ accept: Function, destroy: Function }}
 */
export function createAggregator(config) {
  const windowMs = config.boostAggregationWindowMs;

  /** @type {Map<string, { boostEvent: object, timer: NodeJS.Timeout }>} */
  const pending = new Map();

  /** 聚合完成回调（由 setupBoostObserver 注入） */
  let onComplete = null;

  /**
   * 生成聚合键。
   */
  function _key(guildId, userId) {
    return `${guildId}:${userId}`;
  }

  /**
   * 接受一个 BoostEvent 并尝试聚合。
   *
   * @param {object} boostEvent - normalizer 输出的 BoostEvent
   */
  function accept(boostEvent) {
    const key = _key(boostEvent.guildId, boostEvent.userId);
    const existing = pending.get(key);

    if (!existing) {
      // 新聚合：启动等待窗口
      const timer = setTimeout(() => {
        pending.delete(key);
        if (onComplete) {
          onComplete(existing?.boostEvent || boostEvent);
        }
      }, windowMs);

      pending.set(key, { boostEvent, timer });
    } else {
      // 已存在：累加计数、合并 eventIds、更新时间和 boostCount、重置窗口
      clearTimeout(existing.timer);

      const merged = {
        ...existing.boostEvent,
        boostCount: existing.boostEvent.boostCount + 1,
        eventIds: [...existing.boostEvent.eventIds, boostEvent.eventId],
        timestamp: boostEvent.timestamp, // 使用最新事件的时间
      };

      const timer = setTimeout(() => {
        pending.delete(key);
        if (onComplete) {
          onComplete(merged);
        }
      }, windowMs);

      pending.set(key, { boostEvent: merged, timer });
    }
  }

  /**
   * 设置聚合完成回调。
   * @param {(event: object) => void} callback
   */
  function onAggregate(callback) {
    onComplete = callback;
  }

  /**
   * 销毁聚合器：清除所有待处理计时器，清理内存。
   */
  function destroy() {
    for (const [, entry] of pending) {
      clearTimeout(entry.timer);
    }
    pending.clear();
    onComplete = null;
  }

  return { accept, onAggregate, destroy };
}

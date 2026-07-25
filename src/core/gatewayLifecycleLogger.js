/**
 * Gateway Lifecycle Logger（Gateway 生命周期集中日志）。
 *
 * 职责：
 * - 监听 discord.js Client 的 shard 生命周期事件
 * - 安全记录日志字段（不泄露 Token 等敏感信息）
 * - 集中管理监听器，便于清理
 *
 * 监听事件：
 * - shardReady
 * - shardDisconnect
 * - shardReconnecting
 * - shardResume
 * - shardError
 * - invalidated
 *
 * 不依赖：
 * - Boost Feature
 * - AI
 * - Storage
 * - Alerts
 */

/**
 * 集中注册 Gateway 生命周期监听器。
 *
 * @param {{ client: import("discord.js").Client, logger?: object }} options
 * @returns {{ destroy: Function }}
 */
export function setupGatewayLifecycleLogger(options) {
  const { client, logger } = options;

  /**
   * 安全提取 Error 对象字段。
   * 避免打印包含敏感请求头的完整 Error 对象。
   */
  function _safeError(err) {
    if (!err) return null;
    if (err instanceof Error) {
      return {
        name: err.name,
        message: err.message,
      };
    }
    return { message: String(err) };
  }

  /**
   * 安全读取 client.ws.ping。
   * -1、NaN、Infinity、undefined 等均返回 null。
   */
  function _safePing() {
    try {
      const p = client.ws?.ping;
      if (typeof p !== "number" || !Number.isFinite(p) || p < 0) return null;
      return p;
    } catch {
      return null;
    }
  }

  /**
   * 安全读取 client.ws.status。
   */
  function _safeWsStatus() {
    try {
      return String(client.ws?.status ?? "unavailable");
    } catch {
      return "unavailable";
    }
  }

  // 通用日志字段工厂
  function _baseFields(shardId) {
    return {
      shardId: shardId ?? null,
      wsStatus: _safeWsStatus(),
      ping: _safePing(),
      timestamp: Date.now(),
    };
  }

  // ---- 事件处理器 ----

  function onShardReady(shardId, unavailableGuilds) {
    if (logger) {
      logger.info("[GatewayLifecycle] shardReady", {
        ..._baseFields(shardId),
        unavailableGuilds: unavailableGuilds?.size ?? 0,
      });
    }
  }

  function onShardDisconnect(closeEvent, shardId) {
    if (logger) {
      logger.warn("[GatewayLifecycle] shardDisconnect", {
        ..._baseFields(shardId),
        closeCode: closeEvent?.code ?? null,
        closeReason: closeEvent?.reason ?? null,
        wasClean: closeEvent?.wasClean ?? null,
      });
    }
  }

  function onShardReconnecting(shardId) {
    if (logger) {
      logger.warn("[GatewayLifecycle] shardReconnecting", {
        ..._baseFields(shardId),
      });
    }
  }

  function onShardResume(shardId, replayedEvents) {
    if (logger) {
      logger.info("[GatewayLifecycle] shardResume", {
        ..._baseFields(shardId),
        replayedEvents: replayedEvents ?? 0,
      });
    }
  }

  function onShardError(error, shardId) {
    if (logger) {
      logger.error("[GatewayLifecycle] shardError", {
        ..._baseFields(shardId),
        ..._safeError(error),
      });
    }
  }

  function onInvalidated() {
    if (logger) {
      logger.error("[GatewayLifecycle] invalidated（session 已失效）", {
        wsStatus: _safeWsStatus(),
        ping: _safePing(),
        timestamp: Date.now(),
      });
    }
  }

  // ---- 注册监听器 ----

  client.on("shardReady", onShardReady);
  client.on("shardDisconnect", onShardDisconnect);
  client.on("shardReconnecting", onShardReconnecting);
  client.on("shardResume", onShardResume);
  client.on("shardError", onShardError);
  client.on("invalidated", onInvalidated);

  if (logger) {
    logger.info("[GatewayLifecycle] 生命周期监听器已注册");
  }

  // ---- 清理 ----

  return {
    destroy() {
      client.off("shardReady", onShardReady);
      client.off("shardDisconnect", onShardDisconnect);
      client.off("shardReconnecting", onShardReconnecting);
      client.off("shardResume", onShardResume);
      client.off("shardError", onShardError);
      client.off("invalidated", onInvalidated);
      if (logger) {
        logger.info("[GatewayLifecycle] 生命周期监听器已移除");
      }
    },
  };
}

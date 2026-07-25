/**
 * Gateway Health Monitor（Gateway 健康判断与受控退出）。
 *
 * 职责：
 * - 定期检查 Gateway 健康状态（isReady + ws.status + ws.ping）
 * - 启动宽限期内不触发退出
 * - 持续异常达到阈值后创建故障告警并调用 exitFn(1)
 * - 阈值内恢复：清零异常计时，不发送 Telegram recovery
 * - 正常健康摘要：每小时最多一次
 * - 提供 start() / stop() 生命周期
 *
 * 健康判断规则：
 * - client.isReady() === true
 * - client.ws.status === 0（Ready）
 * - ws.ping 仅用于日志诊断，不单独触发退出
 *
 * 不依赖：
 * - Boost Feature
 * - AI
 * - Storage
 */

/**
 * Gateway 健康状态常量。
 */
export const GatewayHealth = {
  HEALTHY: "healthy",
  GRACE_PERIOD: "grace_period",
  UNHEALTHY: "unhealthy",
  FATAL: "fatal",
};

/**
 * discord.js WebSocketManager status 常量。
 * Status.Ready = 0
 */
const WS_STATUS_READY = 0;

// ---- 默认参数 ----

const DEFAULT_CHECK_INTERVAL_MS = 60_000;
const DEFAULT_STARTUP_GRACE_MS = 5 * 60_000;
const DEFAULT_UNHEALTHY_THRESHOLD_MS = 5 * 60_000;
const DEFAULT_HEALTHY_SUMMARY_INTERVAL_MS = 60 * 60_000;

/**
 * 创建 Gateway Health Monitor。
 *
 * @param {object} options
 * @param {import("discord.js").Client} options.client - Discord Client
 * @param {Function} options.notifyFailure - (type, message, details) => Promise<void>
 * @param {Function} options.notifyRecovery - (type, message) => Promise<void>
 * @param {Function} [options.exitFn] - 退出函数（测试注入），默认 process.exit
 * @param {object} [options.logger] - Logger 实例
 * @param {number} [options.checkIntervalMs] - 检查间隔（默认 60s）
 * @param {number} [options.startupGraceMs] - 启动宽限期（默认 5min）
 * @param {number} [options.unhealthyThresholdMs] - 连续异常阈值（默认 5min）
 * @param {number} [options.healthySummaryIntervalMs] - 正常摘要间隔（默认 1h）
 * @returns {{ start: Function, stop: Function, onReady: Function, getStatus: Function }}
 */
export function createGatewayHealthMonitor(options) {
  const {
    client,
    notifyFailure,
    notifyRecovery,
    exitFn = process.exit,
    logger,
    checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS,
    startupGraceMs = DEFAULT_STARTUP_GRACE_MS,
    unhealthyThresholdMs = DEFAULT_UNHEALTHY_THRESHOLD_MS,
    healthySummaryIntervalMs = DEFAULT_HEALTHY_SUMMARY_INTERVAL_MS,
    alertPersistenceFailureExitCode = 78,
  } = options;

  // ========================
  // 状态
  // ========================

  let _started = false;
  let _stopped = false;
  let _ready = false;
  let _startupAt = null;
  let _readyAt = null;
  let _unhealthySince = null;
  let _lastHealthySummaryAt = null;
  let _hasCreatedFailureAlert = false;
  let _hasExited = false;
  let _intervalId = null;

  // ========================
  // 内部工具
  // ========================

  function _safePing() {
    try {
      const p = client.ws?.ping;
      if (typeof p !== "number" || !Number.isFinite(p) || p < 0) return null;
      return p;
    } catch {
      return null;
    }
  }

  function _safeWsStatus() {
    try {
      const s = client.ws?.status;
      return typeof s === "number" ? s : null;
    } catch {
      return null;
    }
  }

  function _isReady() {
    try {
      return client.isReady() === true;
    } catch {
      return false;
    }
  }

  function _isHealthy() {
    const ready = _isReady();
    const wsStatus = _safeWsStatus();
    // 健康条件：isReady + ws.status === Ready
    return ready && wsStatus === WS_STATUS_READY;
  }

  function _elapsedSince(time) {
    if (!time) return 0;
    return Date.now() - time;
  }

  function _uptime() {
    if (!_readyAt) return 0;
    return Date.now() - _readyAt;
  }

  // ========================
  // 健康检查
  // ========================

  function _check() {
    if (_stopped) return;

    const now = Date.now();
    const ready = _isReady();
    const wsStatus = _safeWsStatus();
    const ping = _safePing();
    const healthy = _isHealthy();

    // ---- 尚未 Ready ----
    if (!_ready) {
      const graceElapsed = _elapsedSince(_startupAt);

      if (graceElapsed >= startupGraceMs) {
        // 宽限期耗尽仍未 Ready
        if (!_hasCreatedFailureAlert) {
          _hasCreatedFailureAlert = true;
          if (logger) {
            logger.error("[GatewayHealth] 启动宽限期耗尽，Gateway 仍未 Ready", {
              graceMs: startupGraceMs,
              graceElapsedMs: graceElapsed,
              isReady: ready,
              wsStatus,
              ping,
            });
          }

          // fire-and-forget 告警；持久化成功 → exit 1，失败 → exit 78
          Promise.resolve()
            .then(() =>
              notifyFailure("gateway_startup_timeout", "Gateway 启动超时：宽限期内未能 Ready", {
                wsStatus: String(wsStatus),
                ping,
                details: { graceMs: startupGraceMs, graceElapsedMs: graceElapsed },
              })
            )
            .then(() => {
              if (!_hasExited) { _hasExited = true; exitFn(1); }
            })
            .catch((err) => {
              if (logger) logger.error("[GatewayHealth] 启动超时告警持久化失败，放弃重启循环", { error: err.message });
              if (!_hasExited) { _hasExited = true; exitFn(alertPersistenceFailureExitCode); }
            });
        }
      } else {
        // 宽限期内
        if (logger) {
          logger.info("[GatewayHealth] 启动宽限期内，Gateway 尚未 Ready", {
            isReady: ready,
            wsStatus,
            ping,
            graceElapsedMs: graceElapsed,
            graceMs: startupGraceMs,
          });
        }
      }
      return;
    }

    // ---- 已 Ready ----
    if (healthy) {
      // 恢复正常
      if (_unhealthySince) {
        const duration = _elapsedSince(_unhealthySince);
        _unhealthySince = null;
        if (logger) {
          logger.info("[GatewayHealth] Gateway 已恢复健康", {
            wasUnhealthyMs: duration,
            wsStatus,
            ping,
          });
        }

        // 只有此前创建了 failure alert 才发送 recovery
        if (_hasCreatedFailureAlert) {
          _hasCreatedFailureAlert = false;
          Promise.resolve()
            .then(() =>
              notifyRecovery("gateway_unhealthy", `Gateway 已恢复健康，持续时间 ${Math.round(duration / 1000)}s`)
            )
            .catch(() => {});
        }
      }

      // 正常健康摘要（限频）
      const shouldLogSummary =
        !_lastHealthySummaryAt ||
        _elapsedSince(_lastHealthySummaryAt) >= healthySummaryIntervalMs;

      if (shouldLogSummary) {
        _lastHealthySummaryAt = now;
        if (logger) {
          logger.info("[GatewayHealth] healthy", {
            ready: true,
            wsStatus: "Ready",
            ping: ping !== null ? `${ping}ms` : "unavailable",
            uptime: `${Math.round(_uptime() / 1000)}s`,
            guildCount: client.guilds?.cache?.size ?? "?",
          });
        }
      }
    } else {
      // 不健康
      if (!_unhealthySince) {
        // 首次检测到不健康
        _unhealthySince = now;
        if (logger) {
          logger.warn("[GatewayHealth] Gateway 不健康", {
            isReady: ready,
            wsStatus,
            ping,
            unhealthySince: _unhealthySince,
          });
        }
      } else {
        // 持续不健康
        const duration = _elapsedSince(_unhealthySince);

        if (duration >= unhealthyThresholdMs) {
          // 达到阈值
          if (!_hasCreatedFailureAlert) {
            _hasCreatedFailureAlert = true;
            if (logger) {
              logger.error("[GatewayHealth] Gateway 持续不健康达到阈值，准备退出", {
                isReady: ready,
                wsStatus,
                ping,
                unhealthySince: _unhealthySince,
                durationMs: duration,
                thresholdMs: unhealthyThresholdMs,
              });
            }

            Promise.resolve()
              .then(() =>
                notifyFailure("gateway_unhealthy", `Gateway 持续不健康 ${Math.round(duration / 1000)}s，达到阈值 ${Math.round(unhealthyThresholdMs / 1000)}s`, {
                  wsStatus: String(wsStatus),
                  ping,
                  details: { durationMs: duration, thresholdMs: unhealthyThresholdMs },
                })
              )
              .then(() => {
                if (!_hasExited) { _hasExited = true; exitFn(1); }
              })
              .catch((err) => {
                if (logger) logger.error("[GatewayHealth] 不健康告警持久化失败，放弃重启循环", { error: err.message });
                if (!_hasExited) { _hasExited = true; exitFn(alertPersistenceFailureExitCode); }
              });
          }
        } else {
          // 未达阈值，仅记录状态
          if (logger) {
            logger.warn("[GatewayHealth] Gateway 持续不健康（未达阈值）", {
              isReady: ready,
              wsStatus,
              ping,
              unhealthySince: _unhealthySince,
              durationMs: duration,
              thresholdMs: unhealthyThresholdMs,
            });
          }
        }
      }
    }
  }

  // ========================
  // 公开 API
  // ========================

  /**
   * 启动健康监控。
   * 多次调用不创建重复 interval。
   */
  function start() {
    if (_started) {
      if (logger) {
        logger.warn("[GatewayHealth] Monitor 已启动，忽略重复 start()");
      }
      return;
    }
    _started = true;
    _stopped = false;
    _startupAt = Date.now();

    // 立即执行第一次检查
    _check();

    _intervalId = setInterval(() => {
      _check();
    }, checkIntervalMs);

    if (logger) {
      logger.info("[GatewayHealth] Monitor 已启动", {
        checkIntervalMs,
        startupGraceMs,
        unhealthyThresholdMs,
        healthySummaryIntervalMs,
      });
    }
  }

  /**
   * 停止健康监控。
   * 清除 interval，不再执行检查。
   */
  function stop() {
    if (_stopped) return;
    _stopped = true;
    if (_intervalId !== null) {
      clearInterval(_intervalId);
      _intervalId = null;
    }
    // 重置状态
    _unhealthySince = null;
    if (logger) {
      logger.info("[GatewayHealth] Monitor 已停止");
    }
  }

  /**
   * 标记 Gateway 首次 Ready。
   * 结束启动宽限期，进入稳定监控状态。
   *
   * 由调用方在 ClientReady 事件中调用。
   * 多次调用幂等，只记录首次。
   */
  function onReady() {
    if (!_ready) {
      _ready = true;
      _readyAt = Date.now();
      if (logger) {
        logger.info("[GatewayHealth] Gateway 首次 Ready，宽限期结束", {
          graceElapsedMs: _elapsedSince(_startupAt),
        });
      }
    }
  }

  /**
   * 获取当前监控器状态（供测试和诊断）。
   */
  function getStatus() {
    return {
      started: _started,
      stopped: _stopped,
      ready: _ready,
      healthy: _isHealthy(),
      isReady: _isReady(),
      wsStatus: _safeWsStatus(),
      ping: _safePing(),
      unhealthySince: _unhealthySince,
      unhealthyDurationMs: _elapsedSince(_unhealthySince),
      hasCreatedFailureAlert: _hasCreatedFailureAlert,
      hasExited: _hasExited,
    };
  }

  return { start, stop, onReady, getStatus };
}

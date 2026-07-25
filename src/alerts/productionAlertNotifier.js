/**
 * Production Alert Notifier（TeaParty-Bell 告警通知抽象）。
 *
 * 职责：
 * - 提供 notifyFailure / notifyRecovery / notifyWarning 接口
 * - 防重复告警：同一轮故障只产生一次 failure alert
 * - 恢复告警：只有已产生 failure alert 的 incident 才配套 recovery alert
 * - 生成稳定 alertId（基于告警类型），方便跨重启识别
 * - 通过 Alert Outbox 持久化告警
 *
 * 不依赖：
 * - Discord
 * - AI
 * - Boost Feature
 * - Hermes（完全解耦）
 */

/**
 * 创建 Production Alert Notifier。
 *
 * @param {{ outbox: object, logger?: object }} options
 * @returns {object} Notifier 实例
 */
export function createProductionAlertNotifier(options) {
  const { outbox, logger } = options;

  /**
   * 跟踪已打开但尚未解决的事故 ID。
   * key: alertType, value: { alertId, startedAt }
   *
   * 进程重启后从 outbox 重新加载。
   */
  const _openIncidents = new Map();

  /** @type {object[]} 从 outbox 加载的告警缓存 */
  let _loadedAlerts = [];

  // ========================
  // 内部
  // ========================

  /**
   * 是否为已打开（未解决）的 incident。
   */
  function _isOpen(alertType) {
    return _openIncidents.has(alertType);
  }

  /**
   * 记录一个新打开的 incident。
   */
  function _markOpen(alertType, alertId) {
    _openIncidents.set(alertType, { alertId, startedAt: Date.now() });
  }

  /**
   * 关闭一个 incident（恢复后）。
   */
  function _markClosed(alertType) {
    _openIncidents.delete(alertType);
  }

  /**
   * 构建标准告警结构。
   */
  function _buildAlert(type, severity, message, details = {}) {
    const now = Date.now();
    // alertId 使用 type 作为稳定标识，跨重启同一类故障可识别
    return {
      id: type,
      service: "TeaParty-Bell",
      type,
      severity,
      status: "pending",
      startedAt: now,
      occurredAt: now,
      durationMs: 0,
      guildId: details.guildId ?? null,
      wsStatus: details.wsStatus ?? null,
      ping: details.ping ?? null,
      message,
      details: details.details ?? {},
    };
  }

  // ========================
  // 公开 API
  // ========================

  /**
   * 从 outbox 加载已有告警，重建内存中的 incident 状态。
   *
   * 必须在 bot 启动时调用一次。
   *
   * @returns {Promise<void>}
   */
  async function initialize() {
    _loadedAlerts = outbox.loadAllAlerts();
    _openIncidents.clear();

    for (const alert of _loadedAlerts) {
      if (alert.status === "pending" || alert.status === "delivery_failed") {
        _markOpen(alert.type, alert.id);
        if (logger) {
          logger.warn("[AlertNotifier] 发现未解决的历史告警", {
            alertId: alert.id,
            type: alert.type,
            severity: alert.severity,
            startedAt: alert.startedAt,
          });
        }
      }
    }
  }

  /**
   * 通知致命故障。
   *
   * 同一类型的故障只产生一次告警。
   * 如果同一类型已有未解决的 incident，只更新 duration 不创建新告警。
   *
   * @param {string} type - 告警类型（如 "gateway_unhealthy"）
   * @param {string} message - 人类可读消息
   * @param {object} [details] - 额外诊断信息
   * @returns {Promise<object|null>} 新创建的告警对象，或 null（已存在同类告警）
   */
  async function notifyFailure(type, message, details = {}) {
    if (_isOpen(type)) {
      if (logger) {
        logger.info("[AlertNotifier] 同类告警已存在，跳过重复通知", { type });
      }
      // 更新 duration
      const existing = _openIncidents.get(type);
      try {
        await outbox.updateAlert(existing.alertId, {
          occurredAt: Date.now(),
          durationMs: Date.now() - existing.startedAt,
          ping: details.ping ?? null,
          wsStatus: details.wsStatus ?? null,
        });
      } catch (err) {
        if (logger) {
          logger.error("[AlertNotifier] 更新告警 duration 失败", {
            alertId: existing.alertId,
            error: err.message,
          });
        }
      }
      return null;
    }

    const alert = _buildAlert(type, "fatal", message, details);

    try {
      await outbox.writeAlert(alert);
      _markOpen(type, alert.id);
      if (logger) {
        logger.error("[AlertNotifier] 故障告警已创建", {
          alertId: alert.id,
          type,
          message,
        });
      }
      return alert;
    } catch (err) {
      if (logger) {
        logger.error("[AlertNotifier] 故障告警写入 outbox 失败", {
          type,
          error: err.message,
        });
      }
      return null;
    }
  }

  /**
   * 通知恢复。
   *
   * 只有此前已产生 failure alert 的 incident 才创建 recovery alert。
   * 短暂断线未产生 failure alert 时，不发送 recovery。
   *
   * @param {string} type - 对应的故障类型
   * @param {string} message - 恢复消息
   * @returns {Promise<object|null>} 恢复告警，或 null
   */
  async function notifyRecovery(type, message) {
    if (!_isOpen(type)) {
      if (logger) {
        logger.info("[AlertNotifier] 无对应未解决故障，跳过 recovery", { type });
      }
      return null;
    }

    const existing = _openIncidents.get(type);
    const recoveryAlert = {
      id: `${type}_recovery`,
      service: "TeaParty-Bell",
      type: "gateway_recovered",
      severity: "fatal",
      status: "resolved",
      startedAt: Date.now(),
      occurredAt: Date.now(),
      durationMs: Date.now() - existing.startedAt,
      guildId: null,
      wsStatus: null,
      ping: null,
      message,
      details: { originalType: type, originalAlertId: existing.alertId },
    };

    try {
      await outbox.writeAlert(recoveryAlert);
      await outbox.markResolved(existing.alertId);
      _markClosed(type);

      if (logger) {
        logger.info("[AlertNotifier] 恢复告警已创建", {
          alertId: recoveryAlert.id,
          originalType: type,
          originalAlertId: existing.alertId,
        });
      }
      return recoveryAlert;
    } catch (err) {
      if (logger) {
        logger.error("[AlertNotifier] 恢复告警写入 outbox 失败", {
          type,
          error: err.message,
        });
      }
      return null;
    }
  }

  /**
   * 通知非致命警告。
   *
   * 重复警告不防重复（每次都可以创建），但使用稳定 alertId，
   * 因此同类型警告会覆盖之前的 pending 文件。
   *
   * @param {string} type - 告警类型
   * @param {string} message - 人类可读消息
   * @param {object} [details] - 额外信息
   * @returns {Promise<object|null>}
   */
  async function notifyWarning(type, message, details = {}) {
    // 警告不进入 _openIncidents 防重复，每次独立记录
    const alert = _buildAlert(type, "warning", message, details);

    try {
      await outbox.writeAlert(alert);
      if (logger) {
        logger.warn("[AlertNotifier] 警告已创建", {
          alertId: alert.id,
          type,
          message,
        });
      }
      return alert;
    } catch (err) {
      if (logger) {
        logger.error("[AlertNotifier] 警告写入 outbox 失败", {
          type,
          error: err.message,
        });
      }
      return null;
    }
  }

  /**
   * 发送 service_ready_after_restart 通知。
   *
   * 仅在进程重启后没有任何未解决 fatal 告警时发送。
   * 如果有未解决 fatal 告警，改为发送 gateway_recovered。
   *
   * @returns {Promise<void>}
   */
  async function notifyReadyAfterRestart() {
    const hasOpenFatal = [..._openIncidents.keys()].some(
      (type) => type !== "application_emoji_unavailable" // 非致命降级不算
    );

    if (hasOpenFatal) {
      // 之前的故障在重启后解决了 → 发送恢复
      for (const [type, incident] of _openIncidents) {
        await notifyRecovery(type, "服务重启后 Gateway 已恢复 Ready 且 Preflight 通过");
      }
    } else {
      // 干净启动
      const alert = _buildAlert(
        "service_ready_after_restart",
        "fatal", // 使用 fatal severity 以确保 Hermes 关注
        "TeaParty-Bell 服务已正常启动，Preflight 通过",
        {}
      );
      alert.status = "resolved"; // 直接标记为已解决——仅用于通知
      alert.id = "service_ready_after_restart";

      try {
        await outbox.writeAlert(alert);
        if (logger) {
          logger.info("[AlertNotifier] 服务就绪通知已创建", {
            alertId: alert.id,
          });
        }
      } catch (err) {
        if (logger) {
          logger.error("[AlertNotifier] 服务就绪通知写入失败", {
            error: err.message,
          });
        }
      }
    }
  }

  /**
   * 查询是否有未解决的 fatal 告警。
   */
  function hasOpenFatalIncident() {
    return _openIncidents.size > 0;
  }

  /**
   * 获取当前所有打开 incident 的列表。
   */
  function getOpenIncidents() {
    return new Map(_openIncidents);
  }

  return {
    initialize,
    notifyFailure,
    notifyRecovery,
    notifyWarning,
    notifyReadyAfterRestart,
    hasOpenFatalIncident,
    getOpenIncidents,
  };
}

/**
 * 生成告警 alertId 的辅助函数。
 * 基于 type + 可选唯一后缀生成稳定 ID。
 *
 * 用于调用方在构造告警前预知 alertId。
 */
export function makeAlertId(type, suffix) {
  const base = type.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (suffix) {
    const safeSuffix = String(suffix).replace(/[^a-zA-Z0-9_-]/g, "_");
    return `${base}_${safeSuffix}`;
  }
  return base;
}

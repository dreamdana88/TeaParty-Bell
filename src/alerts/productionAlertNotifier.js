/**
 * Production Alert Notifier（TeaParty-Bell 告警通知抽象）。
 *
 * 拆分 deliveryStatus（pending|delivered|delivery_failed）
 * 和 incidentStatus（open|resolved），互不干扰。
 *
 * 防重复：
 * - 同一 dedupeKey 的 open incident 只创建一次 failure
 * - 持续异常 → 只更新现有文件的 duration
 * - 新轮次（上一轮已 resolved）→ 新文件
 * - warning 不进入 _openIncidents，不触发 hasOpenFatalIncident
 *
 * 不依赖：Discord / AI / Boost / Hermes。
 */

import { generateAlertId } from "./alertOutbox.js";

export function createProductionAlertNotifier(options) {
  const { outbox, logger } = options;

  /**
   * _openIncidents: Map<dedupeKey, { alertId, startedAt, incidentKey }>
   * 只收录 incidentStatus=open 的 fatal failure incident。
   * warning / recovery / ready 不进入此 Map。
   */
  const _openIncidents = new Map();

  let _loadedAlerts = [];

  // ========================
  // 内部
  // ========================

  function _isOpen(dedupeKey) {
    return _openIncidents.has(dedupeKey);
  }

  function _markOpen(dedupeKey, alertId, incidentKey, startedAt) {
    _openIncidents.set(dedupeKey, { alertId, startedAt, incidentKey });
  }

  function _markClosed(dedupeKey) {
    _openIncidents.delete(dedupeKey);
  }

  function _buildBase(incidentKey, event, severity, dedupeKey, message, overrides = {}) {
    const now = Date.now();
    return {
      id: generateAlertId(incidentKey),
      incidentKey,
      dedupeKey: dedupeKey ?? incidentKey,
      event,
      service: "TeaParty-Bell",
      type: incidentKey,
      severity,
      deliveryStatus: "pending",
      incidentStatus: event === "failure" ? "open" : "resolved",
      startedAt: overrides.startedAt ?? now,
      occurredAt: now,
      durationMs: overrides.durationMs ?? 0,
      guildId: overrides.guildId ?? null,
      wsStatus: overrides.wsStatus ?? null,
      ping: overrides.ping ?? null,
      message,
      details: overrides.details ?? {},
    };
  }

  // ========================
  // 公开 API
  // ========================

  /**
   * 从 outbox 加载已有告警，重建 _openIncidents。
   * 只有 event=failure + severity=fatal + incidentStatus=open 才进入。
   * delivered + open 的 failure 跨重启后仍保留为 open。
   */
  async function initialize() {
    _loadedAlerts = outbox.loadAllAlerts();
    _openIncidents.clear();

    for (const alert of _loadedAlerts) {
      if (
        alert.event === "failure" &&
        alert.severity === "fatal" &&
        alert.incidentStatus === "open"
      ) {
        _markOpen(alert.dedupeKey, alert.id, alert.incidentKey, alert.startedAt);
        if (logger) {
          logger.warn("[AlertNotifier] 发现未解决的历史 fatal incident", {
            alertId: alert.id,
            incidentKey: alert.incidentKey,
            dedupeKey: alert.dedupeKey,
            deliveryStatus: alert.deliveryStatus,
            startedAt: alert.startedAt,
          });
        }
      }
    }
  }

  /**
   * 通知致命故障。
   *
   * 同 dedupeKey + incidentStatus=open → 只更新 duration。
   * 上一轮已 resolved → 创建新文件（不同 id）。
   * 写入失败 → 向上抛错，不静默返回 null。
   */
  async function notifyFailure(incidentKey, message, details = {}) {
    const dedupeKey = incidentKey;

    if (_isOpen(dedupeKey)) {
      if (logger) {
        logger.info("[AlertNotifier] 同类故障已 open，跳过重复通知", { incidentKey, dedupeKey });
      }
      const existing = _openIncidents.get(dedupeKey);
      try {
        await outbox.updateAlert(existing.alertId, {
          occurredAt: Date.now(),
          durationMs: Date.now() - existing.startedAt,
          ping: details.ping ?? null,
          wsStatus: details.wsStatus ?? null,
        });
      } catch (err) {
        if (logger) {
          logger.error("[AlertNotifier] 更新 duration 失败", {
            alertId: existing.alertId,
            error: err.message,
          });
        }
        // 更新失败不删除内存状态，不影响后续通知
      }
      return null; // 未创建新告警
    }

    const alert = _buildBase(incidentKey, "failure", "fatal", dedupeKey, message, details);

    // 写入失败 → 向上抛，让调用方决定策略
    await outbox.writeAlert(alert);
    _markOpen(dedupeKey, alert.id, incidentKey, alert.startedAt);

    if (logger) {
      logger.error("[AlertNotifier] 故障告警已创建", {
        alertId: alert.id,
        incidentKey,
        dedupeKey,
        message,
      });
    }
    return alert;
  }

  /**
   * 通知恢复。
   *
   * 只有 _openIncidents 中有对应 dedupeKey 才创建。
   * Recovery 使用 severity="info"（不使用 fatal），
   * deliveryStatus="pending"（待 Hermes 投递），
   * incidentStatus="resolved"。
   * 同时将原 failure 的 incidentStatus 标记为 resolved。
   */
  async function notifyRecovery(incidentKey, message) {
    const dedupeKey = incidentKey;

    if (!_isOpen(dedupeKey)) {
      if (logger) {
        logger.info("[AlertNotifier] 无对应 open incident，跳过 recovery", { incidentKey });
      }
      return null;
    }

    const existing = _openIncidents.get(dedupeKey);
    const durationMs = Date.now() - existing.startedAt;

    const recoveryAlert = _buildBase(
      `${incidentKey}_recovery`, "recovery", "info", dedupeKey,
      message,
      { durationMs, details: { originalAlertId: existing.alertId } }
    );

    // Recovery 的 incidentStatus 强制为 resolved
    recoveryAlert.incidentStatus = "resolved";

    try {
      await outbox.writeAlert(recoveryAlert);
      await outbox.markResolved(existing.alertId);
      _markClosed(dedupeKey);

      if (logger) {
        logger.info("[AlertNotifier] 恢复告警已创建", {
          alertId: recoveryAlert.id,
          incidentKey,
          originalAlertId: existing.alertId,
          durationMs,
        });
      }
      return recoveryAlert;
    } catch (err) {
      if (logger) {
        logger.error("[AlertNotifier] 恢复告警写入失败", { incidentKey, error: err.message });
      }
      throw err;
    }
  }

  /**
   * 通知非致命 warning。
   *
   * 不进入 _openIncidents（不影响 hasOpenFatalIncident）。
   * 使用独立 incidentKey/dedupeKey，不覆盖历史 warning 文件。
   * 每次独立创建新文件。
   */
  async function notifyWarning(incidentKey, message, details = {}) {
    const dedupeKey = incidentKey + "_warning";
    const alert = _buildBase(incidentKey, "warning", "warning", dedupeKey, message, details);
    // warning 不视为 open incident
    alert.incidentStatus = "resolved";

    try {
      await outbox.writeAlert(alert);
      if (logger) {
        logger.warn("[AlertNotifier] 警告已创建", {
          alertId: alert.id,
          incidentKey,
          message,
        });
      }
      return alert;
    } catch (err) {
      if (logger) {
        logger.error("[AlertNotifier] 警告写入失败", { incidentKey, error: err.message });
      }
      throw err;
    }
  }

  /**
   * notifyReady：服务正常运行通知。
   *
   * 策略：
   * - 有上一轮未解决 fatal incident → 对其逐个发送 recovery
   * - 无未解决 incident → 发送独立 service_operational 通知
   *
   * 使用 severity="info"，deliveryStatus="pending"。
   */
  async function notifyReadyAfterRestart() {
    if (_openIncidents.size > 0) {
      // 存在上一轮未关闭的 incident → 发送 recovery
      for (const [dedupeKey, incident] of _openIncidents) {
        try {
          await notifyRecovery(incident.incidentKey, "服务重启后 Gateway 已恢复 Ready 且 Preflight 通过");
        } catch (err) {
          if (logger) {
            logger.error("[AlertNotifier] Ready 后发送 recovery 失败", {
              dedupeKey, error: err.message,
            });
          }
        }
      }
    } else {
      // 干净启动 → service_operational
      const alert = _buildBase(
        "service_operational", "ready", "info", "service_operational",
        "TeaParty-Bell 服务已正常启动，Preflight 通过", {}
      );
      try {
        await outbox.writeAlert(alert);
        if (logger) {
          logger.info("[AlertNotifier] service_operational 已创建", { alertId: alert.id });
        }
      } catch (err) {
        if (logger) {
          logger.error("[AlertNotifier] service_operational 写入失败", { error: err.message });
        }
        throw err;
      }
    }
  }

  function hasOpenFatalIncident() {
    return _openIncidents.size > 0;
  }

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

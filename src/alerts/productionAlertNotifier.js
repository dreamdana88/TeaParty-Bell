/**
 * Production Alert Notifier（TeaParty-Bell 告警通知抽象）。
 *
 * 拆分 deliveryStatus（pending|delivered|delivery_failed）
 * 和 incidentStatus（open|resolved），互不干扰。
 *
 * Recovery 幂等性：
 * - recoveryAlertId = `${originalAlertId}_recovery`（确定性生成）
 * - Recovery 文件已存在且匹配 → 幂等，不创建重复
 * - Recovery 文件已存在但不匹配 → fail closed
 *
 * 不依赖：Discord / AI / Boost / Hermes。
 */

import { generateAlertId } from "./alertOutbox.js";

export function createProductionAlertNotifier(options) {
  const { outbox, logger } = options;

  /** Map<dedupeKey, { alertId, startedAt, incidentKey }> */
  const _openIncidents = new Map();

  let _loadedAlerts = [];

  // ========================
  // 内部
  // ========================

  function _isOpen(dedupeKey) { return _openIncidents.has(dedupeKey); }
  function _markOpen(dedupeKey, alertId, incidentKey, startedAt) {
    _openIncidents.set(dedupeKey, { alertId, startedAt, incidentKey });
  }
  function _markClosed(dedupeKey) { _openIncidents.delete(dedupeKey); }

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
      updatedAt: now,
      recoveryAt: null,
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

  async function initialize() {
    _loadedAlerts = outbox.loadAllAlerts();
    _openIncidents.clear();

    for (const alert of _loadedAlerts) {
      if (alert.event === "failure" && alert.severity === "fatal" && alert.incidentStatus === "open") {
        _markOpen(alert.dedupeKey, alert.id, alert.incidentKey, alert.startedAt);
        if (logger) logger.warn("[AlertNotifier] 发现未解决的历史 fatal incident", {
          alertId: alert.id, incidentKey: alert.incidentKey, dedupeKey: alert.dedupeKey,
          deliveryStatus: alert.deliveryStatus,
        });
      }
    }
  }

  /**
   * notifyFailure。写入失败 → 向上抛错（不静默）。
   * 重复 incident 的 updateAlert 失败也向上抛。
   */
  async function notifyFailure(incidentKey, message, details = {}) {
    const dedupeKey = incidentKey;

    if (_isOpen(dedupeKey)) {
      if (logger) logger.info("[AlertNotifier] 同类故障已 open，更新 duration", { incidentKey });
      const existing = _openIncidents.get(dedupeKey);
      // updateAlert 失败向上抛（不再 catch 后返回 null）
      await outbox.updateAlert(existing.alertId, {
        occurredAt: Date.now(),
        durationMs: Date.now() - existing.startedAt,
        ping: details.ping ?? null,
        wsStatus: details.wsStatus ?? null,
      });
      return null;
    }

    const alert = _buildBase(incidentKey, "failure", "fatal", dedupeKey, message, details);
    await outbox.writeAlert(alert);
    _markOpen(dedupeKey, alert.id, incidentKey, alert.startedAt);
    if (logger) logger.error("[AlertNotifier] 故障告警已创建", { alertId: alert.id, incidentKey, message });
    return alert;
  }

  /**
   * notifyRecovery — 具备崩溃幂等性。
   *
   * Recovery ID = `${originalAlertId}_recovery`（确定性）。
   * 1. Recovery 文件不存在 → 创建
   * 2. Recovery 文件已存在且 originalAlertId 匹配 → 幂等（跳过写入）
   * 3. Recovery 文件已存在但 originalAlertId 不匹配 → throw OutboxError
   * 4. 最后 markResolved original
   * 5. 只有两步都完成才从 _openIncidents 删除
   */
  async function notifyRecovery(incidentKey, message) {
    const dedupeKey = incidentKey;
    if (!_isOpen(dedupeKey)) {
      if (logger) logger.info("[AlertNotifier] 无对应 open incident，跳过 recovery", { incidentKey });
      return null;
    }

    const existing = _openIncidents.get(dedupeKey);
    const originalAlertId = existing.alertId;
    const recoveryAlertId = `${originalAlertId}_recovery`;
    const durationMs = Date.now() - existing.startedAt;

    // 检查 Recovery 文件是否已存在
    let recoveryExists = false;
    try {
      // 尝试从 outbox 查询（需要已加载的告警列表）
      const all = outbox.loadAllAlerts();
      const found = outbox.findAlert(recoveryAlertId, all);
      if (found) {
        recoveryExists = true;
        // 验证 originalAlertId 匹配
        const origId = found.details?.originalAlertId;
        if (origId !== originalAlertId) {
          throw Object.assign(
            new Error(`Recovery 文件 originalAlertId 不匹配：期望 ${originalAlertId}，实际 ${origId}`),
            { name: "OutboxError", code: "schema_invalid" }
          );
        }
        if (logger) logger.info("[AlertNotifier] Recovery 文件已存在，幂等跳过", { recoveryAlertId, originalAlertId });
      }
    } catch (err) {
      if (err.name === "OutboxError") throw err;
      // 加载失败 → 传播
      throw err;
    }

    // 写入 Recovery（如不存在）
    if (!recoveryExists) {
      const recoveryAlert = {
        id: recoveryAlertId,
        incidentKey: `${incidentKey}_recovery`,
        dedupeKey: `${dedupeKey}_recovery`,
        event: "recovery",
        service: "TeaParty-Bell",
        type: "incident_recovered",
        severity: "info",
        deliveryStatus: "pending",
        incidentStatus: "resolved",
        startedAt: Date.now(),
        occurredAt: Date.now(),
        updatedAt: Date.now(),
        recoveryAt: null,
        durationMs,
        guildId: null,
        wsStatus: null,
        ping: null,
        message,
        details: { originalType: incidentKey, originalAlertId },
      };
      await outbox.writeAlert(recoveryAlert);
    }

    // 标记原 failure 为 resolved
    await outbox.markResolved(originalAlertId);

    // 两者都成功 → 从内存删除
    _markClosed(dedupeKey);

    if (logger) logger.info("[AlertNotifier] 恢复告警已创建", {
      recoveryAlertId, incidentKey, originalAlertId, durationMs,
    });
    return { recoveryAlertId, originalAlertId, incidentKey };
  }

  /**
   * notifyWarning。每次独立创建新文件（不覆盖历史）。
   */
  async function notifyWarning(incidentKey, message, details = {}) {
    const alert = _buildBase(incidentKey, "warning", "warning", incidentKey + "_warning", message, details);
    alert.incidentStatus = "resolved";
    await outbox.writeAlert(alert);
    if (logger) logger.warn("[AlertNotifier] 警告已创建", { alertId: alert.id, incidentKey, message });
    return alert;
  }

  /**
   * notifyReadyAfterRestart — 返回结构化结果。
   *
   * 有 open incident → recovery；无 → service_operational。
   * 任何持久化失败均向上传播（不吞掉，由 bot.js 决定 exit 78）。
   *
   * @param {object} [options]
   * @param {string[]|Set<string>} [options.excludeIncidentKeys]
   *   排除的 incidentKey（如 Forum Bump 由 Runtime 定向恢复）。
   *   若排除后无剩余 open incident 且原本有 open，仍写 service_operational。
   */
  async function notifyReadyAfterRestart(options = {}) {
    const result = { createdReady: false, recovered: [], failedRecoveries: [], skipped: [] };
    const exclude = new Set(
      options.excludeIncidentKeys
        ? [...options.excludeIncidentKeys]
        : [],
    );

    const eligible = [];
    for (const [dedupeKey, incident] of _openIncidents) {
      const key = incident.incidentKey;
      if (exclude.has(key) || exclude.has(dedupeKey)) {
        result.skipped.push(key);
        continue;
      }
      eligible.push({ dedupeKey, incident });
    }

    if (eligible.length > 0) {
      for (const { incident } of eligible) {
        try {
          const rec = await notifyRecovery(incident.incidentKey,
            "服务重启后 Gateway 已恢复 Ready 且 Preflight 通过");
          if (rec) result.recovered.push(rec.incidentKey);
        } catch (err) {
          result.failedRecoveries.push({ incidentKey: incident.incidentKey, error: err.message });
          if (logger) logger.error("[AlertNotifier] Ready recovery 失败", { incidentKey: incident.incidentKey, error: err.message });
        }
      }
    } else {
      // 无「可恢复」的 open incident（可能全被 exclude，或本身无 open）
      // 仍写 service_operational；被 exclude 的 Forum incident 保持 open
      const alert = _buildBase("service_operational", "ready", "info", "service_operational",
        "TeaParty-Bell 服务已正常启动，Preflight 通过", {});
      try {
        await outbox.writeAlert(alert);
        result.createdReady = true;
        if (logger) logger.info("[AlertNotifier] service_operational 已创建", { alertId: alert.id });
      } catch (err) {
        if (logger) logger.error("[AlertNotifier] service_operational 写入失败", { error: err.message });
        throw err;
      }
    }

    // 如果有 recovery 失败，不清除对应 open incident（已在 notifyRecovery 中处理）
    return result;
  }

  function hasOpenFatalIncident() { return _openIncidents.size > 0; }
  function getOpenIncidents() { return new Map(_openIncidents); }

  return { initialize, notifyFailure, notifyRecovery, notifyWarning, notifyReadyAfterRestart, hasOpenFatalIncident, getOpenIncidents };
}

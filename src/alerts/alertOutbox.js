/**
 * Alert Outbox（TeaParty-Bell 生产告警持久化信箱）。
 *
 * Alert file schema (v2):
 *   id              — unique per incident file
 *   incidentKey     — stable key for cross-restart dedup
 *   dedupeKey       — dedup within same incident round (non-empty string)
 *   event           — failure | warning | recovery | ready | integration_test
 *   deliveryStatus  — pending | delivered | delivery_failed
 *   incidentStatus  — open | resolved
 *   updatedAt       — number (positive)
 *   recoveryAt      — number|null
 *   durationMs      — non-negative finite number
 *   guildId         — string|null
 *   wsStatus        — string|null
 *   ping            — number (non-negative finite) | null
 *   details         — plain object (not array)
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";

// ---- 常量 ----

const FILE_VERSION = 2;

const VALID_EVENTS = new Set([
  "failure", "warning", "recovery", "ready", "integration_test",
]);

const VALID_DELIVERY_STATUSES = new Set([
  "pending", "delivered", "delivery_failed",
]);

const VALID_INCIDENT_STATUSES = new Set([
  "open", "resolved",
]);

const VALID_SEVERITIES = new Set(["fatal", "warning", "info"]);

const ALERT_FILE_EXT = ".json";

// ---- 错误类型 ----

export class OutboxError extends Error {
  constructor(message, code, opts = {}) {
    super(message);
    this.name = "OutboxError";
    this.code = code;
    this.cause = opts.cause ?? null;
  }
}

// ---- 工具 ----

function validateAlertId(id) {
  if (typeof id !== "string" || id.length === 0) {
    throw new OutboxError("alertId 必须为非空字符串", "invalid_id");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new OutboxError(
      `alertId 包含非法字符（仅允许 a-z A-Z 0-9 _ -）：${id}`,
      "invalid_id"
    );
  }
  if (id.length > 128) {
    throw new OutboxError(`alertId 过长（最大 128 字符）：${id.length}`, "invalid_id");
  }
}

// ---- 工厂 ----

export function createAlertOutbox(options) {
  const { alertsDir, logger } = options;

  /** @type {Promise<void>} 串行写队列链尾 */
  let _writeQueue = Promise.resolve();

  // ========================
  // 内部：持久化
  // ========================

  function _ensureDir() {
    if (!existsSync(alertsDir)) {
      mkdirSync(alertsDir, { recursive: true });
    }
  }

  function _filePath(alertId) {
    return join(alertsDir, `${alertId}${ALERT_FILE_EXT}`);
  }

  /**
   * 真实原子写 probe：创建随机 probe.tmp → 写入 → rename → 删除。
   * 任一步失败均抛出 OutboxError("write_probe_failed")。
   */
  function verifyWritable() {
    _ensureDir();
    const id = `_probe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const probePath = _filePath(id);
    const tmpPath = probePath + ".tmp";

    try {
      // 确保 probe 文件名不与任何现有文件冲突
      if (existsSync(probePath) || existsSync(tmpPath)) {
        throw new Error("probe file name collision");
      }
      writeFileSync(tmpPath, `{"probe":true,"ts":${Date.now()}}`, "utf-8");
      renameSync(tmpPath, probePath);
    } catch (err) {
      // 清理残留
      try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch {}
      try { if (existsSync(probePath)) unlinkSync(probePath); } catch {}
      throw new OutboxError(
        `告警目录写入 probe 失败：${alertsDir}（${err.message}）`,
        "write_probe_failed",
        { cause: err }
      );
    }

    // 成功后删除 probe 文件
    try { unlinkSync(probePath); } catch {}
  }

  /**
   * 原子写入单条告警文件。version 在此处注入，调用方无法覆盖。
   */
  function _saveAlertFile(alert) {
    _ensureDir();
    const filePath = _filePath(alert.id);
    const tmpPath = filePath + ".tmp";

    const toSave = { ...alert, version: FILE_VERSION };
    const json = JSON.stringify(toSave, null, 2);

    try {
      writeFileSync(tmpPath, json, "utf-8");
      renameSync(tmpPath, filePath);
    } catch (err) {
      throw new OutboxError(
        `告警文件写入失败：${filePath}（${err.message}）`,
        "write_failed",
        { cause: err }
      );
    }
  }

  function _enqueueWrite(operation) {
    const task = _writeQueue.then(operation);
    _writeQueue = task.catch(() => {});
    return task;
  }

  // ========================
  // Schema 校验（完整 v2）
  // ========================

  function _validateAlert(alert, filePath) {
    const ctx = filePath ? `（文件：${filePath}）` : "";
    const E = (msg) => new OutboxError(`${msg}${ctx}`, "schema_invalid");

    if (!alert || typeof alert !== "object" || Array.isArray(alert)) throw E("告警记录必须为对象");
    if (typeof alert.id !== "string" || alert.id.length === 0) throw E("告警缺少有效 id");
    if (typeof alert.incidentKey !== "string" || alert.incidentKey.length === 0) throw E("告警缺少有效 incidentKey");
    if (typeof alert.dedupeKey !== "string" || alert.dedupeKey.length === 0) throw E("告警缺少有效 dedupeKey");
    if (typeof alert.service !== "string" || alert.service.length === 0) throw E("告警缺少有效 service");
    if (typeof alert.type !== "string" || alert.type.length === 0) throw E("告警缺少有效 type");
    if (!VALID_EVENTS.has(alert.event)) throw E(`告警 event 非法："${alert.event}"`);
    if (!VALID_SEVERITIES.has(alert.severity)) throw E(`告警 severity 非法："${alert.severity}"`);
    if (!VALID_DELIVERY_STATUSES.has(alert.deliveryStatus)) throw E(`告警 deliveryStatus 非法："${alert.deliveryStatus}"`);
    if (!VALID_INCIDENT_STATUSES.has(alert.incidentStatus)) throw E(`告警 incidentStatus 非法："${alert.incidentStatus}"`);
    if (typeof alert.startedAt !== "number" || alert.startedAt <= 0) throw E("告警缺少有效 startedAt");
    if (typeof alert.occurredAt !== "number" || alert.occurredAt <= 0) throw E("告警缺少有效 occurredAt");
    if (typeof alert.updatedAt !== "number" || alert.updatedAt <= 0) throw E("告警缺少有效 updatedAt");
    if (alert.recoveryAt !== null && (typeof alert.recoveryAt !== "number" || alert.recoveryAt <= 0)) throw E("告警 recoveryAt 非法（必须为 null 或有效时间戳）");
    if (typeof alert.message !== "string" || alert.message.length === 0) throw E("告警缺少有效 message");
    if (!alert.details || typeof alert.details !== "object" || Array.isArray(alert.details)) throw E("告警 details 必须为普通对象（非数组）");
    if (typeof alert.durationMs !== "number" || !Number.isFinite(alert.durationMs) || alert.durationMs < 0) throw E("告警 durationMs 非法（必须为非负有限数）");
    if (alert.guildId !== null && typeof alert.guildId !== "string") throw E("告警 guildId 非法（必须为 null 或字符串）");
    if (alert.wsStatus !== null && typeof alert.wsStatus !== "string") throw E("告警 wsStatus 非法（必须为 null 或字符串）");
    if (alert.ping !== null && (typeof alert.ping !== "number" || !Number.isFinite(alert.ping) || alert.ping < 0)) throw E("告警 ping 非法（必须为 null 或非负有限数）");
    if (typeof alert.version !== "number" || alert.version !== FILE_VERSION) throw E(`告警 version 不匹配（期望 ${FILE_VERSION}，实际 ${alert.version}）`);
  }

  // ========================
  // 文件加载（区分错误类型）
  // ========================

  function _readRaw(filePath) {
    try {
      return readFileSync(filePath, "utf-8");
    } catch (err) {
      if (err.code === "ENOENT") return null;
      throw new OutboxError(
        `无法读取告警文件：${filePath}（${err.message}）`,
        "read_error",
        { cause: err }
      );
    }
  }

  function _loadAlertFile(filePath) {
    const raw = _readRaw(filePath);
    if (raw === null) throw new OutboxError(`告警文件不存在：${filePath}`, "file_not_found");
    if (raw.trim() === "") throw new OutboxError(`告警文件为空（可能磁盘损坏）：${filePath}。请手动检查。`, "schema_corrupt");

    let alert;
    try { alert = JSON.parse(raw); }
    catch (err) { throw new OutboxError(`告警文件 JSON 损坏：${filePath}（${err.message}）。请手动检查。`, "schema_corrupt", { cause: err }); }

    _validateAlert(alert, filePath);
    return alert;
  }

  // ========================
  // 公开 API
  // ========================

  function loadAllAlerts() {
    _ensureDir();
    const files = readdirSync(alertsDir).filter((f) => f.endsWith(ALERT_FILE_EXT));
    const alerts = [];
    for (const filename of files) {
      const filePath = join(alertsDir, filename);
      alerts.push(_loadAlertFile(filePath));
    }
    if (logger) logger.info("[AlertOutbox] 告警文件已加载", { count: alerts.length, alertsDir });
    return alerts;
  }

  function findAlert(alertId, loadedAlerts) {
    return loadedAlerts.find((a) => a.id === alertId);
  }
  function findOpenIncidents(loadedAlerts) {
    return loadedAlerts.filter((a) => a.incidentStatus === "open");
  }
  function findPendingDelivery(loadedAlerts) {
    return loadedAlerts.filter((a) => a.deliveryStatus === "pending" || a.deliveryStatus === "delivery_failed");
  }

  function writeAlert(alert) {
    validateAlertId(alert.id);
    const { version: _v, ...clean } = alert;
    _validateAlert({ ...clean, version: FILE_VERSION });

    return _enqueueWrite(() => {
      const filePath = _filePath(alert.id);
      _ensureDir();
      if (existsSync(filePath)) throw new OutboxError(`告警文件已存在，拒绝覆盖：${filePath}`, "file_exists");
      _saveAlertFile(clean);
      if (logger) logger.info("[AlertOutbox] 告警已写入", { alertId: alert.id, incidentKey: alert.incidentKey, event: alert.event });
    });
  }

  function updateAlert(alertId, patch) {
    validateAlertId(alertId);
    const filePath = _filePath(alertId);

    return _enqueueWrite(() => {
      const current = _loadAlertFile(filePath);
      const { version: _v, ...rest } = current;
      const merged = { ...rest, ...patch, updatedAt: Date.now() };
      _validateAlert({ ...merged, version: FILE_VERSION }, filePath);
      _saveAlertFile(merged);
      if (logger) logger.info("[AlertOutbox] 告警已更新", { alertId, patch: Object.keys(patch) });
    });
  }

  function markResolved(alertId) {
    return updateAlert(alertId, { incidentStatus: "resolved", recoveryAt: Date.now() });
  }
  function markDelivered(alertId) {
    return updateAlert(alertId, { deliveryStatus: "delivered" });
  }
  function markDeliveryFailed(alertId) {
    return updateAlert(alertId, { deliveryStatus: "delivery_failed" });
  }

  async function close() { await _writeQueue; }

  return {
    verifyWritable, loadAllAlerts, findAlert, findOpenIncidents, findPendingDelivery,
    writeAlert, updateAlert, markResolved, markDelivered, markDeliveryFailed, close,
    _getAlertsDir: () => alertsDir,
  };
}

export function generateAlertId(incidentKey) {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const safe = incidentKey.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return `${safe}_${ts}_${rand}`;
}

/**
 * Alert Outbox（TeaParty-Bell 生产告警持久化信箱）。
 *
 * Alert file schema (v2):
 *   id              — unique per incident file
 *   incidentKey     — stable key for cross-restart dedup
 *   dedupeKey       — dedup within same incident round
 *   event           — failure | warning | recovery | ready | integration_test
 *   deliveryStatus  — pending | delivered | delivery_failed
 *   incidentStatus  — open | resolved
 *
 * 每条告警独立一个 JSON 文件，存储在 data/runtime/alerts/
 * atomic write（tmp → rename） + 串行化写队列。
 * 加载时 fail closed（空文件 / JSON 损坏 / schema 非法 → 抛错）。
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, accessSync, constants } from "fs";
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
   * 验证目录可写性。
   * 抛错 → 调用方应走 exit 78。
   */
  function verifyWritable() {
    _ensureDir();
    try {
      accessSync(alertsDir, constants.R_OK | constants.W_OK);
    } catch (err) {
      throw new OutboxError(
        `告警目录不可读写：${alertsDir}（${err.message}）`,
        "dir_not_accessible",
        { cause: err }
      );
    }
  }

  /**
   * 原子写入单条告警文件。
   * version 在此处注入，调用方无法覆盖。
   */
  function _saveAlertFile(alert) {
    _ensureDir();
    const filePath = _filePath(alert.id);
    const tmpPath = filePath + ".tmp";

    // 强制注入 version（防止调用方覆盖）
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
    _writeQueue = task.catch(() => {
      // 错误已由 operation 内部传播；防止队列断裂
    });
    return task;
  }

  // ========================
  // Schema 校验
  // ========================

  function _validateAlert(alert, filePath) {
    const context = filePath ? `（文件：${filePath}）` : "";

    if (!alert || typeof alert !== "object" || Array.isArray(alert)) {
      throw new OutboxError(`告警记录必须为对象${context}`, "schema_invalid");
    }
    if (typeof alert.id !== "string" || alert.id.length === 0) {
      throw new OutboxError(`告警缺少有效 id${context}`, "schema_invalid");
    }
    if (typeof alert.incidentKey !== "string" || alert.incidentKey.length === 0) {
      throw new OutboxError(`告警缺少有效 incidentKey${context}`, "schema_invalid");
    }
    if (typeof alert.service !== "string" || alert.service.length === 0) {
      throw new OutboxError(`告警缺少有效 service${context}`, "schema_invalid");
    }
    if (typeof alert.type !== "string" || alert.type.length === 0) {
      throw new OutboxError(`告警缺少有效 type${context}`, "schema_invalid");
    }
    if (!VALID_EVENTS.has(alert.event)) {
      throw new OutboxError(
        `告警 event 非法："${alert.event}"${context}`, "schema_invalid"
      );
    }
    if (!VALID_SEVERITIES.has(alert.severity)) {
      throw new OutboxError(
        `告警 severity 非法："${alert.severity}"${context}`, "schema_invalid"
      );
    }
    if (!VALID_DELIVERY_STATUSES.has(alert.deliveryStatus)) {
      throw new OutboxError(
        `告警 deliveryStatus 非法："${alert.deliveryStatus}"${context}`, "schema_invalid"
      );
    }
    if (!VALID_INCIDENT_STATUSES.has(alert.incidentStatus)) {
      throw new OutboxError(
        `告警 incidentStatus 非法："${alert.incidentStatus}"${context}`, "schema_invalid"
      );
    }
    if (typeof alert.startedAt !== "number" || alert.startedAt <= 0) {
      throw new OutboxError(`告警缺少有效 startedAt${context}`, "schema_invalid");
    }
    if (typeof alert.occurredAt !== "number" || alert.occurredAt <= 0) {
      throw new OutboxError(`告警缺少有效 occurredAt${context}`, "schema_invalid");
    }
    if (typeof alert.message !== "string" || alert.message.length === 0) {
      throw new OutboxError(`告警缺少有效 message${context}`, "schema_invalid");
    }
    // version 由 outbox 注入，必须在顶层
    if (typeof alert.version !== "number" || alert.version !== FILE_VERSION) {
      throw new OutboxError(
        `告警 version 不匹配（期望 ${FILE_VERSION}，实际 ${alert.version}）${context}`,
        "schema_invalid"
      );
    }
  }

  // ========================
  // 文件加载（区分错误类型）
  // ========================

  /**
   * 读取原始文件内容。文件不存在返回 null。
   */
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

    // 文件不存在
    if (raw === null) {
      throw new OutboxError(
        `告警文件不存在：${filePath}`,
        "file_not_found"
      );
    }

    // 空文件 → 损坏
    if (raw.trim() === "") {
      throw new OutboxError(
        `告警文件为空（可能磁盘损坏）：${filePath}。请手动检查。`,
        "schema_corrupt"
      );
    }

    let alert;
    try {
      alert = JSON.parse(raw);
    } catch (err) {
      throw new OutboxError(
        `告警文件 JSON 损坏：${filePath}（${err.message}）。请手动检查。`,
        "schema_corrupt",
        { cause: err }
      );
    }

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
      const alert = _loadAlertFile(filePath);
      alerts.push(alert);
    }
    if (logger) {
      logger.info("[AlertOutbox] 告警文件已加载", { count: alerts.length, alertsDir });
    }
    return alerts;
  }

  function findAlert(alertId, loadedAlerts) {
    return loadedAlerts.find((a) => a.id === alertId);
  }

  /**
   * 查找 incidentStatus=open 的告警（用于跨重启恢复）。
   */
  function findOpenIncidents(loadedAlerts) {
    return loadedAlerts.filter((a) => a.incidentStatus === "open");
  }

  /**
   * 查找 deliveryStatus=pending 或 delivery_failed 的告警。
   */
  function findPendingDelivery(loadedAlerts) {
    return loadedAlerts.filter(
      (a) => a.deliveryStatus === "pending" || a.deliveryStatus === "delivery_failed"
    );
  }

  /**
   * 写入新告警。若文件已存在则抛出（防止覆盖）。
   */
  function writeAlert(alert) {
    validateAlertId(alert.id);

    // 版本剥离：调用方传入的 version 会被忽略，由 _saveAlertFile 注入
    const { version: _v, ...clean } = alert;
    _validateAlert({ ...clean, version: FILE_VERSION });

    return _enqueueWrite(() => {
      const filePath = _filePath(alert.id);
      _ensureDir();

      // 防止覆盖已有文件
      if (existsSync(filePath)) {
        throw new OutboxError(
          `告警文件已存在，拒绝覆盖：${filePath}`,
          "file_exists"
        );
      }

      _saveAlertFile(clean);

      if (logger) {
        logger.info("[AlertOutbox] 告警已写入", {
          alertId: alert.id,
          incidentKey: alert.incidentKey,
          event: alert.event,
          deliveryStatus: alert.deliveryStatus,
          incidentStatus: alert.incidentStatus,
        });
      }
    });
  }

  /**
   * 更新已有告警。
   *
   * 文件不存在 → OutboxError("file_not_found")
   * JSON/Schema 损坏 → OutboxError("schema_corrupt")
   * 其他读取错误 → OutboxError("read_error")
   */
  function updateAlert(alertId, patch) {
    validateAlertId(alertId);
    const filePath = _filePath(alertId);

    return _enqueueWrite(() => {
      // 读（区分错误类型——全部向上抛，不静默）
      const current = _loadAlertFile(filePath);

      // 版本剥离 + patch 合并
      const { version: _v, ...rest } = current;
      const merged = { ...rest, ...patch, updatedAt: Date.now() };

      // 更新后再次校验
      _validateAlert({ ...merged, version: FILE_VERSION }, filePath);

      _saveAlertFile(merged);

      if (logger) {
        logger.info("[AlertOutbox] 告警已更新", {
          alertId,
          patch: Object.keys(patch),
        });
      }
    });
  }

  /**
   * 标记 incidentStatus=resolved + 记录 recoveryAt。
   */
  function markResolved(alertId) {
    return updateAlert(alertId, {
      incidentStatus: "resolved",
      recoveryAt: Date.now(),
    });
  }

  function markDelivered(alertId) {
    return updateAlert(alertId, { deliveryStatus: "delivered" });
  }

  function markDeliveryFailed(alertId) {
    return updateAlert(alertId, { deliveryStatus: "delivery_failed" });
  }

  async function close() {
    await _writeQueue;
  }

  return {
    verifyWritable,
    loadAllAlerts,
    findAlert,
    findOpenIncidents,
    findPendingDelivery,
    writeAlert,
    updateAlert,
    markResolved,
    markDelivered,
    markDeliveryFailed,
    close,
    _getAlertsDir: () => alertsDir,
  };
}

/**
 * 生成唯一的告警文件 ID。
 */
export function generateAlertId(incidentKey) {
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const safe = incidentKey.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80);
  return `${safe}_${ts}_${rand}`;
}

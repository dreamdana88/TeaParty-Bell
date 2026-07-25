/**
 * Alert Outbox（TeaParty-Bell 生产告警持久化信箱）。
 *
 * 职责：
 * - 每条告警独立一个 JSON 文件，存储在 data/runtime/alerts/
 * - atomic write（tmp → rename）
 * - 串行化写操作
 * - schema 校验（加载时 fail closed）
 * - 按 alertId 查找、更新、标记 resolved/delivered
 * - 支持跨重启识别未解决 incident
 *
 * 不依赖：
 * - Discord
 * - AI
 * - Boost Feature
 * - Hermes
 */

import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, mkdirSync, readdirSync } from "fs";
import { join, dirname, basename } from "path";

// ---- 常量 ----

const FILE_VERSION = 1;

const VALID_SEVERITIES = new Set(["fatal", "warning"]);
const VALID_STATUSES = new Set(["pending", "delivered", "resolved", "delivery_failed"]);

const ALERT_FILE_EXT = ".json";

// ---- 工具：alertId 安全校验 ----

/**
 * 校验 alertId 是否安全作为文件名使用。
 * 只允许字母、数字、连字符和下划线。
 * 防止目录遍历和特殊字符注入。
 */
function validateAlertId(id) {
  if (typeof id !== "string" || id.length === 0) {
    throw new Error("alertId 必须为非空字符串");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
    throw new Error(`alertId 包含非法字符（仅允许 a-z A-Z 0-9 _ -）：${id}`);
  }
  if (id.length > 128) {
    throw new Error(`alertId 过长（最大 128 字符）：${id.length}`);
  }
}

// ---- 工厂 ----

/**
 * 创建 Alert Outbox 实例。
 *
 * @param {{ alertsDir: string, logger?: object }} options
 * @returns {object} Outbox 实例
 */
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
   * 原子写入单条告警文件。
   * 调用方必须通过 _enqueueWrite 串行化。
   */
  function _saveAlertFile(alert) {
    _ensureDir();
    const filePath = _filePath(alert.id);
    const tmpPath = filePath + ".tmp";
    const json = JSON.stringify(alert, null, 2);
    writeFileSync(tmpPath, json, "utf-8");
    renameSync(tmpPath, filePath);
  }

  /**
   * 将一次写操作排入队列。
   */
  function _enqueueWrite(operation) {
    const task = _writeQueue.then(operation);
    _writeQueue = task.catch(() => {
      // 错误已由 operation 内部记录，防止队列断裂
    });
    return task;
  }

  // ========================
  // Schema 校验
  // ========================

  /**
   * 校验单条告警的结构。
   * 任何不符 → 抛出异常（fail closed）。
   */
  function _validateAlert(alert, filePath) {
    const context = filePath ? `（文件：${filePath}）` : "";

    if (!alert || typeof alert !== "object" || Array.isArray(alert)) {
      throw new Error(`告警记录必须为对象${context}`);
    }

    // id
    if (typeof alert.id !== "string" || alert.id.length === 0) {
      throw new Error(`告警缺少有效 id${context}`);
    }

    // service
    if (typeof alert.service !== "string" || alert.service.length === 0) {
      throw new Error(`告警缺少有效 service${context}`);
    }

    // type
    if (typeof alert.type !== "string" || alert.type.length === 0) {
      throw new Error(`告警缺少有效 type${context}`);
    }

    // severity
    if (!VALID_SEVERITIES.has(alert.severity)) {
      throw new Error(
        `告警 severity 非法："${alert.severity}"，合法值：${[...VALID_SEVERITIES].join(" | ")}${context}`
      );
    }

    // status
    if (!VALID_STATUSES.has(alert.status)) {
      throw new Error(
        `告警 status 非法："${alert.status}"，合法值：${[...VALID_STATUSES].join(" | ")}${context}`
      );
    }

    // startedAt
    if (typeof alert.startedAt !== "number" || alert.startedAt <= 0) {
      throw new Error(`告警缺少有效 startedAt${context}`);
    }

    // occurredAt
    if (typeof alert.occurredAt !== "number" || alert.occurredAt <= 0) {
      throw new Error(`告警缺少有效 occurredAt${context}`);
    }

    // message
    if (typeof alert.message !== "string" || alert.message.length === 0) {
      throw new Error(`告警缺少有效 message${context}`);
    }
  }

  /**
   * 校验 version 字段。
   */
  function _validateVersion(alert, filePath) {
    const context = filePath ? `（文件：${filePath}）` : "";
    if (alert.version !== FILE_VERSION) {
      throw new Error(
        `告警 version 不匹配（期望 ${FILE_VERSION}，实际 ${alert.version}）${context}`
      );
    }
  }

  /**
   * 从文件加载并校验单条告警。
   *
   * @param {string} filePath
   * @returns {object} 校验通过的告警对象
   * @throws {Error} 文件损坏或 schema 非法
   */
  function _loadAlertFile(filePath) {
    let raw;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch (err) {
      throw new Error(
        `无法读取告警文件：${filePath}（${err.message}）`
      );
    }

    // 空文件 → 损坏
    if (raw.trim() === "") {
      throw new Error(
        `告警文件为空（可能磁盘损坏）：${filePath}。请手动检查。`
      );
    }

    let alert;
    try {
      alert = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `告警文件 JSON 损坏：${filePath}（${err.message}）。请手动检查。`
      );
    }

    _validateVersion(alert, filePath);
    _validateAlert(alert, filePath);

    return alert;
  }

  // ========================
  // 公开 API
  // ========================

  /**
   * 列出 data/runtime/alerts/ 目录下所有告警文件。
   *
   * 文件损坏时抛出异常（fail closed），不静默跳过。
   *
   * @returns {object[]} 校验通过的所有告警数组
   * @throws {Error} 任何文件损坏
   */
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

  /**
   * 查找一条告警（同步，不读文件——只在内存中查找已加载的告警）。
   * 如需从文件加载，先调用 loadAllAlerts()。
   *
   * @param {string} alertId
   * @param {object[]} loadedAlerts - 由 loadAllAlerts() 返回的告警数组
   * @returns {object|undefined}
   */
  function findAlert(alertId, loadedAlerts) {
    return loadedAlerts.find((a) => a.id === alertId);
  }

  /**
   * 查找状态为 open（pending）的告警。
   *
   * @param {object[]} loadedAlerts
   * @returns {object[]}
   */
  function findPendingAlerts(loadedAlerts) {
    return loadedAlerts.filter((a) => a.status === "pending" || a.status === "delivery_failed");
  }

  /**
   * 写入一条新告警。
   *
   * @param {object} alert - 告警对象
   * @returns {Promise<void>}
   */
  function writeAlert(alert) {
    validateAlertId(alert.id);
    _validateAlert(alert);
    // 为新写入的告警补上 version
    const toSave = { version: FILE_VERSION, ...alert };

    return _enqueueWrite(() => {
      _saveAlertFile(toSave);
      if (logger) {
        logger.info("[AlertOutbox] 告警已写入", {
          alertId: alert.id,
          type: alert.type,
          severity: alert.severity,
          status: alert.status,
        });
      }
    });
  }

  /**
   * 更新已有告警。
   * 读取当前文件、应用 patch、重新写入。
   *
   * @param {string} alertId
   * @param {object} patch - 要合并的字段
   * @returns {Promise<void>}
   */
  function updateAlert(alertId, patch) {
    validateAlertId(alertId);
    const filePath = _filePath(alertId);

    return _enqueueWrite(() => {
      // 读 → 改 → 写（同一队列内，不会有并发问题）
      let current;
      try {
        current = _loadAlertFile(filePath);
      } catch {
        // 文件不存在 → 无法更新
        if (logger) {
          logger.error("[AlertOutbox] updateAlert 找不到告警文件", { alertId, filePath });
        }
        return;
      }

      Object.assign(current, patch, { updatedAt: Date.now() });
      _validateAlert(current, filePath); // 更新后再次校验
      _saveAlertFile(current);

      if (logger) {
        logger.info("[AlertOutbox] 告警已更新", {
          alertId,
          patch: Object.keys(patch),
        });
      }
    });
  }

  /**
   * 标记告警为 resolved 并记录恢复时间。
   *
   * @param {string} alertId
   * @returns {Promise<void>}
   */
  function markResolved(alertId) {
    return updateAlert(alertId, {
      status: "resolved",
      recoveryAt: Date.now(),
    });
  }

  /**
   * 标记告警为 delivered（Hermes 已取走）。
   *
   * @param {string} alertId
   * @returns {Promise<void>}
   */
  function markDelivered(alertId) {
    return updateAlert(alertId, {
      status: "delivered",
    });
  }

  /**
   * 标记告警投递失败。
   *
   * @param {string} alertId
   * @returns {Promise<void>}
   */
  function markDeliveryFailed(alertId) {
    return updateAlert(alertId, {
      status: "delivery_failed",
    });
  }

  /**
   * 等待所有进行中的写操作完成。
   *
   * @returns {Promise<void>}
   */
  async function close() {
    await _writeQueue;
  }

  return {
    loadAllAlerts,
    findAlert,
    findPendingAlerts,
    writeAlert,
    updateAlert,
    markResolved,
    markDelivered,
    markDeliveryFailed,
    close,
    // 导出供测试
    _getAlertsDir: () => alertsDir,
  };
}

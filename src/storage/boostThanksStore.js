/**
 * Boost 感谢持久化存储（Phase 8）。
 *
 * 职责：
 * - 以 eventIds 生成的 aggregateKey 作为唯一去重依据
 * - 记录每个聚合任务的处理状态机
 * - 原子写入 JSON 状态文件（tmp → rename）
 * - 串行化所有写操作（内部 Promise 队列）
 * - 单进程内 claim 并发保护
 *
 * 不依赖：
 * - Discord
 * - AI
 * - boostThanks Handler 具体实现
 *
 * 运行环境要求 Node.js 内置 crypto 模块可用（用于 SHA-256）。
 */

import { createHash } from "crypto";
import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync, mkdirSync } from "fs";
import { dirname } from "path";

// ---- 常量 ----

const FILE_VERSION = 1;

const TERMINAL_STATUSES = new Set([
  "sent",
  "uncertain",
  "test_skipped",
]);

const RECOVERABLE_STATUSES = new Set([
  "processing",
  "failed_pre_send",
]);

const ALL_STATUSES = new Set([
  "processing",
  "sending",
  "sent",
  "failed_pre_send",
  "uncertain",
  "test_skipped",
]);

// ---- 工具 ----

/**
 * 从 eventIds 生成稳定的 aggregateKey。
 * 排序后拼接 → SHA-256 → 取前 16 个 hex 字符。
 *
 * 相同 eventIds 集合（与顺序无关）始终得到相同 key。
 */
export function generateAggregateKey(eventIds) {
  if (!Array.isArray(eventIds) || eventIds.length === 0) {
    throw new Error("generateAggregateKey: eventIds 必须为非空数组");
  }
  const sorted = [...eventIds].sort();
  const joined = sorted.join(",");
  return createHash("sha256").update(joined).digest("hex").slice(0, 16);
}

// ---- 工厂 ----

/**
 * 创建 BoostThanks 持久化存储。
 *
 * @param {{ filePath: string, logger?: object }} options
 * @returns {object} Store 实例
 */
export function createBoostThanksStore(options) {
  const { filePath, logger } = options;

  /** @type {Map<string, object>} 内存中的记录映射 */
  let _records = null;

  /** @type {Promise<void>} 串行写队列链尾 */
  let _writeQueue = Promise.resolve();

  /** @type {Map<string, Promise>} 进行中的 claim（并发保护） */
  const _inFlight = new Map();

  // ========================
  // 内部：持久化
  // ========================

  /**
   * 确保状态文件所在目录存在。
   */
  function _ensureDir() {
    const dir = dirname(filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 读取并校验当前状态文件。
   *
   * 文件不存在 → 正常首次启动，返回空结构。
   * 文件存在但为空 → 损坏，抛错（fail closed）。
   * JSON 语法错误 → 损坏，抛错（fail closed）。
   * schema 校验失败 → 损坏，抛错（fail closed）。
   *
   * @returns {object} 校验通过的状态数据
   * @throws {Error} 如果文件存在但损坏
   */
  function _readFile() {
    if (!existsSync(filePath)) {
      return { version: FILE_VERSION, records: {} };
    }

    let raw;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch (err) {
      throw new Error(
        `无法读取 BoostThanks 状态文件：${filePath}（${err.message}）`
      );
    }

    // 文件存在但内容为空 → 磁盘损坏，拒绝启动（fail closed）
    if (raw.trim() === "") {
      throw new Error(
        `BoostThanks 状态文件为空（可能磁盘损坏），拒绝启动：${filePath}。请手动检查或恢复备份。`
      );
    }

    let data;
    try {
      data = JSON.parse(raw);
    } catch (err) {
      throw new Error(
        `BoostThanks 状态文件 JSON 损坏，拒绝启动：${filePath}（${err.message}）。请手动检查或恢复备份。`
      );
    }

    _validateSchema(data);

    return data;
  }

  /**
   * 对加载后的状态数据进行 schema 校验。
   * 任何不符 → 抛出异常（fail closed）。
   */
  function _validateSchema(data) {
    // 1. 根对象必须是普通 object
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new Error(
        `BoostThanks 状态文件 schema 非法：根值必须是对象，拒绝启动：${filePath}`
      );
    }

    // 2. version 必须匹配
    if (data.version !== FILE_VERSION) {
      throw new Error(
        `BoostThanks 状态文件 version 不匹配（期望 ${FILE_VERSION}，实际 ${data.version}），拒绝启动：${filePath}`
      );
    }

    // 3. records 必须是普通 object，不能是 Array
    if (!data.records || typeof data.records !== "object" || Array.isArray(data.records)) {
      throw new Error(
        `BoostThanks 状态文件 schema 非法：records 必须是对象（不能是数组），拒绝启动：${filePath}`
      );
    }

    // 4. 逐条校验 record
    for (const [key, record] of Object.entries(data.records)) {
      if (!record || typeof record !== "object" || Array.isArray(record)) {
        throw new Error(
          `BoostThanks 状态文件 schema 非法：record "${key}" 不是对象，拒绝启动：${filePath}`
        );
      }

      // aggregateKey 必须存在且为 string
      if (typeof record.aggregateKey !== "string" || record.aggregateKey === "") {
        throw new Error(
          `BoostThanks 状态文件 schema 非法：record "${key}" 缺少 aggregateKey，拒绝启动：${filePath}`
        );
      }

      // status 必须属于允许状态集合
      if (!ALL_STATUSES.has(record.status)) {
        throw new Error(
          `BoostThanks 状态文件 schema 非法：record "${key}" 状态非法（"${record.status}"），拒绝启动：${filePath}`
        );
      }

      // eventIds 必须是 Array
      if (!Array.isArray(record.eventIds)) {
        throw new Error(
          `BoostThanks 状态文件 schema 非法：record "${key}" 的 eventIds 不是数组，拒绝启动：${filePath}`
        );
      }
    }
  }

  /**
   * 原子写回状态文件（temp → rename）。
   * 调用方必须通过 _writeQueue 串行化。
   */
  function _save() {
    _ensureDir();
    const tmpPath = filePath + ".tmp";
    const json = JSON.stringify(
      { version: FILE_VERSION, records: Object.fromEntries(_records) },
      null,
      2
    );
    writeFileSync(tmpPath, json, "utf-8");
    renameSync(tmpPath, filePath);
  }

  /**
   * 将一次写操作排入队列，返回 Promise。
   * 确保所有写操作按调用顺序执行，不会互相覆盖。
   */
  function _enqueueWrite(operation) {
    const task = _writeQueue.then(operation);
    _writeQueue = task.catch(() => {
      // 错误已由 operation 内部记录，这里仅防止队列断裂
    });
    return task;
  }

  // ========================
  // 内部：内存状态操作
  // ========================

  function _makeRecord(aggregateKey, metadata) {
    const now = Date.now();
    return {
      aggregateKey,
      eventIds: metadata.eventIds ?? [],
      guildId: metadata.guildId ?? null,
      userId: metadata.userId ?? null,
      boostCount: metadata.boostCount ?? 0,
      status: "processing",
      messageId: null,
      channelId: null,
      sentAt: null,
      attemptCount: 0,
      lastErrorStage: null,
      lastError: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * 更新内存中某条记录的字段并异步写盘。
   */
  function _update(aggregateKey, patch) {
    const record = _records.get(aggregateKey);
    if (!record) {
      if (logger) {
        logger.warn("[BoostThanksStore] _update 找不到记录", { aggregateKey });
      }
      return Promise.resolve();
    }
    Object.assign(record, patch, { updatedAt: Date.now() });
    return _enqueueWrite(() => {
      _save();
    });
  }

  // ========================
  // 公开 API
  // ========================

  /**
   * 加载状态文件到内存。
   * 首次启动（文件不存在）正常返回空状态。
   * 文件存在但 JSON 损坏 → 抛出异常（fail closed）。
   *
   * @returns {Promise<void>}
   */
  async function load() {
    if (_records !== null) return; // 已加载
    const data = _readFile();
    _records = new Map(Object.entries(data.records));
    if (logger) {
      logger.info("[BoostThanksStore] 状态已加载", { recordCount: _records.size, filePath });
    }
  }

  /**
   * 尝试 claim 一个聚合事件的处理权。
   *
   * 同步检查 in-flight + 已持久化终态 → 进程中唯一。
   * 如果 claim 成功，创建 processing 记录并异步写盘。
   *
   * @param {string} aggregateKey
   * @param {{ eventIds: string[], guildId: string, userId: string, boostCount: number }} metadata
   * @returns {Promise<object|null>} 新创建的 record，或 null（已被 claim / 已达终态）
   */
  async function claimEvent(aggregateKey, metadata) {
    // ---- 1. 同步检查 in-flight（进程内并发保护） ----
    if (_inFlight.has(aggregateKey)) {
      if (logger) {
        logger.info("[BoostThanksStore] 事件已在处理中（in-flight），跳过", { aggregateKey });
      }
      return null;
    }

    // ---- 2. 检查持久化状态 ----
    const existing = _records.get(aggregateKey);
    if (existing != null) {
      // 终态 → 拒绝
      if (TERMINAL_STATUSES.has(existing.status)) {
        if (logger) {
          logger.info("[BoostThanksStore] 事件已达终态，跳过", {
            aggregateKey,
            status: existing.status,
          });
        }
        return null;
      }
      // 非终态但已在处理中 → 拒绝（应该不会经过 in-flight 检查，但防御）
      if (logger) {
        logger.warn("[BoostThanksStore] 事件状态异常（非终态但未被 in-flight 追踪）", {
          aggregateKey,
          status: existing.status,
        });
      }
      return null;
    }

    // ---- 3. 检查部分 eventIds 冲突 ----
    const conflict = _findPartialConflict(metadata.eventIds);
    if (conflict) {
      if (logger) {
        logger.error("[BoostThanksStore] 检测到 eventIds 部分重叠，拒绝处理", {
          aggregateKey,
          newEventIds: metadata.eventIds,
          conflictKey: conflict.aggregateKey,
          conflictEventIds: conflict.eventIds,
        });
      }
      return null;
    }

    // ---- 4. 创建记录 ----
    const record = _makeRecord(aggregateKey, metadata);
    _records.set(aggregateKey, record);

    // 注册 in-flight
    const writePromise = _enqueueWrite(() => {
      _save();
    }).finally(() => {
      _inFlight.delete(aggregateKey);
    });
    _inFlight.set(aggregateKey, writePromise);

    if (logger) {
      logger.info("[BoostThanksStore] 事件已 claim", {
        aggregateKey,
        guildId: metadata.guildId,
        userId: metadata.userId,
        boostCount: metadata.boostCount,
        eventCount: metadata.eventIds?.length ?? 0,
      });
    }

    return record;
  }

  /**
   * 查找与给定 eventIds 有部分重叠（非完全相同）的已存在记录。
   * @returns {{ aggregateKey: string, eventIds: string[] } | null}
   */
  function _findPartialConflict(newEventIds) {
    const newSet = new Set(newEventIds);
    for (const [key, record] of _records) {
      const existingSet = new Set(record.eventIds);
      const intersection = [...newSet].filter((id) => existingSet.has(id));
      if (intersection.length > 0 && intersection.length < Math.max(newSet.size, existingSet.size)) {
        return { aggregateKey: key, eventIds: record.eventIds };
      }
    }
    return null;
  }

  /**
   * 获取记录（同步）。
   * @param {string} aggregateKey
   * @returns {object|undefined}
   */
  function getRecord(aggregateKey) {
    return _records.get(aggregateKey);
  }

  /**
   * 标记为 processing。
   */
  function markProcessing(aggregateKey) {
    return _update(aggregateKey, { status: "processing" });
  }

  /**
   * 标记为 sending（在真正调用 Discord send() 前）。
   */
  function markSending(aggregateKey) {
    return _update(aggregateKey, { status: "sending" });
  }

  /**
   * 标记为 sent（Discord send() 成功返回后立即调用）。
   */
  function markSent(aggregateKey, { messageId, channelId } = {}) {
    return _update(aggregateKey, {
      status: "sent",
      messageId: messageId ?? null,
      channelId: channelId ?? null,
      sentAt: Date.now(),
    });
  }

  /**
   * 标记为 failed_pre_send（发送前阶段失败，可安全重试）。
   */
  function markFailedPreSend(aggregateKey, { error, errorStage } = {}) {
    const record = _records.get(aggregateKey);
    if (!record) return Promise.resolve();
    return _update(aggregateKey, {
      status: "failed_pre_send",
      attemptCount: (record.attemptCount ?? 0) + 1,
      lastErrorStage: errorStage ?? null,
      lastError: error ?? null,
    });
  }

  /**
   * 标记为 uncertain（发送结果无法确定，禁止自动重试）。
   */
  function markUncertain(aggregateKey, reason) {
    return _update(aggregateKey, {
      status: "uncertain",
      lastError: reason ?? null,
    });
  }

  /**
   * 标记为 test_skipped（TEST_MODE=true 时）。
   */
  function markTestSkipped(aggregateKey) {
    return _update(aggregateKey, { status: "test_skipped" });
  }

  /**
   * 返回可恢复的记录列表（processing 或 failed_pre_send）。
   * @returns {object[]}
   */
  function listRecoverable() {
    return [..._records.values()].filter((r) => RECOVERABLE_STATUSES.has(r.status));
  }

  /**
   * 返回全部记录。
   * @returns {Map<string, object>}
   */
  function getAllRecords() {
    return new Map(_records);
  }

  /**
   * 等待所有进行中的写操作完成。
   * @returns {Promise<void>}
   */
  async function close() {
    await _writeQueue;
  }

  // ========================

  return {
    load,
    claimEvent,
    getRecord,
    markProcessing,
    markSending,
    markSent,
    markFailedPreSend,
    markUncertain,
    markTestSkipped,
    listRecoverable,
    getAllRecords,
    close,
    // 导出供测试
    _getFilePath: () => filePath,
  };
}

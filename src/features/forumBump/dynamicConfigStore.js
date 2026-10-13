/**
 * Forum Bump 动态配置 Store：原子写、revision、进程内写队列。
 * 不自动覆盖损坏文件；不连接 Discord。
 */

import { existsSync, readFileSync } from "fs";
import { writeJsonAtomic } from "../../utils/atomicJson.js";
import {
  FORUM_BUMP_DYNAMIC_CONFIG_VERSION,
  cloneDynamicConfig,
  createDynamicConfigError,
  isForumBumpDynamicConfigError,
  validateDynamicConfig,
} from "./dynamicConfigSchema.js";

function result(operation, fields = {}) {
  return {
    operation,
    success: false,
    changed: false,
    config: null,
    previousRevision: null,
    revision: null,
    errorCode: null,
    ...fields,
  };
}

function errorCodeOf(error, fallback) {
  return isForumBumpDynamicConfigError(error) ? error.code : fallback;
}

/**
 * @param {object} options
 * @param {string} options.configPath
 */
export function createForumBumpDynamicConfigStore({
  configPath,
  logger,
  clock = { now: () => Date.now() },
} = {}) {
  if (typeof configPath !== "string" || configPath.trim().length === 0) {
    throw new TypeError("createForumBumpDynamicConfigStore 需要 configPath");
  }

  /** @type {object|null} */
  let _config = null;
  /** @type {Promise<void>} */
  let _writeQueue = Promise.resolve();

  function _enqueue(operation) {
    const task = _writeQueue.then(operation);
    _writeQueue = task.then(() => {}, () => {});
    return task;
  }

  function _atomicWrite(doc) {
    try {
      writeJsonAtomic(configPath, doc, { fsyncDir: true });
    } catch (error) {
      throw createDynamicConfigError("DYNAMIC_CONFIG_WRITE_FAILED", error);
    }
  }

  function _readAndValidateFromDisk() {
    if (!existsSync(configPath)) {
      throw createDynamicConfigError("DYNAMIC_CONFIG_NOT_FOUND");
    }
    let raw;
    try {
      raw = readFileSync(configPath, "utf8");
    } catch (error) {
      throw createDynamicConfigError("DYNAMIC_CONFIG_READ_FAILED", error);
    }
    if (raw.trim() === "") {
      throw createDynamicConfigError("DYNAMIC_CONFIG_PARSE_FAILED");
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      throw createDynamicConfigError("DYNAMIC_CONFIG_PARSE_FAILED", error);
    }
    // 版本号先于字段校验判定
    if (data && typeof data === "object" && !Array.isArray(data)
      && typeof data.version === "number" && data.version !== FORUM_BUMP_DYNAMIC_CONFIG_VERSION) {
      throw createDynamicConfigError("DYNAMIC_CONFIG_VERSION_UNSUPPORTED");
    }
    return validateDynamicConfig(data);
  }

  /**
   * 加载。文件不存在返回 NOT_FOUND（调用方可用 .env 基线）。
   */
  function load() {
    return _enqueue(async () => {
      try {
        _config = _readAndValidateFromDisk();
        return result("load", { success: true, config: cloneDynamicConfig(_config), revision: _config.revision });
      } catch (error) {
        _config = null;
        return result("load", { errorCode: errorCodeOf(error, "DYNAMIC_CONFIG_READ_FAILED") });
      }
    });
  }

  function getSnapshot() {
    return _config ? cloneDynamicConfig(_config) : null;
  }

  function exists() {
    return existsSync(configPath);
  }

  /**
   * 原子保存（revision 必须匹配 expectedRevision；写入后 revision+1）。
   * @param {object} options
   * @param {object} options.config 待保存文档（revision 应为 expectedRevision）
   * @param {number} options.expectedRevision
   * @param {string|null} [options.updatedBy]
   */
  function save({ config, expectedRevision, updatedBy = null } = {}) {
    return _enqueue(async () => {
      try {
        if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
          return result("save", { errorCode: "DYNAMIC_CONFIG_ARGUMENT_INVALID" });
        }
        if (existsSync(configPath)) {
          const diskDoc = _readAndValidateFromDisk();
          if (diskDoc.revision !== expectedRevision) {
            _config = cloneDynamicConfig(diskDoc);
            return result("save", {
              errorCode: "DYNAMIC_CONFIG_REVISION_CONFLICT",
              previousRevision: diskDoc.revision,
              revision: diskDoc.revision,
              config: cloneDynamicConfig(diskDoc),
            });
          }
        } else if (expectedRevision !== 0) {
          return result("save", { errorCode: "DYNAMIC_CONFIG_REVISION_CONFLICT" });
        }

        // 先校验调用方文档本身（含其 updatedAt/updatedBy），再校验写入用的完整文档
        const validated = validateDynamicConfig({ ...config, revision: expectedRevision });
        const finalDoc = validateDynamicConfig({
          ...validated,
          revision: expectedRevision + 1,
          updatedAt: new Date(clock.now()).toISOString(),
          updatedBy: updatedBy == null ? null : String(updatedBy).trim().slice(0, 200) || null,
        });
        _atomicWrite(finalDoc);
        _config = cloneDynamicConfig(finalDoc);
        logger?.info?.("[ForumBumpDynamicConfig] saved", {
          revision: finalDoc.revision,
          dailyLimit: finalDoc.dailyLimit,
        });
        return result("save", {
          success: true,
          changed: true,
          config: cloneDynamicConfig(finalDoc),
          previousRevision: expectedRevision,
          revision: finalDoc.revision,
        });
      } catch (error) {
        return result("save", { errorCode: errorCodeOf(error, "DYNAMIC_CONFIG_WRITE_FAILED") });
      }
    });
  }

  return {
    configPath,
    load,
    save,
    getSnapshot,
    exists,
  };
}

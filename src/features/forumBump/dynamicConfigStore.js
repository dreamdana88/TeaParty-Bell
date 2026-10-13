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

function emptyResult(operation, extras = {}) {
  return {
    operation,
    success: false,
    changed: false,
    config: null,
    previousRevision: null,
    revision: null,
    errorCode: null,
    ...extras,
  };
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
    if (typeof raw !== "string" || raw.trim() === "") {
      throw createDynamicConfigError("DYNAMIC_CONFIG_PARSE_FAILED");
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      throw createDynamicConfigError("DYNAMIC_CONFIG_PARSE_FAILED", error);
    }
    if (
      data
      && typeof data === "object"
      && !Array.isArray(data)
      && "version" in data
      && typeof data.version === "number"
      && data.version !== FORUM_BUMP_DYNAMIC_CONFIG_VERSION
    ) {
      throw createDynamicConfigError("DYNAMIC_CONFIG_VERSION_UNSUPPORTED");
    }
    return validateDynamicConfig(data);
  }

  /**
   * 加载。文件不存在返回 NOT_FOUND（调用方可用 .env 基线）。
   */
  async function load() {
    return _enqueue(async () => {
      try {
        const doc = _readAndValidateFromDisk();
        _config = cloneDynamicConfig(doc);
        return {
          ...emptyResult("load"),
          success: true,
          config: cloneDynamicConfig(_config),
          revision: _config.revision,
          errorCode: null,
        };
      } catch (error) {
        _config = null;
        const code = isForumBumpDynamicConfigError(error)
          ? error.code
          : "DYNAMIC_CONFIG_READ_FAILED";
        return {
          ...emptyResult("load"),
          success: false,
          errorCode: code,
        };
      }
    });
  }

  function getSnapshot() {
    return _config ? cloneDynamicConfig(_config) : null;
  }

  function exists() {
    try {
      return existsSync(configPath);
    } catch {
      return false;
    }
  }

  /**
   * 原子保存（revision 必须匹配 expectedRevision；写入后 revision+1）。
   * @param {object} options
   * @param {object} options.config 已校验文档（revision 应为 expectedRevision）
   * @param {number} options.expectedRevision
   * @param {string|null} [options.updatedBy]
   */
  async function save({ config, expectedRevision, updatedBy = null } = {}) {
    return _enqueue(async () => {
      try {
        if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
          return {
            ...emptyResult("save"),
            errorCode: "DYNAMIC_CONFIG_ARGUMENT_INVALID",
          };
        }

        let diskDoc = null;
        const fileExists = existsSync(configPath);
        if (fileExists) {
          diskDoc = _readAndValidateFromDisk();
          if (diskDoc.revision !== expectedRevision) {
            _config = cloneDynamicConfig(diskDoc);
            return {
              ...emptyResult("save"),
              errorCode: "DYNAMIC_CONFIG_REVISION_CONFLICT",
              previousRevision: diskDoc.revision,
              revision: diskDoc.revision,
              config: cloneDynamicConfig(diskDoc),
            };
          }
        } else if (expectedRevision !== 0) {
          return {
            ...emptyResult("save"),
            errorCode: "DYNAMIC_CONFIG_REVISION_CONFLICT",
            previousRevision: null,
          };
        }

        const validated = validateDynamicConfig({
          ...config,
          revision: expectedRevision,
        });

        const next = {
          ...validated,
          revision: expectedRevision + 1,
          updatedAt: new Date(clock.now()).toISOString(),
          updatedBy: updatedBy == null
            ? null
            : String(updatedBy).trim().slice(0, 200) || null,
        };
        // 再次校验完整文档
        const finalDoc = validateDynamicConfig(next);
        _atomicWrite(finalDoc);
        _config = cloneDynamicConfig(finalDoc);
        logger?.info?.("[ForumBumpDynamicConfig] saved", {
          revision: finalDoc.revision,
          dailyLimit: finalDoc.dailyLimit,
        });
        return {
          operation: "save",
          success: true,
          changed: true,
          config: cloneDynamicConfig(finalDoc),
          previousRevision: expectedRevision,
          revision: finalDoc.revision,
          errorCode: null,
        };
      } catch (error) {
        const code = isForumBumpDynamicConfigError(error)
          ? error.code
          : "DYNAMIC_CONFIG_WRITE_FAILED";
        return {
          ...emptyResult("save"),
          errorCode: code,
        };
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

/**
 * Forum Bump 动态配置 Store：原子写、revision、进程内写队列。
 * 不自动覆盖损坏文件；不连接 Discord。
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "fs";
import { dirname } from "path";
import { randomBytes } from "crypto";
import {
  FORUM_BUMP_DYNAMIC_CONFIG_VERSION,
  cloneDynamicConfig,
  createDynamicConfigError,
  isForumBumpDynamicConfigError,
  validateDynamicConfig,
} from "./dynamicConfigSchema.js";

function defaultMakeTempName(configPath) {
  const id = randomBytes(8).toString("hex");
  return `${configPath}.tmp-${id}`;
}

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
  fs: fsOps,
  logger,
  clock = { now: () => Date.now() },
  makeTempName = defaultMakeTempName,
} = {}) {
  if (typeof configPath !== "string" || configPath.trim().length === 0) {
    throw new TypeError("createForumBumpDynamicConfigStore 需要 configPath");
  }

  const fs = fsOps ?? {
    existsSync,
    mkdirSync,
    readFileSync,
    openSync,
    writeSync,
    fsyncSync,
    closeSync,
    renameSync,
    unlinkSync,
  };

  /** @type {object|null} */
  let _config = null;
  /** @type {Promise<void>} */
  let _writeQueue = Promise.resolve();

  function _enqueue(operation) {
    const task = _writeQueue.then(operation);
    _writeQueue = task.then(() => {}, () => {});
    return task;
  }

  function _ensureDir() {
    const dir = dirname(configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  function _atomicWrite(doc) {
    _ensureDir();
    const tmpPath = makeTempName(configPath);
    const json = `${JSON.stringify(doc, null, 2)}\n`;
    let fd = null;
    try {
      fd = fs.openSync(tmpPath, "w");
      fs.writeSync(fd, json, 0, "utf8");
      try {
        fs.fsyncSync(fd);
      } catch (fsyncError) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
        fd = null;
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
          // ignore
        }
        throw createDynamicConfigError("DYNAMIC_CONFIG_WRITE_FAILED", fsyncError);
      }
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmpPath, configPath);
      try {
        const dirFd = fs.openSync(dirname(configPath), "r");
        try {
          fs.fsyncSync(dirFd);
        } catch {
          // best-effort
        } finally {
          try {
            fs.closeSync(dirFd);
          } catch {
            // ignore
          }
        }
      } catch {
        // ignore
      }
    } catch (error) {
      if (isForumBumpDynamicConfigError(error) && error.code === "DYNAMIC_CONFIG_WRITE_FAILED") {
        throw error;
      }
      try {
        if (fd != null) fs.closeSync(fd);
      } catch {
        // ignore
      }
      try {
        if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
      } catch {
        // ignore
      }
      throw createDynamicConfigError("DYNAMIC_CONFIG_WRITE_FAILED", error);
    }
  }

  function _readAndValidateFromDisk() {
    if (!fs.existsSync(configPath)) {
      throw createDynamicConfigError("DYNAMIC_CONFIG_NOT_FOUND");
    }
    let raw;
    try {
      raw = fs.readFileSync(configPath, "utf8");
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
      return fs.existsSync(configPath);
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
        const fileExists = fs.existsSync(configPath);
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
        try {
          logger?.info?.("[ForumBumpDynamicConfig] saved", {
            revision: finalDoc.revision,
            dailyLimit: finalDoc.dailyLimit,
          });
        } catch {
          // ignore
        }
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

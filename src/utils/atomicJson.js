/**
 * 统一的原子 JSON 写盘：tmp → write →（可选 fsync）→ rename。
 *
 * 失败时尽力清理 tmp，并原样抛出底层错误；调用方自行包装成业务错误码。
 * rename 之前任一步失败都不会动到旧文件（fail closed）。
 */

import * as nodeFs from "fs";
import { dirname } from "path";
import { randomBytes } from "crypto";

/**
 * @param {string} filePath
 * @param {unknown} data
 * @param {object} [options]
 * @param {Partial<typeof nodeFs>} [options.fs] 局部覆盖 fs 方法（测试注入故障用）
 * @param {string} [options.tmpPath] 默认 `${filePath}.tmp-<随机>`
 * @param {boolean} [options.durable=true] true：open/write/fsync/close；false：writeFileSync
 * @param {boolean} [options.fsyncDir=false] rename 后 best-effort fsync 目录
 * @param {boolean} [options.pretty=true] 2 空格缩进
 * @param {boolean} [options.trailingNewline=true]
 */
export function writeJsonAtomic(filePath, data, {
  fs: fsOverride,
  tmpPath = `${filePath}.tmp-${randomBytes(8).toString("hex")}`,
  durable = true,
  fsyncDir = false,
  pretty = true,
  trailingNewline = true,
} = {}) {
  const fs = fsOverride ? { ...nodeFs, ...fsOverride } : nodeFs;
  const dir = dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const json = (pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data))
    + (trailingNewline ? "\n" : "");
  let fd = null;
  try {
    if (durable) {
      fd = fs.openSync(tmpPath, "w");
      fs.writeSync(fd, json, 0, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
    } else {
      fs.writeFileSync(tmpPath, json, "utf-8");
    }
    fs.renameSync(tmpPath, filePath);
  } catch (error) {
    if (fd != null) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch { /* ignore */ }
    throw error;
  }

  if (fsyncDir) {
    // 目录 fsync best-effort：失败不破坏已成功 rename 的提交
    try {
      const dirFd = fs.openSync(dir, "r");
      try { fs.fsyncSync(dirFd); } catch { /* ignore */ } finally {
        try { fs.closeSync(dirFd); } catch { /* ignore */ }
      }
    } catch { /* 平台不支持打开目录 */ }
  }
}

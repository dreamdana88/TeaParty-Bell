/**
 * 跨进程单实例锁（文件独占创建 + PID 存活探测）。
 *
 * - 不依赖真实 Discord
 * - 崩溃后陈旧锁可被回收（PID 不存在时）
 * - 禁止仅用进程内布尔
 */

import {
  openSync,
  writeFileSync,
  closeSync,
  unlinkSync,
  readFileSync,
  existsSync,
  mkdirSync,
} from "fs";
import { dirname } from "path";

export const INSTANCE_LOCK_BUSY_EXIT_CODE = 78;

export class InstanceLockError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {number} [exitCode=78]
   */
  constructor(message, code, exitCode = INSTANCE_LOCK_BUSY_EXIT_CODE) {
    super(message);
    this.name = "InstanceLockError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

function defaultIsProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // Windows: ESRCH / EINVAL when process gone; EPERM means exists but no permission
    if (err && (err.code === "EPERM" || err.code === "EACCES")) return true;
    return false;
  }
}

/**
 * @param {object} options
 * @param {string} options.lockPath
 * @param {number} [options.pid]
 * @param {(pid:number)=>boolean} [options.isProcessAlive]
 * @param {()=>number} [options.now]
 */
export function createInstanceLock({
  lockPath,
  pid = process.pid,
  isProcessAlive = defaultIsProcessAlive,
  now = () => Date.now(),
} = {}) {
  if (!lockPath || typeof lockPath !== "string") {
    throw new TypeError("createInstanceLock 需要 lockPath");
  }

  let held = false;
  let fd = null;

  function ensureParentDir() {
    const dir = dirname(lockPath);
    mkdirSync(dir, { recursive: true });
  }

  function readLockPayload() {
    try {
      const raw = readFileSync(lockPath, "utf8");
      const data = JSON.parse(raw);
      return {
        pid: typeof data?.pid === "number" ? data.pid : null,
        acquiredAt: data?.acquiredAt ?? null,
      };
    } catch {
      return null;
    }
  }

  function tryUnlink() {
    try {
      unlinkSync(lockPath);
    } catch {
      // ignore
    }
  }

  /**
   * @returns {{ acquired: true, lockPath: string, pid: number }}
   */
  function acquire() {
    if (held) {
      return { acquired: true, lockPath, pid, reentrant: true };
    }
    ensureParentDir();

    // 最多尝试：独占创建；失败则判断陈旧 PID 后回收再试一次
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        fd = openSync(lockPath, "wx");
        const payload = JSON.stringify({
          pid,
          acquiredAt: new Date(now()).toISOString(),
        });
        writeFileSync(fd, `${payload}\n`, "utf8");
        held = true;
        return { acquired: true, lockPath, pid };
      } catch (err) {
        if (err?.code !== "EEXIST") {
          throw new InstanceLockError(
            `无法创建实例锁：${err?.code ?? err?.message ?? "unknown"}`,
            "INSTANCE_LOCK_IO_FAILED",
            1,
          );
        }
        const existing = readLockPayload();
        const otherPid = existing?.pid;
        if (otherPid != null && isProcessAlive(otherPid) && otherPid !== pid) {
          throw new InstanceLockError(
            `另一个 TeaParty-Bell 进程正在运行（pid=${otherPid}）`,
            "INSTANCE_LOCK_BUSY",
            INSTANCE_LOCK_BUSY_EXIT_CODE,
          );
        }
        // 陈旧锁：删除后重试
        tryUnlink();
      }
    }

    throw new InstanceLockError(
      "实例锁竞争失败",
      "INSTANCE_LOCK_BUSY",
      INSTANCE_LOCK_BUSY_EXIT_CODE,
    );
  }

  function release() {
    if (!held) return { released: false };
    held = false;
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
      fd = null;
    }
    // 仅删除自己写入的锁
    const existing = existsSync(lockPath) ? readLockPayload() : null;
    if (!existing || existing.pid === pid || existing.pid == null) {
      tryUnlink();
    }
    return { released: true };
  }

  function isHeld() {
    return held;
  }

  return {
    acquire,
    release,
    isHeld,
    get lockPath() {
      return lockPath;
    },
  };
}

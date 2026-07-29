/**
 * 跨进程单实例锁（文件独占创建 + ownerToken + 安全陈旧回收）。
 *
 * 语义：
 * - 未读到合法 owner payload ≠ 陈旧锁（视为 initializing / busy）
 * - 只有确认 owner PID 已死亡后才能回收
 * - 回收通过 rename claim，避免多进程同时 unlink
 * - release 必须核对 pid + ownerToken
 */

import {
  openSync,
  writeFileSync,
  closeSync,
  unlinkSync,
  readFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from "fs";
import { randomBytes } from "crypto";
import { dirname, join } from "path";

export const INSTANCE_LOCK_BUSY_EXIT_CODE = 78;

/** 新建锁后 payload 尚不可读时的最长等待（ms） */
export const INITIALIZING_WAIT_MS = 200;
export const INITIALIZING_RETRY_MS = 25;
/** 残缺/空锁在此年龄内不得回收 */
export const STALE_PARTIAL_MIN_AGE_MS = 2000;

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
    if (err && (err.code === "EPERM" || err.code === "EACCES")) return true;
    return false;
  }
}

function defaultSleepSync(ms) {
  if (ms <= 0) return;
  const end = Date.now() + ms;
  // 无依赖的同步等待（仅用于短重试）
  while (Date.now() < end) {
    // spin
  }
}

function newOwnerToken() {
  try {
    return randomBytes(16).toString("hex");
  } catch {
    return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  }
}

/**
 * @param {object} options
 * @param {string} options.lockPath
 * @param {number} [options.pid]
 * @param {(pid:number)=>boolean} [options.isProcessAlive]
 * @param {()=>number} [options.now]
 * @param {(ms:number)=>void} [options.sleepSync]
 * @param {()=>string} [options.createOwnerToken]
 * @param {number} [options.writePayloadDelayMs] 测试用：创建后延迟写 payload
 * @param {()=>void} [options.afterCreateBeforeWrite] 测试钩子：独占创建后、写 payload 前
 */
export function createInstanceLock({
  lockPath,
  pid = process.pid,
  isProcessAlive = defaultIsProcessAlive,
  now = () => Date.now(),
  sleepSync = defaultSleepSync,
  createOwnerToken = newOwnerToken,
  writePayloadDelayMs = 0,
  afterCreateBeforeWrite = null,
} = {}) {
  if (!lockPath || typeof lockPath !== "string") {
    throw new TypeError("createInstanceLock 需要 lockPath");
  }

  let held = false;
  let fd = null;
  let ownerToken = null;

  function ensureParentDir() {
    mkdirSync(dirname(lockPath), { recursive: true });
  }

  /**
   * @returns {{ pid: number, ownerToken: string, acquiredAt: string }|null}
   */
  function readLockPayload() {
    try {
      const raw = readFileSync(lockPath, "utf8");
      if (!raw || !String(raw).trim()) return null;
      const data = JSON.parse(raw);
      if (typeof data?.pid !== "number" || !Number.isInteger(data.pid)) return null;
      if (typeof data?.ownerToken !== "string" || data.ownerToken.length < 8) return null;
      return {
        pid: data.pid,
        ownerToken: data.ownerToken,
        acquiredAt: typeof data.acquiredAt === "string" ? data.acquiredAt : null,
      };
    } catch {
      return null;
    }
  }

  function fileAgeMs() {
    try {
      const st = statSync(lockPath);
      return Math.max(0, now() - st.mtimeMs);
    } catch {
      return null;
    }
  }

  function busy(message, code = "INSTANCE_LOCK_BUSY") {
    throw new InstanceLockError(message, code, INSTANCE_LOCK_BUSY_EXIT_CODE);
  }

  /**
   * 在 initializing 窗口内重试读 payload。
   * 使用尝试次数而非注入的 now() 截止，避免测试冻结时钟导致死循环。
   * @returns {{ pid: number, ownerToken: string, acquiredAt: string }|null}
   */
  function waitForPayload() {
    const maxAttempts = Math.max(1, Math.ceil(INITIALIZING_WAIT_MS / INITIALIZING_RETRY_MS));
    let payload = readLockPayload();
    for (let i = 0; !payload && i < maxAttempts; i += 1) {
      sleepSync(INITIALIZING_RETRY_MS);
      payload = readLockPayload();
    }
    return payload;
  }

  /**
   * 原子 claim 陈旧锁：rename 走，再 wx 创建新锁。
   * 多进程同时回收时只有一个 rename 成功。
   * @returns {boolean} 是否 claim 成功并完成新 payload 写入
   */
  function tryReclaimStale() {
    const claimPath = join(
      dirname(lockPath),
      `${lockPath.split(/[/\\]/).pop()}.claim.${createOwnerToken()}`,
    );
    try {
      renameSync(lockPath, claimPath);
    } catch {
      // 已被其他进程 claim 或锁消失
      return false;
    }
    // 已成功移走旧锁；尝试独占创建新锁
    try {
      const token = createOwnerToken();
      fd = openSync(lockPath, "wx");
      const payload = JSON.stringify({
        pid,
        ownerToken: token,
        acquiredAt: new Date(now()).toISOString(),
      });
      writeFileSync(fd, `${payload}\n`, "utf8");
      ownerToken = token;
      held = true;
      try {
        unlinkSync(claimPath);
      } catch {
        // 清理 claim 失败不影响持锁
      }
      return true;
    } catch {
      // 创建失败：尽量恢复 claim 文件以免锁永久丢失
      try {
        if (!existsSync(lockPath)) {
          renameSync(claimPath, lockPath);
        } else {
          unlinkSync(claimPath);
        }
      } catch {
        // ignore
      }
      if (fd != null) {
        try { closeSync(fd); } catch { /* */ }
        fd = null;
      }
      return false;
    }
  }

  function writeOwnerPayload(token) {
    if (typeof afterCreateBeforeWrite === "function") {
      afterCreateBeforeWrite();
    }
    if (writePayloadDelayMs > 0) {
      sleepSync(writePayloadDelayMs);
    }
    const payload = JSON.stringify({
      pid,
      ownerToken: token,
      acquiredAt: new Date(now()).toISOString(),
    });
    writeFileSync(fd, `${payload}\n`, "utf8");
  }

  /**
   * @returns {{ acquired: true, lockPath: string, pid: number, ownerToken: string }}
   */
  function acquire() {
    if (held) {
      return { acquired: true, lockPath, pid, ownerToken, reentrant: true };
    }
    ensureParentDir();

    // 最多：直接创建；失败后处理 busy / reclaim 再试一次
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const token = createOwnerToken();
        fd = openSync(lockPath, "wx");
        writeOwnerPayload(token);
        ownerToken = token;
        held = true;
        return { acquired: true, lockPath, pid, ownerToken };
      } catch (err) {
        if (err?.code !== "EEXIST") {
          throw new InstanceLockError(
            `无法创建实例锁：${err?.code ?? err?.message ?? "unknown"}`,
            "INSTANCE_LOCK_IO_FAILED",
            1,
          );
        }

        // 锁文件存在：先等待 initializing 写完 payload
        let existing = waitForPayload();

        if (!existing) {
          // 仍不可读：年轻 → busy；够老 → 按残缺陈旧锁 reclaim
          const age = fileAgeMs();
          if (age == null || age < STALE_PARTIAL_MIN_AGE_MS) {
            busy("实例锁正在初始化或被其他进程持有");
          }
          // 明确陈旧的残缺锁
          if (tryReclaimStale()) {
            return { acquired: true, lockPath, pid, ownerToken };
          }
          busy("实例锁竞争失败（残缺锁回收）");
        }

        if (existing.pid === pid && held) {
          return { acquired: true, lockPath, pid, ownerToken, reentrant: true };
        }

        if (isProcessAlive(existing.pid) && existing.pid !== pid) {
          busy(`另一个 TeaParty-Bell 进程正在运行（pid=${existing.pid}）`);
        }

        // owner 已死亡（或同 pid 但本进程未 held → 崩溃残留）
        if (!isProcessAlive(existing.pid) || existing.pid === pid) {
          if (tryReclaimStale()) {
            return { acquired: true, lockPath, pid, ownerToken };
          }
          // 其他进程抢到了
          busy("实例锁竞争失败");
        }

        busy("实例锁冲突");
      }
    }

    busy("实例锁竞争失败");
  }

  function release() {
    if (!held) return { released: false };
    const myToken = ownerToken;
    const myPid = pid;
    held = false;
    ownerToken = null;
    if (fd != null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
      fd = null;
    }

    // 仅当磁盘仍是自己时删除
    const existing = existsSync(lockPath) ? readLockPayload() : null;
    if (
      existing
      && existing.pid === myPid
      && existing.ownerToken === myToken
    ) {
      try {
        unlinkSync(lockPath);
      } catch {
        // ignore
      }
      return { released: true };
    }
    // 不是自己的锁：不得删除
    return { released: false, reason: "owner_mismatch" };
  }

  function isHeld() {
    return held;
  }

  function getOwnerToken() {
    return ownerToken;
  }

  return {
    acquire,
    release,
    isHeld,
    getOwnerToken,
    get lockPath() {
      return lockPath;
    },
  };
}

/**
 * 跨进程单实例锁（简化版）。
 *
 * 锁文件以 wx 独占创建，内容 {pid, startTime}。startTime 取 /proc/<pid>/stat 第 22 字段；
 * 无 /proc（macOS / Windows）时为 null，此时只检查 pid 存活，pid 复用可能误判为占用，
 * 需人工删除锁文件。
 *
 * 已存在的锁视为过期：pid 不存活；或 startTime 已知且与该 pid 当前启动时间不符（pid 复用）；
 * 或文件损坏。接管过期锁：先把旧文件 rename 为唯一名，rename 成功者才可独占创建新锁。
 */

import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "fs";
import { randomBytes } from "crypto";
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

/** 刚创建、尚未写完内容的锁文件在此时长内不按「损坏」接管。 */
const CORRUPT_GRACE_MS = 2000;
/** takeover 守卫超过此时长视为崩溃残留。 */
const GUARD_STALE_MS = 10_000;

/** @returns {string|null} /proc/<pid>/stat 第 22 字段（进程启动时间），不可用时 null */
export function readProcessStartTime(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // 第 2 字段 comm 可含空格/括号，从最后一个 ')' 之后数：第 3 字段起
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return fields[19] ?? null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code !== "ESRCH";
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function busy(message) {
  return new InstanceLockError(message, "INSTANCE_LOCK_BUSY");
}

/**
 * @param {object} options
 * @param {string} options.lockPath
 */
export function createInstanceLock({ lockPath } = {}) {
  if (!lockPath || typeof lockPath !== "string") {
    throw new TypeError("createInstanceLock 需要 lockPath");
  }
  const pid = process.pid;
  const startTime = readProcessStartTime(pid);
  let held = false;

  /** 独占创建锁文件；已存在返回 false，其他 IO 错误抛出。 */
  function tryCreate() {
    let fd;
    try {
      fd = openSync(lockPath, "wx");
    } catch (err) {
      if (err?.code === "EEXIST") return false;
      throw new InstanceLockError(
        `无法创建实例锁：${err?.code ?? err?.message ?? "unknown"}`,
        "INSTANCE_LOCK_IO_FAILED",
        1,
      );
    }
    try {
      writeSync(fd, `${JSON.stringify({ pid, startTime })}\n`);
    } finally {
      closeSync(fd);
    }
    return true;
  }

  /** @returns {{ raw: string|null, owner: {pid:number, startTime:string|null}|null }} raw=null 表示文件已不存在 */
  function readLock() {
    let raw;
    try {
      raw = readFileSync(lockPath, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") return { raw: null, owner: null };
      return { raw: "", owner: null };
    }
    try {
      const data = JSON.parse(raw);
      if (Number.isInteger(data?.pid) && data.pid > 0
        && (data.startTime === null || typeof data.startTime === "string")) {
        return { raw, owner: { pid: data.pid, startTime: data.startTime } };
      }
    } catch {
      // 损坏
    }
    return { raw, owner: null };
  }

  function isStale(owner) {
    if (!owner) return true; // 损坏
    if (!isProcessAlive(owner.pid)) return true;
    const current = readProcessStartTime(owner.pid);
    if (owner.startTime != null && current != null) return owner.startTime !== current;
    // 无法比对启动时间：只有「pid 就是本进程而本实例未持锁」时视为崩溃残留
    return owner.pid === pid;
  }

  /** 损坏文件可能是对方刚 wx 创建、尚未写完：在宽限期内等待它写完。 */
  function readSettled() {
    let lock = readLock();
    while (lock.raw !== null && !lock.owner) {
      let age;
      try {
        age = Date.now() - statSync(lockPath).mtimeMs;
      } catch {
        return readLock();
      }
      if (age >= CORRUPT_GRACE_MS) break;
      sleepSync(50);
      lock = readLock();
    }
    return lock;
  }

  /**
   * 接管过期锁。takeover 守卫（wx 独占）保证同一时刻只有一个进程在 rename：
   * 否则持旧视图的进程可能把刚接管者的新锁 rename 走，出现两个胜者。
   */
  function takeOver(staleRaw) {
    const guardPath = `${lockPath}.takeover`;
    let guardFd;
    try {
      guardFd = openSync(guardPath, "wx");
    } catch (err) {
      if (err?.code === "EEXIST") {
        // 守卫残留（接管者在极短窗口内崩溃）：清理后本次仍按占用退出，由进程管理器重启再试
        try {
          if (Date.now() - statSync(guardPath).mtimeMs > GUARD_STALE_MS) unlinkSync(guardPath);
        } catch {
          // ignore
        }
      }
      throw busy("实例锁竞争失败");
    }
    closeSync(guardFd);
    try {
      // 持守卫后复核：锁仍是刚才判定过期的那一份
      const again = readLock();
      if (again.raw !== null && again.raw !== staleRaw) {
        throw busy("实例锁竞争失败");
      }
      const stalePath = `${lockPath}.stale.${pid}.${randomBytes(6).toString("hex")}`;
      let renamed = false;
      try {
        renameSync(lockPath, stalePath);
        renamed = true;
      } catch (err) {
        if (err?.code !== "ENOENT") throw busy("实例锁竞争失败");
        // 已被他人移走：重试一次独占创建
      }
      const created = tryCreate();
      if (renamed) {
        try { unlinkSync(stalePath); } catch { /* ignore */ }
      }
      if (!created) throw busy("实例锁竞争失败");
      held = true;
      return { acquired: true, lockPath, pid, reclaimed: renamed };
    } finally {
      try { unlinkSync(guardPath); } catch { /* ignore */ }
    }
  }

  function acquire() {
    if (held) return { acquired: true, lockPath, pid, reentrant: true };
    mkdirSync(dirname(lockPath), { recursive: true });

    if (tryCreate()) {
      held = true;
      return { acquired: true, lockPath, pid };
    }

    const lock = readSettled();
    if (lock.raw !== null) {
      if (!isStale(lock.owner)) {
        throw busy(`另一个 TeaParty-Bell 进程正在运行（pid=${lock.owner.pid}）`);
      }
      return takeOver(lock.raw);
    }

    // 读的时候锁已消失：重试一次独占创建
    if (tryCreate()) {
      held = true;
      return { acquired: true, lockPath, pid };
    }
    throw busy("实例锁竞争失败");
  }

  /** 正常关闭时释放；仅当锁文件仍是本进程的（pid 一致）才删除。 */
  function release() {
    if (!held) return { released: false };
    held = false;
    const { owner } = readLock();
    if (owner?.pid === pid) {
      try { unlinkSync(lockPath); } catch { /* ignore */ }
      return { released: true };
    }
    return { released: false, reason: "owner_mismatch" };
  }

  return {
    acquire,
    release,
    isHeld: () => held,
    get lockPath() {
      return lockPath;
    },
  };
}

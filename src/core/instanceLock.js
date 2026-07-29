/**
 * 跨进程单实例锁：原子发布完整 owner payload。
 *
 * 发布路径：
 *   1. 同目录写临时文件（完整 JSON）
 *   2. fsync + close
 *   3. linkSync(temp → canonical)  — no-overwrite 原子发布
 *   4. 删除临时文件
 *
 * canonical 一旦可见即含完整合法 payload。
 * 非法 canonical → INSTANCE_LOCK_INVALID / exit 78，不自动回收。
 * 合法死 PID → rename claim 后重新原子发布。
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
  linkSync,
  fsyncSync,
  readdirSync,
} from "fs";
import { randomBytes } from "crypto";
import { dirname, basename, join } from "path";

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
    if (err && (err.code === "EPERM" || err.code === "EACCES")) return true;
    return false;
  }
}

function newOwnerToken() {
  try {
    return randomBytes(16).toString("hex");
  } catch {
    return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  }
}

function isValidPayload(data) {
  if (!data || typeof data !== "object") return false;
  if (typeof data.pid !== "number" || !Number.isInteger(data.pid) || data.pid <= 0) {
    return false;
  }
  if (typeof data.ownerToken !== "string" || data.ownerToken.length < 8) {
    return false;
  }
  if (data.acquiredAt != null && typeof data.acquiredAt !== "string") {
    return false;
  }
  return true;
}

/**
 * @param {object} options
 * @param {string} options.lockPath
 * @param {number} [options.pid]
 * @param {(pid:number)=>boolean} [options.isProcessAlive]
 * @param {()=>number} [options.now]
 * @param {()=>string} [options.createOwnerToken]
 * @param {()=>void} [options.afterTempWriteBeforePublish] 测试：临时文件已写好、尚未 link 到 canonical
 * @param {()=>void} [options.afterPublish] 测试：canonical 发布后
 */
export function createInstanceLock({
  lockPath,
  pid = process.pid,
  isProcessAlive = defaultIsProcessAlive,
  now = () => Date.now(),
  createOwnerToken = newOwnerToken,
  afterTempWriteBeforePublish = null,
  afterPublish = null,
} = {}) {
  if (!lockPath || typeof lockPath !== "string") {
    throw new TypeError("createInstanceLock 需要 lockPath");
  }

  let held = false;
  let ownerToken = null;
  const lockDir = dirname(lockPath);
  const lockBase = basename(lockPath);

  function ensureParentDir() {
    mkdirSync(lockDir, { recursive: true });
  }

  function tempPathFor(token) {
    return join(lockDir, `.${lockBase}.tmp.${token}`);
  }

  function claimPathFor(token) {
    return join(lockDir, `.${lockBase}.claim.${token}`);
  }

  /**
   * @returns {{ ok: true, payload: object } | { ok: false, reason: 'missing'|'invalid' }}
   */
  function readCanonical() {
    if (!existsSync(lockPath)) {
      return { ok: false, reason: "missing" };
    }
    let raw;
    try {
      raw = readFileSync(lockPath, "utf8");
    } catch {
      return { ok: false, reason: "invalid" };
    }
    if (!raw || !String(raw).trim()) {
      return { ok: false, reason: "invalid" };
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      return { ok: false, reason: "invalid" };
    }
    if (!isValidPayload(data)) {
      return { ok: false, reason: "invalid" };
    }
    return {
      ok: true,
      payload: {
        pid: data.pid,
        ownerToken: data.ownerToken,
        acquiredAt: typeof data.acquiredAt === "string" ? data.acquiredAt : null,
      },
    };
  }

  function busy(message, code = "INSTANCE_LOCK_BUSY") {
    throw new InstanceLockError(message, code, INSTANCE_LOCK_BUSY_EXIT_CODE);
  }

  function invalid(message) {
    throw new InstanceLockError(message, "INSTANCE_LOCK_INVALID", INSTANCE_LOCK_BUSY_EXIT_CODE);
  }

  function safeUnlink(p) {
    try {
      if (p && existsSync(p)) unlinkSync(p);
    } catch {
      // ignore
    }
  }

  /**
   * 将完整 payload 原子发布到 canonical lockPath。
   * @returns {string} ownerToken
   */
  function publishPayload() {
    const token = createOwnerToken();
    const tempPath = tempPathFor(token);
    const body = `${JSON.stringify({
      pid,
      ownerToken: token,
      acquiredAt: new Date(now()).toISOString(),
    })}\n`;

    let fd = null;
    try {
      fd = openSync(tempPath, "wx");
      writeFileSync(fd, body, "utf8");
      try {
        fsyncSync(fd);
      } catch {
        // 部分环境/FS 可能不支持 fsync；payload 已完整写入
      }
      closeSync(fd);
      fd = null;

      if (typeof afterTempWriteBeforePublish === "function") {
        afterTempWriteBeforePublish({ tempPath, lockPath, token });
      }

      // 原子 no-overwrite 发布：canonical 已存在则 EEXIST
      linkSync(tempPath, lockPath);
    } catch (err) {
      if (fd != null) {
        try { closeSync(fd); } catch { /* */ }
      }
      safeUnlink(tempPath);
      throw err;
    }

    safeUnlink(tempPath);

    if (typeof afterPublish === "function") {
      afterPublish({ lockPath, token });
    }

    return token;
  }

  /**
   * 原子 reclaim：rename 移走旧锁，再 publish 新锁。
   * @returns {boolean}
   */
  function tryReclaimDead(existingPayload) {
    if (!existingPayload || isProcessAlive(existingPayload.pid)) {
      return false;
    }

    const claimToken = createOwnerToken();
    const claimPath = claimPathFor(claimToken);
    try {
      renameSync(lockPath, claimPath);
    } catch {
      return false;
    }

    try {
      const token = publishPayload();
      ownerToken = token;
      held = true;
      safeUnlink(claimPath);
      return true;
    } catch {
      // 发布失败：若 canonical 仍不存在，尽量还原 claim
      try {
        if (!existsSync(lockPath) && existsSync(claimPath)) {
          renameSync(claimPath, lockPath);
        } else {
          safeUnlink(claimPath);
        }
      } catch {
        // ignore
      }
      return false;
    }
  }

  /**
   * 清理本模块命名的遗留临时文件（不删其他文件）。
   */
  function cleanupOrphanTemps() {
    try {
      const names = readdirSync(lockDir);
      const prefixTmp = `.${lockBase}.tmp.`;
      for (const name of names) {
        if (name.startsWith(prefixTmp)) {
          safeUnlink(join(lockDir, name));
        }
      }
    } catch {
      // ignore
    }
  }

  /**
   * @returns {{ acquired: true, lockPath: string, pid: number, ownerToken: string }}
   */
  function acquire() {
    if (held) {
      return { acquired: true, lockPath, pid, ownerToken, reentrant: true };
    }
    ensureParentDir();
    cleanupOrphanTemps();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const token = publishPayload();
        ownerToken = token;
        held = true;
        return { acquired: true, lockPath, pid, ownerToken };
      } catch (err) {
        if (err instanceof InstanceLockError) throw err;

        if (err?.code !== "EEXIST") {
          // link 失败且非 EEXIST
          throw new InstanceLockError(
            `无法创建实例锁：${err?.code ?? err?.message ?? "unknown"}`,
            "INSTANCE_LOCK_IO_FAILED",
            1,
          );
        }

        // canonical 已存在
        const read = readCanonical();
        if (read.reason === "invalid") {
          invalid("实例锁文件非法或损坏，拒绝自动回收，请人工检查");
        }
        if (read.reason === "missing") {
          // 竞态：存在性变化，重试
          continue;
        }

        const existing = read.payload;
        if (existing.pid === pid && held) {
          return { acquired: true, lockPath, pid, ownerToken, reentrant: true };
        }

        if (isProcessAlive(existing.pid) && existing.pid !== pid) {
          busy(`另一个 TeaParty-Bell 进程正在运行（pid=${existing.pid}）`);
        }

        // 死 PID 或崩溃残留（同 pid 但本进程未 held）
        if (!isProcessAlive(existing.pid) || existing.pid === pid) {
          if (tryReclaimDead(existing)) {
            return { acquired: true, lockPath, pid, ownerToken };
          }
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

    const read = readCanonical();
    if (
      read.ok
      && read.payload.pid === myPid
      && read.payload.ownerToken === myToken
    ) {
      safeUnlink(lockPath);
      return { released: true };
    }
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
    /** 测试用 */
    _readCanonical: readCanonical,
  };
}

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

export const COC_MVP_STATE_VERSION = 1;

function defaultMakeTempName(filePath) {
  return `${filePath}.tmp-${randomBytes(8).toString("hex")}`;
}

/**
 * MVP 临时场次文件。损坏时 fail closed，不改写成空名单。
 */
export function createCocSessionStore({
  filePath,
  fs: fsOps,
  makeTempName = defaultMakeTempName,
} = {}) {
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    throw new TypeError("createCocSessionStore 需要 filePath");
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
  let queue = Promise.resolve();
  /** @type {{ version: number, sessions: object[] }|null} */
  let memory = null;
  let broken = false;

  function enqueue(operation) {
    const task = queue.then(operation, operation);
    queue = task.then(() => {}, () => {});
    return task;
  }

  function emptyState() {
    return { version: COC_MVP_STATE_VERSION, sessions: [] };
  }

  function validate(parsed) {
    if (!parsed || parsed.version !== COC_MVP_STATE_VERSION || !Array.isArray(parsed.sessions)) {
      return false;
    }
    return parsed.sessions.every((session) => (
      session
      && typeof session.sessionId === "string"
      && typeof session.state === "string"
      && typeof session.kpUserId === "string"
      && (Array.isArray(session.pl) || Array.isArray(session.kl))
      && Array.isArray(session.ob)
    ));
  }

  function readFromDisk() {
    if (!fs.existsSync(filePath)) {
      return { ok: true, state: emptyState(), missing: true };
    }
    let text;
    try {
      text = fs.readFileSync(filePath, "utf8");
    } catch {
      return { ok: false, errorCode: "STATE_READ_FAILED" };
    }
    try {
      const parsed = JSON.parse(text);
      if (!validate(parsed)) return { ok: false, errorCode: "STATE_INVALID" };
      let migrated = false;
      const sessions = parsed.sessions.map((session) => {
        if (!Array.isArray(session.pl) && Array.isArray(session.kl)) migrated = true;
        const pl = Array.isArray(session.pl) ? session.pl : session.kl;
        const next = { ...session, pl, pendingMemberOp: session.pendingMemberOp ?? null };
        delete next.kl;
        return next;
      });
      return { ok: true, state: { ...parsed, sessions }, missing: false, migrated };
    } catch {
      return { ok: false, errorCode: "STATE_INVALID" };
    }
  }

  function atomicWrite(state) {
    const dir = dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = makeTempName(filePath);
    const json = `${JSON.stringify(state, null, 2)}\n`;
    let fd = null;
    try {
      fd = fs.openSync(tmpPath, "w");
      fs.writeSync(fd, json, 0, "utf8");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
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
  }

  async function load() {
    return enqueue(async () => {
      const loaded = readFromDisk();
      if (!loaded.ok) {
        broken = true;
        memory = null;
        return loaded;
      }
      if (loaded.migrated) {
        try {
          atomicWrite(loaded.state);
        } catch {
          return { ok: false, errorCode: "STATE_WRITE_FAILED" };
        }
      }
      broken = false;
      memory = loaded.state;
      return { ok: true, state: memory };
    });
  }

  function snapshot() {
    return memory ? structuredClone(memory) : null;
  }

  /**
   * @param {(state: { version: number, sessions: object[] }) => { state: object, result?: unknown }|{ errorCode: string, message: string }} mutator
   */
  async function update(mutator) {
    return enqueue(async () => {
      if (broken) return { ok: false, errorCode: "STATE_INVALID", message: "CoC 场次记录暂时不可用。" };
      if (!memory) {
        const loaded = readFromDisk();
        if (!loaded.ok) {
          broken = true;
          return { ok: false, errorCode: loaded.errorCode, message: "CoC 场次记录暂时不可用。" };
        }
        memory = loaded.state;
      }
      const draft = structuredClone(memory);
      const changed = mutator(draft);
      if (!changed || changed.errorCode) {
        return {
          ok: false,
          errorCode: changed?.errorCode ?? "REJECTED",
          message: changed?.message ?? "这次操作没有写成。",
        };
      }
      try {
        atomicWrite(changed.state);
      } catch {
        return { ok: false, errorCode: "STATE_WRITE_FAILED", message: "场次记录没有保存成功，请稍后再试。" };
      }
      memory = changed.state;
      return { ok: true, state: memory, result: changed.result ?? null };
    });
  }

  return { load, update, snapshot, filePath };
}

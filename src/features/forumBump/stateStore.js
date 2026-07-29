/**
 * Forum Bump 状态 Store：原子写、串行队列、revision 保护。
 *
 * 不自动初始化；不调用 Discord；不生成冷却抖动。
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
  cloneState,
  createInitialState,
  createStateError,
  FORUM_BUMP_STATE_VERSION,
  isForumBumpStateError,
  validateState,
} from "./stateSchema.js";
import {
  abandonBeforeSendTransition,
  beginInFlightTransition,
  completeSuccessTransition,
  deferUntilTransition,
  markMessageDeletedTransition,
  markMessageSentTransition,
  pauseTransition,
  restoreNextEligibleAtTransition,
  resumeTransition,
  rolloverLocalDateTransition,
} from "./stateTransitions.js";
import { planStartupRecovery } from "./stateRecovery.js";

function defaultMakeTempName(statePath) {
  const id = randomBytes(8).toString("hex");
  return `${statePath}.tmp-${id}`;
}

function emptyResult(operation, extras = {}) {
  return {
    operation,
    success: false,
    changed: false,
    state: null,
    previousRevision: null,
    revision: null,
    errorCode: null,
    recoveryStatus: null,
    cleanupRequired: false,
    ...extras,
  };
}

/**
 * @param {object} options
 * @param {string} options.statePath
 * @param {object} [options.fs]
 * @param {object} [options.logger]
 * @param {{ now: () => number }} [options.clock]
 * @param {(statePath: string) => string} [options.makeTempName]
 */
export function createForumBumpStateStore({
  statePath,
  fs: fsOps,
  logger,
  clock = { now: () => Date.now() },
  makeTempName = defaultMakeTempName,
} = {}) {
  if (typeof statePath !== "string" || statePath.trim().length === 0) {
    throw new TypeError("createForumBumpStateStore 需要 statePath");
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
  let _state = null;
  /** @type {Promise<void>} */
  let _writeQueue = Promise.resolve();

  function _enqueue(operation) {
    const task = _writeQueue.then(operation);
    _writeQueue = task.then(() => {}, () => {});
    return task;
  }

  function _ensureDir() {
    const dir = dirname(statePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  /**
   * 原子写：tmp → write → fsync(文件，失败则 fail closed) → close → rename
   * 目录 fsync 仍 best-effort。
   */
  function _atomicWrite(state) {
    _ensureDir();
    const tmpPath = makeTempName(statePath);
    const json = `${JSON.stringify(state, null, 2)}\n`;
    let fd = null;
    try {
      fd = fs.openSync(tmpPath, "w");
      fs.writeSync(fd, json, 0, "utf8");
      // 文件级 fsync：失败必须 fail closed，不得 rename
      try {
        fs.fsyncSync(fd);
      } catch (fsyncError) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore close after fsync failure
        }
        fd = null;
        try {
          if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
        } catch {
          // ignore cleanup
        }
        throw createStateError("STATE_WRITE_FAILED", fsyncError);
      }
      fs.closeSync(fd);
      fd = null;
      fs.renameSync(tmpPath, statePath);
      // 目录 fsync best-effort：仅忽略平台不支持或目录 fsync 失败
      try {
        const dirFd = fs.openSync(dirname(statePath), "r");
        try {
          fs.fsyncSync(dirFd);
        } catch {
          // 目录 fsync 失败不破坏已成功 rename 的提交
        } finally {
          try {
            fs.closeSync(dirFd);
          } catch {
            // ignore
          }
        }
      } catch {
        // 打开目录失败（平台限制）可忽略
      }
    } catch (error) {
      if (isForumBumpStateError(error) && error.code === "STATE_WRITE_FAILED") {
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
      throw createStateError("STATE_WRITE_FAILED", error);
    }
  }

  function _readAndValidateFromDisk() {
    if (!fs.existsSync(statePath)) {
      throw createStateError("STATE_NOT_FOUND");
    }
    let raw;
    try {
      raw = fs.readFileSync(statePath, "utf8");
    } catch (error) {
      throw createStateError("STATE_READ_FAILED", error);
    }
    if (typeof raw !== "string" || raw.trim() === "") {
      throw createStateError("STATE_PARSE_FAILED");
    }
    let data;
    try {
      data = JSON.parse(raw);
    } catch (error) {
      throw createStateError("STATE_PARSE_FAILED", error);
    }
    if (data && typeof data === "object" && !Array.isArray(data)
      && "version" in data
      && data.version !== FORUM_BUMP_STATE_VERSION
      && typeof data.version === "number") {
      throw createStateError("STATE_VERSION_UNSUPPORTED");
    }
    return validateState(data);
  }

  async function _applyTransition(operation, expectedRevision, transitionFn) {
    return _enqueue(async () => {
      const started = clock.now();
      try {
        if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
          throw createStateError("STATE_ARGUMENT_INVALID", undefined, { operation, expectedRevision });
        }

        // 写入前从磁盘重新读取并严格校验，不得仅信内存 _state.revision
        const diskState = _readAndValidateFromDisk();
        _state = diskState;

        if (diskState.revision !== expectedRevision) {
          throw createStateError("STATE_REVISION_CONFLICT", undefined, {
            operation,
            expectedRevision,
            actualRevision: diskState.revision,
          });
        }

        const result = transitionFn(diskState);
        if (!result.ok) {
          throw createStateError(result.errorCode, undefined, result.context ?? { operation });
        }

        if (!result.changed) {
          const snap = cloneState(diskState);
          try {
            logger?.info?.("[ForumBumpState] noop", {
              operation,
              revision: snap.revision,
              changed: false,
            });
          } catch {
            // ignore
          }
          return {
            operation,
            success: true,
            changed: false,
            state: snap,
            previousRevision: snap.revision,
            revision: snap.revision,
            errorCode: null,
            recoveryStatus: null,
            cleanupRequired: false,
          };
        }

        const previousRevision = diskState.revision;
        const next = cloneState(result.state);
        next.revision = previousRevision + 1;
        validateState(next);
        _atomicWrite(next);
        _state = next;

        try {
          logger?.info?.("[ForumBumpState] updated", {
            operation,
            previousRevision,
            revision: next.revision,
            localDate: next.localDate,
            successCount: next.successCount,
            paused: next.paused,
            pauseReason: next.pauseReason,
            inFlightPhase: next.inFlight?.phase ?? null,
            durationMs: Math.max(0, clock.now() - started),
          });
        } catch {
          // ignore
        }

        return {
          operation,
          success: true,
          changed: true,
          state: cloneState(_state),
          previousRevision,
          revision: _state.revision,
          errorCode: null,
          recoveryStatus: null,
          cleanupRequired: false,
        };
      } catch (error) {
        const code = isForumBumpStateError(error) ? error.code : "STATE_WRITE_FAILED";
        try {
          logger?.warn?.("[ForumBumpState] operation failed", {
            operation,
            errorCode: code,
            expectedRevision: expectedRevision ?? null,
          });
        } catch {
          // ignore
        }
        return {
          ...emptyResult(operation),
          errorCode: code,
          state: _state ? cloneState(_state) : null,
          previousRevision: _state?.revision ?? null,
          revision: _state?.revision ?? null,
        };
      }
    });
  }

  async function initialize({ localDate } = {}) {
    return _enqueue(async () => {
      try {
        if (fs.existsSync(statePath)) {
          throw createStateError("STATE_ALREADY_EXISTS");
        }
        const initial = createInitialState(localDate);
        _atomicWrite(initial);
        _state = cloneState(initial);
        try {
          logger?.info?.("[ForumBumpState] initialized", {
            operation: "initialize",
            revision: 0,
            localDate: initial.localDate,
          });
        } catch {
          // ignore
        }
        return {
          operation: "initialize",
          success: true,
          changed: true,
          state: cloneState(_state),
          previousRevision: null,
          revision: 0,
          errorCode: null,
          recoveryStatus: null,
          cleanupRequired: false,
        };
      } catch (error) {
        const code = isForumBumpStateError(error) ? error.code : "STATE_WRITE_FAILED";
        return {
          ...emptyResult("initialize"),
          errorCode: code,
        };
      }
    });
  }

  async function load() {
    return _enqueue(async () => {
      try {
        const loaded = _readAndValidateFromDisk();
        _state = loaded;
        return {
          operation: "load",
          success: true,
          changed: false,
          state: cloneState(_state),
          previousRevision: null,
          revision: _state.revision,
          errorCode: null,
          recoveryStatus: null,
          cleanupRequired: false,
        };
      } catch (error) {
        _state = null;
        const code = isForumBumpStateError(error) ? error.code : "STATE_READ_FAILED";
        return {
          ...emptyResult("load"),
          errorCode: code,
        };
      }
    });
  }

  function getSnapshot() {
    if (!_state) return null;
    return cloneState(_state);
  }

  async function beginInFlight({
    expectedRevision,
    operationId,
    guildId,
    forumChannelId,
    threadId,
    startedAt,
  } = {}) {
    return _applyTransition("beginInFlight", expectedRevision, (state) =>
      beginInFlightTransition(state, {
        operationId,
        guildId,
        forumChannelId,
        threadId,
        startedAt,
      }));
  }

  async function markMessageSent({
    expectedRevision,
    operationId,
    sentMessageId,
    sentAt,
  } = {}) {
    return _applyTransition("markMessageSent", expectedRevision, (state) =>
      markMessageSentTransition(state, { operationId, sentMessageId, sentAt }));
  }

  async function markMessageDeleted({
    expectedRevision,
    operationId,
    deletedAt,
  } = {}) {
    return _applyTransition("markMessageDeleted", expectedRevision, (state) =>
      markMessageDeletedTransition(state, { operationId, deletedAt }));
  }

  async function completeSuccess({
    expectedRevision,
    operationId,
    localDate,
    successAt,
    nextEligibleAt,
  } = {}) {
    return _applyTransition("completeSuccess", expectedRevision, (state) =>
      completeSuccessTransition(state, {
        operationId,
        localDate,
        successAt,
        nextEligibleAt,
      }));
  }

  async function pause({ expectedRevision, reason } = {}) {
    return _applyTransition("pause", expectedRevision, (state) =>
      pauseTransition(state, { reason }));
  }

  async function resume({ expectedRevision } = {}) {
    return _applyTransition("resume", expectedRevision, (state) =>
      resumeTransition(state));
  }

  async function rolloverLocalDate({ expectedRevision, localDate } = {}) {
    return _applyTransition("rolloverLocalDate", expectedRevision, (state) =>
      rolloverLocalDateTransition(state, { localDate }));
  }

  async function abandonBeforeSend({ expectedRevision, operationId } = {}) {
    return _applyTransition("abandonBeforeSend", expectedRevision, (state) =>
      abandonBeforeSendTransition(state, { operationId }));
  }

  async function deferUntil({ expectedRevision, nextEligibleAt } = {}) {
    return _applyTransition("deferUntil", expectedRevision, (state) =>
      deferUntilTransition(state, { nextEligibleAt }));
  }

  /**
   * 配置补偿专用：可回写更早的 nextEligibleAt 或 null。
   */
  async function restoreNextEligibleAt({ expectedRevision, nextEligibleAt } = {}) {
    return _applyTransition("restoreNextEligibleAt", expectedRevision, (state) =>
      restoreNextEligibleAtTransition(state, { nextEligibleAt }));
  }

  async function recoverOnStartup() {
    return _enqueue(async () => {
      try {
        // 始终从磁盘重读，避免缓存掩盖损坏
        const loaded = _readAndValidateFromDisk();
        _state = loaded;
        const plan = planStartupRecovery(_state);
        if (!plan.changed) {
          return {
            operation: "recoverOnStartup",
            success: true,
            changed: false,
            state: cloneState(_state),
            previousRevision: _state.revision,
            revision: _state.revision,
            errorCode: null,
            recoveryStatus: plan.recoveryStatus,
            cleanupRequired: plan.cleanupRequired,
          };
        }

        const previousRevision = _state.revision;
        const next = cloneState(plan.nextState);
        next.revision = previousRevision + 1;
        validateState(next);
        _atomicWrite(next);
        _state = next;

        try {
          logger?.warn?.("[ForumBumpState] recovery pause applied", {
            operation: "recoverOnStartup",
            recoveryStatus: plan.recoveryStatus,
            pauseReason: next.pauseReason,
            previousRevision,
            revision: next.revision,
            inFlightPhase: next.inFlight?.phase ?? null,
          });
        } catch {
          // ignore
        }

        return {
          operation: "recoverOnStartup",
          success: true,
          changed: true,
          state: cloneState(_state),
          previousRevision,
          revision: _state.revision,
          errorCode: null,
          recoveryStatus: plan.recoveryStatus,
          cleanupRequired: plan.cleanupRequired,
        };
      } catch (error) {
        _state = null;
        const code = isForumBumpStateError(error) ? error.code : "STATE_READ_FAILED";
        return {
          ...emptyResult("recoverOnStartup"),
          errorCode: code,
          recoveryStatus: null,
          cleanupRequired: false,
        };
      }
    });
  }

  return {
    initialize,
    load,
    getSnapshot,
    beginInFlight,
    markMessageSent,
    markMessageDeleted,
    completeSuccess,
    pause,
    resume,
    rolloverLocalDate,
    abandonBeforeSend,
    deferUntil,
    restoreNextEligibleAt,
    recoverOnStartup,
  };
}

export { FORUM_BUMP_STATE_PATH } from "./stateSchema.js";

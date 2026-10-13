/**
 * Forum Bump 状态 Store：原子写、串行队列、revision 保护。
 *
 * 不自动初始化；不调用 Discord；不生成冷却抖动。
 */

import { existsSync, readFileSync } from "fs";
import { writeJsonAtomic } from "../../utils/atomicJson.js";
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
  planStartupRecovery,
  restoreNextEligibleAtTransition,
  resumeTransition,
  rolloverLocalDateTransition,
} from "./stateTransitions.js";


function result(operation, fields = {}) {
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
    ...fields,
  };
}

function errorCodeOf(error, fallback) {
  return isForumBumpStateError(error) ? error.code : fallback;
}

/** 方法名 → 纯状态转换；参数对象原样传给转换函数。 */
const TRANSITIONS = {
  beginInFlight: beginInFlightTransition,
  markMessageSent: markMessageSentTransition,
  markMessageDeleted: markMessageDeletedTransition,
  completeSuccess: completeSuccessTransition,
  pause: pauseTransition,
  resume: resumeTransition,
  rolloverLocalDate: rolloverLocalDateTransition,
  abandonBeforeSend: abandonBeforeSendTransition,
  deferUntil: deferUntilTransition,
  // 配置补偿专用：可回写更早的 nextEligibleAt 或 null
  restoreNextEligibleAt: restoreNextEligibleAtTransition,
};

/**
 * @param {object} options
 * @param {string} options.statePath
 * @param {object} [options.fs]
 * @param {object} [options.logger]
 * @param {{ now: () => number }} [options.clock]
 */
export function createForumBumpStateStore({
  statePath,
  fs: fsOps,
  logger,
  clock = { now: () => Date.now() },
} = {}) {
  if (typeof statePath !== "string" || statePath.trim().length === 0) {
    throw new TypeError("createForumBumpStateStore 需要 statePath");
  }

  const fs = fsOps ?? { existsSync, readFileSync };

  /** @type {object|null} */
  let _state = null;
  let _queue = Promise.resolve();

  /** 所有读写串行执行。 */
  function _enqueue(operation) {
    const task = _queue.then(operation);
    _queue = task.then(() => {}, () => {});
    return task;
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
    // 版本号先于字段校验判定，未来版本即使字段不同也报 VERSION_UNSUPPORTED
    if (data && typeof data === "object" && !Array.isArray(data)
      && typeof data.version === "number" && data.version !== FORUM_BUMP_STATE_VERSION) {
      throw createStateError("STATE_VERSION_UNSUPPORTED");
    }
    return validateState(data);
  }

  /** 原子写；失败 fail closed（不 rename、内存状态不变）。 */
  function _write(doc) {
    try {
      writeJsonAtomic(statePath, doc, { fs, fsyncDir: true });
    } catch (error) {
      throw createStateError("STATE_WRITE_FAILED", error);
    }
  }

  /** 校验并写入 revision+1 的新状态。 */
  function _commit(nextState, previousRevision) {
    const next = cloneState(nextState);
    next.revision = previousRevision + 1;
    validateState(next);
    _write(next);
    _state = next;
    return next;
  }

  function _applyTransition(operation, args, transitionFn) {
    const { expectedRevision } = args;
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

        const t = transitionFn(diskState, args);
        if (!t.ok) {
          throw createStateError(t.errorCode, undefined, t.context ?? { operation });
        }
        if (!t.changed) {
          logger?.info?.("[ForumBumpState] noop", { operation, revision: diskState.revision, changed: false });
          return result(operation, {
            success: true,
            state: cloneState(diskState),
            previousRevision: diskState.revision,
            revision: diskState.revision,
          });
        }

        const previousRevision = diskState.revision;
        const next = _commit(t.state, previousRevision);
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
        return result(operation, {
          success: true,
          changed: true,
          state: cloneState(next),
          previousRevision,
          revision: next.revision,
        });
      } catch (error) {
        const code = errorCodeOf(error, "STATE_WRITE_FAILED");
        logger?.warn?.("[ForumBumpState] operation failed", {
          operation,
          errorCode: code,
          expectedRevision: expectedRevision ?? null,
        });
        return result(operation, {
          errorCode: code,
          state: _state ? cloneState(_state) : null,
          previousRevision: _state?.revision ?? null,
          revision: _state?.revision ?? null,
        });
      }
    });
  }

  function initialize({ localDate } = {}) {
    return _enqueue(async () => {
      try {
        if (fs.existsSync(statePath)) {
          throw createStateError("STATE_ALREADY_EXISTS");
        }
        const initial = createInitialState(localDate);
        _write(initial);
        _state = cloneState(initial);
        logger?.info?.("[ForumBumpState] initialized", {
          operation: "initialize",
          revision: 0,
          localDate: initial.localDate,
        });
        return result("initialize", { success: true, changed: true, state: cloneState(_state), revision: 0 });
      } catch (error) {
        return result("initialize", { errorCode: errorCodeOf(error, "STATE_WRITE_FAILED") });
      }
    });
  }

  function load() {
    return _enqueue(async () => {
      try {
        _state = _readAndValidateFromDisk();
        return result("load", { success: true, state: cloneState(_state), revision: _state.revision });
      } catch (error) {
        _state = null;
        return result("load", { errorCode: errorCodeOf(error, "STATE_READ_FAILED") });
      }
    });
  }

  function getSnapshot() {
    return _state ? cloneState(_state) : null;
  }

  function recoverOnStartup() {
    return _enqueue(async () => {
      try {
        // 始终从磁盘重读，避免缓存掩盖损坏
        _state = _readAndValidateFromDisk();
        const plan = planStartupRecovery(_state);
        const meta = { recoveryStatus: plan.recoveryStatus, cleanupRequired: plan.cleanupRequired };
        const previousRevision = _state.revision;
        if (!plan.changed) {
          return result("recoverOnStartup", {
            success: true,
            state: cloneState(_state),
            previousRevision,
            revision: previousRevision,
            ...meta,
          });
        }
        const next = _commit(plan.nextState, previousRevision);
        logger?.warn?.("[ForumBumpState] recovery pause applied", {
          operation: "recoverOnStartup",
          recoveryStatus: plan.recoveryStatus,
          pauseReason: next.pauseReason,
          previousRevision,
          revision: next.revision,
          inFlightPhase: next.inFlight?.phase ?? null,
        });
        return result("recoverOnStartup", {
          success: true,
          changed: true,
          state: cloneState(next),
          previousRevision,
          revision: next.revision,
          ...meta,
        });
      } catch (error) {
        _state = null;
        return result("recoverOnStartup", { errorCode: errorCodeOf(error, "STATE_READ_FAILED") });
      }
    });
  }

  const transitions = Object.fromEntries(Object.entries(TRANSITIONS).map(([operation, fn]) => [
    operation,
    async (args = {}) => _applyTransition(operation, args, fn),
  ]));

  return {
    initialize,
    load,
    getSnapshot,
    ...transitions,
    recoverOnStartup,
  };
}

export { FORUM_BUMP_STATE_PATH } from "./stateSchema.js";

import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { createForumBumpStateStore } from "./stateStore.js";
import { createForumBumpScheduler, safeStateCall } from "./scheduler.js";
import { SCHEDULER_REFERENCE_DEFAULTS } from "./schedulerConfig.js";
import { createForumBumpService } from "./bumpService.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(a, e, l) {
  assert(a === e, `${l} (got ${JSON.stringify(a)})`);
}

const G = "111111111111111111";
const F = "222222222222222222";
const T = "333333333333333333";
const M = "444444444444444444";

console.log("\n=== ForumBump scheduler ===\n");

const dirs = [];

function clearScheduleForTest(sched, timers) {
  // 取消 start 注册的 timer，避免干扰 runOnce 断言
  for (const t of timers.list()) t.cancelled = true;
  // 通过 stop/start 太重；直接清 list 并置 nextWakeAt 依赖 runOnce 结果
  void sched;
}

function makeConfig(extra = {}) {
  return {
    enabled: true,
    guildId: G,
    forumChannelIds: [F],
    ...SCHEDULER_REFERENCE_DEFAULTS,
    // 测试窗口极宽，避免业务时区边界干扰
    activeStart: "00:00",
    activeEnd: "23:59",
    timezone: "UTC",
    cooldownMs: 60_000,
    cooldownJitterMs: 10_000,
    idlePollMs: 30_000,
    failureBackoffMs: 15_000,
    ...extra,
  };
}

function makeClock(start = Date.parse("2026-07-28T12:00:00.000Z")) {
  let t = start;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    set: (ms) => { t = ms; },
  };
}

function makeTimers() {
  const timers = [];
  let id = 0;
  return {
    setTimeout(fn, ms) {
      const handle = ++id;
      timers.push({ handle, fn, ms, cancelled: false, fired: false });
      return handle;
    },
    clearTimeout(handle) {
      const t = timers.find((x) => x.handle === handle);
      if (t) t.cancelled = true;
    },
    flush(handle) {
      const t = timers.find((x) => x.handle === handle && !x.cancelled && !x.fired);
      if (t) {
        t.fired = true;
        t.fn();
      }
    },
    // 活跃 = 未取消且未触发（one-shot timer 触发后不再活跃）
    list: () => timers.filter((t) => !t.cancelled && !t.fired),
  };
}

async function bootStore(dir, localDate = "2026-07-28") {
  const store = createForumBumpStateStore({
    statePath: join(dir, "state.json"),
    logger: { info() {}, warn() {}, error() {} },
  });
  await store.initialize({ localDate });
  return store;
}

try {
  // start 缺失状态失败
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = createForumBumpStateStore({
      statePath: join(dir, "state.json"),
      logger: { info() {}, warn() {} },
    });
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({ candidates: [] }),
      bumpService: { bumpThread: async () => ({ status: "skipped" }) },
      stateStore: store,
      config: makeConfig(),
      clock: makeClock(),
      timers: makeTimers(),
      random: () => 0,
      logger: { info() {}, warn() {} },
    });
    const r = await sched.start();
    assertEqual(r.success, false, "无状态 start 失败");
    assertEqual(r.errorCode, "STATE_NOT_FOUND", "STATE_NOT_FOUND");
  }

  // no_candidate + timer + single-flight
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const clock = makeClock();
    const timers = makeTimers();
    let scanCount = 0;
    let bumpCount = 0;
    const sched = createForumBumpScheduler({
      scanCandidates: async () => {
        scanCount += 1;
        return { candidates: [] };
      },
      bumpService: {
        bumpThread: async () => {
          bumpCount += 1;
          return { status: "skipped" };
        },
      },
      stateStore: store,
      config: makeConfig(),
      clock,
      timers,
      random: () => 0,
      createOperationId: () => "op-1",
      logger: { info() {}, warn() {} },
    });
    const st = await sched.start();
    assert(st.success, "start ok");
    const once = await sched.runOnce();
    assertEqual(once.status, "no_candidate", "无候选");
    assertEqual(scanCount, 1, "扫描一次");
    assertEqual(bumpCount, 0, "不 bump");
    assert(sched.getStatus().nextWakeAt != null, "安排 idle timer");

    const busy = await sched.runOnce();
    // 若未 running 可再跑；single-flight：并行
    const p1 = sched.runOnce();
    const p2 = sched.runOnce();
    const [a, b] = await Promise.all([p1, p2]);
    assert(
      a.status === "busy" || b.status === "busy" || a.status === "no_candidate",
      "single-flight 或顺序完成",
    );
  }

  // 完整成功 + jitter + 只顶一个
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const clock = makeClock();
    const timers = makeTimers();
    let bumpCalls = 0;
    const hooks = [];
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({
        candidates: [
          { threadId: T, forumChannelId: F, rank: 1 },
          { threadId: "999999999999999999", forumChannelId: F, rank: 2 },
        ],
      }),
      bumpService: {
        bumpThread: async ({ lifecycle, threadId }) => {
          bumpCalls += 1;
          assertEqual(threadId, T, "只选第一个候选");
          if (lifecycle?.onBeforeSend) await lifecycle.onBeforeSend({});
          hooks.push("before");
          if (lifecycle?.onMessageSent) {
            await lifecycle.onMessageSent({ sentMessageId: M });
          }
          hooks.push("sent");
          if (lifecycle?.onMessageDeleted) await lifecycle.onMessageDeleted({});
          hooks.push("deleted");
          return {
            status: "succeeded",
            success: true,
            cleanupRequired: false,
            sentMessageId: M,
            diagnosticsComplete: true,
          };
        },
      },
      stateStore: store,
      config: makeConfig({ cooldownMs: 60_000, cooldownJitterMs: 10_000 }),
      clock,
      timers,
      random: () => 0.5, // jitter = floor(0.5*10001)=5000
      createOperationId: () => "op-success",
      logger: { info() {}, warn() {} },
    });
    await sched.start();
    const r = await sched.runOnce();
    assertEqual(r.status, "succeeded", "成功");
    assertEqual(bumpCalls, 1, "只 bump 一次");
    assertEqual(hooks.join(","), "before,sent,deleted", "lifecycle 顺序");
    await store.load();
    const snap = store.getSnapshot();
    assertEqual(snap.successCount, 1, "额度 +1");
    assertEqual(snap.inFlight, null, "inFlight 清空");
    assert(snap.nextEligibleAt != null, "写入 nextEligibleAt");
    const expected = new Date(clock.now()).getTime(); // successAt ~ now after run
    // re-load nextEligible
    const nextMs = Date.parse(snap.nextEligibleAt);
    // successAt during complete uses clock.now() after bump - roughly cooldown+jitter
    assert(nextMs > clock.now(), "冷却在未来或边界");
  }

  // 删除失败 → pause 不 timer
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const clock = makeClock();
    const timers = makeTimers();
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({
        candidates: [{ threadId: T, forumChannelId: F }],
      }),
      bumpService: {
        bumpThread: async ({ lifecycle }) => {
          if (lifecycle?.onBeforeSend) await lifecycle.onBeforeSend({});
          if (lifecycle?.onMessageSent) {
            await lifecycle.onMessageSent({ sentMessageId: M });
          }
          return {
            status: "failed",
            success: false,
            cleanupRequired: true,
            errorCode: "DELETE_FAILED",
            sentMessageId: M,
          };
        },
      },
      stateStore: store,
      config: makeConfig(),
      clock,
      timers,
      random: () => 0,
      createOperationId: () => "op-del",
      logger: { info() {}, warn() {} },
    });
    await sched.start();
    const r = await sched.runOnce();
    assertEqual(r.status, "cleanup_required", "删除失败 cleanup");
    await store.load();
    assertEqual(store.getSnapshot().paused, true, "已 pause");
    assertEqual(store.getSnapshot().pauseReason, "BUMP_DELETE_FAILED", "pause reason");
    assertEqual(sched.getStatus().nextWakeAt, null, "无自动 timer");
  }

  // 发送失败 → abandon + backoff
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const clock = makeClock();
    const timers = makeTimers();
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({
        candidates: [{ threadId: T, forumChannelId: F }],
      }),
      bumpService: {
        bumpThread: async ({ lifecycle }) => {
          if (lifecycle?.onBeforeSend) await lifecycle.onBeforeSend({});
          return {
            status: "failed",
            success: false,
            cleanupRequired: false,
            errorCode: "SEND_FAILED",
            sentMessageId: null,
          };
        },
      },
      stateStore: store,
      config: makeConfig({ failureBackoffMs: 15_000 }),
      clock,
      timers,
      random: () => 0,
      createOperationId: () => "op-send-fail",
      logger: { info() {}, warn() {} },
    });
    await sched.start();
    const r = await sched.runOnce();
    assertEqual(r.status, "send_failed", "发送失败");
    await store.load();
    assertEqual(store.getSnapshot().inFlight, null, "abandon inFlight");
    assertEqual(store.getSnapshot().paused, false, "不 pause");
    assert(sched.getStatus().nextWakeAt != null, "failure backoff timer");
  }

  // 窗外不扫描
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    let scans = 0;
    // 08:00 UTC still inside our wide window - use SH window with early UTC
    const clock = makeClock(Date.parse("2026-07-28T00:00:00.000Z")); // 08:00 SH
    const sched = createForumBumpScheduler({
      scanCandidates: async () => {
        scans += 1;
        return { candidates: [] };
      },
      bumpService: { bumpThread: async () => ({ status: "skipped" }) },
      stateStore: store,
      config: makeConfig({
        timezone: "Asia/Shanghai",
        activeStart: "10:00",
        activeEnd: "22:00",
      }),
      clock,
      timers: makeTimers(),
      random: () => 0,
      logger: { info() {}, warn() {} },
    });
    await sched.start();
    const r = await sched.runOnce();
    assertEqual(r.status, "outside_window", "窗外");
    assertEqual(scans, 0, "窗外不扫描");
  }

  // stop 幂等 + 不留 timer
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const timers = makeTimers();
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({ candidates: [] }),
      bumpService: { bumpThread: async () => ({ status: "skipped" }) },
      stateStore: store,
      config: makeConfig(),
      clock: makeClock(),
      timers,
      random: () => 0,
      logger: { info() {}, warn() {} },
    });
    await sched.start();
    await sched.runOnce();
    await sched.stop();
    await sched.stop();
    assertEqual(sched.getStatus().started, false, "stopped");
    assertEqual(timers.list().length, 0, "无活跃 timer");
  }

  // lifecycle beforeSend 失败不 send（由 bumpService 保证）——调度侧 state_failed
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({
        candidates: [{ threadId: T, forumChannelId: F }],
      }),
      bumpService: {
        bumpThread: async ({ lifecycle }) => {
          try {
            await lifecycle.onBeforeSend({});
          } catch {
            return {
              status: "failed",
              success: false,
              errorCode: "LIFECYCLE_BEFORE_SEND_FAILED",
              cleanupRequired: false,
            };
          }
          return { status: "succeeded", success: true };
        },
      },
      stateStore: {
        ...await (async () => {
          // wrap store to fail beginInFlight
          const s = store;
          return {
            load: (...a) => s.load(...a),
            recoverOnStartup: (...a) => s.recoverOnStartup(...a),
            getSnapshot: () => s.getSnapshot(),
            rolloverLocalDate: (...a) => s.rolloverLocalDate(...a),
            beginInFlight: async () => ({ success: false, errorCode: "STATE_WRITE_FAILED" }),
            markMessageSent: (...a) => s.markMessageSent(...a),
            markMessageDeleted: (...a) => s.markMessageDeleted(...a),
            completeSuccess: (...a) => s.completeSuccess(...a),
            pause: (...a) => s.pause(...a),
            deferUntil: (...a) => s.deferUntil(...a),
            abandonBeforeSend: (...a) => s.abandonBeforeSend(...a),
          };
        })(),
      },
      config: makeConfig(),
      clock: makeClock(),
      timers: makeTimers(),
      random: () => 0,
      createOperationId: () => "op-life",
      logger: { info() {}, warn() {} },
    });
    await sched.start();
    const r = await sched.runOnce();
    assertEqual(r.status, "state_failed", "lifecycle before 失败");
  }

  // getStatus 无历史数组
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({ candidates: [] }),
      bumpService: { bumpThread: async () => ({ status: "skipped" }) },
      stateStore: store,
      config: makeConfig(),
      clock: makeClock(),
      timers: makeTimers(),
      random: () => 0,
      logger: { info() {}, warn() {} },
    });
    await sched.start();
    for (let i = 0; i < 5; i += 1) await sched.runOnce();
    const st = sched.getStatus();
    assert(!("history" in st), "无 history 字段");
    assert(typeof st.lastRunStatus === "string" || st.lastRunStatus == null, "仅 lastRunStatus");
  }

  // ---- Review Fix: 状态失败关闭 ----
  function wrapStore(store, overrides = {}) {
    return {
      load: (...a) => (overrides.load ? overrides.load(...a) : store.load(...a)),
      recoverOnStartup: (...a) => (overrides.recoverOnStartup
        ? overrides.recoverOnStartup(...a)
        : store.recoverOnStartup(...a)),
      getSnapshot: () => store.getSnapshot(),
      rolloverLocalDate: (...a) => (overrides.rolloverLocalDate
        ? overrides.rolloverLocalDate(...a)
        : store.rolloverLocalDate(...a)),
      beginInFlight: (...a) => (overrides.beginInFlight
        ? overrides.beginInFlight(...a)
        : store.beginInFlight(...a)),
      markMessageSent: (...a) => (overrides.markMessageSent
        ? overrides.markMessageSent(...a)
        : store.markMessageSent(...a)),
      markMessageDeleted: (...a) => (overrides.markMessageDeleted
        ? overrides.markMessageDeleted(...a)
        : store.markMessageDeleted(...a)),
      completeSuccess: (...a) => (overrides.completeSuccess
        ? overrides.completeSuccess(...a)
        : store.completeSuccess(...a)),
      pause: (...a) => (overrides.pause ? overrides.pause(...a) : store.pause(...a)),
      deferUntil: (...a) => (overrides.deferUntil
        ? overrides.deferUntil(...a)
        : store.deferUntil(...a)),
      abandonBeforeSend: (...a) => (overrides.abandonBeforeSend
        ? overrides.abandonBeforeSend(...a)
        : store.abandonBeforeSend(...a)),
    };
  }

  function tick() {
    return new Promise((resolve) => setImmediate(resolve));
  }

  async function flushAllTimers(timers) {
    const active = timers.list().slice();
    for (const t of active) {
      if (!t.cancelled && !t.fired) {
        t.fired = true;
        t.fn();
      }
    }
    await tick();
    await tick();
  }

  async function assertNoTimer(sched, timers, label) {
    assertEqual(sched.getStatus().nextWakeAt, null, `${label} nextWakeAt null`);
    assertEqual(timers.list().length, 0, `${label} 无活跃 timer`);
  }

  // Scanner 失败 + deferUntil 失败
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const timers = makeTimers();
    const sched = createForumBumpScheduler({
      scanCandidates: async () => { throw Object.assign(new Error("scan"), { code: "SCAN_FAILED" }); },
      bumpService: { bumpThread: async () => ({ status: "skipped" }) },
      stateStore: wrapStore(store, {
        deferUntil: async () => ({ success: false, errorCode: "STATE_WRITE_FAILED" }),
      }),
      config: makeConfig(),
      clock: makeClock(),
      timers,
      random: () => 0,
      logger: { info() {}, warn() {}, error() {} },
    });
    await sched.start();
    // clear start timer
    timers.list().forEach((t) => { t.cancelled = true; });
    const r = await sched.runOnce();
    assertEqual(r.status, "state_failed", "scan+defer fail → state_failed");
    await assertNoTimer(sched, timers, "scan+defer fail");
  }

  // Scanner 失败 + deferUntil throw
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const timers = makeTimers();
    const sched = createForumBumpScheduler({
      scanCandidates: async () => { throw new Error("scan boom"); },
      bumpService: { bumpThread: async () => ({ status: "skipped" }) },
      stateStore: wrapStore(store, {
        deferUntil: async () => { throw new Error("defer throw"); },
      }),
      config: makeConfig(),
      clock: makeClock(),
      timers,
      random: () => 0,
      logger: { info() {}, warn() {}, error() {} },
    });
    await sched.start();
    clearScheduleForTest(sched, timers);
    const r = await sched.runOnce();
    assertEqual(r.status, "state_failed", "scan+defer throw → state_failed");
    await assertNoTimer(sched, timers, "scan+defer throw");
  }

  // 无候选 + deferUntil 失败
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const timers = makeTimers();
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({ candidates: [] }),
      bumpService: { bumpThread: async () => ({ status: "skipped" }) },
      stateStore: wrapStore(store, {
        deferUntil: async () => ({ success: false, errorCode: "STATE_REVISION_CONFLICT" }),
      }),
      config: makeConfig(),
      clock: makeClock(),
      timers,
      random: () => 0,
      logger: { info() {}, warn() {}, error() {} },
    });
    await sched.start();
    clearScheduleForTest(sched, timers);
    const r = await sched.runOnce();
    assertEqual(r.status, "state_failed", "no_candidate+defer fail");
    assertEqual(r.errorCode, "STATE_REVISION_CONFLICT", "defer errorCode");
    await assertNoTimer(sched, timers, "no_candidate defer fail");
  }

  // skipped + deferUntil 失败
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const timers = makeTimers();
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({
        candidates: [{ threadId: T, forumChannelId: F }],
      }),
      bumpService: {
        bumpThread: async () => ({
          status: "skipped",
          success: false,
          errorCode: "NOT_SILENT_ENOUGH",
          skipReason: "NOT_SILENT_ENOUGH",
        }),
      },
      stateStore: wrapStore(store, {
        deferUntil: async () => ({ success: false, errorCode: "STATE_WRITE_FAILED" }),
      }),
      config: makeConfig(),
      clock: makeClock(),
      timers,
      random: () => 0,
      createOperationId: () => "op-skip",
      logger: { info() {}, warn() {}, error() {} },
    });
    await sched.start();
    clearScheduleForTest(sched, timers);
    const r = await sched.runOnce();
    assertEqual(r.status, "state_failed", "skipped+defer fail");
    await assertNoTimer(sched, timers, "skipped defer fail");
  }

  // SEND_FAILED + abandon 成功但 deferUntil 失败
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const timers = makeTimers();
    let deferCalls = 0;
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({
        candidates: [{ threadId: T, forumChannelId: F }],
      }),
      bumpService: {
        bumpThread: async ({ lifecycle }) => {
          if (lifecycle?.onBeforeSend) await lifecycle.onBeforeSend({});
          return {
            status: "failed",
            success: false,
            cleanupRequired: false,
            errorCode: "SEND_FAILED",
            sentMessageId: null,
          };
        },
      },
      stateStore: wrapStore(store, {
        deferUntil: async (...a) => {
          deferCalls += 1;
          return { success: false, errorCode: "STATE_WRITE_FAILED" };
        },
      }),
      config: makeConfig(),
      clock: makeClock(),
      timers,
      random: () => 0,
      createOperationId: () => "op-sf",
      logger: { info() {}, warn() {}, error() {} },
    });
    await sched.start();
    clearScheduleForTest(sched, timers);
    const r = await sched.runOnce();
    assertEqual(r.status, "state_failed", "SEND_FAILED+defer fail");
    assert(deferCalls >= 1, "调用了 deferUntil");
    await assertNoTimer(sched, timers, "send fail defer fail");
  }

  // DELETE_FAILED + pause 失败
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const timers = makeTimers();
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({
        candidates: [{ threadId: T, forumChannelId: F }],
      }),
      bumpService: {
        bumpThread: async ({ lifecycle }) => {
          if (lifecycle?.onBeforeSend) await lifecycle.onBeforeSend({});
          if (lifecycle?.onMessageSent) {
            await lifecycle.onMessageSent({ sentMessageId: M });
          }
          return {
            status: "failed",
            success: false,
            cleanupRequired: true,
            errorCode: "DELETE_FAILED",
            sentMessageId: M,
          };
        },
      },
      stateStore: wrapStore(store, {
        pause: async () => ({ success: false, errorCode: "STATE_WRITE_FAILED" }),
      }),
      config: makeConfig(),
      clock: makeClock(),
      timers,
      random: () => 0,
      createOperationId: () => "op-df",
      logger: { info() {}, warn() {}, error() {} },
    });
    await sched.start();
    clearScheduleForTest(sched, timers);
    const r = await sched.runOnce();
    assertEqual(r.status, "state_failed", "DELETE+pause fail");
    assertEqual(r.primaryErrorCode, "DELETE_FAILED", "primary DELETE");
    assertEqual(r.stateErrorCode, "STATE_WRITE_FAILED", "state error");
    await assertNoTimer(sched, timers, "delete pause fail");
  }

  // SEND_RESULT_INVALID + pause 失败
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const timers = makeTimers();
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({
        candidates: [{ threadId: T, forumChannelId: F }],
      }),
      bumpService: {
        bumpThread: async ({ lifecycle }) => {
          if (lifecycle?.onBeforeSend) await lifecycle.onBeforeSend({});
          return {
            status: "failed",
            success: false,
            cleanupRequired: false,
            errorCode: "SEND_RESULT_INVALID",
            sentMessageId: null,
          };
        },
      },
      stateStore: wrapStore(store, {
        pause: async () => ({ success: false, errorCode: "STATE_PAUSED" }),
      }),
      config: makeConfig(),
      clock: makeClock(),
      timers,
      random: () => 0,
      createOperationId: () => "op-sri",
      logger: { info() {}, warn() {}, error() {} },
    });
    await sched.start();
    clearScheduleForTest(sched, timers);
    const r = await sched.runOnce();
    assertEqual(r.status, "state_failed", "SRI+pause fail");
    assertEqual(r.primaryErrorCode, "SEND_RESULT_INVALID", "primary SRI");
    await assertNoTimer(sched, timers, "sri pause fail");
  }

  // completeSuccess 失败 + pause 成功 → reconciliation_required（after_delete 对账）
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const timers = makeTimers();
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({
        candidates: [{ threadId: T, forumChannelId: F }],
      }),
      bumpService: {
        bumpThread: async ({ lifecycle }) => {
          if (lifecycle?.onBeforeSend) await lifecycle.onBeforeSend({});
          if (lifecycle?.onMessageSent) {
            await lifecycle.onMessageSent({ sentMessageId: M });
          }
          if (lifecycle?.onMessageDeleted) await lifecycle.onMessageDeleted({});
          return {
            status: "succeeded",
            success: true,
            cleanupRequired: false,
            sentMessageId: M,
            diagnosticsComplete: true,
          };
        },
      },
      stateStore: wrapStore(store, {
        completeSuccess: async () => ({ success: false, errorCode: "STATE_REVISION_CONFLICT" }),
      }),
      config: makeConfig(),
      clock: makeClock(),
      timers,
      random: () => 0,
      createOperationId: () => "op-cs",
      logger: { info() {}, warn() {}, error() {} },
    });
    await sched.start();
    clearScheduleForTest(sched, timers);
    const r = await sched.runOnce();
    assertEqual(r.status, "reconciliation_required", "complete fail+pause ok → reconciliation");
    assertEqual(r.primaryErrorCode, "STATE_REVISION_CONFLICT", "primary complete error");
    await store.load();
    assertEqual(store.getSnapshot().paused, true, "pause 成功");
    await assertNoTimer(sched, timers, "complete fail");
  }

  // completeSuccess 失败 + pause 失败
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const timers = makeTimers();
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({
        candidates: [{ threadId: T, forumChannelId: F }],
      }),
      bumpService: {
        bumpThread: async ({ lifecycle }) => {
          if (lifecycle?.onBeforeSend) await lifecycle.onBeforeSend({});
          if (lifecycle?.onMessageSent) {
            await lifecycle.onMessageSent({ sentMessageId: M });
          }
          if (lifecycle?.onMessageDeleted) await lifecycle.onMessageDeleted({});
          return {
            status: "succeeded",
            success: true,
            cleanupRequired: false,
            sentMessageId: M,
          };
        },
      },
      stateStore: wrapStore(store, {
        completeSuccess: async () => ({ success: false, errorCode: "STATE_WRITE_FAILED" }),
        pause: async () => ({ success: false, errorCode: "STATE_REVISION_CONFLICT" }),
      }),
      config: makeConfig(),
      clock: makeClock(),
      timers,
      random: () => 0,
      createOperationId: () => "op-cs2",
      logger: { info() {}, warn() {}, error() {} },
    });
    await sched.start();
    clearScheduleForTest(sched, timers);
    const r = await sched.runOnce();
    assertEqual(r.status, "state_failed", "complete+pause both fail");
    assertEqual(r.primaryErrorCode, "STATE_WRITE_FAILED", "primary");
    assertEqual(r.stateErrorCode, "STATE_REVISION_CONFLICT", "stateError");
    await assertNoTimer(sched, timers, "both fail");
  }

  // ---- 意外异常边界 ----
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const timers = makeTimers();
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({
        candidates: [{ threadId: T, forumChannelId: F }],
      }),
      bumpService: { bumpThread: async () => ({ status: "skipped" }) },
      stateStore: store,
      config: makeConfig(),
      clock: makeClock(),
      timers,
      random: () => 0,
      createOperationId: () => { throw new Error("opid boom"); },
      logger: { info() {}, warn() {}, error() {} },
    });
    await sched.start();
    clearScheduleForTest(sched, timers);
    const r = await sched.runOnce();
    assertEqual(r.status, "unexpected_failed", "createOperationId throw");
    assertEqual(r.errorCode, "SCHEDULER_UNEXPECTED_FAILED", "unexpected code");
    assertEqual(sched.getStatus().running, false, "running false");
    assertEqual(sched.getStatus().lastRunStatus, "unexpected_failed", "lastRunStatus");
    await assertNoTimer(sched, timers, "opid throw");
  }

  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const timers = makeTimers();
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({
        candidates: [{ threadId: T, forumChannelId: F }],
      }),
      bumpService: {
        bumpThread: async () => { throw new Error("bump boom"); },
      },
      stateStore: store,
      config: makeConfig(),
      clock: makeClock(),
      timers,
      random: () => 0,
      createOperationId: () => "op-x",
      logger: { info() {}, warn() {}, error() {} },
    });
    await sched.start();
    clearScheduleForTest(sched, timers);
    let threw = false;
    let r;
    try {
      r = await sched.runOnce();
    } catch {
      threw = true;
    }
    assert(!threw, "runOnce 不裸抛");
    assertEqual(r.status, "unexpected_failed", "bump throw → unexpected");
    assertEqual(sched.getStatus().running, false, "running cleared");
    await assertNoTimer(sched, timers, "bump throw");
  }

  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const timers = makeTimers();
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({
        candidates: [{ threadId: T, forumChannelId: F }],
      }),
      bumpService: {
        bumpThread: async ({ lifecycle }) => {
          if (lifecycle?.onBeforeSend) await lifecycle.onBeforeSend({});
          if (lifecycle?.onMessageSent) {
            await lifecycle.onMessageSent({ sentMessageId: M });
          }
          if (lifecycle?.onMessageDeleted) await lifecycle.onMessageDeleted({});
          return {
            status: "succeeded",
            success: true,
            cleanupRequired: false,
            sentMessageId: M,
          };
        },
      },
      stateStore: store,
      config: makeConfig(),
      clock: makeClock(),
      timers,
      random: () => { throw new Error("rng"); },
      createOperationId: () => "op-rng",
      logger: { info() {}, warn() {}, error() {} },
    });
    await sched.start();
    clearScheduleForTest(sched, timers);
    const r = await sched.runOnce();
    assertEqual(r.status, "halted", "random throw → halted");
    assertEqual(r.errorCode, "SCHEDULER_RANDOM_INVALID", "random errorCode");
    await store.load();
    assertEqual(store.getSnapshot().paused, true, "random → paused");
    assertEqual(store.getSnapshot().pauseReason, "SCHEDULER_RANDOM_INVALID", "pauseReason");
    assertEqual(store.getSnapshot().inFlight?.phase, "after_delete", "inFlight 保留 after_delete");
    assertEqual(store.getSnapshot().successCount, 0, "random 不 completeSuccess");
    await assertNoTimer(sched, timers, "random throw");
  }

  // dailyLimit / cooldown 不扫描
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    // 人为把 successCount 拉满
    await store.load();
    // 用多次 complete 太重：直接写文件
    const path = join(dir, "state.json");
    const { readFileSync, writeFileSync } = await import("fs");
    const s = JSON.parse(readFileSync(path, "utf8"));
    s.successCount = 10;
    s.revision = 0;
    writeFileSync(path, `${JSON.stringify(s, null, 2)}\n`);
    let scans = 0;
    const sched = createForumBumpScheduler({
      scanCandidates: async () => {
        scans += 1;
        return { candidates: [] };
      },
      bumpService: { bumpThread: async () => ({ status: "skipped" }) },
      stateStore: store,
      config: makeConfig({ dailyLimit: 10 }),
      clock: makeClock(),
      timers: makeTimers(),
      random: () => 0,
      logger: { info() {}, warn() {} },
    });
    await sched.start();
    const r = await sched.runOnce();
    assertEqual(r.status, "daily_limit", "达上限");
    assertEqual(scans, 0, "达上限不扫描");
  }

  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const path = join(dir, "state.json");
    const { readFileSync, writeFileSync } = await import("fs");
    const s = JSON.parse(readFileSync(path, "utf8"));
    s.nextEligibleAt = "2099-01-01T00:00:00.000Z";
    writeFileSync(path, `${JSON.stringify(s, null, 2)}\n`);
    let scans = 0;
    const sched = createForumBumpScheduler({
      scanCandidates: async () => {
        scans += 1;
        return { candidates: [] };
      },
      bumpService: { bumpThread: async () => ({ status: "skipped" }) },
      stateStore: store,
      config: makeConfig(),
      clock: makeClock(),
      timers: makeTimers(),
      random: () => 0,
      logger: { info() {}, warn() {} },
    });
    await sched.start();
    const r = await sched.runOnce();
    assertEqual(r.status, "cooldown", "冷却中");
    assertEqual(scans, 0, "冷却不扫描");
  }

  // recovery 启动无 timer
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    await store.load();
    await store.beginInFlight({
      expectedRevision: 0,
      operationId: "stuck",
      guildId: G,
      forumChannelId: F,
      threadId: T,
      startedAt: "2026-07-28T12:00:00.000Z",
    });
    const timers = makeTimers();
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({ candidates: [] }),
      bumpService: { bumpThread: async () => ({ status: "skipped" }) },
      stateStore: store,
      config: makeConfig(),
      clock: makeClock(),
      timers,
      random: () => 0,
      logger: { info() {}, warn() {} },
    });
    const st = await sched.start();
    assertEqual(st.recoveryStatus, "manual_review_required", "before_send recovery");
    assertEqual(st.timerArmed, false, "recovery 无 timer");
    assertEqual(timers.list().length, 0, "recovery 无活跃 timer");
  }

  // ========== Review Fix2: single-flight / Timer / lifecycle / fallback ==========

  // A. single-flight：handleUnexpected 完成前不释放 running / runPromise
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const timers = makeTimers();
    let releasePause;
    const pauseGate = new Promise((resolve) => { releasePause = resolve; });
    let pauseEntered = false;
    let scanCount = 0;
    let bumpCount = 0;
    let writeCount = 0;
    const sched = createForumBumpScheduler({
      scanCandidates: async () => {
        scanCount += 1;
        return { candidates: [{ threadId: T, forumChannelId: F }] };
      },
      bumpService: {
        bumpThread: async ({ lifecycle }) => {
          bumpCount += 1;
          if (lifecycle?.onBeforeSend) await lifecycle.onBeforeSend({});
          throw new Error("bump boom");
        },
      },
      stateStore: wrapStore(store, {
        pause: async (...a) => {
          pauseEntered = true;
          writeCount += 1;
          await pauseGate;
          return store.pause(...a);
        },
      }),
      config: makeConfig(),
      clock: makeClock(),
      timers,
      random: () => 0,
      createOperationId: () => "op-sf",
      logger: { info() {}, warn() {}, error() {} },
    });
    await sched.start();
    clearScheduleForTest(sched, timers);

    const onceP = sched.runOnce();
    // 等待进入 pause 门闩
    for (let i = 0; i < 50 && !pauseEntered; i += 1) await tick();
    assert(pauseEntered, "A: 已进入 handleUnexpected pause");
    assertEqual(sched.getStatus().running, true, "A: running 仍为 true");
    assert(sched.getStatus().currentOperationId === "op-sf", "A: operationId 未提前清理");

    const scansBefore = scanCount;
    const bumpsBefore = bumpCount;
    const busy = await sched.runOnce();
    assertEqual(busy.status, "busy", "A: 第二次 runOnce → busy");
    assertEqual(scanCount, scansBefore, "A: busy 不扫描");
    assertEqual(bumpCount, bumpsBefore, "A: busy 不 bump");

    let stopDone = false;
    const stopP = sched.stop().then((r) => {
      stopDone = true;
      return r;
    });
    await tick();
    await tick();
    assertEqual(stopDone, false, "A: stop 在恢复完成前不 resolve");

    releasePause();
    const onceR = await onceP;
    assertEqual(onceR.status, "unexpected_failed", "A: 异常恢复完成");
    const stopR = await stopP;
    assert(stopR.success, "A: stop 完成");
    assertEqual(stopDone, true, "A: stop 已 resolve");
    assertEqual(sched.getStatus().running, false, "A: running cleared");
    assertEqual(sched.getStatus().currentOperationId, null, "A: operationId cleared");
    await assertNoTimer(sched, timers, "A after recovery");
    void writeCount;
  }

  // B.1 start 首次 arm setTimeout 抛异常
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const baseTimers = makeTimers();
    let armAttempts = 0;
    const timers = {
      setTimeout(fn, ms) {
        armAttempts += 1;
        if (armAttempts === 1) throw new Error("setTimeout boom");
        return baseTimers.setTimeout(fn, ms);
      },
      clearTimeout: (h) => baseTimers.clearTimeout(h),
      list: () => baseTimers.list(),
    };
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({ candidates: [] }),
      bumpService: { bumpThread: async () => ({ status: "skipped" }) },
      stateStore: store,
      config: makeConfig(),
      clock: makeClock(),
      timers,
      random: () => 0,
      logger: { info() {}, warn() {}, error() {} },
    });
    let threw = false;
    let st;
    try {
      st = await sched.start();
    } catch {
      threw = true;
    }
    assert(!threw, "B1: start 不裸抛");
    assertEqual(st.success, false, "B1: success false");
    assertEqual(st.errorCode, "SCHEDULER_UNEXPECTED_FAILED", "B1: errorCode");
    assertEqual(st.timerArmed, false, "B1: timerArmed false");
    assertEqual(st.nextWakeAt, null, "B1: nextWakeAt null");
    assertEqual(st.started, false, "B1: started false");
    assertEqual(sched.getStatus().started, false, "B1: getStatus started false");
    assertEqual(timers.list().length, 0, "B1: 无活跃 timer");

    // 可再次 start
    const st2 = await sched.start();
    assert(st2.success, "B1: 可再次 start");
    assertEqual(st2.started, true, "B1: 二次 start ok");
    await sched.stop();
  }

  // B.2 运行周期重新 arm 时 setTimeout 抛异常
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const baseTimers = makeTimers();
    let allowArm = true;
    const timers = {
      setTimeout(fn, ms) {
        if (!allowArm) throw new Error("rearm boom");
        return baseTimers.setTimeout(fn, ms);
      },
      clearTimeout: (h) => baseTimers.clearTimeout(h),
      list: () => baseTimers.list(),
    };
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({ candidates: [] }),
      bumpService: { bumpThread: async () => ({ status: "skipped" }) },
      stateStore: store,
      config: makeConfig(),
      clock: makeClock(),
      timers,
      random: () => 0,
      logger: { info() {}, warn() {}, error() {} },
    });
    await sched.start();
    clearScheduleForTest(sched, baseTimers);
    allowArm = false;
    let threw = false;
    let r;
    try {
      r = await sched.runOnce();
    } catch {
      threw = true;
    }
    assert(!threw, "B2: runOnce 不裸抛");
    assertEqual(r.status, "unexpected_failed", "B2: arm 失败 → unexpected_failed");
    assertEqual(r.errorCode, "SCHEDULER_UNEXPECTED_FAILED", "B2: errorCode");
    assertEqual(sched.getStatus().lastRunStatus, "unexpected_failed", "B2: lastRunStatus");
    await assertNoTimer(sched, timers, "B2 rearm fail");
  }

  // B.3 Timer callback 入口 clock.now 抛异常
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const clock = makeClock();
    const timers = makeTimers();
    let nowThrows = false;
    const clockWrap = {
      now: () => {
        if (nowThrows) throw new Error("clock boom");
        return clock.now();
      },
    };
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({ candidates: [] }),
      bumpService: { bumpThread: async () => ({ status: "skipped" }) },
      stateStore: store,
      config: makeConfig(),
      clock: clockWrap,
      timers,
      random: () => 0,
      logger: { info() {}, warn() {}, error() {} },
    });
    await sched.start();
    assert(timers.list().length >= 1, "B3: start 有 timer");
    nowThrows = true;
    let unhandled = 0;
    const onUR = () => { unhandled += 1; };
    process.on("unhandledRejection", onUR);
    try {
      await flushAllTimers(timers);
      await tick();
      await tick();
    } finally {
      process.removeListener("unhandledRejection", onUR);
    }
    assertEqual(unhandled, 0, "B3: 无 unhandled rejection");
    assertEqual(sched.getStatus().nextWakeAt, null, "B3: nextWakeAt null");
    assertEqual(timers.list().length, 0, "B3: 无活跃 timer");
    assertEqual(sched.getStatus().lastRunStatus, "unexpected_failed", "B3: lastRunStatus");
  }

  // B.4 提前触发后重新 schedule 时 setTimeout 抛异常
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const clock = makeClock(Date.parse("2026-07-28T12:00:00.000Z"));
    const baseTimers = makeTimers();
    let throwOnArm = false;
    let scans = 0;
    let bumps = 0;
    const timers = {
      setTimeout(fn, ms) {
        if (throwOnArm) throw new Error("early rearm boom");
        return baseTimers.setTimeout(fn, ms);
      },
      clearTimeout: (h) => baseTimers.clearTimeout(h),
      list: () => baseTimers.list(),
    };
    const sched = createForumBumpScheduler({
      scanCandidates: async () => {
        scans += 1;
        return { candidates: [] };
      },
      bumpService: {
        bumpThread: async () => {
          bumps += 1;
          return { status: "skipped" };
        },
      },
      stateStore: store,
      config: makeConfig({ idlePollMs: 60_000 }),
      clock,
      timers,
      random: () => 0,
      logger: { info() {}, warn() {}, error() {} },
    });
    await sched.start();
    clearScheduleForTest(sched, baseTimers);
    const once = await sched.runOnce();
    assertEqual(once.status, "no_candidate", "B4: no_candidate");
    assert(baseTimers.list().length === 1, "B4: idle timer armed");
    const scansBefore = scans;
    const bumpsBefore = bumps;
    throwOnArm = true;
    // 不 advance clock → callback 视为提前触发 → rearm 抛异常
    await flushAllTimers(baseTimers);
    await tick();
    await tick();
    assertEqual(scans, scansBefore, "B4: 不扫描");
    assertEqual(bumps, bumpsBefore, "B4: 不 bump");
    assertEqual(sched.getStatus().nextWakeAt, null, "B4: nextWakeAt null");
    assertEqual(baseTimers.list().length, 0, "B4: 无活跃 timer");
    assertEqual(sched.getStatus().lastRunStatus, "unexpected_failed", "B4: lastRunStatus");
  }

  // C.1 markMessageSent 返回失败
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const timers = makeTimers();
    let markDeleted = 0;
    let complete = 0;
    let pauseCalls = 0;
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({
        candidates: [{ threadId: T, forumChannelId: F }],
      }),
      bumpService: {
        // 模拟真实 bump：send 已成功 → onMessageSent 失败 → 仍 delete 一次
        bumpThread: async ({ lifecycle }) => {
          if (lifecycle?.onBeforeSend) await lifecycle.onBeforeSend({});
          try {
            if (lifecycle?.onMessageSent) {
              await lifecycle.onMessageSent({ sentMessageId: M });
            }
          } catch {
            // delete once (cleaned)
            return {
              status: "failed",
              success: false,
              cleanupRequired: false,
              errorCode: "LIFECYCLE_AFTER_SEND_FAILED",
              sentMessageId: M,
            };
          }
          return { status: "succeeded", success: true, sentMessageId: M };
        },
      },
      stateStore: wrapStore(store, {
        markMessageSent: async () => ({ success: false, errorCode: "STATE_WRITE_FAILED" }),
        markMessageDeleted: async (...a) => {
          markDeleted += 1;
          return store.markMessageDeleted(...a);
        },
        completeSuccess: async (...a) => {
          complete += 1;
          return store.completeSuccess(...a);
        },
        pause: async (...a) => {
          pauseCalls += 1;
          return store.pause(...a);
        },
      }),
      config: makeConfig(),
      clock: makeClock(),
      timers,
      random: () => 0,
      createOperationId: () => "op-ms-fail",
      logger: { info() {}, warn() {}, error() {} },
    });
    await sched.start();
    clearScheduleForTest(sched, timers);
    const r = await sched.runOnce();
    assertEqual(r.status, "halted", "C1: markSent fail → halted");
    assertEqual(markDeleted, 0, "C1: 不调用 markMessageDeleted");
    assertEqual(complete, 0, "C1: 不 completeSuccess");
    assertEqual(pauseCalls, 1, "C1: 尝试 pause");
    await store.load();
    assertEqual(store.getSnapshot().successCount, 0, "C1: 不增加额度");
    assertEqual(store.getSnapshot().inFlight?.phase, "before_send", "C1: phase before_send");
    assertEqual(store.getSnapshot().paused, true, "C1: paused");
    await assertNoTimer(sched, timers, "C1 markSent fail");
  }

  // C.2 markMessageSent throw
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const timers = makeTimers();
    let markDeleted = 0;
    let complete = 0;
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({
        candidates: [{ threadId: T, forumChannelId: F }],
      }),
      bumpService: {
        bumpThread: async ({ lifecycle }) => {
          if (lifecycle?.onBeforeSend) await lifecycle.onBeforeSend({});
          try {
            if (lifecycle?.onMessageSent) {
              await lifecycle.onMessageSent({ sentMessageId: M });
            }
          } catch {
            return {
              status: "failed",
              success: false,
              cleanupRequired: false,
              errorCode: "LIFECYCLE_AFTER_SEND_FAILED",
              sentMessageId: M,
            };
          }
          return { status: "succeeded", success: true, sentMessageId: M };
        },
      },
      stateStore: wrapStore(store, {
        markMessageSent: async () => { throw new Error("markSent boom"); },
        markMessageDeleted: async (...a) => {
          markDeleted += 1;
          return store.markMessageDeleted(...a);
        },
        completeSuccess: async (...a) => {
          complete += 1;
          return store.completeSuccess(...a);
        },
      }),
      config: makeConfig(),
      clock: makeClock(),
      timers,
      random: () => 0,
      createOperationId: () => "op-ms-throw",
      logger: { info() {}, warn() {}, error() {} },
    });
    await sched.start();
    clearScheduleForTest(sched, timers);
    const r = await sched.runOnce();
    assertEqual(r.status, "halted", "C2: markSent throw → halted");
    assertEqual(markDeleted, 0, "C2: 不 markDeleted");
    assertEqual(complete, 0, "C2: 不 complete");
    await store.load();
    assertEqual(store.getSnapshot().inFlight?.phase, "before_send", "C2: before_send");
    assertEqual(store.getSnapshot().paused, true, "C2: paused");
    await assertNoTimer(sched, timers, "C2 markSent throw");
  }

  // C.2b 真实 Bump Service + markMessageSent 失败：仍 delete 一次，状态 before_send
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const timers = makeTimers();
    const clock = makeClock();
    let sendCount = 0;
    let deleteCount = 0;
    let markDeleted = 0;
    let complete = 0;
    const message = {
      id: M,
      delete: async () => { deleteCount += 1; },
    };
    const thread = {
      id: T,
      type: ChannelType.PublicThread,
      guildId: G,
      parentId: F,
      parent: { id: F, type: ChannelType.GuildForum, defaultSortOrder: 0 },
      name: "t",
      archived: true,
      locked: false,
      pinned: false,
      autoArchiveDuration: 4320,
      archiveTimestamp: 1_700_000_000_000,
      lastMessageId: "1429163615671423037",
      messageCount: 1,
      totalMessageSent: 1,
      appliedTags: [],
      permissionsFor() {
        return {
          has: (f) => [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessagesInThreads,
          ].includes(f),
        };
      },
      send: async () => {
        sendCount += 1;
        thread.lastMessageId = M;
        thread.archived = false;
        return message;
      },
    };
    const client = {
      user: { id: "bot" },
      isReady: () => true,
      channels: {
        fetch: async (id, options) => {
          if (!options?.force) throw new Error("force required");
          if (id === T) return thread;
          if (id === F) return thread.parent;
          throw new Error(`unknown ${id}`);
        },
      },
    };
    const bumpService = createForumBumpService({
      client,
      logger: { info() {}, warn() {}, error() {} },
      clock: { now: () => clock.now() },
      sleep: async () => {},
    });
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({
        candidates: [{ threadId: T, forumChannelId: F, guildId: G }],
      }),
      bumpService,
      stateStore: wrapStore(store, {
        markMessageSent: async () => ({ success: false, errorCode: "STATE_WRITE_FAILED" }),
        markMessageDeleted: async (...a) => {
          markDeleted += 1;
          return store.markMessageDeleted(...a);
        },
        completeSuccess: async (...a) => {
          complete += 1;
          return store.completeSuccess(...a);
        },
      }),
      config: makeConfig(),
      clock,
      timers,
      random: () => 0,
      createOperationId: () => "op-ms-real",
      logger: { info() {}, warn() {}, error() {} },
    });
    await sched.start();
    clearScheduleForTest(sched, timers);
    const r = await sched.runOnce();
    assertEqual(sendCount, 1, "C2b: send 一次");
    assertEqual(deleteCount, 1, "C2b: delete 一次");
    assertEqual(markDeleted, 0, "C2b: 不调用 markMessageDeleted");
    assertEqual(complete, 0, "C2b: 不调用 completeSuccess");
    assertEqual(r.status, "halted", "C2b: status halted");
    await store.load();
    assertEqual(store.getSnapshot().inFlight?.phase, "before_send", "C2b: before_send");
    assertEqual(store.getSnapshot().paused, true, "C2b: paused");
    assertEqual(store.getSnapshot().successCount, 0, "C2b: 不增加额度");
    await assertNoTimer(sched, timers, "C2b real bump markSent fail");
  }

  // C.3 markMessageDeleted 返回失败
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const timers = makeTimers();
    let complete = 0;
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({
        candidates: [{ threadId: T, forumChannelId: F }],
      }),
      bumpService: {
        bumpThread: async ({ lifecycle }) => {
          if (lifecycle?.onBeforeSend) await lifecycle.onBeforeSend({});
          if (lifecycle?.onMessageSent) {
            await lifecycle.onMessageSent({ sentMessageId: M });
          }
          try {
            if (lifecycle?.onMessageDeleted) await lifecycle.onMessageDeleted({});
          } catch {
            return {
              status: "failed",
              success: false,
              cleanupRequired: false,
              errorCode: "LIFECYCLE_AFTER_DELETE_FAILED",
              sentMessageId: M,
            };
          }
          return { status: "succeeded", success: true, sentMessageId: M };
        },
      },
      stateStore: wrapStore(store, {
        markMessageDeleted: async () => ({ success: false, errorCode: "STATE_WRITE_FAILED" }),
        completeSuccess: async (...a) => {
          complete += 1;
          return store.completeSuccess(...a);
        },
      }),
      config: makeConfig(),
      clock: makeClock(),
      timers,
      random: () => 0,
      createOperationId: () => "op-md-fail",
      logger: { info() {}, warn() {}, error() {} },
    });
    await sched.start();
    clearScheduleForTest(sched, timers);
    const r = await sched.runOnce();
    assertEqual(r.status, "halted", "C3: markDeleted fail → halted");
    assertEqual(complete, 0, "C3: 不 completeSuccess");
    await store.load();
    assertEqual(store.getSnapshot().successCount, 0, "C3: 额度不增");
    assertEqual(store.getSnapshot().inFlight?.phase, "after_send", "C3: phase after_send");
    assertEqual(store.getSnapshot().inFlight?.sentMessageId, M, "C3: sentMessageId 保留");
    assertEqual(store.getSnapshot().paused, true, "C3: paused");
    await assertNoTimer(sched, timers, "C3 markDeleted fail");
  }

  // C.4 markMessageDeleted throw
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const timers = makeTimers();
    let complete = 0;
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({
        candidates: [{ threadId: T, forumChannelId: F }],
      }),
      bumpService: {
        bumpThread: async ({ lifecycle }) => {
          if (lifecycle?.onBeforeSend) await lifecycle.onBeforeSend({});
          if (lifecycle?.onMessageSent) {
            await lifecycle.onMessageSent({ sentMessageId: M });
          }
          try {
            if (lifecycle?.onMessageDeleted) await lifecycle.onMessageDeleted({});
          } catch {
            return {
              status: "failed",
              success: false,
              cleanupRequired: false,
              errorCode: "LIFECYCLE_AFTER_DELETE_FAILED",
              sentMessageId: M,
            };
          }
          return { status: "succeeded", success: true, sentMessageId: M };
        },
      },
      stateStore: wrapStore(store, {
        markMessageDeleted: async () => { throw new Error("markDel boom"); },
        completeSuccess: async (...a) => {
          complete += 1;
          return store.completeSuccess(...a);
        },
      }),
      config: makeConfig(),
      clock: makeClock(),
      timers,
      random: () => 0,
      createOperationId: () => "op-md-throw",
      logger: { info() {}, warn() {}, error() {} },
    });
    await sched.start();
    clearScheduleForTest(sched, timers);
    const r = await sched.runOnce();
    assertEqual(r.status, "halted", "C4: markDeleted throw → halted");
    assertEqual(complete, 0, "C4: 不 complete");
    await store.load();
    assertEqual(store.getSnapshot().inFlight?.phase, "after_send", "C4: after_send");
    assertEqual(store.getSnapshot().inFlight?.sentMessageId, M, "C4: sentMessageId");
    await assertNoTimer(sched, timers, "C4 markDeleted throw");
  }

  // C.5 lifecycle 失败后 pause 失败 → state_failed
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const timers = makeTimers();
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({
        candidates: [{ threadId: T, forumChannelId: F }],
      }),
      bumpService: {
        bumpThread: async ({ lifecycle }) => {
          if (lifecycle?.onBeforeSend) await lifecycle.onBeforeSend({});
          try {
            if (lifecycle?.onMessageSent) {
              await lifecycle.onMessageSent({ sentMessageId: M });
            }
          } catch {
            return {
              status: "failed",
              success: false,
              cleanupRequired: false,
              errorCode: "LIFECYCLE_AFTER_SEND_FAILED",
              sentMessageId: M,
            };
          }
          return { status: "succeeded", success: true };
        },
      },
      stateStore: wrapStore(store, {
        markMessageSent: async () => ({ success: false, errorCode: "STATE_WRITE_FAILED" }),
        pause: async () => ({ success: false, errorCode: "STATE_REVISION_CONFLICT" }),
      }),
      config: makeConfig(),
      clock: makeClock(),
      timers,
      random: () => 0,
      createOperationId: () => "op-pause-fail",
      logger: { info() {}, warn() {}, error() {} },
    });
    await sched.start();
    clearScheduleForTest(sched, timers);
    const r = await sched.runOnce();
    assertEqual(r.status, "state_failed", "C5: pause fail → state_failed");
    assertEqual(r.primaryErrorCode, "LIFECYCLE_AFTER_SEND_FAILED", "C5: primary");
    assertEqual(r.stateErrorCode, "STATE_REVISION_CONFLICT", "C5: stateErrorCode");
    await assertNoTimer(sched, timers, "C5 pause fail");
  }

  // D. Stop after send：真实 Bump Service + fake Discord
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const timers = makeTimers();
    const clock = makeClock();
    let sendCount = 0;
    let deleteCount = 0;
    let releaseSend;
    const sendGate = new Promise((resolve) => { releaseSend = resolve; });
    const message = {
      id: M,
      delete: async () => { deleteCount += 1; },
    };
    const thread = {
      id: T,
      type: ChannelType.PublicThread,
      guildId: G,
      parentId: F,
      parent: { id: F, type: ChannelType.GuildForum, defaultSortOrder: 0 },
      name: "t",
      archived: true,
      locked: false,
      pinned: false,
      autoArchiveDuration: 4320,
      archiveTimestamp: 1_700_000_000_000,
      lastMessageId: "1429163615671423037",
      messageCount: 1,
      totalMessageSent: 1,
      appliedTags: [],
      permissionsFor() {
        return {
          has: (f) => [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessagesInThreads,
          ].includes(f),
        };
      },
      send: async () => {
        sendCount += 1;
        await sendGate;
        thread.lastMessageId = M;
        thread.archived = false;
        return message;
      },
    };
    const client = {
      user: { id: "bot" },
      isReady: () => true,
      channels: {
        fetch: async (id, options) => {
          if (!options?.force) throw new Error("force required");
          if (id === T) return thread;
          if (id === F) return thread.parent;
          throw new Error(`unknown ${id}`);
        },
      },
    };
    const sleepLog = [];
    const bumpService = createForumBumpService({
      client,
      logger: { info() {}, warn() {}, error() {} },
      clock: { now: () => clock.now() },
      sleep: async (ms) => { sleepLog.push(ms); },
    });
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({
        candidates: [{
          threadId: T,
          forumChannelId: F,
          guildId: G,
        }],
      }),
      bumpService,
      stateStore: store,
      config: makeConfig(),
      clock,
      timers,
      random: () => 0,
      createOperationId: () => "op-stop-send",
      logger: { info() {}, warn() {}, error() {} },
    });
    await sched.start();
    clearScheduleForTest(sched, timers);
    const onceP = sched.runOnce();
    // 等到 send 被调用
    for (let i = 0; i < 50 && sendCount === 0; i += 1) await tick();
    assertEqual(sendCount, 1, "D: send 已开始");
    const stopP = sched.stop();
    releaseSend();
    const [onceR, stopR] = await Promise.all([onceP, stopP]);
    // stop 后可能 cancelled 或 succeeded，取决于 abort 时点；
    // 规范要求：真实 send+delete 成功仍计入额度
    assert(stopR.success, "D: stop 成功");
    assertEqual(sendCount, 1, "D: send 一次");
    assertEqual(deleteCount, 1, "D: delete 一次");
    await store.load();
    const snap = store.getSnapshot();
    // 若完整成功路径：successCount+1；若 abort 在 send 后仍应 delete 并 complete
    assertEqual(snap.successCount, 1, "D: successCount +1");
    assertEqual(snap.inFlight, null, "D: inFlight 清空");
    assert(snap.lastSuccessAt != null, "D: lastSuccessAt");
    assert(snap.nextEligibleAt != null, "D: nextEligibleAt");
    assertEqual(timers.list().length, 0, "D: 无下一 timer");
    void onceR;
    void sleepLog;
  }

  // E. 三种 Startup Recovery
  for (const scenario of [
    { phase: "before_send", expected: "manual_review_required", withMsg: false },
    { phase: "after_send", expected: "cleanup_required", withMsg: true },
    { phase: "after_delete", expected: "reconciliation_required", withMsg: true },
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    await store.load();
    let rev = 0;
    await store.beginInFlight({
      expectedRevision: rev,
      operationId: `op-${scenario.phase}`,
      guildId: G,
      forumChannelId: F,
      threadId: T,
      startedAt: "2026-07-28T12:00:00.000Z",
    });
    rev += 1;
    if (scenario.phase === "after_send" || scenario.phase === "after_delete") {
      await store.markMessageSent({
        expectedRevision: rev,
        operationId: `op-${scenario.phase}`,
        sentMessageId: M,
        sentAt: "2026-07-28T12:00:01.000Z",
      });
      rev += 1;
    }
    if (scenario.phase === "after_delete") {
      await store.markMessageDeleted({
        expectedRevision: rev,
        operationId: `op-${scenario.phase}`,
        deletedAt: "2026-07-28T12:00:02.000Z",
      });
    }
    let scans = 0;
    let bumps = 0;
    const timers = makeTimers();
    const sched = createForumBumpScheduler({
      scanCandidates: async () => {
        scans += 1;
        return { candidates: [] };
      },
      bumpService: {
        bumpThread: async () => {
          bumps += 1;
          return { status: "skipped" };
        },
      },
      stateStore: store,
      config: makeConfig(),
      clock: makeClock(),
      timers,
      random: () => 0,
      logger: { info() {}, warn() {} },
    });
    const st = await sched.start();
    assertEqual(st.recoveryStatus, scenario.expected, `E: ${scenario.phase} recovery`);
    assertEqual(st.timerArmed, false, `E: ${scenario.phase} no timerArmed`);
    assertEqual(st.nextWakeAt, null, `E: ${scenario.phase} nextWakeAt null`);
    assertEqual(timers.list().length, 0, `E: ${scenario.phase} 无活跃 timer`);
    assertEqual(scans, 0, `E: ${scenario.phase} 不扫描`);
    assertEqual(bumps, 0, `E: ${scenario.phase} 不 bump`);
    await store.load();
    assert(store.getSnapshot().inFlight != null, `E: ${scenario.phase} 保留 inFlight`);
    assertEqual(store.getSnapshot().inFlight.phase, scenario.phase, `E: ${scenario.phase} phase`);
    void scenario.withMsg;
  }

  // F. Random 异常精确断言（补充 status 词表）
  // 见上文 random throw 块，已精确为 halted + SCHEDULER_RANDOM_INVALID

  // G. State fallback 分类
  {
    // load 未知 throw → STATE_READ_FAILED
    {
      const r = await safeStateCall(async () => { throw new Error("load boom"); }, "STATE_READ_FAILED");
      assertEqual(r.ok, false, "G: load throw ok=false");
      assertEqual(r.errorCode, "STATE_READ_FAILED", "G: load → STATE_READ_FAILED");
    }
    // recoverOnStartup 未知 throw → STATE_RECOVERY_FAILED
    {
      const r = await safeStateCall(async () => { throw new Error("rec boom"); }, "STATE_RECOVERY_FAILED");
      assertEqual(r.ok, false, "G: recover throw");
      assertEqual(r.errorCode, "STATE_RECOVERY_FAILED", "G: recover → STATE_RECOVERY_FAILED");
    }
    // recoverOnStartup 返回 STATE_WRITE_FAILED → 保留
    {
      const r = await safeStateCall(
        async () => ({ success: false, errorCode: "STATE_WRITE_FAILED" }),
        "STATE_RECOVERY_FAILED",
      );
      assertEqual(r.errorCode, "STATE_WRITE_FAILED", "G: store errorCode 优先于 recovery fallback");
    }
    // deferUntil 未知 throw → STATE_WRITE_FAILED
    {
      const r = await safeStateCall(async () => { throw new Error("defer boom"); }, "STATE_WRITE_FAILED");
      assertEqual(r.errorCode, "STATE_WRITE_FAILED", "G: defer throw → STATE_WRITE_FAILED");
    }
    // pause 未知 throw → STATE_WRITE_FAILED
    {
      const r = await safeStateCall(async () => { throw new Error("pause boom"); }, "STATE_WRITE_FAILED");
      assertEqual(r.errorCode, "STATE_WRITE_FAILED", "G: pause throw → STATE_WRITE_FAILED");
    }
    // Store 自带合法 errorCode 优先（throw code）
    {
      const err = new Error("x");
      err.code = "STATE_REVISION_CONFLICT";
      const r = await safeStateCall(async () => { throw err; }, "STATE_WRITE_FAILED");
      assertEqual(r.errorCode, "STATE_REVISION_CONFLICT", "G: throw.code 优先");
    }
    // Store 自带合法 errorCode 优先（return）
    {
      const r = await safeStateCall(
        async () => ({ success: false, errorCode: "STATE_DATE_ROLLBACK" }),
        "STATE_WRITE_FAILED",
      );
      assertEqual(r.errorCode, "STATE_DATE_ROLLBACK", "G: result.errorCode 优先");
    }

    // 集成：load throw 在 start
    {
      const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
      dirs.push(dir);
      const store = await bootStore(dir);
      const sched = createForumBumpScheduler({
        scanCandidates: async () => ({ candidates: [] }),
        bumpService: { bumpThread: async () => ({ status: "skipped" }) },
        stateStore: wrapStore(store, {
          load: async () => { throw new Error("load boom"); },
        }),
        config: makeConfig(),
        clock: makeClock(),
        timers: makeTimers(),
        random: () => 0,
        logger: { info() {}, warn() {}, error() {} },
      });
      const st = await sched.start();
      assertEqual(st.success, false, "G: start load throw fail");
      assertEqual(st.errorCode, "STATE_READ_FAILED", "G: start → STATE_READ_FAILED");
    }
    // 集成：recoverOnStartup throw
    {
      const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
      dirs.push(dir);
      const store = await bootStore(dir);
      const sched = createForumBumpScheduler({
        scanCandidates: async () => ({ candidates: [] }),
        bumpService: { bumpThread: async () => ({ status: "skipped" }) },
        stateStore: wrapStore(store, {
          recoverOnStartup: async () => { throw new Error("rec boom"); },
        }),
        config: makeConfig(),
        clock: makeClock(),
        timers: makeTimers(),
        random: () => 0,
        logger: { info() {}, warn() {}, error() {} },
      });
      const st = await sched.start();
      assertEqual(st.success, false, "G: recover throw fail");
      assertEqual(st.errorCode, "STATE_RECOVERY_FAILED", "G: start → STATE_RECOVERY_FAILED");
    }
    // 集成：recoverOnStartup 返回 STATE_WRITE_FAILED
    {
      const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
      dirs.push(dir);
      const store = await bootStore(dir);
      const sched = createForumBumpScheduler({
        scanCandidates: async () => ({ candidates: [] }),
        bumpService: { bumpThread: async () => ({ status: "skipped" }) },
        stateStore: wrapStore(store, {
          recoverOnStartup: async () => ({ success: false, errorCode: "STATE_WRITE_FAILED" }),
        }),
        config: makeConfig(),
        clock: makeClock(),
        timers: makeTimers(),
        random: () => 0,
        logger: { info() {}, warn() {}, error() {} },
      });
      const st = await sched.start();
      assertEqual(st.success, false, "G: recover write fail");
      assertEqual(st.errorCode, "STATE_WRITE_FAILED", "G: 保留 STATE_WRITE_FAILED");
    }
  }

  // completeSuccess 失败 → reconciliation_required（pause 成功）
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-sched-"));
    dirs.push(dir);
    const store = await bootStore(dir);
    const timers = makeTimers();
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({
        candidates: [{ threadId: T, forumChannelId: F }],
      }),
      bumpService: {
        bumpThread: async ({ lifecycle }) => {
          if (lifecycle?.onBeforeSend) await lifecycle.onBeforeSend({});
          if (lifecycle?.onMessageSent) {
            await lifecycle.onMessageSent({ sentMessageId: M });
          }
          if (lifecycle?.onMessageDeleted) await lifecycle.onMessageDeleted({});
          return {
            status: "succeeded",
            success: true,
            cleanupRequired: false,
            sentMessageId: M,
          };
        },
      },
      stateStore: wrapStore(store, {
        completeSuccess: async () => ({ success: false, errorCode: "STATE_WRITE_FAILED" }),
      }),
      config: makeConfig(),
      clock: makeClock(),
      timers,
      random: () => 0,
      createOperationId: () => "op-cs-fail",
      logger: { info() {}, warn() {}, error() {} },
    });
    await sched.start();
    clearScheduleForTest(sched, timers);
    const r = await sched.runOnce();
    assertEqual(r.status, "reconciliation_required", "completeSuccess fail → reconciliation");
    await store.load();
    assertEqual(store.getSnapshot().inFlight?.phase, "after_delete", "complete fail 保留 after_delete");
    assertEqual(store.getSnapshot().paused, true, "complete fail paused");
    assertEqual(store.getSnapshot().successCount, 0, "complete fail 不增额度");
    await assertNoTimer(sched, timers, "completeSuccess fail");
  }

} finally {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  }
}

console.log(`\nForumBump scheduler: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

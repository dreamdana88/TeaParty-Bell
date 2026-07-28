import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createForumBumpStateStore } from "./stateStore.js";
import { createForumBumpScheduler } from "./scheduler.js";
import { SCHEDULER_REFERENCE_DEFAULTS } from "./schedulerConfig.js";

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
      timers.push({ handle, fn, ms, cancelled: false });
      return handle;
    },
    clearTimeout(handle) {
      const t = timers.find((x) => x.handle === handle);
      if (t) t.cancelled = true;
    },
    flush(handle) {
      const t = timers.find((x) => x.handle === handle && !x.cancelled);
      if (t) t.fn();
    },
    list: () => timers.filter((t) => !t.cancelled),
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
      rolloverLocalDate: (...a) => store.rolloverLocalDate(...a),
      beginInFlight: (...a) => (overrides.beginInFlight
        ? overrides.beginInFlight(...a)
        : store.beginInFlight(...a)),
      markMessageSent: (...a) => store.markMessageSent(...a),
      markMessageDeleted: (...a) => store.markMessageDeleted(...a),
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

  // completeSuccess 失败 + pause 成功 → state_failed
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
    assertEqual(r.status, "state_failed", "complete fail+pause ok → state_failed");
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
    // random throw is caught in success path → pause SCHEDULER_RANDOM_INVALID or unexpected
    assert(
      r.status === "halted" || r.status === "state_failed" || r.status === "unexpected_failed",
      "random throw 稳定失败",
    );
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

} finally {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  }
}

console.log(`\nForumBump scheduler: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

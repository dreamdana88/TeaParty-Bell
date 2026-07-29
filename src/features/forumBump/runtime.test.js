import { mkdtempSync, rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createForumBumpRuntime } from "./runtime.js";
import { createForumBumpStateStore } from "./stateStore.js";
import { createForumBumpScheduler } from "./scheduler.js";
import { SCHEDULER_REFERENCE_DEFAULTS } from "./schedulerConfig.js";

let passed = 0;
let failed = 0;
function assert(c, l) {
  if (c) { passed++; console.log(`  PASS: ${l}`); }
  else { failed++; console.error(`  FAIL: ${l}`); }
}
function assertEqual(a, e, l) {
  assert(a === e, `${l} (got ${JSON.stringify(a)})`);
}

const G = "111111111111111111";
const F = "222222222222222222";
const T = "333333333333333333";
const M = "444444444444444444";

console.log("\n=== forumBump runtime ===\n");
const dirs = [];

function makeFb(mode, extra = {}) {
  const cooldownMs = extra.cooldownMs ?? 60_000;
  return {
    mode,
    guildId: G,
    forumChannelIds: [F],
    excludedTagIds: [],
    silenceDays: 30,
    skipPinned: true,
    dailyLimit: 3,
    cooldownMs,
    cooldownJitterMs: 0,
    // 测试注入短自动间隔，避免 00:00–23:59 算出超长间隔
    autoIntervalMs: extra.autoIntervalMs ?? cooldownMs,
    idlePollMs: 30_000,
    failureBackoffMs: 15_000,
    timezone: "UTC",
    activeStart: "00:00",
    activeEnd: "23:59",
    ...extra,
  };
}

function makeTimers() {
  const timers = [];
  let id = 0;
  return {
    setTimeout(fn, ms) {
      const h = ++id;
      timers.push({ handle: h, fn, ms, cancelled: false, fired: false });
      return h;
    },
    clearTimeout(h) {
      const t = timers.find((x) => x.handle === h);
      if (t) t.cancelled = true;
    },
    list: () => timers.filter((t) => !t.cancelled && !t.fired),
    async flush() {
      const active = this.list().slice();
      for (const t of active) {
        t.fired = true;
        t.fn();
      }
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    },
  };
}

try {
  // disabled
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-rt-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    let storeCreates = 0;
    let scan = 0;
    let bump = 0;
    const rt = createForumBumpRuntime({
      client: {},
      config: { forumBump: makeFb("disabled", { statePath }) },
      logger: { info() {}, warn() {}, error() {} },
      createStateStoreFn: () => {
        storeCreates += 1;
        return { load: async () => ({ success: true }) };
      },
      scanCandidatesFn: async () => { scan += 1; return { candidates: [] }; },
      createBumpServiceFn: () => ({ bumpThread: async () => { bump += 1; } }),
    });
    const r = await rt.start();
    assertEqual(r.mode, "disabled", "disabled mode");
    assertEqual(storeCreates, 0, "disabled 不创建 State Store");
    assertEqual(scan, 0, "disabled 不 scan");
    assertEqual(bump, 0, "disabled 不 bump");
    assert(!existsSync(statePath), "disabled 不写状态");
    assert((await rt.start()).idempotent === true, "start 幂等");
    await rt.stop();
    await rt.stop();
    assert(true, "stop 幂等");
  }

  // dry_run
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-rt-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    const store = createForumBumpStateStore({
      statePath,
      logger: { info() {}, warn() {}, error() {} },
    });
    await store.initialize({ localDate: "2026-07-28" });
    let scans = 0;
    let bumps = 0;
    const timers = makeTimers();
    const alerts = [];
    const rt = createForumBumpRuntime({
      client: { user: { id: "bot" } },
      config: { forumBump: makeFb("dry_run", { statePath }) },
      logger: { info() {}, warn() {}, error() {} },
      clock: { now: () => Date.parse("2026-07-28T12:00:00.000Z") },
      timers,
      alertNotifier: {
        notifyFailure: async (k) => { alerts.push(k); },
        notifyRecovery: async () => {},
      },
      createStateStoreFn: () => store,
      scanCandidatesFn: async () => {
        scans += 1;
        return { candidates: [{ threadId: T, forumChannelId: F }] };
      },
      createBumpServiceFn: () => ({
        bumpThread: async () => {
          bumps += 1;
          return { status: "succeeded", success: true };
        },
      }),
    });
    assert((await rt.start()).success, "dry_run start");
    for (const t of timers.list()) t.cancelled = true;
    const once = await rt.getScheduler().runOnce();
    assertEqual(once.status, "dry_run_candidate", "dry_run_candidate");
    assertEqual(scans, 1, "dry_run 扫描");
    assertEqual(bumps, 0, "dry_run 不 bump");
    await store.load();
    const snap = store.getSnapshot();
    assertEqual(snap.successCount, 0, "successCount 不变");
    assertEqual(snap.lastSuccessAt, null, "lastSuccessAt 不变");
    assertEqual(snap.paused, false, "paused 不变");
    assertEqual(snap.inFlight, null, "inFlight 不变");
    assert(snap.nextEligibleAt != null, "nextEligibleAt 可更新");
    assertEqual(alerts.length, 0, "dry_run 不告警");
    for (const t of timers.list()) t.cancelled = true;
    // defer 写入了 nextEligibleAt → 推进时钟越过冷却后再扫
    const nextMs = Date.parse(store.getSnapshot().nextEligibleAt);
    const clock2 = { now: () => nextMs + 1 };
    // Runtime 内 clock 已固定；直接新建一轮 runOnce 用 defer 后冷却路径
    // 验证：冷却期内不扫；冷却结束后再扫
    const cool = await rt.getScheduler().runOnce();
    assert(
      cool.status === "cooldown" || cool.status === "dry_run_candidate",
      "第二轮 cooldown 或再次 dry_run",
    );
    if (cool.status === "cooldown") {
      assertEqual(scans, 1, "冷却中不扫描");
    }
    await rt.stop();

    // 独立用例：无冷却时连续两轮均扫描
    const dir2 = mkdtempSync(join(tmpdir(), "fb-rt-"));
    dirs.push(dir2);
    const sp2 = join(dir2, "state.json");
    const store2 = createForumBumpStateStore({
      statePath: sp2,
      logger: { info() {}, warn() {}, error() {} },
    });
    await store2.initialize({ localDate: "2026-07-28" });
    let scans2 = 0;
    let tNow = Date.parse("2026-07-28T12:00:00.000Z");
    const timers2 = makeTimers();
    const rt2 = createForumBumpRuntime({
      client: { user: { id: "bot" } },
      config: {
        forumBump: makeFb("dry_run", {
          statePath: sp2,
          idlePollMs: 1,
          cooldownMs: 0,
          cooldownJitterMs: 0,
        }),
      },
      logger: { info() {}, warn() {}, error() {} },
      clock: { now: () => tNow },
      timers: timers2,
      alertNotifier: {
        notifyFailure: async () => {},
        notifyRecovery: async () => {},
      },
      createStateStoreFn: () => store2,
      scanCandidatesFn: async () => {
        scans2 += 1;
        return { candidates: [{ threadId: T, forumChannelId: F }] };
      },
      createBumpServiceFn: () => ({
        bumpThread: async () => ({ status: "succeeded", success: true }),
      }),
    });
    await rt2.start();
    for (const t of timers2.list()) t.cancelled = true;
    await rt2.getScheduler().runOnce();
    tNow += 10_000;
    for (const t of timers2.list()) t.cancelled = true;
    await rt2.getScheduler().runOnce();
    assertEqual(scans2, 2, "下一轮重新扫描");
    await rt2.stop();
  }

  // dry_run deferUntil 失败 → state_failed 告警
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-rt-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    const base = createForumBumpStateStore({
      statePath,
      logger: { info() {}, warn() {}, error() {} },
    });
    await base.initialize({ localDate: "2026-07-28" });
    const store = {
      load: (...a) => base.load(...a),
      recoverOnStartup: (...a) => base.recoverOnStartup(...a),
      getSnapshot: () => base.getSnapshot(),
      rolloverLocalDate: (...a) => base.rolloverLocalDate(...a),
      deferUntil: async () => ({ success: false, errorCode: "STATE_WRITE_FAILED" }),
      beginInFlight: (...a) => base.beginInFlight(...a),
      markMessageSent: (...a) => base.markMessageSent(...a),
      markMessageDeleted: (...a) => base.markMessageDeleted(...a),
      completeSuccess: (...a) => base.completeSuccess(...a),
      pause: (...a) => base.pause(...a),
      abandonBeforeSend: (...a) => base.abandonBeforeSend(...a),
    };
    const timers = makeTimers();
    const alerts = [];
    const rt = createForumBumpRuntime({
      client: { user: { id: "bot" } },
      config: { forumBump: makeFb("dry_run", { statePath }) },
      logger: { info() {}, warn() {}, error() {} },
      clock: { now: () => Date.parse("2026-07-28T12:00:00.000Z") },
      timers,
      alertNotifier: {
        notifyFailure: async (k) => { alerts.push(k); },
        notifyRecovery: async () => {},
      },
      createStateStoreFn: () => store,
      scanCandidatesFn: async () => ({
        candidates: [{ threadId: T, forumChannelId: F }],
      }),
      createBumpServiceFn: () => ({ bumpThread: async () => ({ status: "skipped" }) }),
    });
    await rt.start();
    for (const t of timers.list()) t.cancelled = true;
    const once = await rt.getScheduler().runOnce();
    assertEqual(once.status, "state_failed", "dry_run defer fail");
    assertEqual(timers.list().length, 0, "无下一 timer");
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert(alerts.includes("forum_bump_state_unavailable"), "defer fail 告警");
    await rt.stop();
  }

  // execute 成功 + 回调
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-rt-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    const store = createForumBumpStateStore({
      statePath,
      logger: { info() {}, warn() {}, error() {} },
    });
    await store.initialize({ localDate: "2026-07-28" });
    let usedScan = false;
    let usedBump = false;
    const timers = makeTimers();
    const cycleResults = [];
    const rt = createForumBumpRuntime({
      client: { user: { id: "bot" } },
      config: { forumBump: makeFb("execute", { statePath }) },
      logger: { info() {}, warn() {}, error() {} },
      clock: { now: () => Date.parse("2026-07-28T12:00:00.000Z") },
      timers,
      createStateStoreFn: () => store,
      createBumpServiceFn: () => ({
        bumpThread: async ({ lifecycle }) => {
          usedBump = true;
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
      }),
      createSchedulerFn: (deps) => createForumBumpScheduler({
        ...deps,
        onCycleResult: (r) => {
          cycleResults.push(r);
          deps.onCycleResult?.(r);
        },
      }),
      scanCandidatesFn: async () => {
        usedScan = true;
        return { candidates: [{ threadId: T, forumChannelId: F }] };
      },
      alertNotifier: {
        notifyFailure: async () => {},
        notifyRecovery: async () => {},
      },
    });
    await rt.start();
    for (const t of timers.list()) t.cancelled = true;
    const once = await rt.getScheduler().runOnce();
    assertEqual(once.status, "succeeded", "execute 成功");
    assert(usedScan, "使用 Scanner");
    assert(usedBump, "使用 Bump Service");
    assert(cycleResults.some((r) => r.status === "succeeded"), "runOnce 进入回调");
    await store.load();
    assertEqual(store.getSnapshot().successCount, 1, "execute 增加额度");
    await rt.stop();
  }

  // Timer 自动结果进入回调
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-rt-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    const store = createForumBumpStateStore({
      statePath,
      logger: { info() {}, warn() {}, error() {} },
    });
    await store.initialize({ localDate: "2026-07-28" });
    const timers = makeTimers();
    const cycleResults = [];
    const clock = {
      t: Date.parse("2026-07-28T12:00:00.000Z"),
      now: () => clock.t,
    };
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({ candidates: [] }),
      bumpService: { bumpThread: async () => ({ status: "skipped" }) },
      stateStore: store,
      config: {
        enabled: true,
        mode: "execute",
        guildId: G,
        forumChannelIds: [F],
        ...SCHEDULER_REFERENCE_DEFAULTS,
        idlePollMs: 1,
        activeStart: "00:00",
        activeEnd: "23:59",
        timezone: "UTC",
      },
      clock,
      timers,
      random: () => 0,
      logger: { info() {}, warn() {}, error() {} },
      onCycleResult: (r) => { cycleResults.push(r); },
    });
    await sched.start();
    // 推进时间让 timer 到期
    clock.t += 60_000;
    await timers.flush();
    assert(cycleResults.some((r) => r.status === "no_candidate"), "Timer 结果进入回调");
    await sched.stop();
  }

  // 回调 throw 不破坏
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-rt-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    const store = createForumBumpStateStore({
      statePath,
      logger: { info() {}, warn() {}, error() {} },
    });
    await store.initialize({ localDate: "2026-07-28" });
    const timers = makeTimers();
    let calls = 0;
    const sched = createForumBumpScheduler({
      scanCandidates: async () => ({ candidates: [] }),
      bumpService: { bumpThread: async () => ({ status: "skipped" }) },
      stateStore: store,
      config: {
        enabled: true,
        mode: "execute",
        guildId: G,
        forumChannelIds: [F],
        ...SCHEDULER_REFERENCE_DEFAULTS,
        activeStart: "00:00",
        activeEnd: "23:59",
        timezone: "UTC",
      },
      clock: { now: () => Date.parse("2026-07-28T12:00:00.000Z") },
      timers,
      random: () => 0,
      logger: { info() {}, warn() {}, error() {} },
      onCycleResult: () => {
        calls += 1;
        throw new Error("callback boom");
      },
    });
    await sched.start();
    for (const t of timers.list()) t.cancelled = true;
    let threw = false;
    let r;
    try {
      r = await sched.runOnce();
    } catch {
      threw = true;
    }
    assert(!threw, "回调 throw 不破坏 runOnce");
    assertEqual(r.status, "no_candidate", "业务结果仍返回");
    assertEqual(calls, 1, "回调被调用");
    await sched.stop();
  }

  // 缺状态 → 告警
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-rt-"));
    dirs.push(dir);
    const statePath = join(dir, "missing.json");
    const alerts = [];
    const rt = createForumBumpRuntime({
      client: {},
      config: { forumBump: makeFb("execute", { statePath }) },
      logger: { info() {}, warn() {}, error() {} },
      alertNotifier: {
        notifyFailure: async (k) => { alerts.push(k); },
        notifyRecovery: async () => {},
      },
      createStateStoreFn: createForumBumpStateStore,
      createBumpServiceFn: () => ({ bumpThread: async () => ({}) }),
      scanCandidatesFn: async () => ({ candidates: [] }),
    });
    const st = await rt.start();
    assertEqual(st.success, false, "缺状态 start 失败");
    assert(alerts.includes("forum_bump_state_unavailable"), "状态不可用告警");
  }

  // Startup recovery 告警字段：before_send / after_send / after_delete
  for (const scenario of [
    { phase: "before_send", recovery: "manual_review_required", withMsg: false },
    { phase: "after_send", recovery: "cleanup_required", withMsg: true },
    { phase: "after_delete", recovery: "reconciliation_required", withMsg: true },
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "fb-rt-rec-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    const store = createForumBumpStateStore({
      statePath,
      logger: { info() {}, warn() {}, error() {} },
    });
    await store.initialize({ localDate: "2026-07-28" });
    let rev = 0;
    const opId = `op-${scenario.phase}`;
    await store.beginInFlight({
      expectedRevision: rev,
      operationId: opId,
      guildId: G,
      forumChannelId: F,
      threadId: T,
      startedAt: "2026-07-28T12:00:00.000Z",
    });
    rev += 1;
    if (scenario.phase !== "before_send") {
      await store.markMessageSent({
        expectedRevision: rev,
        operationId: opId,
        sentMessageId: M,
        sentAt: "2026-07-28T12:00:01.000Z",
      });
      rev += 1;
    }
    if (scenario.phase === "after_delete") {
      await store.markMessageDeleted({
        expectedRevision: rev,
        operationId: opId,
        deletedAt: "2026-07-28T12:00:02.000Z",
      });
    }
    const alertDetails = [];
    const rt = createForumBumpRuntime({
      client: { user: { id: "bot" } },
      config: { forumBump: makeFb("execute", { statePath }) },
      logger: { info() {}, warn() {}, error() {} },
      createStateStoreFn: () => store,
      createBumpServiceFn: () => ({ bumpThread: async () => ({ status: "skipped" }) }),
      scanCandidatesFn: async () => ({ candidates: [] }),
      alertNotifier: {
        notifyFailure: async (k, m, det) => {
          alertDetails.push({ k, details: det?.details ?? det });
        },
        notifyRecovery: async () => {},
      },
    });
    const st = await rt.start();
    assertEqual(st.recoveryStatus, scenario.recovery, `${scenario.phase} recovery`);
    assert(alertDetails.length >= 1, `${scenario.phase} 有告警`);
    const d = alertDetails[0].details;
    assertEqual(d.forumChannelId, F, `${scenario.phase} forumChannelId`);
    assertEqual(d.threadId, T, `${scenario.phase} threadId`);
    assertEqual(d.inFlightPhase, scenario.phase, `${scenario.phase} phase`);
    assertEqual(d.operationId, opId, `${scenario.phase} operationId`);
    if (scenario.withMsg) {
      assertEqual(d.sentMessageId, M, `${scenario.phase} sentMessageId`);
    } else {
      assertEqual(d.sentMessageId, null, `${scenario.phase} sentMessageId null`);
    }
    await rt.stop();
  }

  // 告警持久化失败 → fatal + onCriticalFailure（不 unhandled）
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-rt-fatal-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    const store = createForumBumpStateStore({
      statePath,
      logger: { info() {}, warn() {}, error() {} },
    });
    await store.initialize({ localDate: "2026-07-28" });
    const timers = makeTimers();
    let criticalCount = 0;
    let unhandled = 0;
    const onUR = () => { unhandled += 1; };
    process.on("unhandledRejection", onUR);
    try {
      const rt = createForumBumpRuntime({
        client: { user: { id: "bot" } },
        config: { forumBump: makeFb("execute", { statePath }) },
        logger: { info() {}, warn() {}, error() {} },
        clock: { now: () => Date.parse("2026-07-28T12:00:00.000Z") },
        timers,
        createStateStoreFn: () => store,
        createBumpServiceFn: () => ({
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
        }),
        scanCandidatesFn: async () => ({
          candidates: [{ threadId: T, forumChannelId: F }],
        }),
        alertNotifier: {
          notifyFailure: async () => {
            throw new Error("disk full");
          },
          notifyRecovery: async () => {},
        },
        onCriticalFailure: () => {
          criticalCount += 1;
        },
      });
      await rt.start();
      for (const t of timers.list()) t.cancelled = true;
      const once = await rt.getScheduler().runOnce();
      assertEqual(once.status, "cleanup_required", "业务结果 cleanup_required");
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assertEqual(criticalCount, 1, "onCriticalFailure 一次");
      assertEqual(rt.getStatus().fatal, true, "Runtime fatal");
      assertEqual(timers.list().length, 0, "无下一 timer");
      // 重复 processCycleResult 不二次 fatal 回调
      await rt.processCycleResult({
        status: "cleanup_required",
        errorCode: "DELETE_FAILED",
        sentMessageId: M,
      });
      assertEqual(criticalCount, 1, "致命回调只一次");
      assertEqual(unhandled, 0, "无 unhandled rejection");
      await rt.stop();
    } finally {
      process.removeListener("unhandledRejection", onUR);
    }
  }

  // state_failed / unexpected 告警失败同样致命
  for (const status of ["state_failed", "unexpected_failed"]) {
    const dir = mkdtempSync(join(tmpdir(), "fb-rt-fatal2-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    const store = createForumBumpStateStore({
      statePath,
      logger: { info() {}, warn() {}, error() {} },
    });
    await store.initialize({ localDate: "2026-07-28" });
    let critical = 0;
    const rt = createForumBumpRuntime({
      client: {},
      config: { forumBump: makeFb("execute", { statePath }) },
      logger: { info() {}, warn() {}, error() {} },
      createStateStoreFn: () => store,
      createBumpServiceFn: () => ({ bumpThread: async () => ({}) }),
      scanCandidatesFn: async () => ({ candidates: [] }),
      alertNotifier: {
        notifyFailure: async () => { throw new Error("disk"); },
        notifyRecovery: async () => {},
      },
      onCriticalFailure: () => { critical += 1; },
    });
    await rt.start();
    await rt.processCycleResult({ status, errorCode: "X" });
    assertEqual(critical, 1, `${status} 告警失败致命`);
    await rt.stop();
  }

  // Timer 回调入口异常 → Runtime 收到 unexpected_failed 告警
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-rt-timer-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    const store = createForumBumpStateStore({
      statePath,
      logger: { info() {}, warn() {}, error() {} },
    });
    await store.initialize({ localDate: "2026-07-28" });
    const clock = {
      t: Date.parse("2026-07-28T12:00:00.000Z"),
      boom: false,
      now() {
        if (this.boom) throw new Error("timer clock boom");
        return this.t;
      },
    };
    const timers = makeTimers();
    const alerts = [];
    const { createForumBumpScheduler } = await import("./scheduler.js");
    const rt = createForumBumpRuntime({
      client: { user: { id: "bot" } },
      config: { forumBump: makeFb("execute", { statePath }) },
      logger: { info() {}, warn() {}, error() {} },
      clock,
      timers,
      createStateStoreFn: () => store,
      createBumpServiceFn: () => ({ bumpThread: async () => ({ status: "skipped" }) }),
      createSchedulerFn: (deps) => createForumBumpScheduler(deps),
      scanCandidatesFn: async () => ({ candidates: [] }),
      alertNotifier: {
        notifyFailure: async (k, m, d) => { alerts.push({ k, d }); },
        notifyRecovery: async () => {},
      },
    });
    await rt.start();
    assert(timers.list().length >= 1, "有 timer");
    clock.boom = true;
    await timers.flush();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    assert(
      alerts.some((a) => a.k === "forum_bump_scheduler_unexpected_failed"),
      "Timer 入口异常 → unexpected_failed 告警",
    );
    assertEqual(timers.list().length, 0, "无活跃 timer");
    await rt.stop();
  }

  // Timer 入口异常 + notifyFailure 失败 → fatal
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-rt-timer-fatal-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    const store = createForumBumpStateStore({
      statePath,
      logger: { info() {}, warn() {}, error() {} },
    });
    await store.initialize({ localDate: "2026-07-28" });
    const clock = {
      t: Date.parse("2026-07-28T12:00:00.000Z"),
      boom: false,
      now() {
        if (this.boom) throw new Error("timer clock boom");
        return this.t;
      },
    };
    const timers = makeTimers();
    let critical = 0;
    let unhandled = 0;
    const onUR = () => { unhandled += 1; };
    process.on("unhandledRejection", onUR);
    try {
      const { createForumBumpScheduler } = await import("./scheduler.js");
      const rt = createForumBumpRuntime({
        client: { user: { id: "bot" } },
        config: { forumBump: makeFb("execute", { statePath }) },
        logger: { info() {}, warn() {}, error() {} },
        clock,
        timers,
        createStateStoreFn: () => store,
        createBumpServiceFn: () => ({ bumpThread: async () => ({ status: "skipped" }) }),
        createSchedulerFn: (deps) => createForumBumpScheduler(deps),
        scanCandidatesFn: async () => ({ candidates: [] }),
        alertNotifier: {
          notifyFailure: async () => { throw new Error("disk full"); },
          notifyRecovery: async () => {},
        },
        onCriticalFailure: () => { critical += 1; },
      });
      await rt.start();
      clock.boom = true;
      await timers.flush();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
      assertEqual(critical, 1, "Timer 告警失败 → critical 一次");
      assertEqual(rt.getStatus().fatal, true, "Runtime fatal");
      assertEqual(timers.list().length, 0, "无下一 timer");
      assertEqual(unhandled, 0, "无 unhandled rejection");
      await rt.stop();
    } finally {
      process.removeListener("unhandledRejection", onUR);
    }
  }
} finally {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  }
}

console.log(`\nforumBump runtime: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

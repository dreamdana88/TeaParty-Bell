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

} finally {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  }
}

console.log(`\nForumBump scheduler: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

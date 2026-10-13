/**
 * 特征测试：顶帖过程中任意时点崩溃后重启，既不重复顶帖、也不漏删帖。
 *
 * 第一进程：真实 State Store + 真实 Scheduler + 真实 Bump Service（假 Discord），
 * 在三个时点「挂起」模拟崩溃：send 前（send 永不返回）、send 后 delete 前（删前等待永不返回）、
 * delete 后（删后等待永不返回）。
 * 重启：仅凭磁盘上的 state.json 创建新的 Runtime，断言恢复分类、暂停原因、告警字段，
 * 且不扫描、不顶帖、不删帖、不 arm timer；再次重启仍保持暂停（不会自动续顶）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { createForumBumpStateStore } from "./stateStore.js";
import { createForumBumpScheduler } from "./scheduler.js";
import { createForumBumpService } from "./bumpService.js";
import { createForumBumpRuntime } from "./runtime.js";
import { SCHEDULER_REFERENCE_DEFAULTS } from "./schedulerConfig.js";

let passed = 0;
let failed = 0;
function assert(c, l) {
  if (c) { passed++; console.log(`  PASS: ${l}`); } else { failed++; console.error(`  FAIL: ${l}`); }
}
function assertEqual(a, e, l) {
  assert(a === e, `${l} (got ${JSON.stringify(a)})`);
}

const G = "111111111111111111";
const F = "222222222222222222";
const T = "333333333333333333";
const M = "444444444444444444";
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const never = () => new Promise(() => {});

function makeTimers() {
  const list = [];
  let id = 0;
  return {
    setTimeout(fn, ms) { const h = ++id; list.push({ h, fn, ms, cancelled: false }); return h; },
    clearTimeout(h) { const t = list.find((x) => x.h === h); if (t) t.cancelled = true; },
    active: () => list.filter((t) => !t.cancelled),
  };
}

function makeThread(hooks) {
  const message = {
    id: M,
    delete: async () => { hooks.deletes += 1; },
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
        has: (f) => [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads].includes(f),
      };
    },
    send: async () => {
      hooks.sends += 1;
      if (hooks.crashAt === "before_send") return never();
      thread.lastMessageId = M;
      thread.archived = false;
      return message;
    },
  };
  return thread;
}

function readState(statePath) {
  return JSON.parse(readFileSync(statePath, "utf8"));
}

async function waitFor(cond, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
}

/** 第一进程：跑到崩溃点后「挂起」，返回此时磁盘状态。 */
async function runUntilCrash(dir, crashAt) {
  const statePath = join(dir, "state.json");
  const store = createForumBumpStateStore({ statePath, logger: quiet });
  await store.initialize({ localDate: "2026-07-28" });
  const hooks = { crashAt, sends: 0, deletes: 0, sleeps: 0 };
  const thread = makeThread(hooks);
  const client = {
    user: { id: "bot" },
    isReady: () => true,
    channels: {
      fetch: async (id) => {
        if (id === T) return thread;
        if (id === F) return thread.parent;
        throw new Error(`unknown ${id}`);
      },
    },
  };
  const now = Date.parse("2026-07-28T12:00:00.000Z");
  const bumpService = createForumBumpService({
    client,
    logger: quiet,
    clock: { now: () => now },
    // 第 1 次 sleep：删前等待；第 2 次：删后等待
    sleep: async () => {
      hooks.sleeps += 1;
      if (crashAt === "after_send" && hooks.sleeps === 1) return never();
      if (crashAt === "after_delete" && hooks.sleeps === 2) return never();
    },
  });
  const sched = createForumBumpScheduler({
    scanCandidates: async () => ({ candidates: [{ threadId: T, forumChannelId: F, guildId: G }] }),
    bumpService,
    stateStore: store,
    config: {
      enabled: true,
      guildId: G,
      forumChannelIds: [F],
      ...SCHEDULER_REFERENCE_DEFAULTS,
      activeStart: "00:00",
      activeEnd: "23:59",
      timezone: "UTC",
      cooldownMs: 60_000,
      cooldownJitterMs: 0,
      idlePollMs: 30_000,
      failureBackoffMs: 15_000,
    },
    clock: { now: () => now },
    timers: makeTimers(),
    random: () => 0,
    createOperationId: () => `op-${crashAt}`,
    logger: quiet,
  });
  await sched.start();
  void sched.runOnce(); // 永不完成 = 进程在此刻崩溃
  await waitFor(() => readState(statePath).inFlight?.phase === crashAt);
  return { statePath, hooks, disk: readState(statePath) };
}

/** 重启：只依据磁盘状态创建新 Runtime。 */
async function restart(dir, statePath) {
  const counts = { scans: 0, bumps: 0 };
  const alerts = [];
  const timers = makeTimers();
  const rt = createForumBumpRuntime({
    client: { user: { id: "bot" } },
    config: {
      forumBump: {
        mode: "execute",
        guildId: G,
        forumChannelIds: [F],
        excludedTagIds: [],
        silenceDays: 30,
        skipPinned: true,
        dailyLimit: 3,
        cooldownMs: 60_000,
        cooldownJitterMs: 0,
        autoIntervalMs: 60_000,
        idlePollMs: 30_000,
        failureBackoffMs: 15_000,
        timezone: "UTC",
        activeStart: "00:00",
        activeEnd: "23:59",
        statePath,
        dynamicConfigPath: join(dir, "config.json"),
      },
    },
    logger: quiet,
    timers,
    clock: { now: () => Date.parse("2026-07-28T12:10:00.000Z") },
    preflightForumsFn: async () => ({ success: true, errorCode: null, failures: [] }),
    scanCandidatesFn: async () => { counts.scans += 1; return { candidates: [] }; },
    createBumpServiceFn: () => ({
      bumpThread: async () => { counts.bumps += 1; return { status: "skipped" }; },
    }),
    alertNotifier: {
      notifyFailure: async (key, _msg, det) => { alerts.push({ key, details: det?.details ?? det }); },
      notifyRecovery: async () => {},
    },
  });
  const st = await rt.start();
  const result = { st, counts, alerts, timersArmed: timers.active().length, disk: readState(statePath) };
  await rt.stop();
  return result;
}

const scenarios = [
  {
    crashAt: "before_send",
    recovery: "manual_review_required",
    pauseReason: "INFLIGHT_BEFORE_SEND",
    alertKey: "forum_bump_scheduler_halted",
    sentMessageId: null,
    sends: 1,
    deletes: 0,
  },
  {
    crashAt: "after_send",
    recovery: "cleanup_required",
    pauseReason: "INFLIGHT_MESSAGE_MAY_EXIST",
    alertKey: "forum_bump_cleanup_required",
    sentMessageId: M,
    sends: 1,
    deletes: 0,
  },
  {
    crashAt: "after_delete",
    recovery: "reconciliation_required",
    pauseReason: "INFLIGHT_SUCCESS_RECONCILIATION_REQUIRED",
    alertKey: "forum_bump_reconciliation_required",
    sentMessageId: M,
    sends: 1,
    deletes: 1,
  },
];

console.log("\n=== forumBump 崩溃恢复（特征测试）===\n");
const dirs = [];
try {
  for (const sc of scenarios) {
    const dir = mkdtempSync(join(tmpdir(), `fb-crash-${sc.crashAt}-`));
    dirs.push(dir);
    const crash = await runUntilCrash(dir, sc.crashAt);
    const tag = `[${sc.crashAt}]`;
    assertEqual(crash.disk.inFlight?.phase, sc.crashAt, `${tag} 崩溃时磁盘 inFlight.phase`);
    assertEqual(crash.disk.inFlight?.sentMessageId ?? null, sc.sentMessageId, `${tag} 崩溃时磁盘 sentMessageId`);
    assertEqual(crash.disk.successCount, 0, `${tag} 崩溃时未计入当日额度`);
    assertEqual(crash.hooks.sends, sc.sends, `${tag} 崩溃前 send 次数`);
    assertEqual(crash.hooks.deletes, sc.deletes, `${tag} 崩溃前 delete 次数`);

    const r1 = await restart(dir, crash.statePath);
    assertEqual(r1.st.recoveryStatus, sc.recovery, `${tag} 重启后恢复分类`);
    assertEqual(r1.st.timerArmed, false, `${tag} 重启后不 arm timer`);
    assertEqual(r1.timersArmed, 0, `${tag} 无活跃 timer`);
    assertEqual(r1.counts.scans, 0, `${tag} 重启后不扫描`);
    assertEqual(r1.counts.bumps, 0, `${tag} 重启后不再顶帖（不重复顶帖）`);
    assertEqual(r1.disk.paused, true, `${tag} 状态已暂停`);
    assertEqual(r1.disk.pauseReason, sc.pauseReason, `${tag} 暂停原因`);
    assertEqual(r1.disk.inFlight?.phase, sc.crashAt, `${tag} 保留 inFlight 供人工处理`);
    assertEqual(r1.disk.inFlight?.sentMessageId ?? null, sc.sentMessageId, `${tag} 保留 sentMessageId（不漏删）`);
    assertEqual(r1.disk.successCount, 0, `${tag} 不自动计入当日额度`);
    assert(r1.alerts.length >= 1, `${tag} 发出恢复告警`);
    const a = r1.alerts[0] ?? {};
    assertEqual(a.key, sc.alertKey, `${tag} 告警 key`);
    assertEqual(a.details?.inFlightPhase, sc.crashAt, `${tag} 告警 inFlightPhase`);
    assertEqual(a.details?.threadId, T, `${tag} 告警 threadId`);
    assertEqual(a.details?.sentMessageId ?? null, sc.sentMessageId, `${tag} 告警 sentMessageId`);
    assertEqual(a.details?.operationId, `op-${sc.crashAt}`, `${tag} 告警 operationId`);

    const r2 = await restart(dir, crash.statePath);
    assertEqual(r2.st.recoveryStatus, sc.recovery, `${tag} 再次重启分类不变`);
    assertEqual(r2.counts.bumps + r2.counts.scans, 0, `${tag} 再次重启仍不扫描/顶帖`);
    assertEqual(r2.disk.pauseReason, sc.pauseReason, `${tag} 再次重启暂停原因不变`);
    assert(existsSync(crash.statePath), `${tag} 状态文件仍在`);
  }
} finally {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
}

console.log(`\n[crashRecovery.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

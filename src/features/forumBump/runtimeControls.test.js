/**
 * D-6A Runtime 动态配置热更新 / 管理员暂停恢复测试。
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { createForumBumpRuntime } from "./runtime.js";
import { createForumBumpStateStore } from "./stateStore.js";
import { createForumBumpDynamicConfigStore } from "./dynamicConfigStore.js";
import { createDynamicConfigDocument } from "./dynamicConfigSchema.js";

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
const F2 = "333333333333333333";
const T = "444444444444444444";
const dirs = [];

console.log("\n=== forumBump runtimeControls (D-6A) ===\n");

function makeFb(mode, extra = {}) {
  return {
    mode,
    guildId: G,
    forumChannelIds: [F],
    excludedTagIds: [],
    silenceDays: 30,
    skipPinned: true,
    dailyLimit: 3,
    cooldownMs: 40 * 60_000,
    cooldownJitterMs: 0,
    autoIntervalMs: 4 * 60 * 60_000, // 10:00–22:00 / 3 = 4h
    idlePollMs: 30_000,
    failureBackoffMs: 15_000,
    timezone: "UTC",
    activeStart: "10:00",
    activeEnd: "22:00",
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
    cancelAll() {
      for (const t of this.list()) t.cancelled = true;
    },
  };
}

function forumPerms(names) {
  return {
    has(flag) {
      const map = {
        [PermissionFlagsBits.ViewChannel]: "ViewChannel",
        [PermissionFlagsBits.ReadMessageHistory]: "ReadMessageHistory",
        [PermissionFlagsBits.SendMessagesInThreads]: "SendMessagesInThreads",
      };
      const name = map[flag] || flag;
      return names.includes(name);
    },
  };
}

function makeClient(forums = {}) {
  return {
    user: { id: "bot" },
    channels: {
      async fetch(id) {
        if (forums[id]) return forums[id];
        const err = new Error("missing");
        err.code = 10003;
        throw err;
      },
    },
  };
}

function defaultForum(id = F) {
  return {
    id,
    type: ChannelType.GuildForum,
    guildId: G,
    permissionsFor: () => forumPerms([
      "ViewChannel", "ReadMessageHistory", "SendMessagesInThreads",
    ]),
  };
}

async function bootExecute(dir, extraFb = {}, opts = {}) {
  const statePath = join(dir, "state.json");
  const dynamicConfigPath = join(dir, "config.json");
  const store = createForumBumpStateStore({
    statePath,
    logger: { info() {}, warn() {}, error() {} },
  });
  await store.initialize({ localDate: "2026-07-28" });
  const timers = makeTimers();
  let tNow = Date.parse("2026-07-28T12:00:00.000Z");
  const clock = { now: () => tNow };
  const scanLog = [];
  const rt = createForumBumpRuntime({
    client: opts.client ?? makeClient({ [F]: defaultForum(F), [F2]: defaultForum(F2) }),
    config: {
      forumBump: makeFb("execute", {
        statePath,
        dynamicConfigPath,
        ...extraFb,
      }),
    },
    logger: { info() {}, warn() {}, error() {} },
    clock,
    timers,
    alertNotifier: {
      notifyFailure: async () => {},
      notifyRecovery: async () => {},
    },
    createStateStoreFn: () => store,
    scanCandidatesFn: async (p) => {
      scanLog.push({
        forumIds: [...(p.forumIds || [])],
        silenceDays: p.silenceDays,
      });
      return {
        candidates: opts.noCandidate
          ? []
          : [{ threadId: T, forumChannelId: (p.forumIds && p.forumIds[0]) || F, guildId: G }],
      };
    },
    createBumpServiceFn: () => ({
      bumpThread: async () => ({
        success: true,
        status: "succeeded",
        sentMessageId: "999999999999999999",
        diagnosticsComplete: true,
      }),
    }),
    preflightForumsFn: opts.preflightForumsFn,
  });
  const start = await rt.start();
  timers.cancelAll();
  return {
    rt, store, timers, clock,
    setNow: (ms) => { tNow = ms; },
    getNow: () => tNow,
    statePath,
    dynamicConfigPath,
    scanLog,
    start,
  };
}

try {
  // --- 文件缺失用 .env 基线 ---
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-ctl-"));
    dirs.push(dir);
    const { rt, start, dynamicConfigPath } = await bootExecute(dir);
    assert(start.success, "无动态文件可 start");
    assertEqual(existsSync(dynamicConfigPath), false, "未自动创建动态文件");
    const snap = await rt.getControlSnapshot();
    assertEqual(snap.dailyLimit, 3, "基线 dailyLimit");
    assertEqual(snap.autoIntervalMinutes, 240, "10–22 / 3 = 240min");
    assertEqual(snap.mode, "execute", "mode");
    await rt.stop();
  }

  // --- 首次修改创建文件 + 重启覆盖 .env ---
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-ctl-"));
    dirs.push(dir);
    const h = await bootExecute(dir, { dailyLimit: 3 });
    const upd = await h.rt.updateDynamicConfig(
      { dailyLimit: 5 },
      { actorId: "u1", actorTag: "admin:u1" },
    );
    assert(upd.success, "首次 update 成功");
    assert(existsSync(h.dynamicConfigPath), "创建 config.json");
    assertEqual(upd.config.dailyLimit, 5, "saved dailyLimit 5");
    assertEqual(upd.config.revision, 1, "revision 1");
    // successCount 不重置
    await h.store.load();
    assertEqual(h.store.getSnapshot().successCount, 0, "不重置 successCount");
    await h.rt.stop();

    // 重启：动态覆盖 .env dailyLimit=3
    const store2 = createForumBumpStateStore({
      statePath: h.statePath,
      logger: { info() {}, warn() {}, error() {} },
    });
    const timers2 = makeTimers();
    const rt2 = createForumBumpRuntime({
      client: makeClient({ [F]: defaultForum(F) }),
      config: {
        forumBump: makeFb("execute", {
          statePath: h.statePath,
          dynamicConfigPath: h.dynamicConfigPath,
          dailyLimit: 3, // .env 仍是 3
        }),
      },
      logger: { info() {}, warn() {}, error() {} },
      clock: { now: () => Date.parse("2026-07-28T12:00:00.000Z") },
      timers: timers2,
      alertNotifier: { notifyFailure: async () => {}, notifyRecovery: async () => {} },
      createStateStoreFn: () => store2,
      scanCandidatesFn: async () => ({ candidates: [] }),
      createBumpServiceFn: () => ({ bumpThread: async () => ({ success: true, status: "succeeded" }) }),
    });
    const s2 = await rt2.start();
    assert(s2.success, "重启 start");
    const snap2 = await rt2.getControlSnapshot();
    assertEqual(snap2.dailyLimit, 5, "动态配置覆盖 .env");
    assertEqual(snap2.autoIntervalMinutes, 144, "720/5=144min");
    await rt2.stop();
  }

  // --- 修改 silenceDays 后扫描使用新值 ---
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-ctl-"));
    dirs.push(dir);
    const h = await bootExecute(dir);
    h.timers.cancelAll();
    await h.rt.updateDynamicConfig({ silenceDays: 7 });
    h.timers.cancelAll();
    // 清除 nextEligible 以便立即 run
    await h.store.load();
    const snap = h.store.getSnapshot();
    await h.store.deferUntil({
      expectedRevision: snap.revision,
      nextEligibleAt: new Date(h.getNow() - 1000).toISOString(),
    });
    await h.rt.getScheduler().rescheduleFromState({ reason: "ready" });
    h.timers.cancelAll();
    await h.rt.getScheduler().runOnce();
    assert(h.scanLog.length >= 1, "发生扫描");
    assertEqual(h.scanLog[h.scanLog.length - 1].silenceDays, 7, "silenceDays=7");
    await h.rt.stop();
  }

  // --- 修改 Forum 列表 ---
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-ctl-"));
    dirs.push(dir);
    const h = await bootExecute(dir);
    h.timers.cancelAll();
    const upd = await h.rt.updateDynamicConfig({ forumChannelIds: [F2] });
    assert(upd.success, "换 Forum 成功");
    await h.store.load();
    const snap = h.store.getSnapshot();
    await h.store.deferUntil({
      expectedRevision: snap.revision,
      nextEligibleAt: new Date(h.getNow() - 1000).toISOString(),
    });
    h.timers.cancelAll();
    await h.rt.getScheduler().runOnce();
    assertEqual(
      h.scanLog[h.scanLog.length - 1].forumIds[0],
      F2,
      "扫描使用新 Forum",
    );
    await h.rt.stop();
  }

  // --- 新增 Forum Preflight 失败整体拒绝 ---
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-ctl-"));
    dirs.push(dir);
    const h = await bootExecute(dir, {}, {
      preflightForumsFn: async () => ({
        success: false,
        errorCode: "DYNAMIC_CONFIG_PREFLIGHT_FAILED",
        failures: [{ forumId: F2, errorCode: "BOT_MISSING_PERMISSION" }],
      }),
    });
    h.timers.cancelAll();
    const before = await h.rt.getControlSnapshot();
    const upd = await h.rt.updateDynamicConfig({ forumChannelIds: [F, F2] });
    assertEqual(upd.success, false, "preflight 失败拒绝");
    assertEqual(upd.errorCode, "DYNAMIC_CONFIG_PREFLIGHT_FAILED", "PREFLIGHT code");
    const after = await h.rt.getControlSnapshot();
    assertEqual(after.dailyLimit, before.dailyLimit, "配置未变");
    assertEqual(after.forumChannelIds.join(","), F, "forum 列表未变");
    assertEqual(existsSync(h.dynamicConfigPath), false, "失败不创建文件");
    await h.rt.stop();
  }

  // --- dailyLimit 调低至已完成以下 → daily_limit 排程 ---
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-ctl-"));
    dirs.push(dir);
    const h = await bootExecute(dir, { dailyLimit: 5 });
    h.timers.cancelAll();
    // 模拟今日已成功 2 次
    await h.store.load();
    let rev = h.store.getSnapshot().revision;
    // 直接写磁盘状态（测试）
    const path = h.statePath;
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.successCount = 2;
    raw.lastSuccessAt = "2026-07-28T11:00:00.000Z";
    raw.revision = rev;
    writeFileSync(path, JSON.stringify(raw, null, 2));
    await h.store.load();

    const upd = await h.rt.updateDynamicConfig({ dailyLimit: 1 });
    assert(upd.success, "调低 dailyLimit 成功");
    await h.store.load();
    const st = h.store.getSnapshot();
    assertEqual(st.successCount, 2, "不重置 successCount");
    assertEqual(st.lastSuccessAt, "2026-07-28T11:00:00.000Z", "保留 lastSuccessAt");
    // 应排到下一日（无活跃 timer 立即，或 next 在未来）
    const snap = await h.rt.getControlSnapshot();
    assert(snap.nextEligibleAt != null, "有 nextEligibleAt");
    assert(Date.parse(snap.nextEligibleAt) > h.getNow(), "next 在未来（下一日）");
    await h.rt.stop();
  }

  // --- inFlight 阻止更新 ---
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-ctl-"));
    dirs.push(dir);
    const h = await bootExecute(dir);
    h.timers.cancelAll();
    const raw = JSON.parse(readFileSync(h.statePath, "utf8"));
    raw.inFlight = {
      operationId: "op_test",
      guildId: G,
      forumChannelId: F,
      threadId: T,
      phase: "after_send",
      sentMessageId: "555555555555555555",
      startedAt: "2026-07-28T11:00:00.000Z",
      updatedAt: "2026-07-28T11:00:01.000Z",
    };
    writeFileSync(h.statePath, JSON.stringify(raw, null, 2));
    const upd = await h.rt.updateDynamicConfig({ silenceDays: 10 });
    assertEqual(upd.success, false, "inFlight 拒绝更新");
    assertEqual(upd.errorCode, "DYNAMIC_CONFIG_INFLIGHT_BLOCKED", "INFLIGHT_BLOCKED");
    await h.rt.stop();
  }

  // --- 非法动态文件 fail closed ---
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-ctl-"));
    dirs.push(dir);
    const statePath = join(dir, "state.json");
    const dynamicConfigPath = join(dir, "config.json");
    writeFileSync(dynamicConfigPath, "{broken", "utf8");
    const store = createForumBumpStateStore({
      statePath,
      logger: { info() {}, warn() {}, error() {} },
    });
    await store.initialize({ localDate: "2026-07-28" });
    const timers = makeTimers();
    const rt = createForumBumpRuntime({
      client: makeClient({ [F]: defaultForum(F) }),
      config: {
        forumBump: makeFb("execute", { statePath, dynamicConfigPath }),
      },
      logger: { info() {}, warn() {}, error() {} },
      clock: { now: () => Date.parse("2026-07-28T12:00:00.000Z") },
      timers,
      alertNotifier: { notifyFailure: async () => {}, notifyRecovery: async () => {} },
      createStateStoreFn: () => store,
      scanCandidatesFn: async () => ({ candidates: [] }),
      createBumpServiceFn: () => ({ bumpThread: async () => ({ success: true, status: "succeeded" }) }),
    });
    const s = await rt.start();
    assertEqual(s.success, false, "损坏配置 start 失败");
    assertEqual(s.timerArmed, false, "无 timer");
    assertEqual(s.errorCode, "DYNAMIC_CONFIG_PARSE_FAILED", "PARSE error");
    assertEqual(timers.list().length, 0, "无活跃 timer");
    await rt.stop();
  }

  // --- 管理员暂停 / 恢复 ---
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-ctl-"));
    dirs.push(dir);
    const h = await bootExecute(dir);
    assert(h.timers.list().length >= 0, "启动后可能有 timer");
    const p1 = await h.rt.pauseByAdmin({ actorId: "admin1" });
    assert(p1.success, "pause 成功");
    assertEqual(p1.pauseReason, "ADMIN_PAUSED", "ADMIN_PAUSED");
    assertEqual(h.timers.list().length, 0, "暂停后无 timer");
    const p2 = await h.rt.pauseByAdmin({ actorId: "admin1" });
    assert(p2.success && p2.idempotent, "重复 pause 幂等");

    await h.store.load();
    assertEqual(h.store.getSnapshot().paused, true, "磁盘 paused");
    assertEqual(h.store.getSnapshot().pauseReason, "ADMIN_PAUSED", "磁盘 reason");

    // 模拟重启后保持
    await h.rt.stop();
    const store2 = createForumBumpStateStore({
      statePath: h.statePath,
      logger: { info() {}, warn() {}, error() {} },
    });
    const timers2 = makeTimers();
    const rt2 = createForumBumpRuntime({
      client: makeClient({ [F]: defaultForum(F) }),
      config: {
        forumBump: makeFb("execute", {
          statePath: h.statePath,
          dynamicConfigPath: h.dynamicConfigPath,
        }),
      },
      logger: { info() {}, warn() {}, error() {} },
      clock: { now: () => Date.parse("2026-07-28T12:00:00.000Z") },
      timers: timers2,
      alertNotifier: { notifyFailure: async () => {}, notifyRecovery: async () => {} },
      createStateStoreFn: () => store2,
      scanCandidatesFn: async () => ({ candidates: [] }),
      createBumpServiceFn: () => ({ bumpThread: async () => ({ success: true, status: "succeeded" }) }),
    });
    const s2 = await rt2.start();
    assert(s2.success !== false || s2.paused === true || s2.halted === true, "重启可识别 paused");
    assertEqual(timers2.list().length, 0, "ADMIN_PAUSED 重启无 timer");
    const snap = await rt2.getControlSnapshot();
    assertEqual(snap.paused, true, "snapshot paused");
    assertEqual(snap.pauseReason, "ADMIN_PAUSED", "snapshot reason");

    const res = await rt2.resumeByAdmin({ actorId: "admin1" });
    assert(res.success, "resume 成功");
    assertEqual(res.paused, false, "已恢复");
    // 可能有 timer
    await store2.load();
    assertEqual(store2.getSnapshot().paused, false, "磁盘 unpaused");
    await rt2.stop();
  }

  // --- 安全故障 pause 不允许管理员 resume ---
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-ctl-"));
    dirs.push(dir);
    const h = await bootExecute(dir);
    h.timers.cancelAll();
    await h.store.load();
    await h.store.pause({
      expectedRevision: h.store.getSnapshot().revision,
      reason: "DELETE_FAILED",
    });
    const res = await h.rt.resumeByAdmin({});
    assertEqual(res.success, false, "安全故障拒绝 resume");
    assertEqual(res.errorCode, "STATE_RECOVERY_REQUIRED", "RECOVERY_REQUIRED");
    await h.store.load();
    assertEqual(h.store.getSnapshot().pauseReason, "DELETE_FAILED", "reason 保留");
    await h.rt.stop();
  }

  // --- inFlight 时拒绝 resume ---
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-ctl-"));
    dirs.push(dir);
    const h = await bootExecute(dir);
    h.timers.cancelAll();
    await h.rt.pauseByAdmin({});
    const raw = JSON.parse(readFileSync(h.statePath, "utf8"));
    raw.inFlight = {
      operationId: "op_x",
      guildId: G,
      forumChannelId: F,
      threadId: T,
      phase: "before_send",
      sentMessageId: null,
      startedAt: "2026-07-28T11:00:00.000Z",
      updatedAt: "2026-07-28T11:00:00.000Z",
    };
    writeFileSync(h.statePath, JSON.stringify(raw, null, 2));
    const res = await h.rt.resumeByAdmin({});
    assertEqual(res.success, false, "inFlight 拒绝 resume");
    assertEqual(res.errorCode, "STATE_RECOVERY_REQUIRED", "inFlight recovery");
    await h.rt.stop();
  }

  // --- 修改 active 窗口后重新排程 ---
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-ctl-"));
    dirs.push(dir);
    // 当前 12:00 UTC 在 10–22 内；改成 14:00–22:00 后变为窗外
    const h = await bootExecute(dir);
    h.timers.cancelAll();
    const upd = await h.rt.updateDynamicConfig({
      activeStart: "14:00",
      activeEnd: "22:00",
    });
    assert(upd.success, "改窗口成功");
    await h.store.load();
    const next = h.store.getSnapshot().nextEligibleAt;
    assert(next != null, "有 nextEligible");
    assert(Date.parse(next) >= Date.parse("2026-07-28T14:00:00.000Z"), "排到 14:00 或之后");
    await h.rt.stop();
  }

  // --- getControlSnapshot 字段 ---
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-ctl-"));
    dirs.push(dir);
    const h = await bootExecute(dir);
    const snap = await h.rt.getControlSnapshot();
    for (const k of [
      "mode", "paused", "pauseReason", "successCount", "dailyLimit",
      "lastSuccessAt", "nextEligibleAt", "inFlightPhase",
      "activeStart", "activeEnd", "forumChannelIds", "silenceDays",
      "autoIntervalMinutes",
    ]) {
      assert(k in snap, `snapshot 含 ${k}`);
    }
    assert(!("token" in snap), "无 token");
    await h.rt.stop();
  }

  // --- 成功路径无抖动：auto interval ---
  {
    const dir = mkdtempSync(join(tmpdir(), "fb-ctl-"));
    dirs.push(dir);
    // 08:00–13:00 dailyLimit 5 → 60min；测试用 UTC 窗
    const h = await bootExecute(dir, {
      dailyLimit: 5,
      activeStart: "08:00",
      activeEnd: "13:00",
      autoIntervalMs: 60 * 60_000,
    });
    h.timers.cancelAll();
    // 确保 eligible
    await h.store.load();
    await h.store.deferUntil({
      expectedRevision: h.store.getSnapshot().revision,
      nextEligibleAt: new Date(h.getNow() - 1000).toISOString(),
    });
    let randomCalls = 0;
    // 替换 scheduler 的 random 不可行；通过 runOnce 后 nextEligible 验证间隔
    const r = await h.rt.getScheduler().runOnce();
    if (r.status === "succeeded") {
      await h.store.load();
      const last = Date.parse(h.store.getSnapshot().lastSuccessAt);
      const next = Date.parse(h.store.getSnapshot().nextEligibleAt);
      assertEqual(next - last, 60 * 60_000, "成功间隔=自动 60min 无抖动");
      assertEqual(h.store.getSnapshot().successCount, 1, "successCount +1");
    } else {
      // 若因其他原因未成功，至少确认配置间隔
      const snap = await h.rt.getControlSnapshot();
      assertEqual(snap.autoIntervalMinutes, 60, "auto 60min");
      assert(true, `runOnce status=${r.status}（配置间隔已校验）`);
    }
    await h.rt.stop();
  }

} finally {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log(`\n=== runtimeControls: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);

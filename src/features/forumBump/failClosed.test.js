/**
 * 特征测试：真实磁盘写失败时 fail closed（不依赖 store 的返回值约定，直接让文件系统拒绝写入）。
 * - 状态文件写失败：不顶帖、不 arm 下一次 timer、发出告警
 * - 动态配置写失败：保存被拒绝、生效配置与磁盘文件都保持原样、调度不变
 * 仅在 POSIX 且非 root 时运行（chmod 才生效）。
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createForumBumpStateStore } from "./stateStore.js";
import { createForumBumpRuntime } from "./runtime.js";
import { createForumBumpService } from "./bumpService.js";
import { ChannelType, PermissionFlagsBits } from "discord.js";

let passed = 0;
let failed = 0;
function assert(c, l) {
  if (c) { passed++; console.log(`  PASS: ${l}`); } else { failed++; console.error(`  FAIL: ${l}`); }
}
function assertEqual(a, e, l) {
  assert(JSON.stringify(a) === JSON.stringify(e), `${l} (got ${JSON.stringify(a)})`);
}

const G = "111111111111111111";
const F = "222222222222222222";
const T = "333333333333333333";
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const NOW = Date.parse("2026-07-28T04:00:00.000Z"); // 上海 12:00，窗口内

function makeTimers() {
  const list = [];
  let id = 0;
  return {
    setTimeout(fn, ms) { const h = ++id; list.push({ h, fn, ms, cancelled: false, fired: false }); return h; },
    clearTimeout(h) { const t = list.find((x) => x.h === h); if (t) t.cancelled = true; },
    active: () => list.filter((t) => !t.cancelled && !t.fired),
    async fireAll() {
      for (const t of this.active()) { t.fired = true; t.fn(); }
      for (let i = 0; i < 30; i += 1) await new Promise((r) => setImmediate(r));
    },
  };
}

async function setup(root, { fresh = true } = {}) {
  const stateDir = join(root, "state");
  const cfgDir = join(root, "cfg");
  const statePath = join(stateDir, "state.json");
  const dynamicConfigPath = join(cfgDir, "config.json");
  if (fresh) {
    mkdirSync(stateDir);
    mkdirSync(cfgDir);
    const boot = createForumBumpStateStore({ statePath, logger: quiet });
    await boot.initialize({ localDate: "2026-07-28" });
  }
  const timers = makeTimers();
  const alerts = [];
  const counts = { bumps: 0, scans: 0, sends: 0, deletes: 0 };
  const hooks = { onSend: null };
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
      return { has: (f) => [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads].includes(f) };
    },
    send: async () => {
      counts.sends += 1;
      if (hooks.onSend) hooks.onSend();
      return { id: "444444444444444444", delete: async () => { counts.deletes += 1; } };
    },
  };
  const client = {
    user: { id: "bot" },
    isReady: () => true,
    channels: { fetch: async (id) => (id === T ? thread : id === F ? thread.parent : null) },
  };
  const rt = createForumBumpRuntime({
    client,
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
        timezone: "Asia/Shanghai",
        activeStart: "10:00",
        activeEnd: "22:00",
        statePath,
        dynamicConfigPath,
      },
    },
    logger: quiet,
    timers,
    clock: { now: () => NOW },
    random: () => 0,
    preflightForumsFn: async () => ({ success: true, errorCode: null, failures: [] }),
    scanCandidatesFn: async () => {
      counts.scans += 1;
      return { candidates: [{ threadId: T, forumChannelId: F, guildId: G }] };
    },
    // 真实 Bump Service（假 Discord），仅把删前/删后等待改为立即返回
    createBumpServiceFn: (deps) => {
      const svc = createForumBumpService({ ...deps, sleep: async () => {} });
      return { bumpThread: async (...a) => { counts.bumps += 1; return svc.bumpThread(...a); } };
    },
    alertNotifier: {
      notifyFailure: async (key) => { alerts.push(key); },
      notifyRecovery: async () => {},
    },
  });
  return { rt, timers, alerts, counts, hooks, stateDir, cfgDir, statePath, dynamicConfigPath };
}

if (typeof process.getuid === "function" && process.getuid() !== 0) {
  const roots = [];
  try {
    // A. 状态写失败（beginInFlight 前）→ 不顶帖
    {
      const root = mkdtempSync(join(tmpdir(), "fb-fc-state-"));
      roots.push(root);
      const h = await setup(root);
      const st = await h.rt.start();
      assert(st.success === true && h.timers.active().length === 1, "A: 启动成功且 arm 了 timer");
      // 对照：同样的环境在可写时确实会发送（证明 A 的「不发送」来自写失败而不是候选不合格）
      const before = readFileSync(h.statePath, "utf8");
      chmodSync(h.stateDir, 0o555);
      try {
        await h.timers.fireAll();
      } finally {
        chmodSync(h.stateDir, 0o755);
      }
      assertEqual(h.counts.sends, 0, "A: 状态写失败（beginInFlight 未落盘）→ 不发送消息");
      assertEqual(h.counts.deletes, 0, "A: 无删除");
      assertEqual(readFileSync(h.statePath, "utf8"), before, "A: 状态文件保持原样");
      assertEqual(h.timers.active().length, 0, "A: 不再 arm 下一次 timer（停止调度）");
      assertEqual(h.alerts, ["forum_bump_state_unavailable"], "A: 告警 key");
      await h.rt.stop();
    }
    // A0. 对照：可写时同样环境会顶帖一次（证明 A 的「不发送」来自写失败）
    {
      const root = mkdtempSync(join(tmpdir(), "fb-fc-ok-"));
      roots.push(root);
      const h = await setup(root);
      await h.rt.start();
      await h.timers.fireAll();
      assertEqual([h.counts.sends, h.counts.deletes], [1, 1], "A0: 可写时 send 1 次、delete 1 次");
      assertEqual(JSON.parse(readFileSync(h.statePath, "utf8")).successCount, 1, "A0: 计入额度");
      await h.rt.stop();
    }
    // A2. send 之后状态变为不可写（markMessageSent 写失败）→ 仍删除消息（不漏删），停止调度
    {
      const root = mkdtempSync(join(tmpdir(), "fb-fc-sent-"));
      roots.push(root);
      const h = await setup(root);
      await h.rt.start();
      h.hooks.onSend = () => chmodSync(h.stateDir, 0o555);
      try {
        await h.timers.fireAll();
      } finally {
        chmodSync(h.stateDir, 0o755);
      }
      assertEqual([h.counts.sends, h.counts.deletes], [1, 1], "A2: send 1 次且仍 delete 1 次（不漏删）");
      const disk = JSON.parse(readFileSync(h.statePath, "utf8"));
      assertEqual(disk.inFlight?.phase ?? null, "before_send", "A2: 磁盘停在 before_send（重启后人工复核，不会自动重顶）");
      assertEqual(disk.successCount, 0, "A2: 不计入额度");
      assertEqual(h.timers.active().length, 0, "A2: 停止调度");
      assertEqual(h.alerts, ["forum_bump_state_unavailable"], "A2: 告警 key");
      await h.rt.stop();

      // A2 续：状态恢复可写后重启（真实恢复路径，同一候选仍可顶）→ 不得再次顶帖
      const r = await setup(root, { fresh: false });
      const st2 = await r.rt.start();
      const disk2 = JSON.parse(readFileSync(r.statePath, "utf8"));
      assertEqual(st2.recoveryStatus, "manual_review_required", "A2 重启: 恢复分类 manual_review_required");
      assertEqual([disk2.paused, disk2.pauseReason], [true, "INFLIGHT_BEFORE_SEND"], "A2 重启: 暂停 INFLIGHT_BEFORE_SEND");
      assertEqual(disk2.inFlight?.phase ?? null, "before_send", "A2 重启: inFlight 保留");
      assertEqual(r.timers.active().length, 0, `A2 重启: 不 arm timer (start=${JSON.stringify(st2.success)})`);
      await r.timers.fireAll();
      const resume = await r.rt.resumeByAdmin({ userId: "admin" });
      assertEqual([resume.success, resume.errorCode], [false, "STATE_RECOVERY_REQUIRED"], "A2 重启: 管理员恢复被拒绝");
      await r.timers.fireAll();
      assertEqual([r.counts.scans, r.counts.bumps, r.counts.sends, r.counts.deletes], [0, 0, 0, 0], "A2 重启: 不扫描、不再次顶帖");
      assertEqual(r.alerts, ["forum_bump_scheduler_halted"], "A2 重启: 告警 key");
      await r.rt.stop();
    }
    // B. 动态配置写失败 → 拒绝保存，生效配置不变
    {
      const root = mkdtempSync(join(tmpdir(), "fb-fc-cfg-"));
      roots.push(root);
      const h = await setup(root);
      await h.rt.start();
      const snapBefore = await h.rt.getControlSnapshot();
      const cfgExisted = existsSync(h.dynamicConfigPath);
      const cfgBefore = cfgExisted ? readFileSync(h.dynamicConfigPath, "utf8") : null;
      const timersBefore = h.timers.active().map((t) => t.ms);
      chmodSync(h.cfgDir, 0o555);
      let upd;
      try {
        upd = await h.rt.updateDynamicConfig({ dailyLimit: 5 }, { actorId: "1", source: "test" });
      } finally {
        chmodSync(h.cfgDir, 0o755);
      }
      assertEqual(upd.success, false, "B: 配置写失败 → 保存失败");
      assertEqual(upd.errorCode, "DYNAMIC_CONFIG_WRITE_FAILED", "B: errorCode");
      const snapAfter = await h.rt.getControlSnapshot();
      assertEqual(snapAfter.dailyLimit, snapBefore.dailyLimit, "B: 生效的每日额度不变");
      assertEqual(existsSync(h.dynamicConfigPath), cfgExisted, "B: 配置文件存在性不变");
      if (cfgExisted) assertEqual(readFileSync(h.dynamicConfigPath, "utf8"), cfgBefore, "B: 配置文件内容不变");
      assertEqual(h.timers.active().map((t) => t.ms), timersBefore, "B: 调度 timer 不变");
      assertEqual(snapAfter.dynamicConfigSource, snapBefore.dynamicConfigSource, "B: 配置来源不变");
      await h.rt.stop();
    }
  } finally {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
  }
} else {
  console.log("  (跳过 POSIX chmod 用例：平台不支持 getuid，或 root 不受权限限制)");
}

console.log(`\n[failClosed.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

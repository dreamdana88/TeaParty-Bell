/**
 * 特征测试（golden）：管理员面板对 Discord 的全部输出——Embed、按钮、Modal、选择页、
 * 提示文案与确认方式（reply/deferUpdate/editReply/showModal…）。
 *
 * 以当前实现生成 __golden__/panel.json；之后任何改动只要改变面板文案或交互，本测试即失败。
 * 有意改动文案时：UPDATE_GOLDEN=1 node src/features/forumBump/admin/panelGolden.test.js
 */
import { EventEmitter } from "events";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { PermissionFlagsBits } from "discord.js";
import { FORUM_BUMP_PANEL_SUBCOMMAND_NAME, FORUM_BUMP_ROOT_COMMAND_NAME } from "./commands.js";
import { createForumBumpPanelSessionStore } from "./sessionStore.js";
import { createForumBumpAdminRouter } from "./adminRouter.js";

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), "__golden__", "panel.json");
const FIXED_NOW = Date.parse("2026-07-28T06:00:00.000Z"); // 上海 14:00
const realNow = Date.now;
Date.now = () => FIXED_NOW;

let passed = 0;
let failed = 0;
function assert(c, l) {
  if (c) { passed++; console.log(`  PASS: ${l}`); } else { failed++; console.error(`  FAIL: ${l}`); }
}

const G = "111111111111111111";
const F = "222222222222222222";
const F2 = "333333333333333333";
const ACTOR = "444444444444444444";

function makeClient() {
  const ee = new EventEmitter();
  return {
    on: (...a) => ee.on(...a),
    off: (...a) => ee.off(...a),
    removeListener: (...a) => ee.removeListener(...a),
    emit: (...a) => ee.emit(...a),
    channels: {
      cache: {
        get: (id) => (id === F ? { id: F, name: "论坛A" } : null),
      },
      fetch: async (id) => (id === F2 ? { id: F2, name: "论坛B" } : null),
    },
  };
}

function makeRuntime(overrides = {}) {
  let snap = {
    mode: "execute",
    started: true,
    fatal: false,
    fatalCode: null,
    paused: false,
    pauseReason: null,
    successCount: 0,
    dailyLimit: 3,
    lastSuccessAt: null,
    nextEligibleAt: null,
    inFlightPhase: null,
    activeStart: "10:00",
    activeEnd: "22:00",
    forumChannelIds: [F],
    silenceDays: 30,
    autoIntervalMinutes: 240,
    nextWakeAt: null,
    running: false,
    dynamicConfigSource: "env",
    dynamicConfigRevision: 0,
    dynamicConfigError: null,
    ...overrides.snap,
  };
  const calls = { update: [], pause: [], resume: [], snapshot: 0 };
  const delayMs = overrides.delayMs ?? 0;
  async function maybeDelay() {
    if (delayMs > 0) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  return {
    calls,
    getControlSnapshot: async () => {
      calls.snapshot += 1;
      await maybeDelay();
      return { ...snap, forumChannelIds: [...snap.forumChannelIds] };
    },
    updateDynamicConfig: async (patch, actor) => {
      calls.update.push({ patch, actor });
      await maybeDelay();
      if (overrides.updateResult) return overrides.updateResult;
      snap = {
        ...snap,
        ...patch,
        dynamicConfigRevision: (snap.dynamicConfigRevision ?? 0) + 1,
        dynamicConfigSource: "file",
      };
      return { success: true, config: { ...patch, revision: snap.dynamicConfigRevision } };
    },
    pauseByAdmin: async (actor) => {
      calls.pause.push(actor);
      await maybeDelay();
      if (overrides.pauseResult) return overrides.pauseResult;
      snap = { ...snap, paused: true, pauseReason: "ADMIN_PAUSED" };
      return { success: true, paused: true, pauseReason: "ADMIN_PAUSED" };
    },
    resumeByAdmin: async (actor) => {
      calls.resume.push(actor);
      await maybeDelay();
      if (overrides.resumeResult) return overrides.resumeResult;
      if (snap.pauseReason !== "ADMIN_PAUSED") {
        return { success: false, errorCode: "STATE_RECOVERY_REQUIRED", pauseReason: snap.pauseReason };
      }
      snap = { ...snap, paused: false, pauseReason: null };
      return { success: true, paused: false };
    },
    _setSnap: (p) => { snap = { ...snap, ...p }; },
  };
}

let ixSeq = 0;
function baseInteraction(extra = {}) {
  const ix = {
    id: `ix_${String(++ixSeq).padStart(4, "0")}`,
    guildId: G,
    channelId: "555555555555555555",
    user: { id: ACTOR, username: "admin", globalName: "管理员" },
    member: { displayName: "管理员" },
    memberPermissions: {
      has: (p) => p === PermissionFlagsBits.Administrator,
    },
    inGuild: () => true,
    replied: false,
    deferred: false,
    ackLog: [],
    lastReply: null,
    lastUpdate: null,
    lastFollowUp: null,
    shownModal: null,
    reply: async function reply(payload) {
      this.ackLog.push({ op: "reply", payload });
      this.replied = true;
      this.lastReply = payload;
      return payload;
    },
    deferReply: async function deferReply(opts) {
      this.ackLog.push({ op: "deferReply", opts });
      this.deferred = true;
      return undefined;
    },
    deferUpdate: async function deferUpdate() {
      this.ackLog.push({ op: "deferUpdate" });
      this.deferred = true;
      return undefined;
    },
    editReply: async function editReply(payload) {
      this.ackLog.push({ op: "editReply", payload });
      this.lastReply = payload;
      return payload;
    },
    followUp: async function followUp(payload) {
      this.ackLog.push({ op: "followUp", payload });
      this.lastFollowUp = payload;
      return payload;
    },
    update: async function update(payload) {
      this.ackLog.push({ op: "update", payload });
      this.lastUpdate = payload;
      this.replied = true;
      return payload;
    },
    showModal: async function showModal(modal) {
      this.ackLog.push({ op: "showModal" });
      this.replied = true;
      this.shownModal = modal;
      return modal;
    },
    ...extra,
  };
  return ix;
}


function serialize(value) {
  const json = JSON.parse(JSON.stringify(value, (k, v) => {
    if (v && typeof v === "object" && typeof v.toJSON === "function" && !Array.isArray(v)) return v.toJSON();
    return v;
  }) ?? "null");
  // session id 已由 pinSessionIds 固定，快照里保留真实（确定的）id
  return json;
}

function record(ix) {
  return ix.ackLog.map((e) => ({
    op: e.op,
    ...(e.payload !== undefined ? { payload: serialize(e.payload) } : {}),
    ...(e.opts !== undefined ? { opts: serialize(e.opts) } : {}),
    ...(e.op === "showModal" ? { modal: serialize(ix.shownModal) } : {}),
  }));
}

function sessionIdFrom(payload) {
  const text = JSON.stringify(serialize.raw ? payload : JSON.parse(JSON.stringify(payload, (k, v) => (
    v && typeof v === "object" && typeof v.toJSON === "function" && !Array.isArray(v) ? v.toJSON() : v))));
  const m = text.match(/fbump:v1:[a-z]+:[a-z]+:([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

/**
 * sessionStore 用 crypto.randomBytes 生成 id 且不可注入（不改生产代码）：
 * 在测试里包一层，把真实 id 映射为确定的 16 位 hex（harness 序号 + session 序号）。
 */
let harnessSeq = 0;
function pinSessionIds(real) {
  const h = ++harnessSeq;
  let n = 0;
  const toReal = new Map();
  const toFake = new Map();
  const fake = (id) => toFake.get(id) ?? id;
  const unfake = (id) => (typeof id === "string" ? (toReal.get(id) ?? `unknown:${id}`) : id);
  const out = (s) => (s && typeof s === "object" && typeof s.sessionId === "string" ? { ...s, sessionId: fake(s.sessionId) } : s);
  return {
    createSession(args) {
      const s = real.createSession(args);
      const f = `${h.toString(16).padStart(4, "0")}${(++n).toString(16).padStart(12, "0")}`;
      toReal.set(f, s.sessionId);
      toFake.set(s.sessionId, f);
      return out(s);
    },
    get: (id) => out(real.get(unfake(id))),
    assertOwner: (id, ctx) => {
      const r = real.assertOwner(unfake(id), ctx);
      return r?.session ? { ...r, session: out(r.session) } : r;
    },
    updateDraft: (id, patch) => out(real.updateDraft(unfake(id), patch)),
    touchRevision: (id, rev) => out(real.touchRevision(unfake(id), rev)),
    deleteSession: (id) => real.deleteSession(unfake(id)),
    clear: () => real.clear(),
    size: () => real.size(),
  };
}

function harness(runtimeOverrides = {}) {
  const runtime = makeRuntime(runtimeOverrides);
  const store = pinSessionIds(createForumBumpPanelSessionStore({ now: () => FIXED_NOW }));
  const router = createForumBumpAdminRouter({
    client: makeClient(),
    guildId: G,
    forumBumpRuntime: runtime,
    logger: { info() {}, warn() {}, error() {} },
    sessionStore: store,
    now: () => FIXED_NOW,
  });
  router.start();
  return { runtime, store, router };
}

const slash = (extra = {}) => baseInteraction({
  isChatInputCommand: () => true,
  commandName: FORUM_BUMP_ROOT_COMMAND_NAME,
  options: { getSubcommand: () => FORUM_BUMP_PANEL_SUBCOMMAND_NAME },
  ...extra,
});
const button = (customId) => baseInteraction({ isButton: () => true, isChatInputCommand: () => false, customId });
const cid = (kind, action, sid) => `fbump:v1:${kind}:${action}:${sid}`;
const modal = (sid, values) => baseInteraction({
  isModalSubmit: () => true,
  isButton: () => false,
  isChatInputCommand: () => false,
  customId: cid("modal", "modal", sid),
  fields: { getTextInputValue: (k) => values[k] },
});

const transcript = {};
async function step(name, h, ix) {
  await h.router._dispatch(ix);
  transcript[name] = record(ix);
  return ix;
}
async function openPanel(name, h) {
  const ix = await step(name, h, slash());
  return sessionIdFrom(ix.lastReply);
}

const VALID = { dailyLimit: "5", activeStart: "08:00", activeEnd: "13:00", silenceDays: "30" };

try {
  // 各种状态下打开面板
  for (const [name, snap] of Object.entries({
    running: {},
    runningWithHistory: { successCount: 2, lastSuccessAt: "2026-07-28T03:10:00.000Z", nextWakeAt: "2026-07-28T07:30:00.000Z" },
    dailyLimitReached: { successCount: 3 },
    adminPaused: { paused: true, pauseReason: "ADMIN_PAUSED" },
    inflightBeforeSend: { paused: true, pauseReason: "INFLIGHT_BEFORE_SEND", inFlightPhase: "before_send" },
    inflightAfterSend: { paused: true, pauseReason: "INFLIGHT_MESSAGE_MAY_EXIST", inFlightPhase: "after_send" },
    inflightAfterDelete: { paused: true, pauseReason: "INFLIGHT_SUCCESS_RECONCILIATION_REQUIRED", inFlightPhase: "after_delete" },
    fatal: { fatal: true, fatalCode: "STATE_UNAVAILABLE" },
    dryRun: { mode: "dry_run" },
    dynamicConfigError: { dynamicConfigError: "DYNAMIC_CONFIG_INVALID" },
    manyForums: { forumChannelIds: [F, F2, "666666666666666666"] },
  })) {
    await openPanel(`open.${name}`, harness({ snap }));
  }

  // 非管理员
  await step("open.denied", harness(), slash({ memberPermissions: { has: () => false } }));

  // 暂停 → 恢复
  {
    const h = harness();
    const sid = await openPanel("pause.open", h);
    await step("pause.click", h, button(cid("btn", "pause", sid)));
    await step("resume.click", h, button(cid("btn", "resume", sid)));
  }
  // 恢复失败（需人工处理的崩溃恢复暂停）
  {
    const h = harness({ snap: { paused: true, pauseReason: "INFLIGHT_MESSAGE_MAY_EXIST", inFlightPhase: "after_send" } });
    const sid = await openPanel("resumeBlocked.open", h);
    await step("resumeBlocked.click", h, button(cid("btn", "resume", sid)));
  }
  // 编辑 → Modal → 校验错误 → 选择页 → 保存 / 取消
  {
    const h = harness();
    const sid = await openPanel("edit.open", h);
    await step("edit.click", h, button(cid("btn", "edit", sid)));
    for (const [name, patch] of Object.entries({
      dailyLimitZero: { dailyLimit: "0" },
      dailyLimitTooHigh: { dailyLimit: "31" },
      dailyLimitNotNumber: { dailyLimit: "abc" },
      badStart: { activeStart: "25:00" },
      badEnd: { activeEnd: "8:00" },
      startAfterEnd: { activeStart: "20:00", activeEnd: "10:00" },
      silenceZero: { silenceDays: "0" },
      silenceTooHigh: { silenceDays: "3651" },
    })) {
      await step(`modal.invalid.${name}`, h, modal(sid, { ...VALID, ...patch }));
    }
    await step("modal.valid", h, modal(sid, VALID));
    await step("save.click", h, button(cid("btn", "save", sid)));
  }
  {
    const h = harness();
    const sid = await openPanel("cancel.open", h);
    await step("cancel.edit", h, button(cid("btn", "edit", sid)));
    await step("cancel.modal", h, modal(sid, VALID));
    await step("cancel.click", h, button(cid("btn", "cancel", sid)));
  }
  // 保存失败的各类错误文案
  for (const code of [
    "DYNAMIC_CONFIG_WRITE_FAILED",
    "DYNAMIC_CONFIG_REVISION_CONFLICT",
    "DYNAMIC_CONFIG_INTERVAL_TOO_SHORT",
    "DYNAMIC_CONFIG_INTERVAL_INVALID",
    "DYNAMIC_CONFIG_PREFLIGHT_FAILED",
    "DYNAMIC_CONFIG_INFLIGHT_BLOCKED",
    "STATE_RECOVERY_REQUIRED",
    "SOMETHING_UNKNOWN",
  ]) {
    const h = harness({ updateResult: { success: false, errorCode: code } });
    const sid = await openPanel(`saveFail.${code}.open`, h);
    await step(`saveFail.${code}.edit`, h, button(cid("btn", "edit", sid)));
    await step(`saveFail.${code}.modal`, h, modal(sid, VALID));
    await step(`saveFail.${code}.save`, h, button(cid("btn", "save", sid)));
  }
  // 会话失效 / 非本人
  {
    const other = harness();
    const sid = await openPanel("session.open", other);
    // 另一个 Router（如重启后）不认识该会话
    await step("session.unknown", harness(), button(cid("btn", "pause", sid)));
    // 非会话所有者点击
    const notOwner = button(cid("btn", "pause", sid));
    notOwner.user = { id: "777777777777777777", username: "other", globalName: "别人" };
    await step("session.notOwner", other, notOwner);
  }

  const actual = JSON.parse(JSON.stringify(transcript));
  if (process.env.UPDATE_GOLDEN === "1") {
    mkdirSync(dirname(GOLDEN), { recursive: true });
    writeFileSync(GOLDEN, `${JSON.stringify(actual, null, 2)}\n`);
    console.log(`  (golden 已写入 ${GOLDEN})`);
  }
  assert(existsSync(GOLDEN), "golden 文件存在");
  const expected = existsSync(GOLDEN) ? JSON.parse(readFileSync(GOLDEN, "utf8")) : {};
  const names = new Set([...Object.keys(expected), ...Object.keys(actual)]);
  for (const name of names) {
    assert(JSON.stringify(actual[name]) === JSON.stringify(expected[name]), `面板输出与 golden 一致：${name}`);
  }
} finally {
  Date.now = realNow;
}

console.log(`\n[panelGolden.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

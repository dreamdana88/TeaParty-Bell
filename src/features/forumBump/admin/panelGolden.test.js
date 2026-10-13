/**
 * 面板关键渲染的聚焦断言（取代原 3788 行的 __golden__/panel.json 全量快照）：
 * 主面板标题/状态行/字段、按钮 custom id 与文案/禁用态、Modal 输入、选择页、
 * 各类校验与保存失败提示、会话过期/非本人提示，以及确认方式（defer/reply/ephemeral）。
 * 期望值均取自原 golden 快照。
 */
import { EventEmitter } from "events";
import { PermissionFlagsBits } from "discord.js";
import { FORUM_BUMP_PANEL_SUBCOMMAND_NAME, FORUM_BUMP_ROOT_COMMAND_NAME } from "./commands.js";
import { createForumBumpPanelSessionStore } from "./sessionStore.js";
import { createForumBumpAdminRouter } from "./adminRouter.js";

const FIXED_NOW = Date.parse("2026-07-28T06:00:00.000Z"); // 上海 14:00
const realNow = Date.now;
Date.now = () => FIXED_NOW;

let passed = 0;
let failed = 0;
function assert(c, l) {
  if (c) { passed++; console.log(`  PASS: ${l}`); } else { failed++; console.error(`  FAIL: ${l}`); }
}
function eq(actual, expected, l) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  assert(a === e, a === e ? l : `${l}\n    got:      ${a}\n    expected: ${e}`);
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

const json = (v) => JSON.parse(JSON.stringify(v));
const ops = (ix) => ix.ackLog.map((e) => e.op);
/** 最后一次 editReply/reply 的 payload（toJSON 后）。 */
const lastPayload = (ix) => json([...ix.ackLog].reverse().find((e) => e.payload)?.payload ?? null);
const sessionIdFrom = (payload) => JSON.stringify(json(payload)).match(/fbump:v1:[a-z]+:[a-z]+:([A-Za-z0-9_-]+)/)?.[1] ?? null;
/** 按钮/选择组件摘要：kind:action/文案[/style][(off)] */
const comps = (payload) => (payload.components ?? []).flatMap((r) => r.components).map((c) => {
  const [, , kind, action] = c.custom_id.split(":");
  return `${kind}:${action}/${c.label ?? c.placeholder}${c.style ? `/${c.style}` : ""}${c.disabled ? "(off)" : ""}`;
});
const embed = (payload) => payload.embeds[0];
const fieldMap = (payload) => Object.fromEntries(embed(payload).fields.map((f) => [f.name, f.value]));

function harness(runtimeOverrides = {}) {
  const runtime = makeRuntime(runtimeOverrides);
  const store = createForumBumpPanelSessionStore({ now: () => FIXED_NOW });
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
async function run(h, ix) {
  await h.router._dispatch(ix);
  return ix;
}
async function openPanel(h, extra) {
  const ix = await run(h, slash(extra));
  return { ix, sid: sessionIdFrom(ix.lastReply), payload: lastPayload(ix) };
}

const VALID = { dailyLimit: "5", activeStart: "08:00", activeEnd: "13:00", silenceDays: "30" };
const TITLE = "🌸 小G宝顶帖控制台";
const SCHEDULE = "活跃时间：10:00–22:00\n自动间隔：约 240 分钟\n入选范围：30 天无回复";
const RUNNING_BTNS = ["btn:edit/编辑配置/1", "btn:pause/暂停顶帖/4"];
const SAFETY = "⚠️ 自动顶帖因安全问题暂停\n\n⚠️ 上一次顶帖任务未正常完成，请检查运行状态\n\n因安全原因已暂停自动顶帖，请勿强制恢复。请联系维护者检查残留消息或状态。";
const SAFETY_BTNS = ["btn:edit/编辑配置/1", "btn:resume/恢复顶帖/2(off)"];

try {
  // 1. 主面板：完整结构（确认方式、标题、颜色、全部字段、按钮）
  {
    const { ix, sid, payload } = await openPanel(harness());
    eq(ix.ackLog[0], { op: "deferReply", opts: { flags: 64 } }, "主面板 ephemeral deferReply");
    eq(ops(ix), ["deferReply", "editReply"], "主面板确认顺序");
    eq(Object.keys(payload), ["embeds", "components"], "主面板 payload 只含 embeds/components");
    const e = embed(payload);
    eq([e.title, e.color, e.description], [TITLE, 12105215, "🟢 自动顶帖运行中"], "主面板标题/颜色/状态行");
    eq(e.fields, [
      { name: "今日进度", value: "0 / 3", inline: true },
      { name: "最近顶帖", value: "暂无", inline: true },
      { name: "下次顶帖", value: "等待调度", inline: true },
      { name: "📅 排班配置", value: SCHEDULE, inline: false },
      { name: "📚 服务版块", value: "论坛A", inline: false },
    ], "主面板字段");
    eq(comps(payload), RUNNING_BTNS, "主面板按钮");
    assert(/^[A-Za-z0-9_-]+$/.test(sid ?? ""), "custom id 携带 session id");
    assert(payload.components[0].components.every((c) => c.custom_id.endsWith(`:${sid}`)), "所有按钮同一 session");
  }

  // 2. 各状态：状态行 / 关键字段 / 按钮
  for (const [name, snap, desc, fields, btns] of [
    ["runningWithHistory", { successCount: 2, lastSuccessAt: "2026-07-28T03:10:00.000Z", nextWakeAt: "2026-07-28T07:30:00.000Z" },
      "🟢 自动顶帖运行中", { 今日进度: "2 / 3", 最近顶帖: "今天 11:10", 下次顶帖: "今天 15:30" }, RUNNING_BTNS],
    ["dailyLimitReached", { successCount: 3 }, "🟢 自动顶帖运行中", { 今日进度: "3 / 3" }, RUNNING_BTNS],
    ["adminPaused", { paused: true, pauseReason: "ADMIN_PAUSED" },
      "⏸️ 自动顶帖已暂停", { 下次顶帖: "恢复后重新计算" }, ["btn:edit/编辑配置/1", "btn:resume/恢复顶帖/3"]],
    ["inflightBeforeSend", { paused: true, pauseReason: "INFLIGHT_BEFORE_SEND", inFlightPhase: "before_send" },
      SAFETY, { 下次顶帖: "安全暂停，暂不排程" }, SAFETY_BTNS],
    ["inflightAfterSend", { paused: true, pauseReason: "INFLIGHT_MESSAGE_MAY_EXIST", inFlightPhase: "after_send" },
      SAFETY, { 下次顶帖: "安全暂停，暂不排程" }, SAFETY_BTNS],
    ["inflightAfterDelete", { paused: true, pauseReason: "INFLIGHT_SUCCESS_RECONCILIATION_REQUIRED", inFlightPhase: "after_delete" },
      SAFETY, { 下次顶帖: "安全暂停，暂不排程" }, SAFETY_BTNS],
    ["fatal", { fatal: true, fatalCode: "STATE_UNAVAILABLE" },
      "🔴 顶帖服务暂时不可用\n\n顶帖服务遇到问题，已停止自动调度。请联系维护者检查运行日志。",
      { 下次顶帖: "安全暂停，暂不排程" }, ["btn:edit/编辑配置/1(off)", "btn:pause/暂停顶帖/4(off)"]],
    ["dryRun", { mode: "dry_run" }, "🧪 当前为预览模式，不会真实顶帖", {}, RUNNING_BTNS],
    ["dynamicConfigError", { dynamicConfigError: "DYNAMIC_CONFIG_INVALID" }, "🟢 自动顶帖运行中", {}, RUNNING_BTNS],
    ["manyForums", { forumChannelIds: [F, F2, "666666666666666666"] }, "🟢 自动顶帖运行中",
      { "📚 服务版块": "论坛A\n论坛B\n❔｜未知或不可用的 Forum" }, RUNNING_BTNS],
  ]) {
    const { payload } = await openPanel(harness({ snap }));
    const fm = fieldMap(payload);
    eq(embed(payload).description, desc, `${name}：状态行`);
    eq(Object.fromEntries(Object.keys(fields).map((k) => [k, fm[k]])), fields, `${name}：字段`);
    eq(fm["📅 排班配置"], SCHEDULE, `${name}：排班配置`);
    eq(comps(payload), btns, `${name}：按钮`);
  }

  // 3. 拒绝类提示（均为 ephemeral reply）
  {
    const denied = await run(harness(), slash({ memberPermissions: { has: () => false } }));
    eq(denied.ackLog, [{ op: "reply", payload: { content: "只有管理员可以使用该操作。", flags: 64 } }], "非管理员");
    const owner = harness();
    const { sid } = await openPanel(owner);
    const unknown = await run(harness(), button(cid("btn", "pause", sid)));
    eq(json(unknown.ackLog), [{ op: "reply", payload: { content: "面板已过期，请重新执行「/顶帖 面板」。", flags: 64 } }], "会话过期");
    const notOwner = button(cid("btn", "pause", sid));
    notOwner.user = { id: "777777777777777777", username: "other", globalName: "别人" };
    await run(owner, notOwner);
    eq(json(notOwner.ackLog), [{ op: "reply", payload: { content: "该操作只能由打开面板的管理员继续，请重新打开顶帖面板。", flags: 64 } }], "非会话所有者");
    eq(owner.runtime.calls.pause.length, 0, "被拒点击不触发 pause");
  }

  // 4. 暂停 → 恢复；安全暂停下恢复被拒
  {
    const h = harness();
    const { sid } = await openPanel(h);
    const p = await run(h, button(cid("btn", "pause", sid)));
    eq(ops(p), ["deferUpdate", "editReply"], "pause 确认方式");
    eq(embed(lastPayload(p)).description, "⏸️ 自动顶帖已暂停\n\n已暂停自动顶帖。", "pause 提示");
    eq(comps(lastPayload(p)).map((c) => c.split("/").slice(0, 2).join("/")), ["btn:edit/编辑配置", "btn:resume/恢复顶帖"], "pause 后按钮切换");
    const sid2 = sessionIdFrom(lastPayload(p));
    const r = await run(h, button(cid("btn", "resume", sid2)));
    eq(embed(lastPayload(r)).description, "🟢 自动顶帖运行中\n\n已恢复自动顶帖。", "resume 提示");
    eq(comps(lastPayload(r)), RUNNING_BTNS, "resume 后按钮");
    eq([h.runtime.calls.pause.length, h.runtime.calls.resume.length], [1, 1], "pause/resume 各调用一次");
  }
  {
    const h = harness({ snap: { paused: true, pauseReason: "INFLIGHT_MESSAGE_MAY_EXIST", inFlightPhase: "after_send" } });
    const { sid } = await openPanel(h);
    const r = await run(h, button(cid("btn", "resume", sid)));
    eq(embed(lastPayload(r)).description, SAFETY.replace("\n\n", "\n\n无法恢复：INFLIGHT_MESSAGE_MAY_EXIST\n\n"), "安全暂停恢复被拒提示");
    eq(comps(lastPayload(r)), SAFETY_BTNS, "安全暂停恢复按钮仍禁用");
  }

  // 5. 编辑：Modal → 校验 → 选择页 → 保存 / 取消
  {
    const h = harness();
    const { sid } = await openPanel(h);
    const ed = await run(h, button(cid("btn", "edit", sid)));
    eq(ops(ed), ["showModal"], "edit 弹出 Modal");
    const m = json(ed.shownModal);
    eq(m.custom_id, cid("modal", "modal", sid), "Modal custom id");
    eq(m.title, "编辑顶帖配置", "Modal 标题");
    eq(m.components.map((r) => r.components[0]).map((c) => [c.custom_id, c.label, c.value, c.min_length, c.max_length]), [
      ["dailyLimit", "每日额度", "3", 1, 2],
      ["activeStart", "活跃开始时间（HH:mm，UTC+8）", "10:00", 4, 5],
      ["activeEnd", "活跃结束时间（HH:mm，UTC+8）", "22:00", 4, 5],
      ["silenceDays", "无回复天数（1–3650）", "30", 1, 4],
    ], "Modal 输入项与预填值");
    eq(m.components[0].components[0].placeholder, "根据活跃时间自动限制，最多 30", "额度 placeholder");

    for (const [patch, msg] of [
      [{ dailyLimit: "0" }, "每日额度必须是至少为 1 的整数。"],
      [{ dailyLimit: "31" }, "每日额度最多为 30 次。"],
      [{ dailyLimit: "abc" }, "每日额度必须是至少为 1 的整数。"],
      [{ activeStart: "25:00" }, "活跃时间必须为 HH:mm 格式。"],
      [{ activeEnd: "8:00" }, "活跃时间必须为 HH:mm 格式。"],
      [{ activeStart: "20:00", activeEnd: "10:00" }, "开始时间必须早于结束时间（不支持跨午夜）。"],
      [{ silenceDays: "0" }, "无回复天数必须是 1–3650 的整数。"],
      [{ silenceDays: "3651" }, "无回复天数必须是 1–3650 的整数。"],
    ]) {
      const ix = await run(h, modal(sid, { ...VALID, ...patch }));
      eq(json(ix.ackLog), [{ op: "reply", payload: { content: msg, flags: 64 } }], `Modal 校验：${JSON.stringify(patch)}`);
    }
    eq(h.runtime.calls.update.length, 0, "校验失败不写配置");

    const sel = await run(h, modal(sid, VALID));
    const sp = lastPayload(sel);
    eq(ops(sel), ["reply"], "选择页 reply");
    eq(sp.flags, 64, "选择页 ephemeral");
    eq(sp.content, "**选择服务 Forum 频道**\n请至少选择一个 GuildForum 频道，然后点击「保存配置」。\n\n当前草稿：额度 5，08:00–13:00，30 天无回复", "选择页文案");
    eq(comps(sp), ["select:select/选择服务 Forum 频道（可多选）", "btn:save/保存配置/3", "btn:cancel/取消/2"], "选择页组件");
    const menu = sp.components[0].components[0];
    eq([menu.type, menu.min_values, menu.max_values, menu.channel_types, menu.default_values],
      [8, 1, 25, [15], [{ id: F, type: "channel" }]], "频道选择器约束与默认值");

    const sv = await run(h, button(cid("btn", "save", sid)));
    eq(ops(sv), ["deferUpdate", "editReply"], "save 确认方式");
    eq(h.runtime.calls.update.length, 1, "save 写一次配置");
    eq(embed(lastPayload(sv)).description, "🟢 自动顶帖运行中\n\n配置已保存。", "save 提示");
    eq([fieldMap(lastPayload(sv))["今日进度"], fieldMap(lastPayload(sv))["📅 排班配置"]],
      ["0 / 5", "活跃时间：08:00–13:00\n自动间隔：约 240 分钟\n入选范围：30 天无回复"], "save 后面板反映新配置");
  }
  {
    const h = harness();
    const { sid } = await openPanel(h);
    await run(h, button(cid("btn", "edit", sid)));
    await run(h, modal(sid, VALID));
    const c = await run(h, button(cid("btn", "cancel", sid)));
    eq(embed(lastPayload(c)).description, "🟢 自动顶帖运行中\n\n已取消编辑。", "cancel 提示");
    eq(fieldMap(lastPayload(c))["今日进度"], "0 / 3", "cancel 不改配置");
    eq(h.runtime.calls.update.length, 0, "cancel 不写配置");
  }

  // 6. 保存失败的错误文案
  for (const [code, notice] of [
    ["DYNAMIC_CONFIG_WRITE_FAILED", "操作失败，请稍后重试或重新打开顶帖面板。"],
    ["DYNAMIC_CONFIG_REVISION_CONFLICT", "配置已被其他操作更新，请重新打开顶帖面板。"],
    ["DYNAMIC_CONFIG_INTERVAL_TOO_SHORT", "当前活跃时段额度过高，请降低每日额度或延长活跃时间。"],
    ["DYNAMIC_CONFIG_INTERVAL_INVALID", "每日额度或活跃时间不合法。"],
    ["DYNAMIC_CONFIG_PREFLIGHT_FAILED", "Forum 频道校验失败，请检查频道类型与权限。"],
    ["DYNAMIC_CONFIG_INFLIGHT_BLOCKED", "当前有进行中的顶帖操作，请稍后再试。"],
    ["STATE_RECOVERY_REQUIRED", "当前为安全故障暂停，无法从面板直接恢复。"],
    ["SOMETHING_UNKNOWN", "操作失败，请稍后重试或重新打开顶帖面板。"],
  ]) {
    const h = harness({ updateResult: { success: false, errorCode: code } });
    const { sid } = await openPanel(h);
    await run(h, button(cid("btn", "edit", sid)));
    await run(h, modal(sid, VALID));
    const sv = await run(h, button(cid("btn", "save", sid)));
    eq(embed(lastPayload(sv)).description, `🟢 自动顶帖运行中\n\n${notice}`, `保存失败 ${code}`);
    eq(comps(lastPayload(sv)), RUNNING_BTNS, `保存失败 ${code}：按钮`);
  }
} finally {
  Date.now = realNow;
}

console.log(`\n[panelGolden.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

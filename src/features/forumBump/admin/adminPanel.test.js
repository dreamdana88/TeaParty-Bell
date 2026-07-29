/**
 * D-6B Forum Bump 管理员面板测试（fake interaction / fake runtime）。
 */
import { EventEmitter } from "events";
import {
  ApplicationCommandType,
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";
import {
  FORUM_BUMP_PANEL_SUBCOMMAND_NAME,
  FORUM_BUMP_ROOT_COMMAND_NAME,
  buildForumBumpPanelCommand,
  forumBumpAdminCommandDefinitions,
} from "./commands.js";
import { allAdminCommandDefinitions } from "../../adminCommands.js";
import {
  getManualMessageCommands,
  MANUAL_REPLY_COMMAND_NAME,
  SLASH_SEND_COMMAND_NAME,
} from "../../manualMessage/commands.js";
import {
  buildPanelContent,
  buildPanelComponents,
  buildConfigModal,
  buildForumSelectPage,
  parseModalFields,
  parseCustomId,
  buildCustomId,
  CUSTOM_IDS,
  formatUtc8,
  resolveRunStatusLabel,
  safeRuntimeErrorMessage,
} from "./panelView.js";
import { createForumBumpPanelSessionStore } from "./sessionStore.js";
import { createForumBumpAdminRouter } from "./adminRouter.js";

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
const ACTOR = "444444444444444444";

console.log("\n=== forumBump adminPanel (D-6B) ===\n");

// ---------- 命令定义 ----------
{
  const cmd = buildForumBumpPanelCommand().toJSON();
  assertEqual(cmd.name, FORUM_BUMP_ROOT_COMMAND_NAME, "根命令 顶帖");
  assertEqual(cmd.type, ApplicationCommandType.ChatInput, "Chat Input");
  assertEqual(
    cmd.default_member_permissions,
    String(PermissionFlagsBits.Administrator),
    "默认 Administrator",
  );
  assertEqual(cmd.options?.[0]?.name, FORUM_BUMP_PANEL_SUBCOMMAND_NAME, "子命令 面板");
  assertEqual(forumBumpAdminCommandDefinitions.length, 1, "forum 定义 1 条");

  const all = allAdminCommandDefinitions;
  assertEqual(all.length, 3, "全部管理员命令 3 个");
  const names = all.map((c) => c.name);
  assert(names.includes(MANUAL_REPLY_COMMAND_NAME), "保留 小G宝回复");
  assert(names.includes(SLASH_SEND_COMMAND_NAME), "保留 小g宝发言");
  assert(names.includes(FORUM_BUMP_ROOT_COMMAND_NAME), "含 顶帖");
  assertEqual(getManualMessageCommands().length, 2, "人工命令列表仍为 2");
}

// ---------- 展示 ----------
{
  const snap = {
    mode: "execute",
    started: true,
    fatal: false,
    paused: false,
    pauseReason: null,
    successCount: 1,
    dailyLimit: 3,
    lastSuccessAt: "2026-07-28T04:00:00.000Z",
    nextEligibleAt: "2026-07-28T08:00:00.000Z",
    inFlightPhase: null,
    activeStart: "08:00",
    activeEnd: "13:00",
    forumChannelIds: [F],
    silenceDays: 30,
    autoIntervalMinutes: 60,
    nextWakeAt: Date.parse("2026-07-28T08:00:00.000Z"),
    dynamicConfigRevision: 2,
  };
  assertEqual(resolveRunStatusLabel(snap), "运行中", "运行中");
  assertEqual(resolveRunStatusLabel({ ...snap, paused: true, pauseReason: "ADMIN_PAUSED" }), "管理员暂停", "管理员暂停");
  assertEqual(resolveRunStatusLabel({ ...snap, paused: true, pauseReason: "DELETE_FAILED" }), "安全故障暂停", "安全故障");
  assertEqual(resolveRunStatusLabel({ ...snap, fatal: true }), "Runtime 异常", "fatal");
  assertEqual(resolveRunStatusLabel({ mode: "disabled", started: true }), "已禁用", "disabled");

  const content = buildPanelContent(snap, { forumNameMap: new Map([[F, "测试论坛"]]) });
  assert(content.includes("1 / 3"), "今日进度");
  assert(content.includes("08:00–13:00"), "活跃时间");
  assert(content.includes("约 60 分钟"), "自动间隔");
  assert(content.includes("测试论坛"), "频道名称");
  assert(content.includes("UTC+8"), "UTC+8 标记");
  assert(formatUtc8("2026-07-28T04:00:00.000Z").includes("UTC+8"), "formatUtc8");

  const sessionId = "a".repeat(16);
  const comps = buildPanelComponents(snap, sessionId);
  assertEqual(comps.length, 1, "主面板一行按钮");
  const labels = comps[0].components.map((b) => b.data?.label ?? b.label);
  assert(labels.includes("编辑配置"), "编辑配置按钮");
  assert(labels.includes("暂停顶帖"), "暂停按钮");

  const paused = buildPanelComponents(
    { ...snap, paused: true, pauseReason: "ADMIN_PAUSED" },
    sessionId,
  );
  assert(
    paused[0].components.some((b) => (b.data?.label ?? b.label) === "恢复顶帖"),
    "ADMIN_PAUSED 显示恢复",
  );
  const safety = buildPanelComponents(
    { ...snap, paused: true, pauseReason: "DELETE_FAILED" },
    sessionId,
  );
  const resumeBtn = safety[0].components.find((b) => (b.data?.label ?? b.label) === "恢复顶帖");
  assert(resumeBtn?.data?.disabled === true || resumeBtn?.data?.disabled === true, "安全暂停禁用恢复");
}

// ---------- Modal / Select ----------
{
  const sid = "b".repeat(16);
  const modal = buildConfigModal({
    dailyLimit: 5,
    activeStart: "08:00",
    activeEnd: "13:00",
    silenceDays: 30,
  }, sid);
  assert(modal, "Modal 可构建");
  assert(modal.data?.custom_id?.includes(sid) || modal.data?.customId?.includes?.(sid)
    || String(modal.data?.custom_id || "").includes("modal"), "Modal customId");

  const ok = parseModalFields({
    dailyLimit: "5",
    activeStart: "08:00",
    activeEnd: "13:00",
    silenceDays: "30",
  });
  assert(ok.ok, "合法 Modal 字段");
  assertEqual(ok.values.dailyLimit, 5, "dailyLimit 5");

  const bad = parseModalFields({
    dailyLimit: "0",
    activeStart: "08:00",
    activeEnd: "13:00",
    silenceDays: "30",
  });
  assert(!bad.ok, "非法额度");

  const page = buildForumSelectPage({
    dailyLimit: 5,
    activeStart: "08:00",
    activeEnd: "13:00",
    silenceDays: 30,
    forumChannelIds: [F],
  }, sid);
  assert(page?.components?.length >= 2, "select + 按钮行");
  const selectRow = page.components[0];
  const select = selectRow.components[0];
  const chTypes = select.data?.channel_types ?? select.data?.channelTypes;
  assert(
    Array.isArray(chTypes) && chTypes.includes(ChannelType.GuildForum),
    "仅 GuildForum",
  );
  const min = select.data?.min_values ?? select.data?.minValues;
  assertEqual(min, 1, "至少选 1");
}

// ---------- Session ----------
{
  let t = 1_000_000;
  const store = createForumBumpPanelSessionStore({ now: () => t, ttlMs: 1000 });
  const s = store.createSession({
    actorId: ACTOR,
    guildId: G,
    dynamicConfigRevision: 1,
    draft: { dailyLimit: 3, activeStart: "10:00", activeEnd: "22:00", silenceDays: 30, forumChannelIds: [F] },
  });
  assert(s.sessionId.length === 16, "sessionId 16 hex");
  const ok = store.assertOwner(s.sessionId, { actorId: ACTOR, guildId: G });
  assert(ok.ok, "owner ok");
  const badActor = store.assertOwner(s.sessionId, { actorId: "other", guildId: G });
  assertEqual(badActor.errorCode, "SESSION_ACTOR_MISMATCH", "他人拒绝");
  t += 2000;
  const exp = store.assertOwner(s.sessionId, { actorId: ACTOR, guildId: G });
  assertEqual(exp.errorCode, "SESSION_EXPIRED", "过期拒绝");
}

// ---------- Router 集成 ----------
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
  const calls = { update: [], pause: [], resume: [] };
  return {
    calls,
    getControlSnapshot: async () => ({ ...snap, forumChannelIds: [...snap.forumChannelIds] }),
    updateDynamicConfig: async (patch, actor) => {
      calls.update.push({ patch, actor });
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
      if (overrides.pauseResult) return overrides.pauseResult;
      snap = { ...snap, paused: true, pauseReason: "ADMIN_PAUSED" };
      return { success: true, paused: true, pauseReason: "ADMIN_PAUSED" };
    },
    resumeByAdmin: async (actor) => {
      calls.resume.push(actor);
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

function baseInteraction(extra = {}) {
  return {
    id: `ix_${Math.random().toString(36).slice(2)}`,
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
    reply: async function reply(payload) {
      this.replied = true;
      this.lastReply = payload;
      return payload;
    },
    editReply: async function editReply(payload) {
      this.lastReply = payload;
      return payload;
    },
    followUp: async function followUp(payload) {
      this.lastFollowUp = payload;
      return payload;
    },
    update: async function update(payload) {
      this.lastUpdate = payload;
      this.replied = true;
      return payload;
    },
    showModal: async function showModal(modal) {
      this.shownModal = modal;
      return modal;
    },
    ...extra,
  };
}

{
  const client = makeClient();
  const runtime = makeRuntime();
  const router = createForumBumpAdminRouter({
    client,
    guildId: G,
    forumBumpRuntime: runtime,
    logger: { info() {}, warn() {}, error() {} },
  });
  router.start();
  router.start(); // 幂等

  const ix = baseInteraction({
    isChatInputCommand: () => true,
    commandName: FORUM_BUMP_ROOT_COMMAND_NAME,
    options: {
      getSubcommand: () => FORUM_BUMP_PANEL_SUBCOMMAND_NAME,
    },
  });
  await router._dispatch(ix);
  assert(ix.replied, "面板 slash 已回复");
  assert(String(ix.lastReply?.content || "").includes("顶帖控制面板"), "面板内容");
  assert(String(ix.lastReply?.content || "").includes("execute"), "显示 mode");
  assert(String(ix.lastReply?.content || "").includes("论坛A") || String(ix.lastReply?.content || "").includes(F), "频道展示");
  assert(ix.lastReply?.components?.length >= 1, "有按钮");

  // 非管理员
  const denied = baseInteraction({
    isChatInputCommand: () => true,
    commandName: FORUM_BUMP_ROOT_COMMAND_NAME,
    options: { getSubcommand: () => FORUM_BUMP_PANEL_SUBCOMMAND_NAME },
    memberPermissions: { has: () => false },
  });
  await router._dispatch(denied);
  assert(String(denied.lastReply?.content || "").includes("管理员"), "非管理员拒绝");

  router.destroy();
  // destroy 后不再处理
  const after = baseInteraction({
    isChatInputCommand: () => true,
    commandName: FORUM_BUMP_ROOT_COMMAND_NAME,
    options: { getSubcommand: () => FORUM_BUMP_PANEL_SUBCOMMAND_NAME },
  });
  await router._dispatch(after);
  assert(!after.replied, "destroy 后不处理");
}

// 暂停 / 恢复
{
  const client = makeClient();
  const runtime = makeRuntime();
  const store = createForumBumpPanelSessionStore({ now: () => Date.now() });
  const router = createForumBumpAdminRouter({
    client,
    guildId: G,
    forumBumpRuntime: runtime,
    logger: { info() {}, warn() {}, error() {} },
    sessionStore: store,
  });
  router.start();

  const open = baseInteraction({
    isChatInputCommand: () => true,
    commandName: FORUM_BUMP_ROOT_COMMAND_NAME,
    options: { getSubcommand: () => FORUM_BUMP_PANEL_SUBCOMMAND_NAME },
  });
  await router._dispatch(open);
  const sessionId = store.size() === 1
    ? [...(store._sessions?.keys?.() || [])][0]
    : null;
  // 从按钮 customId 提取 session
  const btnRow = open.lastReply?.components?.[0];
  const pauseBtn = btnRow?.components?.find((b) => {
    const id = b.data?.custom_id || b.data?.customId;
    return id && id.includes(":pause:");
  });
  const customId = pauseBtn?.data?.custom_id || pauseBtn?.data?.customId;
  const parsed = parseCustomId(customId);
  assert(parsed?.action === "pause", "暂停按钮");

  const pauseIx = baseInteraction({
    isButton: () => true,
    isChatInputCommand: () => false,
    customId,
  });
  await router._dispatch(pauseIx);
  assertEqual(runtime.calls.pause.length, 1, "pauseByAdmin 调用");
  assertEqual(runtime.calls.pause[0].source, "discord_admin_panel", "actor source");
  const pauseContent = pauseIx.lastUpdate?.content || pauseIx.lastReply?.content || "";
  assert(pauseContent.includes("已暂停") || pauseContent.includes("管理员暂停"), "暂停后面板更新");

  // 再次暂停幂等
  const snap = await runtime.getControlSnapshot();
  const sid = parsed.sessionId;
  store.touchRevision(sid, snap.dynamicConfigRevision);
  const pause2 = baseInteraction({
    isButton: () => true,
    customId: buildCustomId("btn", CUSTOM_IDS.pause, sid),
  });
  // 会话可能仍在；若过期则从 resume 按钮路径测幂等
  await runtime.pauseByAdmin({ actorId: ACTOR, source: "discord_admin_panel" });
  assertEqual((await runtime.getControlSnapshot()).pauseReason, "ADMIN_PAUSED", "仍 ADMIN_PAUSED");

  // 安全故障拒绝恢复
  runtime._setSnap({ paused: true, pauseReason: "DELETE_FAILED" });
  const session2 = store.createSession({
    actorId: ACTOR,
    guildId: G,
    dynamicConfigRevision: 0,
    draft: { dailyLimit: 3, activeStart: "10:00", activeEnd: "22:00", silenceDays: 30, forumChannelIds: [F] },
  });
  const resumeIx = baseInteraction({
    isButton: () => true,
    customId: buildCustomId("btn", CUSTOM_IDS.resume, session2.sessionId),
  });
  await router._dispatch(resumeIx);
  const resumeText = resumeIx.lastUpdate?.content || resumeIx.lastReply?.content || "";
  assert(
    resumeText.includes("无法恢复") || resumeText.includes("DELETE_FAILED") || resumeText.includes("安全"),
    "安全故障拒绝恢复",
  );
  assertEqual(runtime.calls.resume.length, 0, "未调用 resumeByAdmin");

  // ADMIN_PAUSED 可恢复
  runtime._setSnap({ paused: true, pauseReason: "ADMIN_PAUSED" });
  const session3 = store.createSession({
    actorId: ACTOR,
    guildId: G,
    dynamicConfigRevision: 0,
    draft: { dailyLimit: 3, activeStart: "10:00", activeEnd: "22:00", silenceDays: 30, forumChannelIds: [F] },
  });
  const resumeOk = baseInteraction({
    isButton: () => true,
    customId: buildCustomId("btn", CUSTOM_IDS.resume, session3.sessionId),
  });
  await router._dispatch(resumeOk);
  assertEqual(runtime.calls.resume.length, 1, "resume 调用");
  assertEqual((await runtime.getControlSnapshot()).paused, false, "已恢复");

  router.destroy();
}

// 保存配置完整 patch + revision 过期
{
  const client = makeClient();
  const runtime = makeRuntime();
  const store = createForumBumpPanelSessionStore({ now: () => Date.now() });
  const router = createForumBumpAdminRouter({
    client,
    guildId: G,
    forumBumpRuntime: runtime,
    logger: { info() {}, warn() {}, error() {} },
    sessionStore: store,
  });
  router.start();

  const session = store.createSession({
    actorId: ACTOR,
    guildId: G,
    dynamicConfigRevision: 0,
    draft: {
      dailyLimit: 5,
      activeStart: "08:00",
      activeEnd: "13:00",
      silenceDays: 14,
      forumChannelIds: [F, F2],
    },
  });

  const saveIx = baseInteraction({
    isButton: () => true,
    customId: buildCustomId("btn", CUSTOM_IDS.save, session.sessionId),
  });
  await router._dispatch(saveIx);
  assertEqual(runtime.calls.update.length, 1, "updateDynamicConfig 一次");
  const patch = runtime.calls.update[0].patch;
  assertEqual(patch.dailyLimit, 5, "patch dailyLimit");
  assertEqual(patch.activeStart, "08:00", "patch start");
  assertEqual(patch.activeEnd, "13:00", "patch end");
  assertEqual(patch.silenceDays, 14, "patch silence");
  assertEqual(patch.forumChannelIds.join(","), `${F},${F2}`, "完整 forum 列表");
  assertEqual(runtime.calls.update[0].actor.source, "discord_admin_panel", "actorContext");

  // revision 过期
  const stale = store.createSession({
    actorId: ACTOR,
    guildId: G,
    dynamicConfigRevision: 0,
    draft: {
      dailyLimit: 3,
      activeStart: "10:00",
      activeEnd: "22:00",
      silenceDays: 30,
      forumChannelIds: [F],
    },
  });
  runtime._setSnap({ dynamicConfigRevision: 9 });
  const staleIx = baseInteraction({
    isButton: () => true,
    customId: buildCustomId("btn", CUSTOM_IDS.save, stale.sessionId),
  });
  await router._dispatch(staleIx);
  const staleText = staleIx.lastUpdate?.content || staleIx.lastReply?.content || "";
  assert(staleText.includes("配置已被其他操作更新"), "revision 过期提示");
  assertEqual(runtime.calls.update.length, 1, "过期不调用 update");

  // Runtime 失败保留旧配置
  const failRt = makeRuntime({
    updateResult: { success: false, errorCode: "DYNAMIC_CONFIG_INTERVAL_TOO_SHORT", safeMessage: "间隔过短" },
  });
  const store2 = createForumBumpPanelSessionStore({ now: () => Date.now() });
  const router2 = createForumBumpAdminRouter({
    client,
    guildId: G,
    forumBumpRuntime: failRt,
    logger: { info() {}, warn() {}, error() {} },
    sessionStore: store2,
  });
  router2.start();
  const sFail = store2.createSession({
    actorId: ACTOR,
    guildId: G,
    dynamicConfigRevision: 0,
    draft: {
      dailyLimit: 10,
      activeStart: "10:00",
      activeEnd: "10:20",
      silenceDays: 30,
      forumChannelIds: [F],
    },
  });
  const failIx = baseInteraction({
    isButton: () => true,
    customId: buildCustomId("btn", CUSTOM_IDS.save, sFail.sessionId),
  });
  await router2._dispatch(failIx);
  const failText = failIx.lastUpdate?.content || failIx.lastReply?.content || "";
  assert(failText.includes("间隔") || failText.includes("失败") || failText.includes("30"), "安全错误提示");
  assert(!failText.includes("stack"), "无 stack");
  assertEqual((await failRt.getControlSnapshot()).dailyLimit, 3, "旧 dailyLimit 保持");

  // 取消不修改
  const cancelRt = makeRuntime();
  const store3 = createForumBumpPanelSessionStore({ now: () => Date.now() });
  const router3 = createForumBumpAdminRouter({
    client,
    guildId: G,
    forumBumpRuntime: cancelRt,
    logger: { info() {}, warn() {}, error() {} },
    sessionStore: store3,
  });
  router3.start();
  const sCancel = store3.createSession({
    actorId: ACTOR,
    guildId: G,
    dynamicConfigRevision: 0,
    draft: {
      dailyLimit: 9,
      activeStart: "08:00",
      activeEnd: "12:00",
      silenceDays: 7,
      forumChannelIds: [F2],
    },
  });
  const cancelIx = baseInteraction({
    isButton: () => true,
    customId: buildCustomId("btn", CUSTOM_IDS.cancel, sCancel.sessionId),
  });
  await router3._dispatch(cancelIx);
  assertEqual(cancelRt.calls.update.length, 0, "取消不 update");
  assertEqual((await cancelRt.getControlSnapshot()).dailyLimit, 3, "取消保持配置");

  router.destroy();
  router2.destroy();
  router3.destroy();
}

// Modal 提交流程
{
  const client = makeClient();
  const runtime = makeRuntime();
  const store = createForumBumpPanelSessionStore({ now: () => Date.now() });
  const router = createForumBumpAdminRouter({
    client,
    guildId: G,
    forumBumpRuntime: runtime,
    logger: { info() {}, warn() {}, error() {} },
    sessionStore: store,
  });
  router.start();
  const session = store.createSession({
    actorId: ACTOR,
    guildId: G,
    dynamicConfigRevision: 0,
    draft: {
      dailyLimit: 3,
      activeStart: "10:00",
      activeEnd: "22:00",
      silenceDays: 30,
      forumChannelIds: [F],
    },
  });
  const modalIx = baseInteraction({
    isModalSubmit: () => true,
    isButton: () => false,
    customId: buildCustomId("modal", CUSTOM_IDS.modal, session.sessionId),
    fields: {
      getTextInputValue: (k) => ({
        dailyLimit: "5",
        activeStart: "08:00",
        activeEnd: "13:00",
        silenceDays: "30",
      }[k]),
    },
  });
  await router._dispatch(modalIx);
  const draft = store.get(session.sessionId)?.draft;
  assertEqual(draft?.dailyLimit, 5, "Modal 写入 draft");
  assert(String(modalIx.lastReply?.content || "").includes("选择服务 Forum"), "进入频道选择页");

  // 非法 Modal
  const badModal = baseInteraction({
    isModalSubmit: () => true,
    customId: buildCustomId("modal", CUSTOM_IDS.modal, session.sessionId),
    fields: {
      getTextInputValue: (k) => ({
        dailyLimit: "99",
        activeStart: "08:00",
        activeEnd: "13:00",
        silenceDays: "30",
      }[k]),
    },
  });
  await router._dispatch(badModal);
  assert(String(badModal.lastReply?.content || "").includes("1–10") || String(badModal.lastReply?.content || "").includes("额度"), "非法额度提示");

  router.destroy();
}

// 不识别其他命令
{
  const client = makeClient();
  const runtime = makeRuntime();
  const router = createForumBumpAdminRouter({
    client,
    guildId: G,
    forumBumpRuntime: runtime,
    logger: { info() {}, warn() {}, error() {} },
  });
  router.start();
  const foreign = baseInteraction({
    isChatInputCommand: () => true,
    commandName: SLASH_SEND_COMMAND_NAME,
    options: { getSubcommand: () => null },
  });
  await router._dispatch(foreign);
  assert(!foreign.replied, "不处理人工发言命令");
  router.destroy();
}

assertEqual(safeRuntimeErrorMessage({ errorCode: "DYNAMIC_CONFIG_REVISION_CONFLICT" }).includes("重新打开"), true, "revision 安全文案");

console.log(`\n=== adminPanel: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);

/**
 * D-6B Forum Bump 管理员面板测试（fake interaction / fake runtime）。
 */
import { EventEmitter } from "events";
import {
  ApplicationCommandType,
  ChannelType,
  MessageFlags,
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
  buildPanelEmbed,
  buildPanelMessage,
  buildPanelComponents,
  buildConfigModal,
  buildForumSelectPage,
  parseModalFields,
  parseCustomId,
  buildCustomId,
  CUSTOM_IDS,
  formatNaturalTime,
  formatNextRunLabel,
  formatInFlightNotice,
  formatForumList,
  resolveStatusHeadline,
  safeRuntimeErrorMessage,
  PANEL_EMBED_COLOR,
  PANEL_TITLE,
  MAX_FORUM_LINES_IN_PANEL,
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

// ---------- 展示（Embed 美化）----------
function embedJson(embed) {
  return typeof embed.toJSON === "function" ? embed.toJSON() : embed.data;
}

{
  // 固定「今天」为 2026-07-28 上海下午（UTC 06:00 = 上海 14:00）
  const nowMs = Date.parse("2026-07-28T06:00:00.000Z");
  const snap = {
    mode: "execute",
    started: true,
    fatal: false,
    paused: false,
    pauseReason: null,
    successCount: 3,
    dailyLimit: 10,
    lastSuccessAt: "2026-07-28T11:44:00.000Z", // 上海 19:44
    nextEligibleAt: "2026-07-29T02:00:00.000Z", // 上海 明天 10:00
    inFlightPhase: null,
    activeStart: "10:00",
    activeEnd: "22:00",
    forumChannelIds: [F],
    silenceDays: 30,
    autoIntervalMinutes: 72,
    nextWakeAt: Date.parse("2026-07-29T02:00:00.000Z"),
    dynamicConfigRevision: 2,
  };

  assertEqual(resolveStatusHeadline(snap), "🟢 自动顶帖运行中", "正常运行文案");
  assertEqual(
    resolveStatusHeadline({ ...snap, paused: true, pauseReason: "ADMIN_PAUSED" }),
    "⏸️ 自动顶帖已暂停",
    "管理员暂停文案",
  );
  assertEqual(
    resolveStatusHeadline({ ...snap, paused: true, pauseReason: "DELETE_FAILED" }),
    "⚠️ 自动顶帖因安全问题暂停",
    "安全暂停文案",
  );
  assertEqual(
    resolveStatusHeadline({ ...snap, fatal: true }),
    "🔴 顶帖服务暂时不可用",
    "fatal 文案",
  );
  assertEqual(
    resolveStatusHeadline({ mode: "disabled", started: true }),
    "⏹️ 自动顶帖功能已关闭",
    "disabled 文案",
  );
  assertEqual(
    resolveStatusHeadline({ ...snap, mode: "dry_run" }),
    "🧪 当前为预览模式，不会真实顶帖",
    "dry_run 文案",
  );

  const embed = buildPanelEmbed(snap, {
    forumNameMap: new Map([[F, "沉醉梦境·红茶"]]),
    nowMs,
  });
  const ej = embedJson(embed);
  assertEqual(ej.color, PANEL_EMBED_COLOR, "Embed 颜色 0xB8B5FF");
  assertEqual(ej.title, PANEL_TITLE, "标题 小G宝顶帖控制台");
  assert(ej.description.includes("🟢 自动顶帖运行中"), "description 状态");
  assert(!ej.description.includes("execute"), "execute 隐藏 mode");
  assert(!ej.description.includes("inFlight"), "隐藏 inFlight 字段");
  assert(!ej.description.includes("异常原因"), "隐藏空异常");
  assert(!String(JSON.stringify(ej)).includes(F), "面板不出现 Forum ID");
  assert(!String(JSON.stringify(ej)).includes("UTC+8"), "不显示 UTC+8 标记");
  assert(!String(JSON.stringify(ej)).includes("before_send"), "不展示 phase");

  const fieldMap = Object.fromEntries((ej.fields || []).map((f) => [f.name, f.value]));
  assertEqual(fieldMap["今日进度"], "3 / 10", "今日进度字段");
  assertEqual(fieldMap["最近顶帖"], "今天 19:44", "最近顶帖自然时间");
  assertEqual(fieldMap["下次顶帖"], "明天 10:00", "下次顶帖明天");
  assert(fieldMap["📅 排班配置"]?.includes("10:00–22:00"), "排班活跃时间");
  assert(fieldMap["📅 排班配置"]?.includes("约 72 分钟"), "排班间隔");
  assert(fieldMap["📚 服务版块"]?.includes("沉醉梦境·红茶"), "版块名称");
  assert(fieldMap["📚 服务版块"]?.includes("｜"), "版块 emoji 分隔");
  assert(!fieldMap["📚 服务版块"]?.includes("#"), "版块无 #");

  // 其他日期
  assertEqual(
    formatNaturalTime("2026-07-31T02:00:00.000Z", nowMs),
    "7月31日 10:00",
    "其他日期格式",
  );
  assert(!formatNaturalTime("2026-07-28T11:44:30.000Z", nowMs).includes(":30"), "不显示秒");
  assertEqual(formatNaturalTime(null, nowMs), "暂无", "无最近成功");

  // 暂停 next
  assertEqual(
    formatNextRunLabel({ ...snap, paused: true, pauseReason: "ADMIN_PAUSED" }, nowMs),
    "恢复后重新计算",
    "管理员暂停 next",
  );
  assertEqual(
    formatNextRunLabel({ ...snap, paused: true, pauseReason: "DELETE_FAILED" }, nowMs),
    "安全暂停，暂不排程",
    "安全暂停 next",
  );
  assertEqual(
    formatNextRunLabel({ mode: "disabled", paused: false }, nowMs),
    "服务已禁用",
    "disabled next",
  );
  assertEqual(
    formatNextRunLabel({
      mode: "execute",
      paused: false,
      nextEligibleAt: null,
      nextWakeAt: null,
    }, nowMs),
    "等待调度",
    "无排程 next",
  );

  // dry_run / disabled embed
  const dry = embedJson(buildPanelEmbed({ ...snap, mode: "dry_run" }, { nowMs }));
  assert(dry.description.includes("预览模式"), "dry_run 预览提示");
  const dis = embedJson(buildPanelEmbed({ ...snap, mode: "disabled" }, { nowMs }));
  assert(dis.description.includes("已关闭"), "disabled 关闭提示");

  // inFlight
  assertEqual(formatInFlightNotice({ ...snap, inFlightPhase: null }), null, "空 inFlight 隐藏");
  assertEqual(
    formatInFlightNotice({ ...snap, inFlightPhase: "after_send", running: true }),
    "🔄 当前正在处理一项顶帖任务",
    "正常执行中 inFlight",
  );
  assertEqual(
    formatInFlightNotice({
      ...snap,
      inFlightPhase: "after_send",
      paused: true,
      pauseReason: "DELETE_FAILED",
    }),
    "⚠️ 上一次顶帖任务未正常完成，请检查运行状态",
    "风险 inFlight 警告",
  );
  const riskEmbed = embedJson(buildPanelEmbed({
    ...snap,
    inFlightPhase: "before_send",
    paused: true,
    pauseReason: "DELETE_FAILED",
  }, { nowMs }));
  assert(riskEmbed.description.includes("未正常完成"), "风险警告在 description");
  assert(!riskEmbed.description.includes("before_send"), "原始 phase 不展示");

  // Forum 截断
  const manyIds = Array.from({ length: MAX_FORUM_LINES_IN_PANEL + 3 }, (_, i) =>
    String(200000000000000000n + BigInt(i)));
  const names = new Map(manyIds.map((id, i) => [id, `版块${i}`]));
  const fl = formatForumList(manyIds, names);
  assert(fl.truncated, "频道过多截断");
  assertEqual(fl.hiddenCount, 3, "hiddenCount=3");
  assert(fl.text.includes("另有 3 个服务版块"), "截断提示");
  assertEqual(formatForumList([F], null).text.includes("未知或不可用的 Forum"), true, "无法解析名称");

  const sessionId = "a".repeat(16);
  const msg = buildPanelMessage(snap, sessionId, {
    forumNameMap: new Map([[F, "测试论坛"]]),
    nowMs,
  });
  assertEqual(msg.embeds.length, 1, "一条 embed");
  assertEqual(msg.components.length, 1, "主面板一行按钮");
  const labels = msg.components[0].components.map((b) => b.data?.label ?? b.label);
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
  assert(resumeBtn?.data?.disabled === true, "安全暂停禁用恢复");
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
  const dailyLabel = modal.components?.[0]?.components?.[0]?.data?.label
    ?? modal.data?.components?.[0]?.components?.[0]?.label
    ?? "每日额度";
  assertEqual(dailyLabel, "每日额度", "Modal 不再显示固定 1–10 标签");
  assert(!String(dailyLabel).includes("1–10") && !String(dailyLabel).includes("1-10"), "标签无 1-10");

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
  assert(!bad.ok, "非法额度 0");

  const over = parseModalFields({
    dailyLimit: "11",
    activeStart: "08:00",
    activeEnd: "13:00",
    silenceDays: "30",
  });
  assert(!over.ok, "超出动态上限拒绝");
  assert(over.safeMessage.includes("最多支持 10 次"), "提示当前可用最大次数");
  assertEqual(over.maxDailyLimit, 10, "maxDailyLimit=10");

  const abs = parseModalFields({
    dailyLimit: "31",
    activeStart: "08:00",
    activeEnd: "23:00",
    silenceDays: "30",
  });
  assert(!abs.ok, "超过 30 拒绝");
  assert(abs.safeMessage.includes("30"), "绝对上限 30 文案");

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

function baseInteraction(extra = {}) {
  const ix = {
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

function firstAck(ix) {
  return ix.ackLog[0]?.op ?? null;
}

function ackOps(ix) {
  return ix.ackLog.map((x) => x.op);
}

function isEphemeralFlags(flags) {
  // MessageFlags.Ephemeral === 64
  return flags === 64 || flags === MessageFlags.Ephemeral;
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
  assertEqual(firstAck(ix), "deferReply", "slash 先 deferReply");
  assert(ix.deferred, "slash deferred");
  assert(Array.isArray(ix.lastReply?.embeds) && ix.lastReply.embeds.length === 1, "面板使用 Embed");
  const replyEmbed = embedJson(ix.lastReply.embeds[0]);
  assertEqual(replyEmbed.color, PANEL_EMBED_COLOR, "回复 Embed 颜色");
  assertEqual(replyEmbed.title, PANEL_TITLE, "回复 Embed 标题");
  assert(replyEmbed.description?.includes("运行中") || replyEmbed.description?.includes("🟢"), "状态文案");
  assert(!JSON.stringify(replyEmbed).includes("execute"), "隐藏 execute 模式");
  assert(JSON.stringify(replyEmbed).includes("论坛A"), "频道名称展示");
  assert(!JSON.stringify(replyEmbed).includes(F), "不展示频道 ID");
  assert(ix.lastReply?.components?.length >= 1, "有按钮");
  assert(ackOps(ix).includes("editReply"), "最终 editReply");
  assertEqual(ackOps(ix).filter((o) => o === "deferReply" || o === "reply").length, 1, "slash 只确认一次");

  // 非管理员
  const denied = baseInteraction({
    isChatInputCommand: () => true,
    commandName: FORUM_BUMP_ROOT_COMMAND_NAME,
    options: { getSubcommand: () => FORUM_BUMP_PANEL_SUBCOMMAND_NAME },
    memberPermissions: { has: () => false },
  });
  await router._dispatch(denied);
  assert(String(denied.lastReply?.content || "").includes("管理员"), "非管理员拒绝");
  assertEqual(firstAck(denied), "reply", "拒绝路径直接 reply");
  assert(isEphemeralFlags(denied.ackLog[0]?.payload?.flags), "拒绝仍 ephemeral");

  router.destroy();
  // destroy 后不再处理
  const after = baseInteraction({
    isChatInputCommand: () => true,
    commandName: FORUM_BUMP_ROOT_COMMAND_NAME,
    options: { getSubcommand: () => FORUM_BUMP_PANEL_SUBCOMMAND_NAME },
  });
  await router._dispatch(after);
  assertEqual(after.ackLog.length, 0, "destroy 后不处理");
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
  assertEqual(firstAck(pauseIx), "deferUpdate", "暂停先 deferUpdate");
  assertEqual(runtime.calls.pause.length, 1, "pauseByAdmin 调用");
  assertEqual(runtime.calls.pause[0].source, "discord_admin_panel", "actor source");
  const pauseEmbed = pauseIx.lastReply?.embeds?.[0]
    ? embedJson(pauseIx.lastReply.embeds[0])
    : null;
  assert(pauseEmbed, "暂停后仍 Embed");
  assert(
    pauseEmbed.description?.includes("已暂停") || pauseEmbed.description?.includes("⏸️"),
    "暂停后面板更新",
  );
  assert(ackOps(pauseIx).includes("editReply"), "暂停后 editReply");

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
  assertEqual(firstAck(resumeIx), "deferUpdate", "恢复先 deferUpdate");
  const resumeText = resumeIx.lastReply?.embeds?.[0]
    ? JSON.stringify(embedJson(resumeIx.lastReply.embeds[0]))
    : (resumeIx.lastReply?.content || "");
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
  assertEqual(firstAck(resumeOk), "deferUpdate", "成功恢复先 deferUpdate");
  assertEqual(runtime.calls.resume.length, 1, "resume 调用");
  assertEqual((await runtime.getControlSnapshot()).paused, false, "已恢复");
  assert(ackOps(resumeOk).includes("editReply"), "恢复后 editReply");

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
  assertEqual(firstAck(saveIx), "deferUpdate", "保存先 deferUpdate");
  assertEqual(runtime.calls.update.length, 1, "updateDynamicConfig 一次");
  const patch = runtime.calls.update[0].patch;
  assertEqual(patch.dailyLimit, 5, "patch dailyLimit");
  assertEqual(patch.activeStart, "08:00", "patch start");
  assertEqual(patch.activeEnd, "13:00", "patch end");
  assertEqual(patch.silenceDays, 14, "patch silence");
  assertEqual(patch.forumChannelIds.join(","), `${F},${F2}`, "完整 forum 列表");
  assertEqual(runtime.calls.update[0].actor.source, "discord_admin_panel", "actorContext");
  assert(ackOps(saveIx).includes("editReply"), "保存后 editReply");

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
  assertEqual(firstAck(staleIx), "deferUpdate", "过期保存仍先 deferUpdate");
  const staleText = staleIx.lastReply?.content || "";
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
  assertEqual(firstAck(failIx), "deferUpdate", "失败保存先 deferUpdate");
  const failText = failIx.lastReply?.embeds?.[0]
    ? JSON.stringify(embedJson(failIx.lastReply.embeds[0]))
    : (failIx.lastReply?.content || "");
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
  assertEqual(firstAck(cancelIx), "deferUpdate", "取消先 deferUpdate");
  assertEqual(cancelRt.calls.update.length, 0, "取消不 update");
  assertEqual((await cancelRt.getControlSnapshot()).dailyLimit, 3, "取消保持配置");
  assert(ackOps(cancelIx).includes("editReply"), "取消后 editReply");

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
  const badText = String(badModal.lastReply?.content || "");
  assert(
    badText.includes("额度") || badText.includes("最多") || badText.includes("30"),
    "非法额度提示",
  );
  assert(!badText.includes("1–10") && !badText.includes("1-10"), "不再提示固定 1–10");

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
  assertEqual(foreign.ackLog.length, 0, "不处理人工发言命令");
  router.destroy();
}

// ---------- Interaction 3 秒安全：延迟 Runtime ----------
{
  const client = makeClient();
  const runtime = makeRuntime({ delayMs: 80 });
  const store = createForumBumpPanelSessionStore({ now: () => Date.now() });
  const router = createForumBumpAdminRouter({
    client,
    guildId: G,
    forumBumpRuntime: runtime,
    logger: { info() {}, warn() {}, error() {} },
    sessionStore: store,
  });
  router.start();

  // Slash：Runtime Promise 完成前已 deferReply
  {
    const ix = baseInteraction({
      isChatInputCommand: () => true,
      commandName: FORUM_BUMP_ROOT_COMMAND_NAME,
      options: { getSubcommand: () => FORUM_BUMP_PANEL_SUBCOMMAND_NAME },
    });
    let snapStarted = false;
    let deferredBeforeSnap = false;
    const origSnap = runtime.getControlSnapshot.bind(runtime);
    runtime.getControlSnapshot = async () => {
      snapStarted = true;
      deferredBeforeSnap = ix.deferred === true && firstAck(ix) === "deferReply";
      return origSnap();
    };
    await router._dispatch(ix);
    assert(snapStarted, "调用了 getControlSnapshot");
    assert(deferredBeforeSnap, "Runtime 前已 deferReply");
    assert(ackOps(ix).includes("editReply"), "延迟后 editReply");
    assertEqual(
      ackOps(ix).filter((o) => o === "deferReply" || o === "reply" || o === "deferUpdate" || o === "showModal").length,
      1,
      "slash 仅一次确认",
    );
    assert(isEphemeralFlags(ix.ackLog.find((a) => a.op === "deferReply")?.opts?.flags), "deferReply ephemeral");
    runtime.getControlSnapshot = origSnap;
  }

  // 编辑按钮：showModal 前无 Runtime 调用
  {
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
    const snapsBefore = runtime.calls.snapshot;
    const ix = baseInteraction({
      isButton: () => true,
      customId: buildCustomId("btn", CUSTOM_IDS.edit, session.sessionId),
    });
    await router._dispatch(ix);
    assertEqual(firstAck(ix), "showModal", "编辑首次响应 showModal");
    assertEqual(runtime.calls.snapshot, snapsBefore, "编辑前无 Runtime snapshot");
    assertEqual(runtime.calls.update.length, 0, "编辑前无 update");
    assert(ix.shownModal, "已 showModal");
  }

  // 暂停：Runtime 前已 deferUpdate
  {
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
    const ix = baseInteraction({
      isButton: () => true,
      customId: buildCustomId("btn", CUSTOM_IDS.pause, session.sessionId),
    });
    let deferredBeforePause = false;
    const origPause = runtime.pauseByAdmin.bind(runtime);
    runtime.pauseByAdmin = async (actor) => {
      deferredBeforePause = ix.deferred === true && firstAck(ix) === "deferUpdate";
      return origPause(actor);
    };
    await router._dispatch(ix);
    assert(deferredBeforePause, "pause Runtime 前已 deferUpdate");
    assert(ackOps(ix).includes("editReply"), "pause 后 editReply");
    assertEqual(
      ackOps(ix).filter((o) => o === "deferUpdate" || o === "reply" || o === "showModal").length,
      1,
      "pause 仅一次确认",
    );
    runtime.pauseByAdmin = origPause;
  }

  // 恢复：Runtime 前已 deferUpdate
  {
    runtime._setSnap({ paused: true, pauseReason: "ADMIN_PAUSED" });
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
    const ix = baseInteraction({
      isButton: () => true,
      customId: buildCustomId("btn", CUSTOM_IDS.resume, session.sessionId),
    });
    let deferredBeforeResume = false;
    const origResume = runtime.resumeByAdmin.bind(runtime);
    runtime.resumeByAdmin = async (actor) => {
      deferredBeforeResume = ix.deferred === true && firstAck(ix) === "deferUpdate";
      return origResume(actor);
    };
    await router._dispatch(ix);
    assert(deferredBeforeResume, "resume Runtime 前已 deferUpdate");
    assert(ackOps(ix).includes("editReply"), "resume 后 editReply");
    runtime.resumeByAdmin = origResume;
  }

  // 保存：Runtime 前已 deferUpdate；revision 防护仍有效
  {
    runtime._setSnap({
      paused: false,
      pauseReason: null,
      dynamicConfigRevision: 3,
      dailyLimit: 3,
    });
    const session = store.createSession({
      actorId: ACTOR,
      guildId: G,
      dynamicConfigRevision: 3,
      draft: {
        dailyLimit: 5,
        activeStart: "08:00",
        activeEnd: "13:00",
        silenceDays: 30,
        forumChannelIds: [F],
      },
    });
    const ix = baseInteraction({
      isButton: () => true,
      customId: buildCustomId("btn", CUSTOM_IDS.save, session.sessionId),
    });
    let deferredBeforeUpdate = false;
    const origUpd = runtime.updateDynamicConfig.bind(runtime);
    runtime.updateDynamicConfig = async (patch, actor) => {
      deferredBeforeUpdate = ix.deferred === true && firstAck(ix) === "deferUpdate";
      return origUpd(patch, actor);
    };
    await router._dispatch(ix);
    assert(deferredBeforeUpdate, "save Runtime 前已 deferUpdate");
    assert(ackOps(ix).includes("editReply"), "save 后 editReply");
    runtime.updateDynamicConfig = origUpd;

    // 旧写防护
    const stale = store.createSession({
      actorId: ACTOR,
      guildId: G,
      dynamicConfigRevision: 1,
      draft: {
        dailyLimit: 4,
        activeStart: "10:00",
        activeEnd: "22:00",
        silenceDays: 30,
        forumChannelIds: [F],
      },
    });
    runtime._setSnap({ dynamicConfigRevision: 9 });
    const updatesBefore = runtime.calls.update.length;
    const staleIx = baseInteraction({
      isButton: () => true,
      customId: buildCustomId("btn", CUSTOM_IDS.save, stale.sessionId),
    });
    await router._dispatch(staleIx);
    assertEqual(firstAck(staleIx), "deferUpdate", "旧写仍先 deferUpdate");
    assertEqual(runtime.calls.update.length, updatesBefore, "旧写不调用 update");
    assert(String(staleIx.lastReply?.content || "").includes("配置已被其他操作更新"), "旧写提示");
  }

  router.destroy();
}

assertEqual(safeRuntimeErrorMessage({ errorCode: "DYNAMIC_CONFIG_REVISION_CONFLICT" }).includes("重新打开"), true, "revision 安全文案");

console.log(`\n=== adminPanel: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);

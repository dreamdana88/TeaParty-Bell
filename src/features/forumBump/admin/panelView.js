/**
 * Forum Bump 管理员面板展示与组件构建。
 * 时间统一按 UTC+8 展示。
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { validateDailyLimitForWindow } from "../autoInterval.js";

export const FB_CUSTOM_PREFIX = "fbump:v1";
export const DISPLAY_TIMEZONE = "Asia/Shanghai";

export const CUSTOM_IDS = Object.freeze({
  edit: "edit",
  pause: "pause",
  resume: "resume",
  modal: "modal",
  select: "select",
  save: "save",
  cancel: "cancel",
});

const HHMM_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * customId: fbump:v1:{kind}:{action}:{sessionId}
 * @param {string} kind btn|modal|select
 * @param {string} action
 * @param {string} sessionId
 */
export function buildCustomId(kind, action, sessionId) {
  const id = `${FB_CUSTOM_PREFIX}:${kind}:${action}:${sessionId}`;
  if (id.length > 100) return null;
  return id;
}

/**
 * @param {string} customId
 * @returns {{ kind: string, action: string, sessionId: string }|null}
 */
export function parseCustomId(customId) {
  if (typeof customId !== "string" || !customId.startsWith(`${FB_CUSTOM_PREFIX}:`)) {
    return null;
  }
  const parts = customId.split(":");
  // fbump v1 kind action sessionId
  if (parts.length !== 5) return null;
  if (parts[0] !== "fbump" || parts[1] !== "v1") return null;
  const kind = parts[2];
  const action = parts[3];
  const sessionId = parts[4];
  if (!kind || !action || !/^[a-f0-9]{16}$/i.test(sessionId)) return null;
  return { kind, action, sessionId };
}

export function isForumBumpCustomId(customId) {
  return parseCustomId(customId) != null;
}

/**
 * @param {string|null|undefined} iso
 * @returns {string}
 */
export function formatUtc8(iso) {
  if (!iso || typeof iso !== "string") return "无";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "无";
  try {
    const dtf = new Intl.DateTimeFormat("zh-CN", {
      timeZone: DISPLAY_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    return `${dtf.format(new Date(ms))}（UTC+8）`;
  } catch {
    return "无";
  }
}

/**
 * @param {object} snap getControlSnapshot()
 */
export function resolveRunStatusLabel(snap) {
  if (!snap) return "Runtime 异常";
  if (snap.mode === "disabled") return "已禁用";
  if (snap.fatal) return "Runtime 异常";
  if (snap.dynamicConfigError || snap.dynamicConfigSource === "failed") {
    return "Runtime 异常";
  }
  if (snap.paused === true) {
    if (snap.pauseReason === "ADMIN_PAUSED") return "管理员暂停";
    return "安全故障暂停";
  }
  if (snap.started && snap.mode !== "disabled") return "运行中";
  return "Runtime 异常";
}

/**
 * @param {string[]} forumChannelIds
 * @param {Map<string, string>|Record<string, string>|null} nameMap
 */
export function formatForumList(forumChannelIds, nameMap = null) {
  if (!Array.isArray(forumChannelIds) || forumChannelIds.length === 0) {
    return "（未配置）";
  }
  return forumChannelIds.map((id) => {
    const name = nameMap instanceof Map
      ? nameMap.get(id)
      : nameMap?.[id];
    if (name) return `#${name} (\`${id}\`)`;
    return `<#${id}>`;
  }).join("\n");
}

/**
 * 下次执行展示文案（仅展示语义，不改变 Runtime 排程）。
 * @param {object} snap
 */
export function formatNextRunLabel(snap) {
  if (!snap || snap.mode === "disabled") {
    return "服务已禁用";
  }
  if (snap.paused === true) {
    if (snap.pauseReason === "ADMIN_PAUSED") {
      return "已暂停，恢复后重新计算";
    }
    return "安全暂停，暂不排程";
  }
  if (snap.fatal === true || snap.dynamicConfigSource === "failed") {
    return "安全暂停，暂不排程";
  }
  if (snap.nextEligibleAt) {
    return formatUtc8(snap.nextEligibleAt);
  }
  if (snap.nextWakeAt != null) {
    const iso = typeof snap.nextWakeAt === "number"
      ? new Date(snap.nextWakeAt).toISOString()
      : String(snap.nextWakeAt);
    return formatUtc8(iso);
  }
  return "等待调度";
}

/**
 * @param {object} snap
 * @param {{ forumNameMap?: Map|object }} [opts]
 */
export function buildPanelContent(snap, opts = {}) {
  const status = resolveRunStatusLabel(snap);
  const mode = snap?.mode ?? "unknown";
  const successCount = snap?.successCount ?? 0;
  const dailyLimit = snap?.dailyLimit ?? "?";
  const lastSuccess = formatUtc8(snap?.lastSuccessAt);
  const inFlight = snap?.inFlightPhase
    ? String(snap.inFlightPhase)
    : "无";
  let fault = "无";
  if (snap?.fatal && snap?.fatalCode) fault = String(snap.fatalCode);
  else if (snap?.dynamicConfigError) fault = String(snap.dynamicConfigError);
  else if (snap?.paused && snap?.pauseReason && snap.pauseReason !== "ADMIN_PAUSED") {
    fault = String(snap.pauseReason);
  }

  const activeStart = snap?.activeStart ?? "?";
  const activeEnd = snap?.activeEnd ?? "?";
  const silenceDays = snap?.silenceDays ?? "?";
  const autoMin = snap?.autoIntervalMinutes;
  const autoLabel = Number.isFinite(autoMin)
    ? `约 ${autoMin} 分钟`
    : "不可用";

  const forums = formatForumList(snap?.forumChannelIds, opts.forumNameMap ?? null);

  return [
    "**顶帖控制面板**",
    "",
    "**运行状态**",
    `状态：${status}`,
    `模式：\`${mode}\`（只读）`,
    `今日进度：${successCount} / ${dailyLimit}`,
    `最近成功：${lastSuccess}`,
    `下次执行：${formatNextRunLabel(snap)}`,
    `inFlight：${inFlight}`,
    `异常原因：${fault}`,
    "",
    "**当前配置**",
    `每日额度：${dailyLimit}`,
    `活跃时间：${activeStart}–${activeEnd}（UTC+8）`,
    `服务 Forum：`,
    forums,
    `帖子入选范围：${silenceDays} 天无回复`,
    `自动间隔：${autoLabel}`,
  ].join("\n");
}

/**
 * @param {object} snap
 * @param {string} sessionId
 */
export function buildPanelComponents(snap, sessionId) {
  const editId = buildCustomId("btn", CUSTOM_IDS.edit, sessionId);
  const pauseOrResume = snap?.paused === true && snap?.pauseReason === "ADMIN_PAUSED"
    ? buildCustomId("btn", CUSTOM_IDS.resume, sessionId)
    : buildCustomId("btn", CUSTOM_IDS.pause, sessionId);
  if (!editId || !pauseOrResume) return [];

  const canResume = snap?.paused === true && snap?.pauseReason === "ADMIN_PAUSED";
  const isSafetyPause = snap?.paused === true && snap?.pauseReason !== "ADMIN_PAUSED";
  const isAdminPaused = canResume;

  const editBtn = new ButtonBuilder()
    .setCustomId(editId)
    .setLabel("编辑配置")
    .setStyle(ButtonStyle.Primary)
    .setDisabled(snap?.mode === "disabled" || snap?.fatal === true);

  let controlBtn;
  if (isAdminPaused) {
    controlBtn = new ButtonBuilder()
      .setCustomId(pauseOrResume)
      .setLabel("恢复顶帖")
      .setStyle(ButtonStyle.Success)
      .setDisabled(false);
  } else if (isSafetyPause) {
    // 安全故障：按钮禁用，防止绕过
    controlBtn = new ButtonBuilder()
      .setCustomId(buildCustomId("btn", CUSTOM_IDS.resume, sessionId))
      .setLabel("恢复顶帖")
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);
  } else {
    controlBtn = new ButtonBuilder()
      .setCustomId(pauseOrResume)
      .setLabel("暂停顶帖")
      .setStyle(ButtonStyle.Danger)
      .setDisabled(snap?.mode === "disabled" || snap?.fatal === true);
  }

  return [
    new ActionRowBuilder().addComponents(editBtn, controlBtn),
  ];
}

/**
 * Modal 预填四项配置。
 * @param {object} draft
 * @param {string} sessionId
 */
export function buildConfigModal(draft, sessionId) {
  const customId = buildCustomId("modal", CUSTOM_IDS.modal, sessionId);
  if (!customId) return null;

  const daily = new TextInputBuilder()
    .setCustomId("dailyLimit")
    .setLabel("每日额度")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(2)
    .setPlaceholder("根据活跃时间自动限制，最多 30")
    .setValue(String(draft?.dailyLimit ?? "3"));

  const start = new TextInputBuilder()
    .setCustomId("activeStart")
    .setLabel("活跃开始时间（HH:mm，UTC+8）")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(4)
    .setMaxLength(5)
    .setValue(String(draft?.activeStart ?? "10:00"));

  const end = new TextInputBuilder()
    .setCustomId("activeEnd")
    .setLabel("活跃结束时间（HH:mm，UTC+8）")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(4)
    .setMaxLength(5)
    .setValue(String(draft?.activeEnd ?? "22:00"));

  const silence = new TextInputBuilder()
    .setCustomId("silenceDays")
    .setLabel("无回复天数（1–3650）")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(4)
    .setValue(String(draft?.silenceDays ?? "30"));

  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle("编辑顶帖配置")
    .addComponents(
      new ActionRowBuilder().addComponents(daily),
      new ActionRowBuilder().addComponents(start),
      new ActionRowBuilder().addComponents(end),
      new ActionRowBuilder().addComponents(silence),
    );
}

/**
 * 解析 Modal 文本字段（基础格式 + 活跃窗动态额度校验）。
 * @returns {{ ok: true, values } | { ok: false, safeMessage: string, maxDailyLimit?: number }}
 */
export function parseModalFields(fields) {
  const rawLimit = String(fields?.dailyLimit ?? "").trim();
  const rawStart = String(fields?.activeStart ?? "").trim();
  const rawEnd = String(fields?.activeEnd ?? "").trim();
  const rawSilence = String(fields?.silenceDays ?? "").trim();

  if (!HHMM_RE.test(rawStart) || !HHMM_RE.test(rawEnd)) {
    return { ok: false, safeMessage: "活跃时间必须为 HH:mm 格式。" };
  }
  const [sh, sm] = rawStart.split(":").map(Number);
  const [eh, em] = rawEnd.split(":").map(Number);
  if (sh * 60 + sm >= eh * 60 + em) {
    return { ok: false, safeMessage: "开始时间必须早于结束时间（不支持跨午夜）。" };
  }

  if (!/^\d+$/.test(rawLimit)) {
    return { ok: false, safeMessage: "每日额度必须是至少为 1 的整数。" };
  }
  const dailyLimit = Number(rawLimit);
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1) {
    return { ok: false, safeMessage: "每日额度必须是至少为 1 的整数。" };
  }
  const limitCheck = validateDailyLimitForWindow(rawStart, rawEnd, dailyLimit);
  if (!limitCheck.ok) {
    return {
      ok: false,
      safeMessage: limitCheck.safeMessage,
      maxDailyLimit: limitCheck.maxDailyLimit,
    };
  }

  if (!/^\d+$/.test(rawSilence)) {
    return { ok: false, safeMessage: "无回复天数必须是 1–3650 的整数。" };
  }
  const silenceDays = Number(rawSilence);
  if (!Number.isInteger(silenceDays) || silenceDays < 1 || silenceDays > 3650) {
    return { ok: false, safeMessage: "无回复天数必须是 1–3650 的整数。" };
  }

  return {
    ok: true,
    values: {
      dailyLimit,
      activeStart: rawStart,
      activeEnd: rawEnd,
      silenceDays,
    },
    maxDailyLimit: limitCheck.maxDailyLimit,
  };
}

/**
 * 频道选择 + 保存/取消。
 * @param {object} draft
 * @param {string} sessionId
 */
export function buildForumSelectPage(draft, sessionId) {
  const selectId = buildCustomId("select", CUSTOM_IDS.select, sessionId);
  const saveId = buildCustomId("btn", CUSTOM_IDS.save, sessionId);
  const cancelId = buildCustomId("btn", CUSTOM_IDS.cancel, sessionId);
  if (!selectId || !saveId || !cancelId) return null;

  const select = new ChannelSelectMenuBuilder()
    .setCustomId(selectId)
    .setPlaceholder("选择服务 Forum 频道（可多选）")
    .setMinValues(1)
    .setMaxValues(25)
    .setChannelTypes(ChannelType.GuildForum);

  const defaults = Array.isArray(draft?.forumChannelIds)
    ? draft.forumChannelIds.filter((id) => typeof id === "string").slice(0, 25)
    : [];
  if (defaults.length > 0 && typeof select.setDefaultChannels === "function") {
    try {
      select.setDefaultChannels(defaults);
    } catch {
      // 预选失败不阻塞
    }
  }

  const saveBtn = new ButtonBuilder()
    .setCustomId(saveId)
    .setLabel("保存配置")
    .setStyle(ButtonStyle.Success);
  const cancelBtn = new ButtonBuilder()
    .setCustomId(cancelId)
    .setLabel("取消")
    .setStyle(ButtonStyle.Secondary);

  const content = [
    "**选择服务 Forum 频道**",
    "请至少选择一个 GuildForum 频道，然后点击「保存配置」。",
    "",
    `当前草稿：额度 ${draft?.dailyLimit}，${draft?.activeStart}–${draft?.activeEnd}，${draft?.silenceDays} 天无回复`,
  ].join("\n");

  return {
    content,
    components: [
      new ActionRowBuilder().addComponents(select),
      new ActionRowBuilder().addComponents(saveBtn, cancelBtn),
    ],
  };
}

export function safeRuntimeErrorMessage(result) {
  if (result?.safeMessage && typeof result.safeMessage === "string") {
    return result.safeMessage;
  }
  if (result?.errorCode === "DYNAMIC_CONFIG_REVISION_CONFLICT"
    || result?.errorCode === "SESSION_REVISION_STALE") {
    return "配置已被其他操作更新，请重新打开顶帖面板。";
  }
  if (result?.errorCode === "DYNAMIC_CONFIG_INTERVAL_TOO_SHORT") {
    if (Number.isInteger(result?.maxDailyLimit)) {
      return `当前活跃时段最多支持 ${result.maxDailyLimit} 次，请降低每日额度或延长活跃时间。`;
    }
    return "当前活跃时段额度过高，请降低每日额度或延长活跃时间。";
  }
  if (result?.errorCode === "DYNAMIC_CONFIG_INTERVAL_INVALID") {
    return result?.safeMessage || "每日额度或活跃时间不合法。";
  }
  if (result?.errorCode === "DYNAMIC_CONFIG_PREFLIGHT_FAILED") {
    return "Forum 频道校验失败，请检查频道类型与权限。";
  }
  if (result?.errorCode === "DYNAMIC_CONFIG_INFLIGHT_BLOCKED") {
    return "当前有进行中的顶帖操作，请稍后再试。";
  }
  if (result?.errorCode === "STATE_RECOVERY_REQUIRED") {
    return "当前为安全故障暂停，无法从面板直接恢复。";
  }
  return "操作失败，请稍后重试或重新打开顶帖面板。";
}

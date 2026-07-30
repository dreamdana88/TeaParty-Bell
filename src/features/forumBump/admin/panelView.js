/**
 * Forum Bump 管理员面板展示与组件构建。
 * 面板使用 Discord Embed；时间按 Asia/Shanghai 自然化展示。
 * 仅 UI 层，不修改 Runtime / 状态文件。
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelSelectMenuBuilder,
  ChannelType,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { validateDailyLimitForWindow } from "../autoInterval.js";

export const FB_CUSTOM_PREFIX = "fbump:v1";
export const DISPLAY_TIMEZONE = "Asia/Shanghai";
export const PANEL_EMBED_COLOR = 0xB8B5FF;
export const PANEL_TITLE = "🌸 小G宝顶帖控制台";

/** Embed field value 上限 1024；预留下限避免发送失败 */
export const MAX_FORUM_LINES_IN_PANEL = 12;

/** 无法解析频道名称时的占位（统一装饰，避免与真实名称重复） */
export const UNKNOWN_FORUM_LABEL = "❔｜未知或不可用的 Forum";

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
 * @param {number} ms
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number }|null}
 */
export function getShanghaiParts(ms) {
  if (!Number.isFinite(ms)) return null;
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: DISPLAY_TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    const parts = dtf.formatToParts(new Date(ms));
    const map = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
    return {
      year: Number(map.year),
      month: Number(map.month),
      day: Number(map.day),
      hour: Number(map.hour),
      minute: Number(map.minute),
    };
  } catch {
    return null;
  }
}

function ymdKey(p) {
  return p.year * 10_000 + p.month * 100 + p.day;
}

function addDaysShanghai(parts, deltaDays) {
  // 以中午 UTC 近似平移，再取上海日历日
  const noonGuess = Date.UTC(parts.year, parts.month - 1, parts.day, 4, 0, 0)
    + deltaDays * 24 * 3600_000;
  return getShanghaiParts(noonGuess);
}

/**
 * 自然时间：今天 / 明天 / M月D日 HH:mm（无秒、无 UTC+8 后缀）。
 * @param {string|null|undefined} iso
 * @param {number} [nowMs]
 */
export function formatNaturalTime(iso, nowMs = Date.now()) {
  if (!iso || typeof iso !== "string") return "暂无";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "暂无";
  const target = getShanghaiParts(ms);
  const now = getShanghaiParts(nowMs);
  if (!target || !now) return "暂无";

  const hh = String(target.hour).padStart(2, "0");
  const mm = String(target.minute).padStart(2, "0");
  const clock = `${hh}:${mm}`;

  const tKey = ymdKey(target);
  const nKey = ymdKey(now);
  if (tKey === nKey) return `今天 ${clock}`;

  const tomorrow = addDaysShanghai(now, 1);
  if (tomorrow && tKey === ymdKey(tomorrow)) return `明天 ${clock}`;

  return `${target.month}月${target.day}日 ${clock}`;
}

/**
 * 兼容旧名：自然时间（无秒）。
 * @deprecated 面板请用 formatNaturalTime
 */
export function formatUtc8(iso, nowMs = Date.now()) {
  return formatNaturalTime(iso, nowMs);
}

/**
 * 状态主文案（Embed description 首行）。
 */
export function resolveStatusHeadline(snap) {
  if (!snap) return "🔴 顶帖服务暂时不可用";
  if (snap.mode === "disabled") return "⏹️ 自动顶帖功能已关闭";
  if (snap.fatal || snap.dynamicConfigSource === "failed") {
    return "🔴 顶帖服务暂时不可用";
  }
  if (snap.mode === "dry_run") {
    return "🧪 当前为预览模式，不会真实顶帖";
  }
  if (snap.paused === true) {
    if (snap.pauseReason === "ADMIN_PAUSED") return "⏸️ 自动顶帖已暂停";
    return "⚠️ 自动顶帖因安全问题暂停";
  }
  if (snap.started) return "🟢 自动顶帖运行中";
  return "🔴 顶帖服务暂时不可用";
}

/** @deprecated 使用 resolveStatusHeadline */
export function resolveRunStatusLabel(snap) {
  return resolveStatusHeadline(snap);
}

/**
 * inFlight 展示：null 隐藏；正常执行中简短提示；风险状态醒目警告。
 * 不展示 before_send / after_send / after_delete。
 * @returns {string|null}
 */
export function formatInFlightNotice(snap) {
  const phase = snap?.inFlightPhase ?? null;
  if (!phase) return null;

  const risky = snap?.paused === true
    || snap?.fatal === true
    || snap?.dynamicConfigSource === "failed"
    || (typeof snap?.pauseReason === "string"
      && snap.pauseReason !== "ADMIN_PAUSED"
      && snap.pauseReason.length > 0);

  if (risky) {
    return "⚠️ 上一次顶帖任务未正常完成，请检查运行状态";
  }
  return "🔄 当前正在处理一项顶帖任务";
}

/**
 * 安全故障时的可读说明（无内部错误码）。
 * @returns {string|null}
 */
export function formatSafetyNotice(snap) {
  if (!snap) return null;
  if (snap.fatal || snap.dynamicConfigSource === "failed") {
    return "顶帖服务遇到问题，已停止自动调度。请联系维护者检查运行日志。";
  }
  if (snap.paused === true && snap.pauseReason && snap.pauseReason !== "ADMIN_PAUSED") {
    return "因安全原因已暂停自动顶帖，请勿强制恢复。请联系维护者检查残留消息或状态。";
  }
  return null;
}

/**
 * 下次执行展示。
 */
export function formatNextRunLabel(snap, nowMs = Date.now()) {
  if (!snap || snap.mode === "disabled") {
    return "服务已禁用";
  }
  if (snap.paused === true) {
    if (snap.pauseReason === "ADMIN_PAUSED") {
      return "恢复后重新计算";
    }
    return "安全暂停，暂不排程";
  }
  if (snap.fatal === true || snap.dynamicConfigSource === "failed") {
    return "安全暂停，暂不排程";
  }
  if (snap.nextEligibleAt) {
    return formatNaturalTime(snap.nextEligibleAt, nowMs);
  }
  if (snap.nextWakeAt != null) {
    const iso = typeof snap.nextWakeAt === "number"
      ? new Date(snap.nextWakeAt).toISOString()
      : String(snap.nextWakeAt);
    return formatNaturalTime(iso, nowMs);
  }
  return "等待调度";
}

/**
 * 最近顶帖。
 */
export function formatLastSuccessLabel(snap, nowMs = Date.now()) {
  if (!snap?.lastSuccessAt) return "暂无";
  return formatNaturalTime(snap.lastSuccessAt, nowMs);
}

/**
 * 服务版块列表：直接显示 Discord 真实频道名称，不再统一追加 emoji / ｜。
 * 无法解析时使用固定占位。不显示频道 ID；过多时截断。
 * @returns {{ text: string, truncated: boolean, hiddenCount: number }}
 */
export function formatForumList(forumChannelIds, nameMap = null, options = {}) {
  const maxLines = Number.isInteger(options.maxLines)
    ? options.maxLines
    : MAX_FORUM_LINES_IN_PANEL;

  if (!Array.isArray(forumChannelIds) || forumChannelIds.length === 0) {
    return { text: "（未配置）", truncated: false, hiddenCount: 0 };
  }

  const lines = [];
  for (let i = 0; i < forumChannelIds.length; i += 1) {
    const id = forumChannelIds[i];
    const name = nameMap instanceof Map
      ? nameMap.get(id)
      : nameMap?.[id];
    // 真实名称原样展示（频道名本身可含 emoji / ｜）；禁止再次装饰
    const label = (typeof name === "string" && name.trim())
      ? name.trim()
      : UNKNOWN_FORUM_LABEL;
    lines.push(label);
  }

  if (lines.length <= maxLines) {
    return { text: lines.join("\n"), truncated: false, hiddenCount: 0 };
  }

  const shown = lines.slice(0, maxLines);
  const hiddenCount = lines.length - maxLines;
  shown.push(`另有 ${hiddenCount} 个服务版块`);
  return { text: shown.join("\n"), truncated: true, hiddenCount };
}

/**
 * 构建面板 Embed。
 * @param {object} snap
 * @param {{ forumNameMap?: Map|object, nowMs?: number, notice?: string|null }} [opts]
 */
export function buildPanelEmbed(snap, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const headline = resolveStatusHeadline(snap);
  const notice = typeof opts.notice === "string" && opts.notice.trim()
    ? opts.notice.trim()
    : null;

  const descriptionParts = [headline];
  if (notice) descriptionParts.push("", notice);

  const inFlightNotice = formatInFlightNotice(snap);
  if (inFlightNotice) descriptionParts.push("", inFlightNotice);

  const safety = formatSafetyNotice(snap);
  if (safety) descriptionParts.push("", safety);

  const successCount = snap?.successCount ?? 0;
  const dailyLimit = snap?.dailyLimit ?? "?";
  const activeStart = snap?.activeStart ?? "?";
  const activeEnd = snap?.activeEnd ?? "?";
  const silenceDays = snap?.silenceDays ?? "?";
  const autoMin = snap?.autoIntervalMinutes;
  const autoLabel = Number.isFinite(autoMin)
    ? `约 ${autoMin} 分钟`
    : "不可用";

  const scheduleBody = [
    `活跃时间：${activeStart}–${activeEnd}`,
    `自动间隔：${autoLabel}`,
    `入选范围：${silenceDays} 天无回复`,
  ].join("\n");

  const forums = formatForumList(
    snap?.forumChannelIds,
    opts.forumNameMap ?? null,
  );

  const embed = new EmbedBuilder()
    .setColor(PANEL_EMBED_COLOR)
    .setTitle(PANEL_TITLE)
    .setDescription(descriptionParts.join("\n"))
    .addFields(
      {
        name: "今日进度",
        value: `${successCount} / ${dailyLimit}`,
        inline: true,
      },
      {
        name: "最近顶帖",
        value: formatLastSuccessLabel(snap, nowMs),
        inline: true,
      },
      {
        name: "下次顶帖",
        value: formatNextRunLabel(snap, nowMs),
        inline: true,
      },
      {
        name: "📅 排班配置",
        value: scheduleBody,
        inline: false,
      },
      {
        name: "📚 服务版块",
        value: forums.text.slice(0, 1024) || "（未配置）",
        inline: false,
      },
    );

  return embed;
}

/**
 * 完整面板消息载荷（Embed + 可选 notice content）。
 * @returns {{ embeds: EmbedBuilder[], components: ActionRowBuilder[], content: string|undefined }}
 */
export function buildPanelMessage(snap, sessionId, opts = {}) {
  const embed = buildPanelEmbed(snap, opts);
  const components = sessionId
    ? buildPanelComponents(snap, sessionId)
    : [];
  // 操作成功提示放 content，避免挤进 embed description 过长；空则省略
  const content = typeof opts.notice === "string" && opts.notice.trim()
    ? opts.notice.trim()
    : undefined;
  // notice 已写入 embed description，content 可空（避免重复）
  return {
    embeds: [embed],
    components,
    // 不重复发 notice content
    content: undefined,
  };
}

/**
 * 兼容旧测试：返回可检索的纯文本摘要（非发送用）。
 * @deprecated 面板发送请用 buildPanelMessage / buildPanelEmbed
 */
export function buildPanelContent(snap, opts = {}) {
  const embed = buildPanelEmbed(snap, opts);
  const data = typeof embed.toJSON === "function" ? embed.toJSON() : embed.data;
  const fields = (data.fields || [])
    .map((f) => `${f.name}\n${f.value}`)
    .join("\n");
  return [data.title, data.description, fields].filter(Boolean).join("\n");
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
 * 解析 Modal 文本字段。
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

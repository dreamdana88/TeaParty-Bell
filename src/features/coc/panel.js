import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from "discord.js";

export const COC_CUSTOM_PREFIX = "coc:v1";
export const PANEL_COLOR = 0x6e4b8b;

const MAX_NAMES = 12;

export function buildCustomId(action, sessionId = "") {
  const id = sessionId
    ? `${COC_CUSTOM_PREFIX}:${action}:${sessionId}`
    : `${COC_CUSTOM_PREFIX}:${action}`;
  if (id.length > 100) return null;
  return id;
}

export function parseCustomId(customId) {
  if (typeof customId !== "string" || !customId.startsWith(`${COC_CUSTOM_PREFIX}:`)) return null;
  const rest = customId.slice(COC_CUSTOM_PREFIX.length + 1);
  const splitAt = rest.indexOf(":");
  if (splitAt === -1) return { action: rest, sessionId: null };
  const action = rest.slice(0, splitAt);
  const sessionId = rest.slice(splitAt + 1);
  if (!action || !sessionId) return null;
  return { action, sessionId };
}

export function isCocCustomId(customId) {
  return parseCustomId(customId) != null || customId === `${COC_CUSTOM_PREFIX}:modal-open`;
}

function namesBlock(session) {
  const klLines = session.kl.slice(0, MAX_NAMES).map((member) => `${member.characterName}（<@${member.userId}>）`);
  const obLines = session.ob.slice(0, MAX_NAMES).map((member) => `<@${member.userId}>`);
  const klMore = session.kl.length > MAX_NAMES ? `\n…还有 ${session.kl.length - MAX_NAMES} 人` : "";
  const obMore = session.ob.length > MAX_NAMES ? `\n…还有 ${session.ob.length - MAX_NAMES} 人` : "";
  return {
    kl: klLines.length ? `${klLines.join("\n")}${klMore}` : "还没有人",
    ob: obLines.length ? `${obLines.join("\n")}${obMore}` : "还没有人",
  };
}

function button(customId, label, style) {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
}

export function recruitComponents(sessionId, disabled = false) {
  const row1 = new ActionRowBuilder().addComponents(
    button(buildCustomId("kl", sessionId), "🎭 报名 KL", ButtonStyle.Primary).setDisabled(disabled),
    button(buildCustomId("ob", sessionId), "👁 报名 OB", ButtonStyle.Secondary).setDisabled(disabled),
    button(buildCustomId("leave", sessionId), "↩ 取消报名", ButtonStyle.Secondary).setDisabled(disabled),
  );
  const row2 = new ActionRowBuilder().addComponents(
    button(buildCustomId("start", sessionId), "🎲 正式开始", ButtonStyle.Success).setDisabled(disabled),
    button(buildCustomId("abort", sessionId), "✖ 取消开团", ButtonStyle.Danger).setDisabled(disabled),
  );
  return [row1, row2];
}

export function recruitPanel(session, disabled = false) {
  const names = namesBlock(session);
  return {
    embeds: [{
      color: PANEL_COLOR,
      title: "🎲 CoC 跑团招募",
      description: [
        `模组：${session.title}`,
        `KP：<@${session.kpUserId}>`,
        "",
        `🎭 KL 调查员：${session.kl.length}人`,
        names.kl,
        "",
        `👁 OB 旁观者：${session.ob.length}人`,
        names.ob,
        "",
        disabled ? "报名已结束。" : "等待报名中……",
      ].join("\n"),
    }],
    components: recruitComponents(session.sessionId, disabled),
  };
}

export function startedPanel(session) {
  return {
    embeds: [{
      color: PANEL_COLOR,
      title: `🎲 《${session.title}》已经开团`,
      description: [
        `KP：<@${session.kpUserId}>`,
        "",
        `🎭 KL：${session.kl.length}人`,
        `👁 OB：${session.ob.length}人`,
        "",
        "报名已结束。",
      ].join("\n"),
    }],
    components: recruitComponents(session.sessionId, true),
  };
}

export function cancelledPanel(session) {
  return {
    embeds: [{
      color: PANEL_COLOR,
      title: `《${session.title}》招募已取消。`,
      description: `KP：<@${session.kpUserId}>`,
    }],
    components: recruitComponents(session.sessionId, true),
  };
}

export function controlPanel(session) {
  return {
    embeds: [{
      color: PANEL_COLOR,
      title: `🎲 《${session.title}》`,
      description: [
        `KP：<@${session.kpUserId}>`,
        `KL：${session.kl.length}人`,
        `OB：${session.ob.length}人`,
        "",
        "跑团已开始。",
      ].join("\n"),
    }],
    components: [
      new ActionRowBuilder().addComponents(
        button(buildCustomId("end", session.sessionId), "🛑 结束本局", ButtonStyle.Danger),
      ),
    ],
  };
}

export function endedNotice(title) {
  return [
    "🎲 本局已经结束。",
    "",
    "本频道将在48小时后自动删除。",
    "请在此之前保存需要保留的内容。",
    "",
    `《${title}》`,
  ].join("\n");
}

export function confirmRow(action, sessionId, confirmLabel, backLabel) {
  return new ActionRowBuilder().addComponents(
    button(buildCustomId(action, sessionId), confirmLabel, ButtonStyle.Danger),
    button(buildCustomId(`back-${action}`, sessionId), backLabel, ButtonStyle.Secondary),
  );
}

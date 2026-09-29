import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { obSeatLabel } from "./memberQuery.js";

export const COC_CUSTOM_PREFIX = "coc:v1";
export const PANEL_COLOR = 0x6e4b8b;

const MAX_NAMES = 12;

export function buildCustomId(action, sessionId = "", userId = "") {
  const parts = [COC_CUSTOM_PREFIX, action];
  if (sessionId) parts.push(sessionId);
  if (userId) parts.push(userId);
  const id = parts.join(":");
  if (id.length > 100) return null;
  return id;
}

export function parseCustomId(customId) {
  if (typeof customId !== "string" || !customId.startsWith(`${COC_CUSTOM_PREFIX}:`)) return null;
  const parts = customId.split(":");
  const action = parts[2];
  if (!action) return null;
  return {
    action,
    sessionId: parts[3] ?? null,
    userId: parts[4] ?? null,
  };
}

export function isCocCustomId(customId) {
  return parseCustomId(customId) != null || customId === `${COC_CUSTOM_PREFIX}:modal-open`;
}

function namesBlock(session) {
  const klLines = session.pl.slice(0, MAX_NAMES).map((member) => `${member.characterName}（<@${member.userId}>）`);
  const obLines = session.ob.slice(0, MAX_NAMES).map((member) => `<@${member.userId}>`);
  const klMore = session.pl.length > MAX_NAMES ? `\n…还有 ${session.pl.length - MAX_NAMES} 人` : "";
  const obMore = session.ob.length > MAX_NAMES ? `\n…还有 ${session.ob.length - MAX_NAMES} 人` : "";
  return {
    pl: klLines.length ? `${klLines.join("\n")}${klMore}` : "还没有人",
    ob: obLines.length ? `${obLines.join("\n")}${obMore}` : "还没有人",
  };
}

function button(customId, label, style) {
  return new ButtonBuilder().setCustomId(customId).setLabel(label).setStyle(style);
}

export function recruitComponents(sessionId, disabled = false) {
  const row1 = new ActionRowBuilder().addComponents(
    button(buildCustomId("kl", sessionId), "🎭 报名 PL", ButtonStyle.Primary).setDisabled(disabled),
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
        `🎭 PL 调查员：${session.pl.length}人`,
        names.pl,
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
        `🎭 PL：${session.pl.length}人`,
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

export function controlPanel(session, { transcript = false } = {}) {
  const components = [
    new ActionRowBuilder().addComponents(
      button(buildCustomId("members", session.sessionId), "👥 成员管理", ButtonStyle.Primary),
      button(buildCustomId("end", session.sessionId), "🛑 结束本局", ButtonStyle.Danger),
    ),
  ];
  if (transcript) {
    components.push(new ActionRowBuilder().addComponents(
      button(buildCustomId("privacy", session.sessionId), "团录与隐私", ButtonStyle.Secondary),
    ));
  }
  return {
    embeds: [{
      color: PANEL_COLOR,
      title: `🎲 《${session.title}》`,
      description: [
        `KP：<@${session.kpUserId}>`,
        `PL：${session.pl.length}人`,
        `OB：${session.ob.length}人`,
        "",
        "跑团已开始。",
      ].join("\n"),
    }],
    components,
  };
}

export function transcriptPrivacyPrompt(optedOut, sessionId) {
  if (optedOut) {
    return {
      content: "从现在起，你的发言不会进入本局团录。恢复之后只记新的消息，退出期间的不会补上。",
      components: [
        new ActionRowBuilder().addComponents(
          button(buildCustomId("privacy-on", sessionId), "恢复记录我之后的消息", ButtonStyle.Primary),
        ),
      ],
    };
  }
  return {
    content: "从现在起，你的发言会进入本局团录。若选择不记录，只跳过之后的新消息。",
    components: [
      new ActionRowBuilder().addComponents(
        button(buildCustomId("privacy-off", sessionId), "不记录我之后的消息", ButtonStyle.Secondary),
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

export function memberAdminPanel(session) {
  return {
    content: [
      "👥 本局成员管理",
      "",
      `PL：${session.pl.length}人`,
      `OB：${session.ob.length}人`,
    ].join("\n"),
    components: [
      new ActionRowBuilder().addComponents(
        button(buildCustomId("madd-pl", session.sessionId), "➕ 添加 PL", ButtonStyle.Primary),
        button(buildCustomId("madd-ob", session.sessionId), "👁 添加 OB", ButtonStyle.Secondary),
      ),
      new ActionRowBuilder().addComponents(
        button(buildCustomId("convert", session.sessionId), "🔄 转换身份", ButtonStyle.Secondary),
        button(buildCustomId("kick", session.sessionId), "➖ 移出本局", ButtonStyle.Danger),
      ),
    ],
  };
}

export function memberSearchModal(sessionId, action) {
  const findingPl = action === "modal-find-pl";
  return new ModalBuilder()
    .setCustomId(buildCustomId(action, sessionId))
    .setTitle(findingPl ? "搜索要加入的 PL" : "搜索要加入的 OB")
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("query")
        .setLabel("名字开头，或 Discord 用户 ID")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(32)
        .setPlaceholder("例如 奈 或 damantou"),
    ));
}

export function memberSearchResults(sessionId, action, members) {
  return {
    content: members.length >= 25
      ? "找到太多人了。请把开头写得更长一些，再搜一次。"
      : `找到 ${members.length} 人。选中后再继续。`,
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(buildCustomId(action, sessionId))
          .setPlaceholder("选择搜索结果")
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(members.map((member) => ({
            label: member.label,
            value: member.userId,
            ...(member.bot ? { description: "机器人，不能加入" } : {}),
          }))),
      ),
    ],
  };
}

export function memberPickPanel(session, action, prompt, profiles = {}) {
  const options = [
    ...session.pl.map((member) => ({
      label: `PL ${member.characterName}`.slice(0, 100),
      value: `pl:${member.userId}`,
    })),
    ...session.ob.map((member) => ({
      label: obSeatLabel({ userId: member.userId, ...(profiles[member.userId] ?? {}) }),
      value: `ob:${member.userId}`,
    })),
  ].slice(0, 25);
  if (options.length === 0) {
    return { content: "本局还没有可以操作的 PL 或 OB。", components: [] };
  }
  return {
    content: prompt,
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(buildCustomId(action, session.sessionId))
          .setPlaceholder("选择本局成员")
          .setMinValues(1)
          .setMaxValues(1)
          .addOptions(options),
      ),
    ],
  };
}

export function confirmRow(action, sessionId, confirmLabel, backLabel, userId = "") {
  return new ActionRowBuilder().addComponents(
    button(buildCustomId(action, sessionId, userId), confirmLabel, ButtonStyle.Danger),
    button(buildCustomId(`back-${action}`, sessionId), backLabel, ButtonStyle.Secondary),
  );
}

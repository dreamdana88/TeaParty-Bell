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
import {
  eligibleSecretPl,
  findSecretThread,
  MAX_SECRET_THREADS,
  removableSecretPl,
  secretThreadsOf,
} from "./sessionRules.js";

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
      button(buildCustomId("secret", session.sessionId), "🔒 秘密交流", ButtonStyle.Secondary),
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

export function secretHubPanel(session, selectedThreadId = null, notice = null) {
  const allThreads = secretThreadsOf(session);
  const atLimit = allThreads.length >= MAX_SECRET_THREADS;
  const threads = allThreads.slice(0, MAX_SECRET_THREADS);
  const selected = threads.find((thread) => thread.threadId === selectedThreadId) ?? null;
  const lines = ["🔒 秘密交流", ""];
  if (notice) lines.push(String(notice), "");
  if (!threads.length) lines.push("尚无秘密子区");
  else {
    lines.push("已有子区");
    if (selected) lines.push(`当前：${selected.name}`);
    if (atLimit) lines.push(`最多 ${MAX_SECRET_THREADS} 个秘密子区。`);
  }
  const components = [];
  if (threads.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(buildCustomId("s-pick", session.sessionId))
        .setPlaceholder("选择子区……")
        .setMinValues(1)
        .setMaxValues(1)
        .addOptions(threads.map((thread) => ({
          label: thread.name.slice(0, 100),
          value: thread.threadId,
          default: thread.threadId === selected?.threadId,
        }))),
    ));
  }
  components.push(new ActionRowBuilder().addComponents(
    button(buildCustomId("s-add", session.sessionId), "＋ 添加子区", ButtonStyle.Primary).setDisabled(atLimit),
    button(buildCustomId("s-mem", session.sessionId, selected?.threadId ?? ""), "管理参与者", ButtonStyle.Secondary)
      .setDisabled(!selected),
  ));
  return { content: lines.join("\n"), components };
}

export function secretThreadModal(sessionId) {
  return new ModalBuilder()
    .setCustomId(buildCustomId("s-modal", sessionId))
    .setTitle("添加秘密子区")
    .addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder()
        .setCustomId("name")
        .setLabel("子区名称")
        .setStyle(TextInputStyle.Short)
        .setRequired(true)
        .setMaxLength(100),
    ));
}

export function secretCreatePlPanel(session) {
  const options = (session.pl ?? []).slice(0, 25).map((member) => ({
    label: String(member.characterName ?? "PL").slice(0, 100),
    value: member.userId,
  }));
  const components = [];
  if (options.length) {
    components.push(new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId(buildCustomId("s-pls", session.sessionId))
        .setPlaceholder("选择要加入的本团 PL")
        .setMinValues(1)
        .setMaxValues(Math.min(25, options.length))
        .addOptions(options),
    ));
  }
  components.push(new ActionRowBuilder().addComponents(
    button(buildCustomId("s-only", session.sessionId), "仅 KP 与 OB", ButtonStyle.Secondary),
  ));
  return {
    content: options.length
      ? "选择要加入这个秘密子区的本团 PL。本团 KP 和 OB 会自动加入。"
      : "当前没有可选的本团 PL。将只加入 KP 与本团 OB。",
    components,
  };
}

export function secretMembersPanel(session, threadId) {
  const thread = findSecretThread(session, threadId);
  if (!thread) {
    return { content: "没有找到这个秘密子区。", components: [] };
  }
  const plNames = thread.plUserIds.map((userId) => {
    const member = session.pl.find((item) => item.userId === userId);
    return member ? `${member.characterName}（<@${userId}>）` : `<@${userId}>`;
  });
  const obLines = (session.ob ?? []).map((member) => `<@${member.userId}>`);
  return {
    content: [
      `🔒 ${thread.name}`,
      "",
      "参与名单",
      `KP：<@${session.kpUserId}>`,
      `PL：${plNames.length ? plNames.join("、") : "无"}`,
      `OB：${obLines.length ? obLines.join("、") : "无"}`,
    ].join("\n"),
    components: [
      new ActionRowBuilder().addComponents(
        button(buildCustomId("s-apl", session.sessionId, thread.threadId), "增补 PL", ButtonStyle.Primary),
        button(buildCustomId("s-rpl", session.sessionId, thread.threadId), "移除 PL", ButtonStyle.Danger),
      ),
      new ActionRowBuilder().addComponents(
        button(buildCustomId("s-back", session.sessionId, thread.threadId), "返回", ButtonStyle.Secondary),
      ),
    ],
  };
}

export function secretPickPlPanel(session, threadId, action, prompt) {
  const thread = findSecretThread(session, threadId);
  const members = action === "s-apls"
    ? eligibleSecretPl(session, thread)
    : removableSecretPl(session, thread).map((userId) => (
      session.pl.find((member) => member.userId === userId) ?? { userId, characterName: "PL" }
    ));
  const options = members.slice(0, 25).map((member) => ({
    label: String(member.characterName ?? "PL").slice(0, 100),
    value: member.userId,
  }));
  if (!options.length) {
    return {
      content: action === "s-apls" ? "没有可以增补的本团 PL。" : "没有可以移除的 PL。",
      components: [],
    };
  }
  return {
    content: prompt,
    components: [
      new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId(buildCustomId(action, session.sessionId, threadId))
          .setPlaceholder("选择本团 PL")
          .setMinValues(1)
          .setMaxValues(Math.min(25, options.length))
          .addOptions(options),
      ),
    ],
  };
}

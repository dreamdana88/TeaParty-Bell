import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder } from "discord.js";
import { fileURLToPath } from "node:url";
import { buildCustomId } from "./panel.js";

export function archiveCommandPanel(imagePath = fileURLToPath(new URL("../../resources/coc/archive-banner.png", import.meta.url))) {
  return {
    allowedMentions: { parse: [] },
    embeds: [new EmbedBuilder().setColor(0x78383f)
      .setImage("attachment://archive-banner.png"),
      new EmbedBuilder().setColor(0x78383f).setDescription("**点击按钮前往档案馆创建/管理角色**")],
    files: [new AttachmentBuilder(imagePath, { name: "archive-banner.png" })],
    components: [new ActionRowBuilder().addComponents(new ButtonBuilder()
      .setLabel("前往档案馆").setStyle(ButtonStyle.Link).setURL("https://coc.dreamdana.baby"))],
  };
}

export function archiveEntry(url, content = "打开调查员档案馆创建或管理角色卡；未登录时请先完成 Discord 授权。") {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
  } catch { return { content: "档案馆网址尚未配置，请联系管理员。", components: [] }; }
  return { content, allowedMentions: { parse: [] }, components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("打开档案馆 · 建卡").setStyle(ButtonStyle.Link).setURL(url),
  )] };
}

export function characterChoices(sessionId, userId, cards, page = 0, invitationId) {
  const last = Math.max(0, Math.ceil(cards.length / 25) - 1);
  const current = Math.min(last, Math.max(0, page));
  const components = [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(buildCustomId("pick-invited-character", sessionId, invitationId))
    .setPlaceholder("选择本次跑团的调查员")
    .addOptions(cards.slice(current * 25, (current + 1) * 25).map((card) => ({
      label: (card.name || "未命名调查员").slice(0, 100), value: card.id,
      description: `${card.occupation || "职业未填写"} · ${card.era || "时代未填写"}`.slice(0, 100),
    }))))];
  if (last > 0) components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(buildCustomId(`invited-page-${current - 1}`, sessionId, invitationId))
      .setLabel("上一页").setStyle(ButtonStyle.Secondary).setDisabled(current === 0),
    new ButtonBuilder().setCustomId(buildCustomId(`invited-page-${current + 1}`, sessionId, invitationId))
      .setLabel("下一页").setStyle(ButtonStyle.Secondary).setDisabled(current === last),
  ));
  if (invitationId) components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(buildCustomId("invite-cancel", sessionId, invitationId)).setLabel("取消选卡").setStyle(ButtonStyle.Secondary),
  ));
  return { content: `请选择你自己的调查员（第 ${current + 1}/${last + 1} 页）。`, allowedMentions: { parse: [] }, components };
}

export function characterInvitation(sessionId, invitation) {
  return { content: `<@${invitation.targetUserId}>，请选择本局调查员。只有你本人可以选卡；你或 KP 可以取消邀请。`,
    allowedMentions: { users: [invitation.targetUserId], parse: [] },
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(buildCustomId("invite-open", sessionId, invitation.id)).setLabel("选择调查员").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId(buildCustomId("invite-cancel", sessionId, invitation.id)).setLabel("取消邀请").setStyle(ButtonStyle.Secondary),
    )] };
}

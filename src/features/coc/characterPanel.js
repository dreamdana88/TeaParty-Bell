import { ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder } from "discord.js";
import { buildCustomId } from "./panel.js";

export function archiveEntry(url, content = "打开调查员档案馆创建或管理角色卡；未登录时请先完成 Discord 授权。") {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
  } catch { return { content: "档案馆网址尚未配置，请联系管理员。", components: [] }; }
  return { content, allowedMentions: { parse: [] }, components: [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setLabel("打开档案馆 · 建卡").setStyle(ButtonStyle.Link).setURL(url),
  )] };
}

export function characterChoices(sessionId, userId, cards, page = 0) {
  const last = Math.max(0, Math.ceil(cards.length / 25) - 1);
  const current = Math.min(last, Math.max(0, page));
  const components = [new ActionRowBuilder().addComponents(new StringSelectMenuBuilder()
    .setCustomId(buildCustomId("pick-character", sessionId, userId))
    .setPlaceholder("选择本次跑团的调查员")
    .addOptions(cards.slice(current * 25, (current + 1) * 25).map((card) => ({
      label: (card.name || "未命名调查员").slice(0, 100), value: card.id,
      description: `${card.occupation || "职业未填写"} · ${card.era || "时代未填写"}`.slice(0, 100),
    }))))];
  if (last > 0) components.push(new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(buildCustomId(`cards-page-${current - 1}`, sessionId, userId))
      .setLabel("上一页").setStyle(ButtonStyle.Secondary).setDisabled(current === 0),
    new ButtonBuilder().setCustomId(buildCustomId(`cards-page-${current + 1}`, sessionId, userId))
      .setLabel("下一页").setStyle(ButtonStyle.Secondary).setDisabled(current === last),
  ));
  return { content: `请选择你自己的调查员（第 ${current + 1}/${last + 1} 页）。`, allowedMentions: { parse: [] }, components };
}

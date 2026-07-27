import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

export const MANUAL_REPLY_MODAL_PREFIX = "manual:v1:reply";
export const MANUAL_REPLY_CONTENT_CUSTOM_ID = "content";
export const MANUAL_REPLY_MODAL_TITLE = "让小G宝回复";

// Discord Snowflake 为无符号十进制整数；当前 Discord ID 长度为 17–20 位。
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

export function isSnowflake(value) {
  return typeof value === "string" && SNOWFLAKE_PATTERN.test(value);
}

export function createReplyModalCustomId(channelId, targetMessageId) {
  if (!isSnowflake(channelId) || !isSnowflake(targetMessageId)) {
    return null;
  }
  return `${MANUAL_REPLY_MODAL_PREFIX}:${channelId}:${targetMessageId}`;
}

/**
 * 严格解析人工回复 Modal 的上下文，不接受额外字段或非 Snowflake 值。
 * @returns {{channelId: string, targetMessageId: string}|null}
 */
export function parseReplyModalCustomId(customId) {
  if (typeof customId !== "string") return null;
  const parts = customId.split(":");
  if (parts.length !== 5) return null;
  if (parts.slice(0, 3).join(":") !== MANUAL_REPLY_MODAL_PREFIX) return null;
  if (!isSnowflake(parts[3]) || !isSnowflake(parts[4])) return null;
  return { channelId: parts[3], targetMessageId: parts[4] };
}

export function buildReplyModal({ channelId, targetMessageId }) {
  const customId = createReplyModalCustomId(channelId, targetMessageId);
  if (!customId) return null;

  const contentInput = new TextInputBuilder()
    .setCustomId(MANUAL_REPLY_CONTENT_CUSTOM_ID)
    .setLabel("回复内容")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(2000);

  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(MANUAL_REPLY_MODAL_TITLE)
    .addComponents(new ActionRowBuilder().addComponents(contentInput));
}

import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";

export const MANUAL_REPLY_MODAL_PREFIX = "manual:v1:reply";
export const MANUAL_SEND_MODAL_PREFIX = "manual:v1:send";
export const MANUAL_REPLY_CONTENT_CUSTOM_ID = "content";
export const MANUAL_SEND_CONTENT_CUSTOM_ID = "content";
export const MAX_MODAL_CUSTOM_ID_LENGTH = 100;
export const MANUAL_REPLY_MODAL_TITLE = "让小G宝回复";
export const MANUAL_SEND_MODAL_TITLE = "让小G宝发言";

// Discord Snowflake 为无符号十进制整数；当前 Discord ID 长度为 17–20 位。
const SNOWFLAKE_PATTERN = /^\d{17,20}$/;

export function isSnowflake(value) {
  return typeof value === "string" && SNOWFLAKE_PATTERN.test(value);
}

function isValidCustomId(customId) {
  return typeof customId === "string"
    && customId.length > 0
    && customId.length <= MAX_MODAL_CUSTOM_ID_LENGTH;
}

export function createReplyModalCustomId(channelId, targetMessageId) {
  if (!isSnowflake(channelId) || !isSnowflake(targetMessageId)) return null;
  const customId = `${MANUAL_REPLY_MODAL_PREFIX}:${channelId}:${targetMessageId}`;
  return customId.length <= MAX_MODAL_CUSTOM_ID_LENGTH ? customId : null;
}

export function createSendModalCustomId(channelId) {
  if (!isSnowflake(channelId)) return null;
  const customId = `${MANUAL_SEND_MODAL_PREFIX}:${channelId}`;
  return customId.length <= MAX_MODAL_CUSTOM_ID_LENGTH ? customId : null;
}

/**
 * 严格解析人工发言 Modal 上下文。
 * @returns {{version: "v1", action: "send"|"reply", channelId: string, targetMessageId?: string}|null}
 */
export function parseManualModalContext(customId) {
  if (!isValidCustomId(customId)) return null;
  const parts = customId.split(":");
  if (parts[0] !== "manual" || parts[1] !== "v1") return null;

  if (parts[2] === "send") {
    if (parts.length !== 4 || !isSnowflake(parts[3])) return null;
    return { version: "v1", action: "send", channelId: parts[3] };
  }

  if (parts[2] === "reply") {
    if (parts.length !== 5 || !isSnowflake(parts[3]) || !isSnowflake(parts[4])) return null;
    return {
      version: "v1",
      action: "reply",
      channelId: parts[3],
      targetMessageId: parts[4],
    };
  }

  return null;
}

/**
 * 保持 Stage B-2 的 Reply 解析返回形状。
 * @returns {{channelId: string, targetMessageId: string}|null}
 */
export function parseReplyModalCustomId(customId) {
  const context = parseManualModalContext(customId);
  if (!context || context.action !== "reply") return null;
  return { channelId: context.channelId, targetMessageId: context.targetMessageId };
}

/**
 * @returns {{channelId: string}|null}
 */
export function parseSendModalCustomId(customId) {
  const context = parseManualModalContext(customId);
  if (!context || context.action !== "send") return null;
  return { channelId: context.channelId };
}

function buildContentModal({ customId, title, label }) {
  if (!customId) return null;
  const contentInput = new TextInputBuilder()
    .setCustomId("content")
    .setLabel(label)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(2000);

  return new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title)
    .addComponents(new ActionRowBuilder().addComponents(contentInput));
}

export function buildReplyModal({ channelId, targetMessageId }) {
  return buildContentModal({
    customId: createReplyModalCustomId(channelId, targetMessageId),
    title: MANUAL_REPLY_MODAL_TITLE,
    label: "回复内容",
  });
}

export function buildSendModal({ channelId }) {
  return buildContentModal({
    customId: createSendModalCustomId(channelId),
    title: MANUAL_SEND_MODAL_TITLE,
    label: "发言内容",
  });
}

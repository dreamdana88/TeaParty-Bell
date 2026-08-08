/**
 * Manual Message Service：管理员人工发言的共享业务核心。
 *
 * 本模块不注册 Discord Interaction，不连接 Hermes，也不触碰 Boost 状态。
 */

import {
  ChannelType,
  PermissionFlagsBits,
} from "discord.js";
import { logger as defaultLogger } from "../../utils/logger.js";
import {
  MANUAL_MESSAGE_SOURCES,
  ManualMessageError,
  createManualMessageError,
  isManualMessageError,
} from "./errors.js";
import {
  countContentCharacters,
  validateManualContent,
} from "./contentPolicy.js";
import { validateManualMentions } from "./manualMentionPolicy.js";
import { createManualMessageAudit } from "./audit.js";

const ALLOWED_CHANNEL_TYPES = new Set([
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]);

const THREAD_CHANNEL_TYPES = new Set([
  ChannelType.PublicThread,
  ChannelType.PrivateThread,
  ChannelType.AnnouncementThread,
]);

const UNKNOWN_CHANNEL_CODE = 10003;
const UNKNOWN_MESSAGE_CODE = 10008;
const MISSING_ACCESS_CODE = 50001;
const MISSING_PERMISSION_CODE = 50013;
const MISSING_PERMISSION_CODES = new Set([MISSING_ACCESS_CODE, MISSING_PERMISSION_CODE]);

function getAllowedGuildId(config) {
  return config?.discordGuildId ?? config?.discord?.guildId ?? null;
}

function getChannelGuildId(channel) {
  return channel?.guildId ?? channel?.guild?.id ?? null;
}

function isUnknownMessage(error) {
  return error?.code === UNKNOWN_MESSAGE_CODE;
}

function getSafeDiscordErrorMeta(error) {
  return {
    errorName: typeof error?.name === "string" && error.name.length > 0 ? error.name : "Error",
    discordCode: error?.code ?? null,
    errorMessage: typeof error?.message === "string" ? error.message : String(error),
  };
}

function logDiscordError(logger, operation, error) {
  try {
    logger?.warn?.(`[ManualMessage] ${operation}`, getSafeDiscordErrorMeta(error));
  } catch {
    // 诊断日志不可用时不能改变业务错误分类或发送结果。
  }
}

function safeAudit(audit, entry) {
  try {
    audit?.record?.(entry);
  } catch {
    // 审计实现已经自我隔离；注入的测试审计也不能改变发送结果。
  }
}

function messageIdOrThrow(message, action) {
  if (message && typeof message.id === "string" && message.id.length > 0) {
    return message.id;
  }
  throw createManualMessageError(action === "send" ? "SEND_FAILED" : "REPLY_FAILED");
}

export function createManualMessageService({
  client,
  config,
  logger = defaultLogger,
  audit = createManualMessageAudit({ logger }),
} = {}) {
  if (!client) throw new TypeError("createManualMessageService 需要 client");

  const allowedGuildId = getAllowedGuildId(config);

  function validateActor(actor) {
    if (!actor || typeof actor !== "object" || Array.isArray(actor)) {
      throw createManualMessageError("INVALID_ACTOR");
    }
    if (typeof actor.id !== "string" || actor.id.trim().length === 0) {
      throw createManualMessageError("INVALID_ACTOR");
    }
    if (actor.username !== undefined && typeof actor.username !== "string") {
      throw createManualMessageError("INVALID_ACTOR");
    }
    if (actor.displayName !== undefined && typeof actor.displayName !== "string") {
      throw createManualMessageError("INVALID_ACTOR");
    }
  }

  function getAuditActor(actor) {
    return {
      id: actor && typeof actor.id === "string" && actor.id.trim().length > 0
        ? actor.id
        : "unknown",
      username: actor && typeof actor.username === "string" ? actor.username : undefined,
      displayName: actor && typeof actor.displayName === "string" ? actor.displayName : undefined,
    };
  }

  function validateRequest({ guildId, source, actor }) {
    if (!MANUAL_MESSAGE_SOURCES.includes(source)) {
      throw createManualMessageError("INVALID_SOURCE");
    }
    validateActor(actor);
    if (!guildId || guildId !== allowedGuildId) {
      throw createManualMessageError("WRONG_GUILD");
    }
  }

  async function fetchChannel(channelId) {
    if (!channelId || !client.channels?.fetch) {
      throw createManualMessageError("CHANNEL_NOT_FOUND");
    }

    let channel;
    try {
      channel = await client.channels.fetch(channelId);
    } catch (error) {
      logDiscordError(logger, "channel fetch failed", error);
      if (error?.code === UNKNOWN_CHANNEL_CODE) {
        throw createManualMessageError("CHANNEL_NOT_FOUND", error);
      }
      if (MISSING_PERMISSION_CODES.has(error?.code)) {
        throw createManualMessageError("BOT_MISSING_PERMISSION", error);
      }
      throw createManualMessageError("CHANNEL_FETCH_FAILED", error);
    }

    if (!channel) {
      throw createManualMessageError("CHANNEL_NOT_FOUND");
    }
    return channel;
  }

  function validateChannel(channel, guildId) {
    if (getChannelGuildId(channel) !== guildId) {
      throw createManualMessageError("WRONG_GUILD");
    }
    if (!ALLOWED_CHANNEL_TYPES.has(channel.type)) {
      throw createManualMessageError("WRONG_CHANNEL_TYPE");
    }
  }

  function validatePermissions(channel, action) {
    if (!client.user || typeof channel.permissionsFor !== "function") {
      throw createManualMessageError("BOT_MISSING_PERMISSION");
    }

    let permissions;
    try {
      permissions = channel.permissionsFor(client.user);
    } catch (error) {
      throw createManualMessageError("BOT_MISSING_PERMISSION", error);
    }
    if (!permissions || typeof permissions.has !== "function") {
      throw createManualMessageError("BOT_MISSING_PERMISSION");
    }

    if (
      THREAD_CHANNEL_TYPES.has(channel.type) &&
      channel.locked === true &&
      !permissions.has(PermissionFlagsBits.ManageThreads)
    ) {
      throw createManualMessageError("THREAD_LOCKED");
    }

    const required = [PermissionFlagsBits.ViewChannel];
    if (THREAD_CHANNEL_TYPES.has(channel.type)) {
      required.push(PermissionFlagsBits.SendMessagesInThreads);
    } else {
      required.push(PermissionFlagsBits.SendMessages);
    }
    if (action === "reply") {
      required.push(PermissionFlagsBits.ReadMessageHistory);
    }

    const missing = required.filter((permission) => !permissions.has(permission));
    if (missing.length > 0) {
      throw createManualMessageError("BOT_MISSING_PERMISSION", new Error("missing Discord permissions"));
    }
  }

  async function prepare({ action, guildId, channelId, content, actor, source }) {
    validateRequest({ guildId, source, actor });
    const contentPolicy = validateManualContent(content);
    const channel = await fetchChannel(channelId);
    validateChannel(channel, guildId);
    validatePermissions(channel, action);
    const guild = channel.guild ?? client.guilds?.cache?.get?.(guildId) ?? null;
    const mentionPolicy = await validateManualMentions(contentPolicy.content, { guild, guildId });
    return { contentPolicy, mentionPolicy, channel };
  }

  async function run(action, params, operation) {
    const auditActor = getAuditActor(params?.actor);
    const auditContext = {
      action,
      source: params?.source,
      actor: auditActor,
      actorId: auditActor.id,
      actorUsername: auditActor.username,
      actorDisplayName: auditActor.displayName,
      guildId: params?.guildId,
      channelId: params?.channelId,
      targetMessageId: action === "reply" ? params?.targetMessageId : null,
      contentLength: countContentCharacters(params?.content),
    };

    try {
      const result = await operation();
      safeAudit(audit, {
        ...auditContext,
        sentMessageId: result.messageId,
        success: true,
        errorCode: null,
      });
      return result;
    } catch (error) {
      const normalized = isManualMessageError(error)
        ? error
        : new ManualMessageError(
          action === "send" ? "SEND_FAILED" : "REPLY_FAILED",
          undefined,
          error,
        );
      safeAudit(audit, {
        ...auditContext,
        sentMessageId: null,
        success: false,
        errorCode: normalized.code,
      });
      throw normalized;
    }
  }

  async function send(params = {}) {
    return run("send", params, async () => {
      const { contentPolicy, mentionPolicy, channel } = await prepare({ action: "send", ...params });
      let sentMessage;
      try {
        sentMessage = await channel.send({
          content: contentPolicy.content,
          allowedMentions: mentionPolicy.allowedMentions,
        });
      } catch (error) {
        logDiscordError(logger, "send failed", error);
        throw createManualMessageError("SEND_FAILED", error);
      }
      return {
        messageId: messageIdOrThrow(sentMessage, "send"),
        guildId: params.guildId,
        channelId: params.channelId,
        action: "send",
      };
    });
  }

  async function reply(params = {}) {
    return run("reply", params, async () => {
      const { contentPolicy, mentionPolicy, channel } = await prepare({ action: "reply", ...params });
      if (!params.targetMessageId || !channel.messages?.fetch) {
        throw createManualMessageError("TARGET_MESSAGE_NOT_FOUND");
      }

      let targetMessage;
      try {
        targetMessage = await channel.messages.fetch(params.targetMessageId);
      } catch (error) {
        logDiscordError(logger, "target message fetch failed", error);
        if (isUnknownMessage(error)) {
          throw createManualMessageError("TARGET_MESSAGE_NOT_FOUND", error);
        }
        if (MISSING_PERMISSION_CODES.has(error?.code)) {
          throw createManualMessageError("BOT_MISSING_PERMISSION", error);
        }
        throw createManualMessageError("TARGET_MESSAGE_FETCH_FAILED", error);
      }

      if (!targetMessage) {
        throw createManualMessageError("TARGET_MESSAGE_NOT_FOUND");
      }
      if (getChannelGuildId(targetMessage) !== params.guildId) {
        throw createManualMessageError("WRONG_GUILD");
      }
      const targetChannelId = targetMessage.channelId ?? targetMessage.channel?.id ?? null;
      if (targetChannelId !== params.channelId) {
        throw createManualMessageError("TARGET_MESSAGE_NOT_FOUND");
      }
      if (typeof targetMessage.reply !== "function") {
        throw createManualMessageError("REPLY_FAILED");
      }

      let sentMessage;
      try {
        sentMessage = await targetMessage.reply({
          content: contentPolicy.content,
          allowedMentions: mentionPolicy.allowedMentions,
        });
      } catch (error) {
        logDiscordError(logger, "reply failed", error);
        if (isUnknownMessage(error)) {
          throw createManualMessageError("TARGET_MESSAGE_NOT_FOUND", error);
        }
        throw createManualMessageError("REPLY_FAILED", error);
      }

      return {
        messageId: messageIdOrThrow(sentMessage, "reply"),
        guildId: params.guildId,
        channelId: params.channelId,
        action: "reply",
      };
    });
  }

  return { send, reply };
}

export const MANUAL_MESSAGE_CHANNEL_TYPES = Object.freeze([...ALLOWED_CHANNEL_TYPES]);
export const MANUAL_MESSAGE_THREAD_TYPES = Object.freeze([...THREAD_CHANNEL_TYPES]);

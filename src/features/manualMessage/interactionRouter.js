import { Events, PermissionFlagsBits } from "discord.js";
import { logger as defaultLogger } from "../../utils/logger.js";
import { isManualMessageError } from "./errors.js";
import { MANUAL_REPLY_COMMAND_NAME } from "./commands.js";
import {
  buildReplyModal,
  parseReplyModalCustomId,
  MANUAL_REPLY_MODAL_PREFIX,
} from "./modalContext.js";

const DEFAULT_HANDLED_INTERACTION_TTL_MS = 10 * 60 * 1000;
const REPLY_SUCCESS_MESSAGE = "小G宝已经回复这条消息。";
const DUPLICATE_MESSAGE = "该操作已经处理。";
const INVALID_CONTEXT_MESSAGE = "该操作已失效，请重新打开。";
const GENERIC_FAILURE_MESSAGE = "处理人工回复失败，请稍后重试。";
const NOT_IN_GUILD_MESSAGE = "该操作只能在服务器内使用。";
const WRONG_GUILD_MESSAGE = "该操作不能用于当前服务器。";
const NOT_ADMIN_MESSAGE = "只有管理员可以使用该操作。";
const SAFE_ROUTER_ERROR_MESSAGE = "Interaction Router operation failed.";

function safeErrorFields(error) {
  const fields = {
    errorName: typeof error?.name === "string" ? error.name : "Error",
  };
  if (isManualMessageError(error)) {
    fields.errorCode = error.code;
    const discordCode = error.discordCode ?? error.cause?.code;
    if (discordCode !== undefined && discordCode !== null) fields.discordCode = discordCode;
    return fields;
  }
  if (error?.code !== undefined && error?.code !== null) fields.discordCode = error.code;
  fields.errorMessage = SAFE_ROUTER_ERROR_MESSAGE;
  return fields;
}

function isRecognizedContextMenu(interaction) {
  return typeof interaction?.isMessageContextMenuCommand === "function"
    && interaction.isMessageContextMenuCommand()
    && interaction.commandName === MANUAL_REPLY_COMMAND_NAME;
}

function isRecognizedModal(interaction) {
  const customId = interaction?.customId;
  return typeof interaction?.isModalSubmit === "function"
    && interaction.isModalSubmit()
    && typeof customId === "string"
    && (customId === MANUAL_REPLY_MODAL_PREFIX || customId.startsWith(`${MANUAL_REPLY_MODAL_PREFIX}:`));
}

export function createManualInteractionRouter({
  client,
  manualMessageService,
  guildId,
  logger = defaultLogger,
  now = () => Date.now(),
  handledInteractionTtlMs = DEFAULT_HANDLED_INTERACTION_TTL_MS,
} = {}) {
  if (!client || typeof client.on !== "function") {
    throw new TypeError("client must provide on()");
  }
  if (!manualMessageService || typeof manualMessageService.reply !== "function") {
    throw new TypeError("manualMessageService must provide reply()");
  }

  const getNow = typeof now === "function" ? now : () => Date.now();
  const ttl = Number.isFinite(handledInteractionTtlMs) && handledInteractionTtlMs > 0
    ? handledInteractionTtlMs
    : DEFAULT_HANDLED_INTERACTION_TTL_MS;
  const handledInteractions = new Map();
  let started = false;

  function interactionMeta(interaction, extra = {}) {
    return {
      interactionId: interaction?.id ?? null,
      interactionType: interaction?.type ?? null,
      commandName: interaction?.commandName ?? null,
      guildId: interaction?.guildId ?? null,
      channelId: interaction?.channelId ?? null,
      targetMessageId: interaction?.targetId ?? null,
      actorId: interaction?.user?.id ?? null,
      ...extra,
    };
  }

  function log(level, message, interaction, extra = {}) {
    const method = typeof logger?.[level] === "function"
      ? logger[level]
      : logger?.warn;
    if (typeof method !== "function") return;
    try {
      method.call(logger, `[ManualMessageRouter] ${message}`, interactionMeta(interaction, extra));
    } catch {
      // 日志设施失败不能让 Interaction 处理流程崩溃。
    }
  }

  function cleanupHandled() {
    const current = getNow();
    for (const [interactionId, expiresAt] of handledInteractions) {
      if (expiresAt <= current) handledInteractions.delete(interactionId);
    }
  }

  function claimInteraction(interaction) {
    const interactionId = interaction?.id;
    if (typeof interactionId !== "string" || interactionId.trim().length === 0) {
      return false;
    }
    cleanupHandled();
    const current = getNow();
    const expiresAt = handledInteractions.get(interactionId);
    if (expiresAt !== undefined && expiresAt > current) return false;
    handledInteractions.set(interactionId, current + ttl);
    return true;
  }

  function accessFailure(interaction) {
    let inGuild = false;
    try {
      inGuild = interaction?.inGuild?.() === true;
    } catch (error) {
      log("warn", "无法判断 Interaction 是否来自 Guild", interaction, safeErrorFields(error));
    }
    if (!inGuild) return { code: "NOT_IN_GUILD", message: NOT_IN_GUILD_MESSAGE };
    if (interaction.guildId !== guildId) {
      return { code: "WRONG_GUILD", message: WRONG_GUILD_MESSAGE };
    }

    let isAdmin = false;
    try {
      isAdmin = interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator) === true;
    } catch (error) {
      log("warn", "无法判断 Interaction 管理员权限", interaction, safeErrorFields(error));
    }
    if (!isAdmin) return { code: "NOT_ADMIN", message: NOT_ADMIN_MESSAGE };
    return null;
  }

  async function respondEphemeral(interaction, content) {
    try {
      if (interaction?.deferred && typeof interaction.editReply === "function") {
        return await interaction.editReply({ content });
      }
      if (interaction?.replied && typeof interaction.followUp === "function") {
        return await interaction.followUp({ content, ephemeral: true });
      }
      if (typeof interaction?.reply === "function") {
        return await interaction.reply({ content, ephemeral: true });
      }
    } catch (error) {
      log("warn", "Interaction 响应失败", interaction, safeErrorFields(error));
    }
    return undefined;
  }

  async function handleContextMenu(interaction) {
    if (!claimInteraction(interaction)) {
      await respondEphemeral(interaction, DUPLICATE_MESSAGE);
      return;
    }

    const failure = accessFailure(interaction);
    if (failure) {
      log("warn", `拒绝 Context Menu：${failure.code}`, interaction);
      await respondEphemeral(interaction, failure.message);
      return;
    }

    const modal = buildReplyModal({
      channelId: interaction.channelId,
      targetMessageId: interaction.targetId,
    });
    if (!modal) {
      log("warn", "Context Menu 目标 ID 格式无效", interaction);
      await respondEphemeral(interaction, INVALID_CONTEXT_MESSAGE);
      return;
    }

    try {
      await interaction.showModal(modal);
    } catch (error) {
      log("warn", "打开回复 Modal 失败", interaction, safeErrorFields(error));
      await respondEphemeral(interaction, GENERIC_FAILURE_MESSAGE);
    }
  }

  async function handleModalSubmit(interaction) {
    if (!claimInteraction(interaction)) {
      await respondEphemeral(interaction, DUPLICATE_MESSAGE);
      return;
    }

    const failure = accessFailure(interaction);
    if (failure) {
      log("warn", `拒绝 Modal Submit：${failure.code}`, interaction);
      await respondEphemeral(interaction, failure.message);
      return;
    }

    const context = parseReplyModalCustomId(interaction.customId);
    if (!context) {
      log("warn", "Modal Context 无效", interaction);
      await respondEphemeral(interaction, INVALID_CONTEXT_MESSAGE);
      return;
    }

    let content;
    try {
      content = interaction.fields.getTextInputValue("content");
      await interaction.deferReply({ ephemeral: true });
    } catch (error) {
      log("warn", "读取或确认 Modal Submit 失败", interaction, safeErrorFields(error));
      await respondEphemeral(interaction, GENERIC_FAILURE_MESSAGE);
      return;
    }

    const user = interaction.user ?? {};
    const actor = {
      id: user.id,
      username: user.username,
      displayName: interaction.member?.displayName ?? user.globalName ?? user.username,
    };

    try {
      await manualMessageService.reply({
        guildId: interaction.guildId,
        channelId: context.channelId,
        targetMessageId: context.targetMessageId,
        content,
        actor,
        source: "discord_context_menu",
      });
      await respondEphemeral(interaction, REPLY_SUCCESS_MESSAGE);
    } catch (error) {
      const message = isManualMessageError(error) ? error.safeMessage : GENERIC_FAILURE_MESSAGE;
      log("warn", "Manual Message Service 回复失败", interaction, safeErrorFields(error));
      await respondEphemeral(interaction, message);
    }
  }

  async function dispatch(interaction) {
    if (isRecognizedContextMenu(interaction)) {
      await handleContextMenu(interaction);
      return;
    }
    if (isRecognizedModal(interaction)) {
      await handleModalSubmit(interaction);
    }
  }

  function onInteractionCreate(interaction) {
    if (!started) return;
    cleanupHandled();
    void dispatch(interaction).catch((error) => {
      log("error", "Interaction Router 未捕获异常", interaction, safeErrorFields(error));
      void respondEphemeral(interaction, GENERIC_FAILURE_MESSAGE);
    });
  }

  function start() {
    if (started) return;
    client.on(Events.InteractionCreate, onInteractionCreate);
    started = true;
  }

  function destroy() {
    if (started) {
      if (typeof client.off === "function") client.off(Events.InteractionCreate, onInteractionCreate);
      else if (typeof client.removeListener === "function") client.removeListener(Events.InteractionCreate, onInteractionCreate);
      started = false;
    }
    handledInteractions.clear();
  }

  return { start, destroy };
}

export const MANUAL_INTERACTION_ROUTER_MESSAGES = Object.freeze({
  REPLY_SUCCESS_MESSAGE,
  DUPLICATE_MESSAGE,
  INVALID_CONTEXT_MESSAGE,
});

/**
 * Forum Bump 管理员面板 Interaction Router。
 * 只处理 /顶帖 面板 及本面板 customId；直接调用 Runtime 控制接口。
 *
 * Interaction 3 秒响应：
 * - Slash：立即 deferReply(ephemeral) → editReply
 * - 编辑按钮：无 I/O，立即 showModal（用 session draft）
 * - 暂停/恢复/保存/取消：立即 deferUpdate → editReply
 * - Modal 提交：本地解析，直接 ephemeral reply
 */

import { Events, MessageFlags, PermissionFlagsBits } from "discord.js";
import {
  FORUM_BUMP_PANEL_SUBCOMMAND_NAME,
  FORUM_BUMP_ROOT_COMMAND_NAME,
} from "./commands.js";
import { createForumBumpPanelSessionStore } from "./sessionStore.js";
import {
  CUSTOM_IDS,
  buildConfigModal,
  buildForumSelectPage,
  buildPanelMessage,
  isForumBumpCustomId,
  parseCustomId,
  parseModalFields,
  safeRuntimeErrorMessage,
} from "./panelView.js";

const NOT_IN_GUILD = "该操作只能在服务器内使用。";
const WRONG_GUILD = "该操作不能用于当前服务器。";
const NOT_ADMIN = "只有管理员可以使用该操作。";
const SESSION_EXPIRED = "面板已过期，请重新执行「/顶帖 面板」。";
const SESSION_MISMATCH = "该操作只能由打开面板的管理员继续，请重新打开顶帖面板。";
const REVISION_STALE = "配置已被其他操作更新，请重新打开顶帖面板。";
const GENERIC = "处理顶帖面板失败，请稍后重试。";

function safeErrorFields(error) {
  return {
    errorName: typeof error?.name === "string" ? error.name : "Error",
    errorCode: typeof error?.code === "string" ? error.code : null,
  };
}

/**
 * @param {object} options
 */
export function createForumBumpAdminRouter({
  client,
  guildId,
  forumBumpRuntime,
  logger,
  now = () => Date.now(),
  sessionStore = null,
  /** (ids: string[]) => Promise<Map<string,string>> */
  resolveForumNamesFn = null,
} = {}) {
  if (!client || typeof client.on !== "function") {
    throw new TypeError("createForumBumpAdminRouter 需要 client.on");
  }
  if (typeof guildId !== "string" || !guildId) {
    throw new TypeError("createForumBumpAdminRouter 需要 guildId");
  }
  if (!forumBumpRuntime
    || typeof forumBumpRuntime.getControlSnapshot !== "function") {
    throw new TypeError("createForumBumpAdminRouter 需要 forumBumpRuntime 控制接口");
  }

  const sessions = sessionStore ?? createForumBumpPanelSessionStore({ now });
  let started = false;
  let destroyed = false;

  function log(level, message, extra = {}) {
    try {
      logger?.[level]?.(`[ForumBumpAdminRouter] ${message}`, extra);
    } catch {
      // ignore
    }
  }

  function accessFailure(interaction) {
    let inGuild = false;
    try {
      inGuild = interaction?.inGuild?.() === true;
    } catch {
      inGuild = false;
    }
    if (!inGuild) return { code: "NOT_IN_GUILD", message: NOT_IN_GUILD };
    if (interaction.guildId !== guildId) {
      return { code: "WRONG_GUILD", message: WRONG_GUILD };
    }
    let isAdmin = false;
    try {
      isAdmin = interaction.memberPermissions?.has?.(PermissionFlagsBits.Administrator) === true;
    } catch {
      isAdmin = false;
    }
    if (!isAdmin) return { code: "NOT_ADMIN", message: NOT_ADMIN };
    return null;
  }

  function actorFrom(interaction) {
    const user = interaction?.user ?? {};
    return {
      actorId: user.id ?? null,
      actorTag: interaction?.member?.displayName
        ?? user.globalName
        ?? user.username
        ?? user.id
        ?? "unknown",
      source: "discord_admin_panel",
    };
  }

  function sessionDeniedMessage(code) {
    return code === "SESSION_EXPIRED" ? SESSION_EXPIRED : SESSION_MISMATCH;
  }

  /**
   * 首次 ephemeral reply（未 defer 时）。
   */
  async function replyEphemeral(interaction, payload) {
    if (destroyed) return;
    const data = typeof payload === "string" ? { content: payload } : payload;
    try {
      if (interaction?.deferred || interaction?.replied) {
        await interaction.editReply(data);
        return;
      }
      await interaction.reply({ ...data, flags: MessageFlags.Ephemeral });
    } catch (error) {
      log("warn", "replyEphemeral 失败", safeErrorFields(error));
    }
  }

  /**
   * 已 defer 后更新面板内容。
   */
  async function editReplyPanel(interaction, payload) {
    if (destroyed) return;
    const data = typeof payload === "string" ? { content: payload } : payload;
    try {
      if (typeof interaction.editReply === "function") {
        await interaction.editReply(data);
        return;
      }
    } catch (error) {
      log("warn", "editReply 失败", safeErrorFields(error));
    }
  }

  async function deferReplyEphemeral(interaction) {
    if (interaction?.deferred || interaction?.replied) return true;
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      return true;
    } catch (error) {
      log("warn", "deferReply 失败", safeErrorFields(error));
      return false;
    }
  }

  async function deferUpdateOnce(interaction) {
    if (interaction?.deferred || interaction?.replied) return true;
    try {
      await interaction.deferUpdate();
      return true;
    } catch (error) {
      log("warn", "deferUpdate 失败", safeErrorFields(error));
      return false;
    }
  }

  async function resolveForumNames(ids) {
    if (typeof resolveForumNamesFn === "function") {
      try {
        return await resolveForumNamesFn(ids);
      } catch {
        return new Map();
      }
    }
    const map = new Map();
    if (!client?.channels) return map;
    for (const id of ids ?? []) {
      try {
        let ch = client.channels.cache?.get?.(id);
        if (!ch && typeof client.channels.fetch === "function") {
          ch = await client.channels.fetch(id).catch(() => null);
        }
        if (ch?.name) map.set(id, ch.name);
      } catch {
        // ignore single channel
      }
    }
    return map;
  }

  async function snapshotPanelPayload(sessionId, notice = null) {
    const snap = await forumBumpRuntime.getControlSnapshot();
    const nameMap = await resolveForumNames(snap.forumChannelIds ?? []);
    const message = buildPanelMessage(snap, sessionId, {
      forumNameMap: nameMap,
      notice,
    });
    return { snap, ...message };
  }

  function openSessionFromSnap(snap, actorId) {
    return sessions.createSession({
      actorId,
      guildId,
      dynamicConfigRevision: snap.dynamicConfigRevision ?? 0,
      draft: {
        dailyLimit: snap.dailyLimit,
        activeStart: snap.activeStart,
        activeEnd: snap.activeEnd,
        silenceDays: snap.silenceDays,
        forumChannelIds: snap.forumChannelIds ?? [],
      },
    });
  }

  function isPanelSlash(interaction) {
    return typeof interaction?.isChatInputCommand === "function"
      && interaction.isChatInputCommand()
      && interaction.commandName === FORUM_BUMP_ROOT_COMMAND_NAME
      && interaction.options?.getSubcommand?.(false) === FORUM_BUMP_PANEL_SUBCOMMAND_NAME;
  }

  function isOurComponent(interaction) {
    const id = interaction?.customId;
    if (!isForumBumpCustomId(id)) return false;
    return (
      (typeof interaction.isButton === "function" && interaction.isButton())
      || (typeof interaction.isModalSubmit === "function" && interaction.isModalSubmit())
      || (typeof interaction.isChannelSelectMenu === "function" && interaction.isChannelSelectMenu())
      || (typeof interaction.isAnySelectMenu === "function" && interaction.isAnySelectMenu())
    );
  }

  /**
   * /顶帖 面板：立即 deferReply，再读 Runtime。
   */
  async function handleSlashPanel(interaction) {
    const denied = accessFailure(interaction);
    if (denied) {
      await replyEphemeral(interaction, denied.message);
      return;
    }

    if (!(await deferReplyEphemeral(interaction))) return;

    const actor = actorFrom(interaction);
    try {
      const snap = await forumBumpRuntime.getControlSnapshot();
      const session = openSessionFromSnap(snap, actor.actorId);
      const nameMap = await resolveForumNames(snap.forumChannelIds ?? []);
      const message = buildPanelMessage(snap, session.sessionId, {
        forumNameMap: nameMap,
      });
      await editReplyPanel(interaction, {
        embeds: message.embeds,
        components: message.components,
      });
    } catch (error) {
      log("error", "打开面板失败", safeErrorFields(error));
      await editReplyPanel(interaction, { content: GENERIC, components: [] });
    }
  }

  /**
   * 已 defer 后刷新面板（Embed + editReply）。
   */
  async function refreshPanelAfterDefer(interaction, sessionId, notice = null) {
    const payload = await snapshotPanelPayload(sessionId, notice);
    await editReplyPanel(interaction, {
      embeds: payload.embeds,
      components: payload.components,
    });
  }

  /**
   * 编辑按钮：禁止 Runtime I/O；用 session draft 立即 showModal。
   */
  async function handleEditButton(interaction, sessionId) {
    const actor = actorFrom(interaction);
    const check = sessions.assertOwner(sessionId, {
      actorId: actor.actorId,
      guildId: interaction.guildId,
    });
    if (!check.ok) {
      await replyEphemeral(interaction, sessionDeniedMessage(check.errorCode));
      return;
    }

    const draft = sessions.get(sessionId)?.draft;
    const modal = buildConfigModal(draft, sessionId);
    if (!modal) {
      await replyEphemeral(interaction, GENERIC);
      return;
    }
    try {
      await interaction.showModal(modal);
    } catch (error) {
      log("warn", "showModal 失败", safeErrorFields(error));
      // showModal 失败时可能尚未确认
      if (!interaction.deferred && !interaction.replied) {
        await replyEphemeral(interaction, GENERIC);
      }
    }
  }

  function setSessionRevision(sessionId, revision) {
    sessions.touchRevision?.(sessionId, revision);
  }

  /**
   * 暂停 / 恢复：立即 deferUpdate，再 Runtime。
   */
  async function handlePauseResume(interaction, sessionId, action) {
    const actor = actorFrom(interaction);
    const check = sessions.assertOwner(sessionId, {
      actorId: actor.actorId,
      guildId: interaction.guildId,
    });
    if (!check.ok) {
      await replyEphemeral(interaction, sessionDeniedMessage(check.errorCode));
      return;
    }

    if (!(await deferUpdateOnce(interaction))) return;

    try {
      const snap = await forumBumpRuntime.getControlSnapshot();
      if (action === CUSTOM_IDS.resume) {
        if (snap.paused && snap.pauseReason !== "ADMIN_PAUSED") {
          await refreshPanelAfterDefer(
            interaction,
            sessionId,
            `无法恢复：${snap.pauseReason || "安全故障暂停"}`,
          );
          return;
        }
        const result = await forumBumpRuntime.resumeByAdmin({
          actorId: actor.actorId,
          actorTag: actor.actorTag,
          source: actor.source,
        });
        if (!result.success) {
          await refreshPanelAfterDefer(interaction, sessionId, safeRuntimeErrorMessage(result));
          return;
        }
        const after = await forumBumpRuntime.getControlSnapshot();
        setSessionRevision(sessionId, after.dynamicConfigRevision ?? 0);
        await refreshPanelAfterDefer(interaction, sessionId, "已恢复自动顶帖。");
        return;
      }

      const result = await forumBumpRuntime.pauseByAdmin({
        actorId: actor.actorId,
        actorTag: actor.actorTag,
        source: actor.source,
      });
      if (!result.success) {
        await refreshPanelAfterDefer(interaction, sessionId, safeRuntimeErrorMessage(result));
        return;
      }
      const after = await forumBumpRuntime.getControlSnapshot();
      setSessionRevision(sessionId, after.dynamicConfigRevision ?? 0);
      await refreshPanelAfterDefer(interaction, sessionId, "已暂停自动顶帖。");
    } catch (error) {
      log("error", "暂停/恢复失败", safeErrorFields(error));
      await editReplyPanel(interaction, { content: GENERIC, components: [] });
    }
  }

  /**
   * Modal 提交：仅本地解析，直接 ephemeral reply。
   */
  async function handleModal(interaction, sessionId) {
    const actor = actorFrom(interaction);
    const check = sessions.assertOwner(sessionId, {
      actorId: actor.actorId,
      guildId: interaction.guildId,
    });
    if (!check.ok) {
      await replyEphemeral(interaction, sessionDeniedMessage(check.errorCode));
      return;
    }

    const fields = {
      dailyLimit: interaction.fields?.getTextInputValue?.("dailyLimit"),
      activeStart: interaction.fields?.getTextInputValue?.("activeStart"),
      activeEnd: interaction.fields?.getTextInputValue?.("activeEnd"),
      silenceDays: interaction.fields?.getTextInputValue?.("silenceDays"),
    };
    const parsed = parseModalFields(fields);
    if (!parsed.ok) {
      await replyEphemeral(interaction, parsed.safeMessage);
      return;
    }

    sessions.updateDraft(sessionId, parsed.values);
    const draft = sessions.get(sessionId)?.draft;
    const page = buildForumSelectPage(draft, sessionId);
    if (!page) {
      await replyEphemeral(interaction, GENERIC);
      return;
    }
    await replyEphemeral(interaction, page);
  }

  /**
   * 频道选择：仅本地 draft 更新，用 update 作为首次响应（无 Runtime I/O）。
   */
  async function handleChannelSelect(interaction, sessionId) {
    const actor = actorFrom(interaction);
    const check = sessions.assertOwner(sessionId, {
      actorId: actor.actorId,
      guildId: interaction.guildId,
    });
    if (!check.ok) {
      await replyEphemeral(interaction, sessionDeniedMessage(check.errorCode));
      return;
    }

    let values = [];
    try {
      values = Array.isArray(interaction.values) ? [...interaction.values] : [];
    } catch {
      values = [];
    }
    if (values.length === 0) {
      try {
        await interaction.update({
          content: "请至少选择一个 Forum 频道。",
          components: buildForumSelectPage(sessions.get(sessionId)?.draft, sessionId)?.components ?? [],
        });
      } catch (error) {
        log("warn", "channel select update 失败", safeErrorFields(error));
      }
      return;
    }

    sessions.updateDraft(sessionId, { forumChannelIds: values });
    const draft = sessions.get(sessionId)?.draft;
    const page = buildForumSelectPage(draft, sessionId);
    try {
      await interaction.update({
        content: `${page.content}\n\n已选择 ${values.length} 个频道。`,
        components: page.components,
      });
    } catch (error) {
      log("warn", "channel select update 失败", safeErrorFields(error));
    }
  }

  /**
   * 保存：立即 deferUpdate，再 Runtime。
   */
  async function handleSave(interaction, sessionId) {
    const actor = actorFrom(interaction);
    const check = sessions.assertOwner(sessionId, {
      actorId: actor.actorId,
      guildId: interaction.guildId,
    });
    if (!check.ok) {
      await replyEphemeral(interaction, sessionDeniedMessage(check.errorCode));
      return;
    }

    if (!(await deferUpdateOnce(interaction))) return;

    try {
      const session = sessions.get(sessionId) ?? check.session;
      const live = await forumBumpRuntime.getControlSnapshot();
      if ((live.dynamicConfigRevision ?? 0) !== (session.dynamicConfigRevision ?? 0)) {
        sessions.deleteSession(sessionId);
        await editReplyPanel(interaction, { content: REVISION_STALE, components: [] });
        return;
      }

      const draft = session.draft;
      if (!Array.isArray(draft.forumChannelIds) || draft.forumChannelIds.length === 0) {
        await editReplyPanel(interaction, {
          content: "请至少选择一个 Forum 频道后再保存。",
          components: buildForumSelectPage(draft, sessionId)?.components ?? [],
        });
        return;
      }

      const patch = {
        dailyLimit: draft.dailyLimit,
        activeStart: draft.activeStart,
        activeEnd: draft.activeEnd,
        silenceDays: draft.silenceDays,
        forumChannelIds: [...draft.forumChannelIds],
      };

      const result = await forumBumpRuntime.updateDynamicConfig(patch, {
        actorId: actor.actorId,
        actorTag: actor.actorTag,
        source: actor.source,
      });

      if (!result.success) {
        const newSession = openSessionFromSnap(live, actor.actorId);
        sessions.deleteSession(sessionId);
        await refreshPanelAfterDefer(
          interaction,
          newSession.sessionId,
          safeRuntimeErrorMessage(result),
        );
        return;
      }

      sessions.deleteSession(sessionId);
      const after = await forumBumpRuntime.getControlSnapshot();
      const newSession = openSessionFromSnap(after, actor.actorId);
      await refreshPanelAfterDefer(interaction, newSession.sessionId, "配置已保存。");
    } catch (error) {
      log("error", "保存配置失败", safeErrorFields(error));
      await editReplyPanel(interaction, { content: GENERIC, components: [] });
    }
  }

  /**
   * 取消：立即 deferUpdate，再刷新面板。
   */
  async function handleCancel(interaction, sessionId) {
    const actor = actorFrom(interaction);
    const check = sessions.assertOwner(sessionId, {
      actorId: actor.actorId,
      guildId: interaction.guildId,
    });
    if (!check.ok) {
      await replyEphemeral(interaction, sessionDeniedMessage(check.errorCode));
      return;
    }

    if (!(await deferUpdateOnce(interaction))) return;

    try {
      sessions.deleteSession(sessionId);
      const snap = await forumBumpRuntime.getControlSnapshot();
      const newSession = openSessionFromSnap(snap, actor.actorId);
      await refreshPanelAfterDefer(interaction, newSession.sessionId, "已取消编辑。");
    } catch (error) {
      log("error", "取消编辑失败", safeErrorFields(error));
      await editReplyPanel(interaction, { content: GENERIC, components: [] });
    }
  }

  async function dispatch(interaction) {
    if (destroyed || !started) return;

    if (isPanelSlash(interaction)) {
      await handleSlashPanel(interaction);
      return;
    }

    if (!isOurComponent(interaction)) return;

    const denied = accessFailure(interaction);
    if (denied) {
      await replyEphemeral(interaction, denied.message);
      return;
    }

    const parsed = parseCustomId(interaction.customId);
    if (!parsed) {
      await replyEphemeral(interaction, SESSION_EXPIRED);
      return;
    }

    const { action, sessionId } = parsed;

    if (typeof interaction.isButton === "function" && interaction.isButton()) {
      if (action === CUSTOM_IDS.edit) {
        await handleEditButton(interaction, sessionId);
        return;
      }
      if (action === CUSTOM_IDS.pause || action === CUSTOM_IDS.resume) {
        await handlePauseResume(interaction, sessionId, action);
        return;
      }
      if (action === CUSTOM_IDS.save) {
        await handleSave(interaction, sessionId);
        return;
      }
      if (action === CUSTOM_IDS.cancel) {
        await handleCancel(interaction, sessionId);
        return;
      }
    }

    if (typeof interaction.isModalSubmit === "function" && interaction.isModalSubmit()) {
      if (action === CUSTOM_IDS.modal) {
        await handleModal(interaction, sessionId);
        return;
      }
    }

    if (
      (typeof interaction.isChannelSelectMenu === "function" && interaction.isChannelSelectMenu())
      || (typeof interaction.isAnySelectMenu === "function" && interaction.isAnySelectMenu())
    ) {
      if (action === CUSTOM_IDS.select) {
        await handleChannelSelect(interaction, sessionId);
      }
    }
  }

  function onInteractionCreate(interaction) {
    if (!started || destroyed) return;
    const isOurs = isPanelSlash(interaction)
      || (interaction?.customId && isForumBumpCustomId(interaction.customId));
    if (!isOurs) return;

    void dispatch(interaction).catch((error) => {
      log("error", "未捕获异常", safeErrorFields(error));
      void replyEphemeral(interaction, GENERIC);
    });
  }

  function start() {
    if (started || destroyed) return;
    client.on(Events.InteractionCreate, onInteractionCreate);
    started = true;
    log("info", "Forum Bump Admin Router 已启动");
  }

  function destroy() {
    destroyed = true;
    if (started) {
      if (typeof client.off === "function") {
        client.off(Events.InteractionCreate, onInteractionCreate);
      } else if (typeof client.removeListener === "function") {
        client.removeListener(Events.InteractionCreate, onInteractionCreate);
      }
      started = false;
    }
    sessions.clear();
    log("info", "Forum Bump Admin Router 已停止");
  }

  return {
    start,
    destroy,
    /** 测试用 */
    _sessions: sessions,
    _dispatch: dispatch,
  };
}

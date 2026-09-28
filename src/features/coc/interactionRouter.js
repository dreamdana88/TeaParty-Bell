import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import {
  buildCustomId,
  cancelledPanel,
  confirmRow,
  controlPanel,
  endedNotice,
  memberAdminPanel,
  memberPickPanel,
  memberSearchModal,
  memberSearchResults,
  parseCustomId,
  recruitPanel,
  startedPanel,
} from "./panel.js";
import { classifyMemberQuery, memberOptionLabel } from "./memberQuery.js";
import { COC_COMMAND_NAME, COC_OPEN_SUBCOMMAND, COC_PANEL_SUBCOMMAND, ROLL_COMMAND_NAME } from "./commands.js";

const CLOSED = "CoC 跑团暂时没有开启。";

function ephemeral(content) {
  return { content, flags: MessageFlags.Ephemeral };
}

async function replyEphemeral(interaction, content) {
  const payload = ephemeral(content);
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload);
    return;
  }
  await interaction.reply(payload);
}

function textRow(customId, label, maxLength) {
  return new ActionRowBuilder().addComponents(
    new TextInputBuilder()
      .setCustomId(customId)
      .setLabel(label)
      .setStyle(TextInputStyle.Short)
      .setRequired(true)
      .setMaxLength(maxLength),
  );
}

function titleModal() {
  return new ModalBuilder()
    .setCustomId(buildCustomId("modal-open"))
    .setTitle("发起 CoC 跑团")
    .addComponents(textRow("title", "模组名称", 80));
}

function nameModal(sessionId) {
  return new ModalBuilder()
    .setCustomId(buildCustomId("modal-kl", sessionId))
    .setTitle("报名调查员")
    .addComponents(textRow("character", "本局角色名", 32));
}

function targetNameModal(action, sessionId, userId) {
  return new ModalBuilder()
    .setCustomId(buildCustomId(action, sessionId, userId))
    .setTitle("本局角色名")
    .addComponents(textRow("character", "本局角色名", 32));
}

function displayNameOf(interaction) {
  return interaction.member?.displayName
    ?? interaction.member?.nickname
    ?? interaction.user?.globalName
    ?? interaction.user?.username
    ?? "调查员";
}

export function createCocInteractionRouter({
  client,
  service,
  discord,
  onSessionEnded,
  logger = console,
} = {}) {
  let started = false;

  function closedMessage() {
    return service.statusMessage?.() ?? CLOSED;
  }

  async function repostPanel(interaction) {
    const preview = service.previewRepost(interaction.channelId, interaction.user.id);
    if (!preview.ok) {
      await replyEphemeral(interaction, preview.message);
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const messageId = await discord.sendMessage(preview.session.runChannelId, controlPanel(preview.session));
    await service.setControlMessage(preview.session.sessionId, messageId);
    await interaction.editReply({ content: "控制面板已重新发送。", flags: MessageFlags.Ephemeral });
  }

  async function syncPanels(session) {
    try {
      if (session?.controlMessageId && session.runChannelId) {
        await discord.editMessage(session.runChannelId, session.controlMessageId, controlPanel(session));
      }
    } catch (error) {
      logger.warn?.("CoC 控制面板更新失败", { message: error?.message, sessionId: session?.sessionId });
    }
    try {
      if (session?.recruitMessageId && session.recruitChannelId) {
        await discord.editMessage(session.recruitChannelId, session.recruitMessageId, startedPanel(session));
      }
    } catch (error) {
      logger.warn?.("CoC 招募面板人数更新失败", { message: error?.message, sessionId: session?.sessionId });
    }
  }

  async function showMemberSearch(interaction, parsed) {
    const classified = classifyMemberQuery(interaction.fields.getTextInputValue("query"));
    if (!classified.ok) {
      await replyEphemeral(interaction, classified.message);
      return;
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const session = service.find(parsed.sessionId);
    if (!session) {
      await interaction.editReply({ content: "这场跑团已经不在了。" });
      return;
    }
    let members;
    try {
      members = await discord.searchMembers(session.guildId, classified.query);
    } catch (error) {
      const status = error?.status ?? error?.httpStatus;
      logger.warn?.("CoC 搜索成员失败", { message: error?.message, status });
      await interaction.editReply({
        content: status === 403
          ? "成员搜索被 Discord 拒绝了。请稍后重试，或直接粘贴对方的 Discord 用户 ID。"
          : "没有搜到这个人。请换一个更短的开头，或粘贴 Discord 用户 ID。",
      });
      return;
    }
    if (members.length === 0) {
      await interaction.editReply({
        content: `没有找到以「${classified.query}」开头的成员。搜索看的是用户名和服务器昵称的开头，也可以直接粘贴用户 ID。`,
      });
      return;
    }
    const labeled = members.map((member) => ({ ...member, label: memberOptionLabel(member) }));
    if (labeled.length === 1 && classified.kind === "id") {
      if (parsed.action === "modal-find-pl") {
        await interaction.editReply({
          content: `找到 ${labeled[0].label}。请填写本局角色名。`,
          components: [
            new ActionRowBuilder().addComponents(
              new ButtonBuilder()
                .setCustomId(buildCustomId("ask-name", parsed.sessionId, labeled[0].userId))
                .setLabel("填写角色名")
                .setStyle(ButtonStyle.Primary),
            ),
          ],
        });
        return;
      }
      const added = await service.addOb(parsed.sessionId, interaction.user.id, labeled[0].userId);
      if (!added.ok) {
        await interaction.editReply({ content: added.message });
        return;
      }
      await syncPanels(added.session);
      await interaction.editReply({ content: "已添加为 OB。" });
      return;
    }
    const pickAction = parsed.action === "modal-find-pl" ? "pick-found-pl" : "pick-found-ob";
    await interaction.editReply(memberSearchResults(parsed.sessionId, pickAction, labeled));
  }

  async function editRecruit(session, payload) {
    if (!session?.recruitChannelId || !session.recruitMessageId) return;
    await discord.editMessage(session.recruitChannelId, session.recruitMessageId, payload);
  }

  async function handleOpenModal(interaction) {
    if (service.availability() !== "ready") {
      await replyEphemeral(interaction, closedMessage());
      return;
    }
    const title = interaction.fields.getTextInputValue("title");
    const preview = service.previewOpen({
      guildId: interaction.guildId,
      kpUserId: interaction.user.id,
      title,
    });
    if (!preview.ok) {
      await replyEphemeral(interaction, preview.message);
      return;
    }
    await interaction.deferReply();
    const opened = await service.openRecruit({
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      kpUserId: interaction.user.id,
      title,
      messageId: null,
    });
    if (!opened.ok) {
      await interaction.editReply(ephemeral(opened.message));
      return;
    }
    const message = await interaction.editReply(recruitPanel(opened.session));
    const attached = await service.setRecruitMessage(opened.session.sessionId, message.id);
    if (!attached.ok) {
      await interaction.followUp(ephemeral(attached.message));
    }
  }

  async function refreshFromComponent(interaction, session) {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(recruitPanel(session));
      return;
    }
    await interaction.update(recruitPanel(session));
  }

  async function handleAction(interaction, action, sessionId, targetUserId) {
    if (service.availability() !== "ready") {
      await replyEphemeral(interaction, closedMessage());
      return;
    }
    const userId = interaction.user.id;
    if (action === "kl") {
      await interaction.showModal(nameModal(sessionId));
      return;
    }
    if (action === "ob") {
      const joined = await service.joinOb(sessionId, userId);
      if (!joined.ok) {
        await replyEphemeral(interaction, joined.message);
        return;
      }
      await refreshFromComponent(interaction, joined.session);
      return;
    }
    if (action === "leave") {
      const left = await service.leave(sessionId, userId);
      if (!left.ok) {
        await replyEphemeral(interaction, left.message);
        return;
      }
      await refreshFromComponent(interaction, left.session);
      return;
    }
    if (action === "start") {
      const preview = service.previewStart(sessionId, userId);
      if (!preview.ok) {
        await replyEphemeral(interaction, preview.message);
        return;
      }
      await interaction.reply({
        ...ephemeral(preview.text),
        components: [confirmRow("go", sessionId, "确认开始", "返回")],
      });
      return;
    }
    if (action === "abort") {
      const preview = service.previewCancel(sessionId, userId);
      if (!preview.ok) {
        await replyEphemeral(interaction, preview.message);
        return;
      }
      await interaction.reply({
        ...ephemeral(preview.text),
        components: [confirmRow("stop", sessionId, "确认取消", "返回")],
      });
      return;
    }
    if (action === "back-go-ob" || action === "back-go-kick") {
      const preview = service.previewMembers(sessionId, userId);
      if (!preview.ok) {
        await interaction.update({ content: "这场跑团当前无法继续管理成员。", components: [] });
        return;
      }
      const panel = memberAdminPanel(preview.session);
      await interaction.update({ content: panel.content, components: panel.components });
      return;
    }
    if (action === "back-go" || action === "back-stop" || action === "back-finish") {
      await interaction.update({ content: "已返回。", components: [] });
      return;
    }
    if (action === "go") {
      await interaction.deferUpdate();
      const started = await service.confirmStart(sessionId, userId);
      if (!started.ok) {
        await interaction.editReply(ephemeral(started.message));
        return;
      }
      try {
        const controlMessageId = await discord.sendMessage(started.session.runChannelId, controlPanel(started.session));
        await service.setControlMessage(sessionId, controlMessageId);
      } catch (error) {
        logger.warn?.("CoC 控制面板发送失败", { message: error?.message, sessionId });
      }
      try {
        await discord.editMessage(
          started.session.recruitChannelId,
          started.session.recruitMessageId,
          startedPanel(started.session),
        );
      } catch (error) {
        logger.warn?.("CoC 招募面板更新失败", { message: error?.message, sessionId });
      }
      await interaction.editReply(ephemeral(`《${started.session.title}》已经开团。`));
      return;
    }
    if (action === "stop") {
      await interaction.deferUpdate();
      const cancelled = await service.cancelRecruit(sessionId, userId);
      if (!cancelled.ok) {
        await interaction.editReply(ephemeral(cancelled.message));
        return;
      }
      try {
        await discord.editMessage(
          cancelled.session.recruitChannelId,
          cancelled.session.recruitMessageId,
          cancelledPanel(cancelled.session),
        );
      } catch (error) {
        logger.warn?.("CoC 取消面板更新失败", { message: error?.message, sessionId });
      }
      await interaction.editReply(ephemeral("招募已取消。"));
      return;
    }
    if (action === "ask-name") {
      await interaction.showModal(targetNameModal("modal-add-pl", sessionId, targetUserId));
      return;
    }
    if (action === "members") {
      const preview = service.previewMembers(sessionId, userId);
      if (!preview.ok) {
        await replyEphemeral(interaction, preview.message);
        return;
      }
      await interaction.reply({ ...memberAdminPanel(preview.session), flags: MessageFlags.Ephemeral });
      return;
    }
    if (action === "madd-pl") {
      await interaction.showModal(memberSearchModal(sessionId, "modal-find-pl"));
      return;
    }
    if (action === "madd-ob") {
      await interaction.showModal(memberSearchModal(sessionId, "modal-find-ob"));
      return;
    }
    if (action === "convert") {
      const preview = service.previewMembers(sessionId, userId);
      if (!preview.ok) {
        await replyEphemeral(interaction, preview.message);
        return;
      }
      await interaction.reply({
        ...memberPickPanel(preview.session, "pick-convert", "选择要转换身份的本局成员"),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (action === "kick") {
      const preview = service.previewMembers(sessionId, userId);
      if (!preview.ok) {
        await replyEphemeral(interaction, preview.message);
        return;
      }
      await interaction.reply({
        ...memberPickPanel(preview.session, "pick-kick", "选择要移出本局的 PL 或 OB"),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (action === "go-ob") {
      await interaction.deferUpdate();
      const converted = await service.convertPlToOb(sessionId, userId, targetUserId);
      if (!converted.ok) {
        await interaction.editReply({ content: converted.message, components: [] });
        return;
      }
      await syncPanels(converted.session);
      await interaction.editReply({ content: "已转为 OB。", components: [] });
      return;
    }
    if (action === "go-kick") {
      await interaction.deferUpdate();
      const removed = await service.removeMember(sessionId, userId, targetUserId);
      if (!removed.ok) {
        await interaction.editReply({ content: removed.message, components: [] });
        return;
      }
      await syncPanels(removed.session);
      await interaction.editReply({ content: "已移出本局。", components: [] });
      return;
    }
    if (action === "end") {
      const preview = service.previewEnd(sessionId, userId);
      if (!preview.ok) {
        await replyEphemeral(interaction, preview.message);
        return;
      }
      await interaction.reply({
        ...ephemeral(preview.text),
        components: [confirmRow("finish", sessionId, "确认结束", "继续跑团")],
      });
      return;
    }
    if (action === "finish") {
      await interaction.deferUpdate();
      const ended = await service.finish(sessionId, userId);
      if (!ended.ok) {
        await interaction.editReply(ephemeral(ended.message));
        return;
      }
      try {
        await discord.sendMessage(ended.session.runChannelId, { content: endedNotice(ended.session.title) });
      } catch (error) {
        logger.warn?.("CoC 结束说明发送失败", { message: error?.message, sessionId });
      }
      try {
        if (ended.session.controlMessageId) {
          await discord.editMessage(ended.session.runChannelId, ended.session.controlMessageId, {
            components: [],
          });
        }
      } catch {
        // 控制消息停用不了也不影响锁门。
      }
      onSessionEnded?.(ended.session);
      await interaction.editReply(ephemeral("本局已经结束。频道将在 48 小时后删除。"));
    }
  }

  async function onInteraction(interaction) {
    try {
      if (interaction.isChatInputCommand?.() && interaction.commandName === COC_COMMAND_NAME) {
        const subcommand = interaction.options.getSubcommand(false);
        if (subcommand === COC_PANEL_SUBCOMMAND) {
          await repostPanel(interaction);
          return;
        }
        if (subcommand !== COC_OPEN_SUBCOMMAND) return;
        if (service.availability() !== "ready") {
          await replyEphemeral(interaction, closedMessage());
          return;
        }
        await interaction.showModal(titleModal());
        return;
      }
      if (interaction.isChatInputCommand?.() && interaction.commandName === ROLL_COMMAND_NAME) {
        const expression = interaction.options.getString("dice", true);
        const rolled = await service.roll({
          channelId: interaction.channelId,
          userId: interaction.user.id,
          displayName: displayNameOf(interaction),
          expression,
        });
        if (!rolled.ok) {
          await replyEphemeral(interaction, rolled.message);
          return;
        }
        await interaction.reply({ content: rolled.text });
        return;
      }
      if (interaction.isModalSubmit?.()) {
        const parsed = parseCustomId(interaction.customId);
        if (!parsed) return;
        if (parsed.action === "modal-open") {
          await handleOpenModal(interaction);
          return;
        }
        if (parsed.action === "modal-kl") {
          const joined = await service.joinPl(
            parsed.sessionId,
            interaction.user.id,
            interaction.fields.getTextInputValue("character"),
          );
          if (!joined.ok) {
            await replyEphemeral(interaction, joined.message);
            return;
          }
          await interaction.deferUpdate();
          await interaction.editReply(recruitPanel(joined.session));
          return;
        }
        if (parsed.action === "modal-find-pl" || parsed.action === "modal-find-ob") {
          await showMemberSearch(interaction, parsed);
          return;
        }
        if (parsed.action === "modal-add-pl" || parsed.action === "modal-ob-pl") {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          const name = interaction.fields.getTextInputValue("character");
          const changed = parsed.action === "modal-add-pl"
            ? await service.addPl(parsed.sessionId, interaction.user.id, parsed.userId, name)
            : await service.convertObToPl(parsed.sessionId, interaction.user.id, parsed.userId, name);
          if (!changed.ok) {
            await interaction.editReply({ content: changed.message });
            return;
          }
          await syncPanels(changed.session);
          await interaction.editReply({ content: parsed.action === "modal-add-pl" ? "已添加为 PL。" : "已转为 PL。" });
        }
        return;
      }
      if (interaction.isStringSelectMenu?.()) {
        const parsed = parseCustomId(interaction.customId);
        if (!parsed?.sessionId) return;
        const selected = String(interaction.values?.[0] ?? "");
        if (parsed.action === "pick-found-pl" || parsed.action === "pick-found-ob") {
          if (!selected) return;
          if (parsed.action === "pick-found-pl") {
            await interaction.showModal(targetNameModal("modal-add-pl", parsed.sessionId, selected));
            return;
          }
          await interaction.deferUpdate();
          const added = await service.addOb(parsed.sessionId, interaction.user.id, selected);
          if (!added.ok) {
            await interaction.editReply({ content: added.message, components: [] });
            return;
          }
          await syncPanels(added.session);
          await interaction.editReply({ content: "已添加为 OB。", components: [] });
          return;
        }
        const [role, targetUserId] = selected.split(":");
        if (!targetUserId) return;
        if (parsed.action === "pick-convert" && role === "ob") {
          await interaction.showModal(targetNameModal("modal-ob-pl", parsed.sessionId, targetUserId));
          return;
        }
        if (parsed.action === "pick-convert" && role === "pl") {
          await interaction.update({
            content: "确定把这名 PL 转为 OB？符合条件时会恢复原来的昵称。",
            components: [confirmRow("go-ob", parsed.sessionId, "确认转为 OB", "返回", targetUserId)],
          });
          return;
        }
        if (parsed.action === "pick-kick") {
          await interaction.update({
            content: "确定把这名成员移出本局？移出后将看不到这个频道。",
            components: [confirmRow("go-kick", parsed.sessionId, "确认移出", "返回", targetUserId)],
          });
        }
        return;
      }
      if (interaction.isButton?.()) {
        const parsed = parseCustomId(interaction.customId);
        if (!parsed?.sessionId) return;
        await handleAction(interaction, parsed.action, parsed.sessionId, parsed.userId);
      }
    } catch (error) {
      logger.error?.("CoC 交互失败", { message: error?.message });
      try {
        await replyEphemeral(interaction, "这次操作没有完成，请稍后再试。");
      } catch {
        // 交互已经失效时不再抛出。
      }
    }
  }

  function start() {
    if (started) return;
    client.on(Events.InteractionCreate, onInteraction);
    started = true;
  }

  function destroy() {
    if (!started) return;
    client.off?.(Events.InteractionCreate, onInteraction);
    client.removeListener?.(Events.InteractionCreate, onInteraction);
    started = false;
  }

  return { start, destroy };
}

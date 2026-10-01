import { randomBytes } from "crypto";
import { buildRoomOverwrites } from "./channelAccess.js";
import { planChannelNames } from "./channelName.js";
import { parseBonusPenalty, rollBonusPenalty } from "./dice/bonusPenalty.js";
import { formatRoll, rollDice } from "./dice/roller.js";
import { formatBonusPenalty, formatTextDice } from "./textDice.js";
import { INVALID_DICE_MESSAGE, parseDiceExpression } from "./dice/parser.js";
import { planNicknameRestore } from "./nickname.js";
import {
  buildTranscriptFiles,
  TRANSCRIPT_FAILED_NOTICE,
  TRANSCRIPT_INCOMPLETE_NOTICE,
} from "./transcript.js";
import {
  activeSessionInChannel,
  applyAddOb,
  applyAddPl,
  applyRemoveMember,
  beginTranscriptSeats,
  createRecruitingSession,
  gateMemberAdmin,
  gateNewMember,
  gateTranscriptPrivacy,
  findOccupyingSession,
  isPrunableSession,
  lockStarting,
  markCancelled,
  markEnded,
  markEnding,
  memberRole,
  normalizeCharacterName,
  normalizeTitle,
  participantIds,
  replaceSession,
  requestCancel,
  requestEnd,
  requestStart,
  revertStarting,
  signupPl,
  signupOb,
  cancelSignup,
  isTranscriptOptedOut,
  speakerName,
  withTranscriptOptOut,
  SESSION_STATES,
} from "./sessionRules.js";

function unavailable(message = "CoC 跑团暂时没有开启。") {
  return { ok: false, message };
}

function channelMissing(error) {
  const code = error?.code ?? error?.discordCode;
  return code === 10003;
}

/**
 * @param {object} options
 * @param {ReturnType<import("./sessionStore.js").createCocSessionStore>} options.store
 */
export function createCocSessionService({
  store,
  discord,
  config,
  clock = { now: () => Date.now() },
  logger = console,
  createId = () => randomBytes(8).toString("hex"),
  randomInt,
  characters,
} = {}) {
  let mode = config?.enabled ? "ready" : "off";

  function sessions() {
    return store.snapshot()?.sessions ?? [];
  }

  function find(sessionId) {
    return sessions().find((session) => session.sessionId === sessionId) ?? null;
  }

  function availability() {
    return mode;
  }

  function statusMessage() {
    if (mode === "broken") return "CoC 场次记录暂时不可用。";
    return config?.disabledReason || "CoC 跑团暂时没有开启。";
  }

  function markBroken() {
    mode = "broken";
  }

  function markReady() {
    mode = "ready";
  }

  function setBotUserId(botUserId) {
    config.botUserId = botUserId;
  }

  function previewOpen({ guildId, kpUserId, title }) {
    if (mode !== "ready") return unavailable(mode === "broken" ? "CoC 场次记录暂时不可用。" : undefined);
    if (guildId !== config.guildId) return { ok: false, message: "这个命令只能在茶话会里使用。" };
    if (!normalizeTitle(title)) return { ok: false, message: "模组名称不能为空，且不能超过 80 个字。" };
    if (findOccupyingSession(sessions(), kpUserId)) {
      return { ok: false, message: "你当前已经参加了一场 CoC 跑团，请先结束或退出上一场。" };
    }
    return { ok: true };
  }

  async function setControlMessage(sessionId, messageId) {
    const saved = await store.update((state) => {
      const current = state.sessions.find((session) => session.sessionId === sessionId);
      if (!current) return { errorCode: "MISSING", message: "这场跑团已经不在了。" };
      const next = { ...current, controlMessageId: messageId };
      return { state: { ...state, sessions: replaceSession(state.sessions, next) }, result: next };
    });
    if (!saved.ok) return { ok: false, message: saved.message };
    return { ok: true, session: saved.result };
  }

  async function setRecruitMessage(sessionId, messageId) {
    const saved = await store.update((state) => {
      const current = state.sessions.find((session) => session.sessionId === sessionId);
      if (!current) return { errorCode: "MISSING", message: "这场招募已经不在了。" };
      const next = { ...current, recruitMessageId: messageId };
      return { state: { ...state, sessions: replaceSession(state.sessions, next) }, result: next };
    });
    if (!saved.ok) return { ok: false, message: saved.message };
    return { ok: true, session: saved.result };
  }

  async function openRecruit({ guildId, channelId, kpUserId, title, messageId }) {
    if (mode !== "ready") return unavailable(mode === "broken" ? "CoC 场次记录暂时不可用。" : undefined);
    if (guildId !== config.guildId) return { ok: false, message: "这个命令只能在茶话会里使用。" };
    const normalized = normalizeTitle(title);
    if (!normalized) return { ok: false, message: "模组名称不能为空，且不能超过 80 个字。" };
    if (findOccupyingSession(sessions(), kpUserId)) {
      return { ok: false, message: "你当前已经参加了一场 CoC 跑团，请先结束或退出上一场。" };
    }
    const session = createRecruitingSession({
      sessionId: createId(),
      guildId,
      recruitChannelId: channelId,
      recruitMessageId: messageId,
      kpUserId,
      title: normalized,
      now: clock.now(),
    });
    const saved = await store.update((state) => {
      if (findOccupyingSession(state.sessions, kpUserId)) {
        return { errorCode: "ALREADY_IN_SESSION", message: "你当前已经参加了一场 CoC 跑团，请先结束或退出上一场。" };
      }
      return { state: { ...state, sessions: [...state.sessions, session] }, result: session };
    });
    if (!saved.ok) return { ok: false, message: saved.message };
    return { ok: true, session: saved.result };
  }

  async function mutateRecruit(sessionId, userId, change) {
    if (mode !== "ready") return unavailable(mode === "broken" ? "CoC 场次记录暂时不可用。" : undefined);
    const saved = await store.update((state) => {
      const current = state.sessions.find((session) => session.sessionId === sessionId);
      if (!current) return { errorCode: "MISSING", message: "这场招募已经不在了。" };
      const changed = change(state.sessions, current, userId);
      if (!changed.ok) return { errorCode: "REJECTED", message: changed.message };
      return {
        state: { ...state, sessions: replaceSession(state.sessions, changed.session) },
        result: changed.session,
      };
    });
    if (!saved.ok) return { ok: false, message: saved.message };
    return { ok: true, session: saved.result };
  }

  function joinPl(sessionId, userId, characterName) {
    return mutateRecruit(sessionId, userId, (all, session) => signupPl(all, session, userId, characterName));
  }

  async function prepareCharacterSelection(sessionId, userId) {
    if (!characters) return { ok: false, message: "档案馆接口尚未配置。" };
    const previous = find(sessionId)?.pl.find((member) => member.userId === userId);
    const joined = await joinPl(sessionId, userId, previous?.characterName || "待选择调查员");
    if (!joined.ok) return joined;
    const listed = await characters.list(userId);
    return { ...listed, session: joined.session };
  }

  async function selectCharacter(sessionId, userId, characterId) {
    if (mode !== "ready") return unavailable(statusMessage());
    if (!characters) return { ok: false, message: "档案馆接口尚未配置。" };
    const session = find(sessionId);
    if (session?.state !== SESSION_STATES.recruiting || !session.pl.some((member) => member.userId === userId)) {
      return { ok: false, message: "只有本场招募中的 PL 可以选择调查员。" };
    }
    const read = await characters.read(characterId, userId);
    if (!read.ok) return read;
    const snapshot = read.snapshot;
    if (snapshot.ownerDiscordUserId !== userId) return { ok: false, message: "只能选择自己的角色卡。" };
    if (!normalizeCharacterName(snapshot.characterName)) {
      return { ok: false, message: "调查员姓名不能超过 32 个字，请先到档案馆修改。" };
    }
    const saved = await store.update((state) => {
      const current = state.sessions.find((item) => item.sessionId === sessionId);
      if (mode !== "ready" || current?.state !== SESSION_STATES.recruiting
        || !current.pl.some((member) => member.userId === userId)) {
        return { errorCode: "REJECTED", message: "报名状态已改变，请重新打开选卡。" };
      }
      const next = { ...current, pl: current.pl.map((member) => member.userId === userId
        ? { ...member, ...structuredClone(snapshot) } : member) };
      return { state: { ...state, sessions: replaceSession(state.sessions, next) }, result: next };
    });
    return saved.ok ? { ok: true, session: saved.result } : { ok: false, message: saved.message };
  }

  function unselectedMessage(session) {
    return characters && session.pl.some((member) => !member.characterId)
      ? "还有 PL 未选择档案馆角色卡，请先完成选卡后再开团。" : null;
  }

  function joinOb(sessionId, userId) {
    return mutateRecruit(sessionId, userId, (all, session) => signupOb(all, session, userId));
  }

  function leave(sessionId, userId) {
    return mutateRecruit(sessionId, userId, (_all, session) => cancelSignup(session, userId));
  }

  function previewStart(sessionId, actorId) {
    const session = find(sessionId);
    if (!session) return { ok: false, message: "这场招募已经不在了。" };
    const gate = requestStart(session, actorId);
    if (!gate.ok) return gate;
    const unselected = unselectedMessage(session);
    if (unselected) return { ok: false, message: unselected };
    return {
      ok: true,
      text: `确定开始《${session.title}》？\n\nPL：${session.pl.length}\nOB：${session.ob.length}`,
    };
  }

  function previewCancel(sessionId, actorId) {
    const session = find(sessionId);
    if (!session) return { ok: false, message: "这场招募已经不在了。" };
    const gate = requestCancel(session, actorId);
    if (!gate.ok) return gate;
    return { ok: true, text: `确定取消《${session.title}》的招募？` };
  }

  function previewEnd(sessionId, actorId) {
    const session = find(sessionId);
    if (!session) return { ok: false, message: "这场跑团已经不在了。" };
    const gate = requestEnd(session, actorId);
    if (!gate.ok) return gate;
    const lines = [
      `确定结束《${session.title}》？`,
      "",
      "结束后会：",
    ];
    if (config.messageContentEnabled === true && config.transcriptEnabled === true) {
      lines.push("• 把本局团录发在频道里");
    }
    lines.push("• 恢复PL昵称", "• 移除KP/PL/OB身份色", "• 锁定本频道", "• 48小时后删除频道");
    return { ok: true, text: lines.join("\n") };
  }

  async function cancelRecruit(sessionId, actorId) {
    return mutateRecruit(sessionId, actorId, (_all, session) => {
      const gate = requestCancel(session, actorId);
      if (!gate.ok) return gate;
      return { ok: true, session: markCancelled(session, clock.now()) };
    });
  }

  async function rollbackStart(session, { channelId = null, rolesGranted = false, nicknames = [] } = {}) {
    if (rolesGranted) {
      await removeRoles(session).catch((error) => {
        logger.warn?.("CoC 回滚身份组失败", { message: error?.message, sessionId: session.sessionId });
      });
    }
    for (const member of nicknames) {
      const plan = planNicknameRestore({
        originalNickname: member.originalNickname,
        appliedNickname: member.appliedNickname,
        currentNickname: member.appliedNickname,
      });
      try {
        if (plan.action === "clear") await discord.setNickname(session.guildId, member.userId, null);
        if (plan.action === "set") await discord.setNickname(session.guildId, member.userId, plan.nickname);
      } catch (error) {
        logger.warn?.("CoC 回滚昵称失败", { message: error?.message, userId: member.userId });
      }
    }
    const channelRemoved = await deleteRunChannel(channelId);
    if (!channelRemoved) {
      await store.update((state) => {
        const current = state.sessions.find((item) => item.sessionId === session.sessionId);
        if (!current || current.state !== SESSION_STATES.starting) return { state, result: null };
        const next = { ...current, runChannelId: channelId, rolesGranted: rolesGranted || current.rolesGranted };
        return { state: { ...state, sessions: replaceSession(state.sessions, next) }, result: next };
      });
      return;
    }
    await store.update((state) => {
      const current = state.sessions.find((item) => item.sessionId === session.sessionId);
      if (!current) return { state, result: null };
      return { state: { ...state, sessions: replaceSession(state.sessions, revertStarting(current)) }, result: null };
    });
  }

  async function removeRoles(session) {
    const roleIds = [config.kpRoleId, config.plRoleId, config.obRoleId];
    for (const userId of participantIds(session)) {
      for (const roleId of roleIds) {
        try {
          await discord.removeRole(session.guildId, userId, roleId);
        } catch (error) {
          logger.warn?.("CoC 卸下身份组失败", {
            message: error?.message,
            sessionId: session.sessionId,
            userId,
          });
        }
      }
    }
  }

  async function restoreNicknames(session) {
    for (const member of session.pl) {
      if (!member.appliedNickname) continue;
      try {
        const currentNickname = await discord.fetchNickname(session.guildId, member.userId);
        const plan = planNicknameRestore({
          originalNickname: member.originalNickname,
          appliedNickname: member.appliedNickname,
          currentNickname,
        });
        if (plan.action === "clear") await discord.setNickname(session.guildId, member.userId, null);
        if (plan.action === "set") await discord.setNickname(session.guildId, member.userId, plan.nickname);
      } catch (error) {
        logger.warn?.("CoC 恢复昵称失败", { message: error?.message, userId: member.userId });
      }
    }
  }

  async function deleteRunChannel(channelId) {
    if (!channelId) return true;
    try {
      await discord.deleteChannel(channelId);
      return true;
    } catch (error) {
      if (channelMissing(error)) return true;
      logger.warn?.("CoC 删除频道失败", { message: error?.message, channelId });
      return false;
    }
  }

  async function confirmStart(sessionId, actorId) {
    if (mode !== "ready") return unavailable(mode === "broken" ? "CoC 场次记录暂时不可用。" : undefined);
    const locked = await store.update((state) => {
      const current = state.sessions.find((session) => session.sessionId === sessionId);
      if (!current) return { errorCode: "MISSING", message: "这场招募已经不在了。" };
      const gate = requestStart(current, actorId);
      if (!gate.ok) return { errorCode: "REJECTED", message: gate.message };
      const unselected = unselectedMessage(current);
      if (unselected) return { errorCode: "REJECTED", message: unselected };
      const starting = lockStarting(current);
      if (!starting.ok) return { errorCode: "REJECTED", message: starting.message };
      return {
        state: { ...state, sessions: replaceSession(state.sessions, starting.session) },
        result: starting.session,
      };
    });
    if (!locked.ok) return { ok: false, message: locked.message };
    const session = locked.result;
    if (!config.botUserId) {
      await rollbackStart(session);
      return { ok: false, message: "小G宝还没准备好自己的频道权限，请稍后再开始。" };
    }
    let channel = null;
    try {
      const existingNames = await discord.listSiblingNames(config.categoryId);
      const names = planChannelNames(session.title, existingNames);
      const overwrites = buildRoomOverwrites({
        guildId: session.guildId,
        botUserId: config.botUserId,
        userIds: participantIds(session),
      });
      channel = await discord.createTextChannel({
        names,
        parentId: config.categoryId,
        permissionOverwrites: overwrites,
      });
    } catch (error) {
      logger.warn?.("CoC 创建频道失败", { message: error?.message, sessionId });
      await rollbackStart(session);
      return { ok: false, message: "跑团频道没有建起来，招募还在，可以再试一次。" };
    }

    const savedChannel = await store.update((state) => {
      const current = state.sessions.find((item) => item.sessionId === sessionId);
      if (!current || current.state !== SESSION_STATES.starting) {
        return { errorCode: "REJECTED", message: "这场招募的状态已经变了。" };
      }
      const next = { ...current, runChannelId: channel.id };
      return { state: { ...state, sessions: replaceSession(state.sessions, next) }, result: next };
    });
    if (!savedChannel.ok) {
      await rollbackStart(session, { channelId: channel.id });
      return { ok: false, message: savedChannel.message };
    }

    try {
      await discord.addRole(session.guildId, session.kpUserId, config.kpRoleId);
      for (const member of session.pl) {
        await discord.addRole(session.guildId, member.userId, config.plRoleId);
      }
      for (const member of session.ob) {
        await discord.addRole(session.guildId, member.userId, config.obRoleId);
      }
    } catch (error) {
      logger.warn?.("CoC 发放身份组失败", { message: error?.message, sessionId });
      await rollbackStart(savedChannel.result, { channelId: channel.id, rolesGranted: true });
      return { ok: false, message: "身份颜色没有发齐，已经收回这次建房。招募还在。" };
    }

    const rolesSaved = await store.update((state) => {
      const current = state.sessions.find((item) => item.sessionId === sessionId);
      if (!current || current.state !== SESSION_STATES.starting) {
        return { errorCode: "REJECTED", message: "这场招募的状态已经变了。" };
      }
      const next = { ...current, rolesGranted: true, runChannelId: channel.id };
      return { state: { ...state, sessions: replaceSession(state.sessions, next) }, result: next };
    });
    if (!rolesSaved.ok) {
      await rollbackStart(savedChannel.result, { channelId: channel.id, rolesGranted: true });
      return { ok: false, message: rolesSaved.message };
    }

    let latestKl = session.pl;
    for (const member of session.pl) {
      let recorded = { ...member, originalNickname: null, appliedNickname: null };
      try {
        const originalNickname = await discord.fetchNickname(session.guildId, member.userId);
        await discord.setNickname(session.guildId, member.userId, member.characterName);
        recorded = { ...member, originalNickname, appliedNickname: member.characterName };
      } catch (error) {
        logger.warn?.("CoC 修改昵称失败", { message: error?.message, userId: member.userId });
      }
      const nickSaved = await store.update((state) => {
        const current = state.sessions.find((item) => item.sessionId === sessionId);
        if (!current || current.state !== SESSION_STATES.starting) {
          return { errorCode: "REJECTED", message: "这场招募的状态已经变了。" };
        }
        const next = {
          ...current,
          pl: current.pl.map((item) => (item.userId === member.userId ? recorded : item)),
        };
        return { state: { ...state, sessions: replaceSession(state.sessions, next) }, result: next.pl };
      });
      if (!nickSaved.ok) {
        await rollbackStart(
          { ...session, pl: latestKl.map((item) => (item.userId === member.userId ? recorded : item)) },
          { channelId: channel.id, rolesGranted: true, nicknames: [recorded] },
        );
        return { ok: false, message: nickSaved.message };
      }
      latestKl = nickSaved.result;
    }

    const activated = await store.update((state) => {
      const current = state.sessions.find((item) => item.sessionId === sessionId);
      if (!current || current.state !== SESSION_STATES.starting) {
        return { errorCode: "REJECTED", message: "这场招募的状态已经变了。" };
      }
      const startedAt = clock.now();
      const next = {
        ...current,
        state: SESSION_STATES.active,
        startedAt,
        runChannelId: channel.id,
        rolesGranted: true,
        transcriptSeats: beginTranscriptSeats({ ...current, startedAt }),
      };
      return { state: { ...state, sessions: replaceSession(state.sessions, next) }, result: next };
    });
    if (!activated.ok) {
      await rollbackStart(
        { ...session, pl: latestKl },
        { channelId: channel.id, rolesGranted: true, nicknames: latestKl },
      );
      return { ok: false, message: activated.message };
    }
    return { ok: true, session: activated.result };
  }

  async function cleanupRoom(session) {
    await restoreNicknames(session);
    await removeRoles(session);
    if (!session.runChannelId) return;
    try {
      await discord.lockChannel(session.runChannelId, participantIds(session));
    } catch (error) {
      logger.warn?.("CoC 锁定频道失败", { message: error?.message, sessionId: session.sessionId });
    }
  }

  async function markSessionEnding(sessionId, actorId) {
    return store.update((state) => {
      const current = state.sessions.find((item) => item.sessionId === sessionId);
      if (!current) return { errorCode: "MISSING", message: "这场跑团已经不在了。" };
      if (actorId && current.kpUserId !== actorId) {
        return { errorCode: "REJECTED", message: "只有 KP 可以结束本局。" };
      }
      if (current.state === SESSION_STATES.ending) {
        return { state, result: current };
      }
      if (current.state !== SESSION_STATES.active) {
        return { errorCode: "REJECTED", message: "这场跑团现在不能结束。" };
      }
      const next = markEnding(current, clock.now());
      return { state: { ...state, sessions: replaceSession(state.sessions, next) }, result: next };
    });
  }

  async function markSessionEnded(sessionId) {
    return store.update((state) => {
      const current = state.sessions.find((item) => item.sessionId === sessionId);
      if (!current) return { errorCode: "MISSING", message: "这场跑团已经不在了。" };
      if (current.state === SESSION_STATES.ended) return { state, result: current };
      if (current.state !== SESSION_STATES.ending) {
        return { errorCode: "REJECTED", message: "这场跑团现在不能结束。" };
      }
      const next = markEnded(current, clock.now());
      return { state: { ...state, sessions: replaceSession(state.sessions, next) }, result: next };
    });
  }

  function transcriptActive() {
    return config.messageContentEnabled === true && config.transcriptEnabled === true;
  }

  async function notifyTranscriptFailed(session, content = TRANSCRIPT_FAILED_NOTICE) {
    if (!session?.runChannelId || typeof discord.sendMessage !== "function") return;
    try {
      await discord.sendMessage(session.runChannelId, { content });
    } catch (error) {
      logger.warn?.("CoC 团录失败说明没有发出", { message: error?.message, sessionId: session.sessionId });
    }
  }

  async function deliverTranscript(session) {
    if (!transcriptActive() || !session?.runChannelId) return { skipped: true };
    const current = find(session.sessionId) ?? session;
    if (current.transcriptDelivered === true) return { skipped: true };
    if (typeof discord.fetchChannelHistory !== "function") {
      logger.warn?.("CoC 团录没有频道历史接口", { sessionId: current.sessionId });
      await notifyTranscriptFailed(current);
      return { ok: false };
    }
    let history;
    try {
      history = await discord.fetchChannelHistory(current.runChannelId, {
        startedAt: current.startedAt ?? null,
      });
    } catch (error) {
      logger.warn?.("CoC 团录没有读到频道历史", { message: error?.message, sessionId: current.sessionId });
      await notifyTranscriptFailed(current);
      return { ok: false };
    }
    const messages = Array.isArray(history) ? history : history?.messages;
    const truncated = Array.isArray(history) ? false : history?.truncated === true;
    let files;
    try {
      files = buildTranscriptFiles(current, messages ?? [], {
        botUserId: config.botUserId,
        truncated,
      }).files;
    } catch (error) {
      logger.warn?.("CoC 团录没有整理出来", { message: error?.message, sessionId: current.sessionId });
      await notifyTranscriptFailed(current);
      return { ok: false };
    }
    let sentAll = true;
    for (const file of files) {
      try {
        await discord.sendMessage(current.runChannelId, {
          files: [{ attachment: Buffer.from(file.markdown, "utf8"), name: file.name }],
        });
      } catch (error) {
        sentAll = false;
        logger.warn?.("CoC 团录没有完整发出", { message: error?.message, sessionId: current.sessionId });
      }
    }
    if (!sentAll) {
      await notifyTranscriptFailed(current, TRANSCRIPT_INCOMPLETE_NOTICE);
      return { ok: false };
    }
    const marked = await store.update((state) => {
      const latest = state.sessions.find((item) => item.sessionId === current.sessionId);
      if (!latest) return { state, result: null };
      const next = { ...latest, transcriptDelivered: true };
      return { state: { ...state, sessions: replaceSession(state.sessions, next) }, result: next };
    });
    if (!marked.ok) {
      logger.warn?.("CoC 团录已发出，但没有记下交付状态", { sessionId: current.sessionId });
    }
    return { ok: true };
  }

  async function finish(sessionId, actorId) {
    if (mode !== "ready") return unavailable(mode === "broken" ? "CoC 场次记录暂时不可用。" : undefined);
    const session = find(sessionId);
    if (!session) return { ok: false, message: "这场跑团已经不在了。" };
    const gate = requestEnd(session, actorId);
    if (!gate.ok) return gate;
    const ending = await markSessionEnding(sessionId, actorId);
    if (!ending.ok) return { ok: false, message: ending.message };
    await cleanupRoom(ending.result);
    await deliverTranscript(ending.result);
    const ended = await markSessionEnded(sessionId);
    if (!ended.ok) return { ok: false, message: ended.message };
    return { ok: true, session: ended.result };
  }

  async function continueEnding(sessionId) {
    const session = find(sessionId);
    if (!session || session.state !== SESSION_STATES.ending) return { ok: true, skipped: true };
    await cleanupRoom(session);
    await deliverTranscript(session);
    return markSessionEnded(sessionId).then((ended) => (
      ended.ok ? { ok: true, session: ended.result } : { ok: false, message: ended.message }
    ));
  }

  async function reconcileStarting(session) {
    const channelId = session.runChannelId;
    if (channelId || session.rolesGranted) await removeRoles(session);
    await restoreNicknames(session);
    const channelRemoved = await deleteRunChannel(channelId);
    if (!channelRemoved) {
      logger.warn?.("CoC 未完成的开团还留着频道，下次启动会再清理。", { sessionId: session.sessionId });
      return { ok: false, stuck: true };
    }
    const saved = await store.update((state) => {
      const current = state.sessions.find((item) => item.sessionId === session.sessionId);
      if (!current || current.state !== SESSION_STATES.starting) return { state, result: current ?? null };
      const next = revertStarting({ ...current, runChannelId: channelId });
      return { state: { ...state, sessions: replaceSession(state.sessions, next) }, result: next };
    });
    return saved.ok ? { ok: true, session: saved.result } : { ok: false, message: saved.message };
  }

  async function pruneSettled() {
    await store.update((state) => {
      const now = clock.now();
      return {
        state: {
          ...state,
          sessions: state.sessions.filter((session) => !isPrunableSession(session, now)),
        },
        result: null,
      };
    });
  }

  async function clearPending(sessionId) {
    await store.update((state) => {
      const current = state.sessions.find((item) => item.sessionId === sessionId);
      if (!current) return { state, result: null };
      return {
        state: { ...state, sessions: replaceSession(state.sessions, { ...current, pendingMemberOp: null }) },
        result: null,
      };
    });
  }

  async function ensureCocRole(guildId, userId, target) {
    if (target !== "pl") await discord.removeRole(guildId, userId, config.plRoleId);
    if (target !== "ob") await discord.removeRole(guildId, userId, config.obRoleId);
    if (target === "pl") await discord.addRole(guildId, userId, config.plRoleId);
    if (target === "ob") await discord.addRole(guildId, userId, config.obRoleId);
  }

  async function ensureChannelAccess(channelId, userId, allowed) {
    if (!channelId) return;
    if (allowed) await discord.grantChannelAccess(channelId, userId);
    else await discord.revokeChannelAccess(channelId, userId);
  }

  async function moveNickname(guildId, userId, fromNick, toNick) {
    const currentNickname = await discord.fetchNickname(guildId, userId);
    if ((currentNickname ?? null) !== (fromNick ?? null)) return false;
    if ((toNick ?? null) === (fromNick ?? null)) return true;
    await discord.setNickname(guildId, userId, toNick ?? null);
    return true;
  }

  async function rollbackPending(sessionId) {
    const session = find(sessionId);
    const op = session?.pendingMemberOp;
    if (!session || !op) return;
    try {
      await ensureCocRole(session.guildId, op.targetUserId, op.beforeRole ?? null);
    } catch (error) {
      logger.warn?.("CoC 回滚身份组失败", { message: error?.message, userId: op.targetUserId });
    }
    if (session.runChannelId && op.beforeChannelAccess === false) {
      try {
        await discord.revokeChannelAccess(session.runChannelId, op.targetUserId);
      } catch (error) {
        logger.warn?.("CoC 收回频道权限失败", { message: error?.message });
      }
    }
    if (session.runChannelId && op.beforeChannelAccess === true) {
      try {
        await discord.grantChannelAccess(session.runChannelId, op.targetUserId);
      } catch (error) {
        logger.warn?.("CoC 补回频道权限失败", { message: error?.message });
      }
    }
    if (op.nicknameAfter !== undefined) {
      try {
        await moveNickname(session.guildId, op.targetUserId, op.nicknameAfter, op.nicknameBefore ?? null);
      } catch (error) {
        logger.warn?.("CoC 回滚成员昵称失败", { message: error?.message, userId: op.targetUserId });
      }
    }
    await clearPending(sessionId);
  }

  async function reserveMemberOp(sessionId, actorId, extraGate, op) {
    if (mode !== "ready") return unavailable(mode === "broken" ? "CoC 场次记录暂时不可用。" : undefined);
    return store.update((state) => {
      const current = state.sessions.find((item) => item.sessionId === sessionId);
      const gate = gateMemberAdmin(current, actorId);
      if (!gate.ok) return { errorCode: "REJECTED", message: gate.message };
      const extra = extraGate(state.sessions, current);
      if (!extra.ok) return { errorCode: "REJECTED", message: extra.message };
      const next = { ...current, pendingMemberOp: { ...op, startedAt: clock.now() } };
      return { state: { ...state, sessions: replaceSession(state.sessions, next) }, result: next };
    });
  }

  async function commitMember(sessionId, apply) {
    return store.update((state) => {
      const current = state.sessions.find((item) => item.sessionId === sessionId);
      if (!current?.pendingMemberOp) return { errorCode: "MISSING", message: "没有进行中的成员变更。" };
      const next = apply(current, clock.now());
      return { state: { ...state, sessions: replaceSession(state.sessions, next) }, result: next };
    });
  }

  async function applyPlannedNickname(session, op) {
    if (op.nicknameAfter === undefined) return { originalNickname: null, appliedNickname: null, changed: false };
    try {
      const changed = await moveNickname(session.guildId, op.targetUserId, op.nicknameBefore ?? null, op.nicknameAfter ?? null);
      if (!changed) return { originalNickname: op.nicknameBefore ?? null, appliedNickname: null, changed: false };
      return {
        originalNickname: op.nicknameBefore ?? null,
        appliedNickname: op.nicknameAfter ?? null,
        changed: true,
      };
    } catch (error) {
      logger.warn?.("CoC 修改昵称失败", { message: error?.message, userId: op.targetUserId });
      return { originalNickname: op.nicknameBefore ?? null, appliedNickname: null, changed: false };
    }
  }

  async function runMemberChange(sessionId, actorId, extraGate, op, apply) {
    const reserved = await reserveMemberOp(sessionId, actorId, extraGate, op);
    if (!reserved.ok) return { ok: false, message: reserved.message };
    const session = reserved.result;
    const pending = session.pendingMemberOp;
    try {
      const nick = await applyPlannedNickname(session, pending);
      await ensureCocRole(session.guildId, pending.targetUserId, pending.afterRole ?? null);
      if (pending.afterChannelAccess !== pending.beforeChannelAccess) {
        await ensureChannelAccess(session.runChannelId, pending.targetUserId, pending.afterChannelAccess);
      }
      const saved = await commitMember(sessionId, (current, at) => apply(current, nick, at));
      if (!saved.ok) throw new Error(saved.message);
      return { ok: true, session: saved.result };
    } catch (error) {
      logger.warn?.("CoC 成员变更失败", { message: error?.message, sessionId, type: pending.type });
      await rollbackPending(sessionId);
      return { ok: false, message: "这次成员变更没有完成，已收回。" };
    }
  }

  async function addPl(sessionId, actorId, targetUserId, characterName) {
    let info;
    try {
      info = await discord.fetchGuildMember(find(sessionId)?.guildId, targetUserId);
    } catch {
      return { ok: false, message: "该成员不在这个服务器里。" };
    }
    const name = normalizeCharacterName(characterName);
    if (!name) return { ok: false, message: "角色名不能为空，且不能超过 32 个字。" };
    return runMemberChange(
      sessionId,
      actorId,
      (all, session) => gateNewMember(all, session, targetUserId, info.bot),
      {
        id: createId(),
        type: "add-pl",
        targetUserId,
        beforeRole: null,
        afterRole: "pl",
        beforeChannelAccess: false,
        afterChannelAccess: true,
        nicknameBefore: info.nickname ?? null,
        nicknameAfter: name,
      },
      (current, nick, at) => applyAddPl(current, {
        userId: targetUserId,
        characterName: name,
        originalNickname: nick.originalNickname,
        appliedNickname: nick.changed ? name : null,
      }, at),
    );
  }

  async function addOb(sessionId, actorId, targetUserId) {
    let info;
    try {
      info = await discord.fetchGuildMember(find(sessionId)?.guildId, targetUserId);
    } catch {
      return { ok: false, message: "该成员不在这个服务器里。" };
    }
    return runMemberChange(
      sessionId,
      actorId,
      (all, session) => gateNewMember(all, session, targetUserId, info.bot),
      {
        id: createId(),
        type: "add-ob",
        targetUserId,
        beforeRole: null,
        afterRole: "ob",
        beforeChannelAccess: false,
        afterChannelAccess: true,
      },
      (_current, _nick, at) => applyAddOb(_current, targetUserId, at),
    );
  }

  async function convertObToPl(sessionId, actorId, targetUserId, characterName) {
    const name = normalizeCharacterName(characterName);
    if (!name) return { ok: false, message: "角色名不能为空，且不能超过 32 个字。" };
    let nicknameBefore = null;
    try {
      nicknameBefore = await discord.fetchNickname(find(sessionId)?.guildId, targetUserId);
    } catch {
      nicknameBefore = null;
    }
    return runMemberChange(
      sessionId,
      actorId,
      (_all, session) => (
        memberRole(session, targetUserId) === "OB"
          ? { ok: true }
          : { ok: false, message: "只能把本局 OB 转成 PL。" }
      ),
      {
        id: createId(),
        type: "ob-to-pl",
        targetUserId,
        beforeRole: "ob",
        afterRole: "pl",
        beforeChannelAccess: true,
        afterChannelAccess: true,
        nicknameBefore,
        nicknameAfter: name,
      },
      (current, nick, at) => applyAddPl(current, {
        userId: targetUserId,
        characterName: name,
        originalNickname: nick.originalNickname,
        appliedNickname: nick.changed ? name : null,
      }, at),
    );
  }

  async function convertPlToOb(sessionId, actorId, targetUserId) {
    const current = find(sessionId);
    const pl = current?.pl.find((member) => member.userId === targetUserId);
    const nicknameBefore = pl?.appliedNickname ?? null;
    const nicknameAfter = pl?.appliedNickname ? (pl.originalNickname ?? null) : undefined;
    return runMemberChange(
      sessionId,
      actorId,
      (_all, session) => (
        memberRole(session, targetUserId) === "PL"
          ? { ok: true }
          : { ok: false, message: "只能把本局 PL 转成 OB。" }
      ),
      {
        id: createId(),
        type: "pl-to-ob",
        targetUserId,
        beforeRole: "pl",
        afterRole: "ob",
        beforeChannelAccess: true,
        afterChannelAccess: true,
        ...(nicknameAfter !== undefined ? { nicknameBefore, nicknameAfter } : {}),
      },
      (_current, _nick, at) => applyAddOb(_current, targetUserId, at),
    );
  }

  async function removeMember(sessionId, actorId, targetUserId) {
    const current = find(sessionId);
    const role = current ? memberRole(current, targetUserId) : null;
    const pl = current?.pl.find((member) => member.userId === targetUserId);
    const nicknameBefore = role === "PL" ? (pl?.appliedNickname ?? null) : undefined;
    const nicknameAfter = role === "PL" && pl?.appliedNickname ? (pl.originalNickname ?? null) : undefined;
    return runMemberChange(
      sessionId,
      actorId,
      (_all, session) => {
        const found = memberRole(session, targetUserId);
        if (found === "KP") return { ok: false, message: "不能把 KP 移出本局。" };
        if (found !== "PL" && found !== "OB") return { ok: false, message: "该成员不在本局中。" };
        return { ok: true };
      },
      {
        id: createId(),
        type: role === "PL" ? "remove-pl" : "remove-ob",
        targetUserId,
        beforeRole: role === "PL" ? "pl" : "ob",
        afterRole: null,
        beforeChannelAccess: true,
        afterChannelAccess: false,
        ...(nicknameAfter !== undefined ? { nicknameBefore, nicknameAfter } : {}),
      },
      (_session, _nick, at) => applyRemoveMember(_session, targetUserId, at),
    );
  }

  async function recoverInterrupted() {
    for (const session of sessions().filter((item) => item.pendingMemberOp)) {
      await rollbackPending(session.sessionId);
    }
    const ended = [];
    for (const session of sessions().filter((item) => item.state === SESSION_STATES.starting)) {
      await reconcileStarting(session);
    }
    for (const session of sessions().filter((item) => item.state === SESSION_STATES.ending)) {
      const result = await continueEnding(session.sessionId);
      if (result.ok && result.session?.state === SESSION_STATES.ended) ended.push(result.session);
    }
    await pruneSettled();
    return { ended };
  }

  function previewMembers(sessionId, actorId) {
    if (mode !== "ready") return unavailable(mode === "broken" ? "CoC 场次记录暂时不可用。" : undefined);
    const session = find(sessionId);
    const gate = gateMemberAdmin(session, actorId);
    if (!gate.ok) return gate;
    return { ok: true, session };
  }

  function previewRepost(channelId, actorId) {
    if (mode !== "ready") return unavailable(mode === "broken" ? "CoC 场次记录暂时不可用。" : undefined);
    const session = activeSessionInChannel(sessions(), channelId);
    if (!session) return { ok: false, message: "请到这场跑团自己的频道里重新发送面板。" };
    if (session.kpUserId !== actorId) return { ok: false, message: "只有 KP 可以重新发送控制面板。" };
    return { ok: true, session };
  }

  async function deleteIfDue(sessionId) {
    const session = find(sessionId);
    if (!session || session.state !== SESSION_STATES.ended || session.channelDeleted) return { ok: true, skipped: true };
    if (session.deleteAt == null || session.deleteAt > clock.now()) return { ok: true, skipped: true };
    try {
      if (session.runChannelId) await discord.deleteChannel(session.runChannelId);
    } catch (error) {
      const missing = error?.code === 10003 || error?.discordCode === 10003;
      if (!missing) {
        logger.warn?.("CoC 删除频道失败", { message: error?.message, sessionId });
        return { ok: false, message: "频道还没有删掉，下次启动会再试。" };
      }
    }
    await store.update((state) => {
      const current = state.sessions.find((item) => item.sessionId === sessionId);
      if (!current) return { state, result: null };
      const next = { ...current, channelDeleted: true };
      return { state: { ...state, sessions: replaceSession(state.sessions, next) }, result: next };
    });
    return { ok: true, deleted: true };
  }

  function transcriptControlsEnabled() {
    return transcriptActive();
  }

  function previewTranscriptPrivacy(sessionId, userId) {
    if (mode !== "ready") return unavailable(mode === "broken" ? "CoC 场次记录暂时不可用。" : undefined);
    if (!transcriptControlsEnabled()) return { ok: false, message: "这场跑团当前不整理团录。" };
    const gate = gateTranscriptPrivacy(find(sessionId), userId);
    if (!gate.ok) return gate;
    return { ok: true, optedOut: isTranscriptOptedOut(find(sessionId), userId) };
  }

  async function setTranscriptOptOut(sessionId, userId, optedOut) {
    if (mode !== "ready") return unavailable(mode === "broken" ? "CoC 场次记录暂时不可用。" : undefined);
    if (!transcriptControlsEnabled()) return { ok: false, message: "这场跑团当前不整理团录。" };
    const gate = gateTranscriptPrivacy(find(sessionId), userId);
    if (!gate.ok) return gate;
    const saved = await store.update((state) => {
      const current = state.sessions.find((item) => item.sessionId === sessionId);
      const again = gateTranscriptPrivacy(current, userId);
      if (!again.ok) return { errorCode: "REJECTED", message: again.message };
      const next = withTranscriptOptOut(current, userId, optedOut === true, clock.now());
      return { state: { ...state, sessions: replaceSession(state.sessions, next) }, result: next };
    });
    if (!saved.ok) return { ok: false, message: saved.message };
    return {
      ok: true,
      session: saved.result,
      optedOut: isTranscriptOptedOut(saved.result, userId),
    };
  }

  function hasActiveRunChannel(channelId) {
    return activeSessionInChannel(sessions(), channelId) != null;
  }

  async function rollTextDice({ channelId, userId, content }) {
    if (config.messageContentEnabled !== true) return { ignore: true };
    if (!hasActiveRunChannel(channelId)) return { ignore: true };
    const bonus = parseBonusPenalty(content);
    const parsed = bonus.ok ? null : parseDiceExpression(content);
    if (!bonus.ok && !parsed?.ok) return { ignore: true };
    const session = activeSessionInChannel(sessions(), channelId);
    if (!session) return { ignore: true };
    const role = memberRole(session, userId);
    if (role !== "KP" && role !== "PL") return { ignore: true };
    if (bonus.ok) {
      const rolled = rollBonusPenalty(bonus, randomInt);
      if (!rolled.ok) return { ignore: true };
      return { ok: true, text: formatBonusPenalty(userId, rolled) };
    }
    const rolled = rollDice(parsed, randomInt);
    if (!rolled.ok) return { ignore: true };
    return {
      ok: true,
      text: formatTextDice(userId, rolled),
    };
  }

  async function roll({ channelId, userId, displayName, expression }) {
    if (mode !== "ready") return unavailable(mode === "broken" ? "CoC 场次记录暂时不可用。" : undefined);
    const session = activeSessionInChannel(sessions(), channelId);
    if (!session) {
      return { ok: false, message: "这个骰子功能目前只在小G宝创建的 CoC 跑团房间中使用。" };
    }
    const rolled = rollDice(expression, randomInt);
    if (!rolled.ok) return { ok: false, message: INVALID_DICE_MESSAGE };
    return {
      ok: true,
      text: formatRoll(speakerName(session, userId, displayName), rolled),
    };
  }

  function dueSessions() {
    return sessions().filter((session) => (
      session.state === SESSION_STATES.ended
      && !session.channelDeleted
      && session.deleteAt != null
    ));
  }

  return {
    availability,
    statusMessage,
    markBroken,
    markReady,
    setBotUserId,
    previewOpen,
    openRecruit,
    setRecruitMessage,
    setControlMessage,
    joinPl,
    prepareCharacterSelection,
    selectCharacter,
    joinOb,
    leave,
    previewStart,
    previewCancel,
    previewEnd,
    cancelRecruit,
    confirmStart,
    finish,
    addPl,
    addOb,
    convertObToPl,
    convertPlToOb,
    removeMember,
    previewMembers,
    recoverInterrupted,
    previewRepost,
    deleteIfDue,
    roll,
    rollTextDice,
    hasActiveRunChannel,
    transcriptControlsEnabled,
    previewTranscriptPrivacy,
    setTranscriptOptOut,
    dueSessions,
    find,
  };
}

import { randomBytes } from "crypto";
import { buildRoomOverwrites } from "./channelAccess.js";
import { planChannelNames } from "./channelName.js";
import { formatRoll, rollDice } from "./dice/roller.js";
import { INVALID_DICE_MESSAGE } from "./dice/parser.js";
import { planNicknameRestore } from "./nickname.js";
import {
  activeSessionInChannel,
  createRecruitingSession,
  findOccupyingSession,
  isPrunableSession,
  lockStarting,
  markCancelled,
  markEnded,
  markEnding,
  normalizeTitle,
  participantIds,
  replaceSession,
  requestCancel,
  requestEnd,
  requestStart,
  revertStarting,
  signupKl,
  signupOb,
  cancelSignup,
  speakerName,
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

  function joinKl(sessionId, userId, characterName) {
    return mutateRecruit(sessionId, userId, (all, session) => signupKl(all, session, userId, characterName));
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
    return {
      ok: true,
      text: `确定开始《${session.title}》？\n\nKL：${session.kl.length}\nOB：${session.ob.length}`,
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
    return {
      ok: true,
      text: [
        `确定结束《${session.title}》？`,
        "",
        "结束后会：",
        "• 恢复KL昵称",
        "• 移除KP/KL/OB身份色",
        "• 锁定本频道",
        "• 48小时后删除频道",
      ].join("\n"),
    };
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
    const roleIds = [config.kpRoleId, config.klRoleId, config.obRoleId];
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
    for (const member of session.kl) {
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
      for (const member of session.kl) {
        await discord.addRole(session.guildId, member.userId, config.klRoleId);
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

    let latestKl = session.kl;
    for (const member of session.kl) {
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
          kl: current.kl.map((item) => (item.userId === member.userId ? recorded : item)),
        };
        return { state: { ...state, sessions: replaceSession(state.sessions, next) }, result: next.kl };
      });
      if (!nickSaved.ok) {
        await rollbackStart(
          { ...session, kl: latestKl.map((item) => (item.userId === member.userId ? recorded : item)) },
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
      const next = {
        ...current,
        state: SESSION_STATES.active,
        startedAt: clock.now(),
        runChannelId: channel.id,
        rolesGranted: true,
      };
      return { state: { ...state, sessions: replaceSession(state.sessions, next) }, result: next };
    });
    if (!activated.ok) {
      await rollbackStart(
        { ...session, kl: latestKl },
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

  async function finish(sessionId, actorId) {
    if (mode !== "ready") return unavailable(mode === "broken" ? "CoC 场次记录暂时不可用。" : undefined);
    const session = find(sessionId);
    if (!session) return { ok: false, message: "这场跑团已经不在了。" };
    const gate = requestEnd(session, actorId);
    if (!gate.ok) return gate;
    const ending = await markSessionEnding(sessionId, actorId);
    if (!ending.ok) return { ok: false, message: ending.message };
    await cleanupRoom(ending.result);
    const ended = await markSessionEnded(sessionId);
    if (!ended.ok) return { ok: false, message: ended.message };
    return { ok: true, session: ended.result };
  }

  async function continueEnding(sessionId) {
    const session = find(sessionId);
    if (!session || session.state !== SESSION_STATES.ending) return { ok: true, skipped: true };
    await cleanupRoom(session);
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

  async function recoverInterrupted() {
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
    joinKl,
    joinOb,
    leave,
    previewStart,
    previewCancel,
    previewEnd,
    cancelRecruit,
    confirmStart,
    finish,
    recoverInterrupted,
    previewRepost,
    deleteIfDue,
    roll,
    dueSessions,
    find,
  };
}

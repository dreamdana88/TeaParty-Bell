export const SESSION_STATES = Object.freeze({
  recruiting: "RECRUITING",
  starting: "STARTING",
  active: "ACTIVE",
  ended: "ENDED",
  cancelled: "CANCELLED",
});

export const DELETE_AFTER_MS = 48 * 60 * 60 * 1000;
export const MAX_CHARACTER_NAME = 32;
export const MAX_TITLE = 80;
export const ALREADY_IN_SESSION_MESSAGE = "你当前已经参加了一场 CoC 跑团，请先结束或退出上一场。";

const OCCUPYING = new Set([
  SESSION_STATES.recruiting,
  SESSION_STATES.starting,
  SESSION_STATES.active,
]);

export function involvesUser(session, userId) {
  return session.kpUserId === userId
    || session.kl.some((member) => member.userId === userId)
    || session.ob.some((member) => member.userId === userId);
}

export function findOccupyingSession(sessions, userId, exceptSessionId = null) {
  return sessions.find((session) => (
    OCCUPYING.has(session.state)
    && session.sessionId !== exceptSessionId
    && involvesUser(session, userId)
  )) ?? null;
}

export function normalizeTitle(raw) {
  if (typeof raw !== "string") return null;
  const title = raw.replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
  if (!title || title.length > MAX_TITLE) return null;
  return title;
}

export function normalizeCharacterName(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
  if (!name || name.length > MAX_CHARACTER_NAME) return null;
  return name;
}

function withoutUser(list, userId) {
  return list.filter((member) => member.userId !== userId);
}

/**
 * @param {object[]} sessions
 * @param {object} session
 */
export function replaceSession(sessions, session) {
  return sessions.map((item) => (item.sessionId === session.sessionId ? session : item));
}

export function createRecruitingSession({
  sessionId,
  guildId,
  recruitChannelId,
  recruitMessageId,
  kpUserId,
  title,
  now,
}) {
  return {
    sessionId,
    state: SESSION_STATES.recruiting,
    guildId,
    recruitChannelId,
    recruitMessageId,
    runChannelId: null,
    controlMessageId: null,
    kpUserId,
    title,
    kl: [],
    ob: [],
    createdAt: now,
    startedAt: null,
    endedAt: null,
    deleteAt: null,
    channelDeleted: false,
  };
}

export function signupKl(sessions, session, userId, characterName) {
  if (session.state !== SESSION_STATES.recruiting) {
    return { ok: false, message: "这场招募已经不能报名了。" };
  }
  if (session.kpUserId === userId) {
    return { ok: false, message: "KP 不用再报名调查员或旁观者。" };
  }
  if (findOccupyingSession(sessions, userId, session.sessionId)) {
    return { ok: false, message: ALREADY_IN_SESSION_MESSAGE };
  }
  const name = normalizeCharacterName(characterName);
  if (!name) {
    return { ok: false, message: "角色名不能为空，且不能超过 32 个字。" };
  }
  const previous = session.kl.find((member) => member.userId === userId);
  const next = {
    ...session,
    ob: withoutUser(session.ob, userId),
    kl: [
      ...withoutUser(session.kl, userId),
      {
        userId,
        characterName: name,
        originalNickname: previous?.originalNickname ?? null,
        appliedNickname: previous?.appliedNickname ?? null,
      },
    ],
  };
  return { ok: true, session: next };
}

export function signupOb(sessions, session, userId) {
  if (session.state !== SESSION_STATES.recruiting) {
    return { ok: false, message: "这场招募已经不能报名了。" };
  }
  if (session.kpUserId === userId) {
    return { ok: false, message: "KP 不用再报名调查员或旁观者。" };
  }
  if (findOccupyingSession(sessions, userId, session.sessionId)) {
    return { ok: false, message: ALREADY_IN_SESSION_MESSAGE };
  }
  const next = {
    ...session,
    kl: withoutUser(session.kl, userId),
    ob: session.ob.some((member) => member.userId === userId)
      ? session.ob
      : [...session.ob, { userId }],
  };
  return { ok: true, session: next };
}

export function cancelSignup(session, userId) {
  if (session.state !== SESSION_STATES.recruiting) {
    return { ok: false, message: "这场招募已经不能修改报名了。" };
  }
  if (session.kpUserId === userId) {
    return { ok: false, message: "KP 不能取消自己的开团身份。若要停下，请取消开团。" };
  }
  return {
    ok: true,
    session: {
      ...session,
      kl: withoutUser(session.kl, userId),
      ob: withoutUser(session.ob, userId),
    },
  };
}

export function requestStart(session, actorId) {
  if (actorId !== session.kpUserId) {
    return { ok: false, message: "只有 KP 可以正式开始。" };
  }
  if (session.state !== SESSION_STATES.recruiting) {
    return { ok: false, message: "这场招募已经开始或已经结束。" };
  }
  if (session.kl.length < 1) {
    return { ok: false, message: "至少需要一名调查员才能开团。" };
  }
  return { ok: true };
}

export function lockStarting(session) {
  if (session.state !== SESSION_STATES.recruiting) {
    return { ok: false, message: "这场招募已经在开始，或已经开始了。" };
  }
  return { ok: true, session: { ...session, state: SESSION_STATES.starting } };
}

export function revertStarting(session) {
  if (session.state !== SESSION_STATES.starting) return session;
  return {
    ...session,
    state: SESSION_STATES.recruiting,
    runChannelId: null,
    controlMessageId: null,
  };
}

export function requestCancel(session, actorId) {
  if (actorId !== session.kpUserId) {
    return { ok: false, message: "只有 KP 可以取消开团。" };
  }
  if (session.state !== SESSION_STATES.recruiting) {
    return { ok: false, message: "正式开始之后不能再用取消开团。" };
  }
  return { ok: true };
}

export function markCancelled(session, now) {
  return {
    ...session,
    state: SESSION_STATES.cancelled,
    endedAt: now,
  };
}

export function participantIds(session) {
  return [session.kpUserId, ...session.kl.map((member) => member.userId), ...session.ob.map((member) => member.userId)];
}

export function requestEnd(session, actorId) {
  if (actorId !== session.kpUserId) {
    return { ok: false, message: "只有 KP 可以结束本局。" };
  }
  if (session.state !== SESSION_STATES.active) {
    return { ok: false, message: "这场跑团现在不能结束。" };
  }
  return { ok: true };
}

export function markEnded(session, now) {
  return {
    ...session,
    state: SESSION_STATES.ended,
    endedAt: now,
    deleteAt: now + DELETE_AFTER_MS,
  };
}

export function activeSessionInChannel(sessions, channelId) {
  return sessions.find((session) => (
    session.state === SESSION_STATES.active && session.runChannelId === channelId
  )) ?? null;
}

export function speakerName(session, userId, displayName) {
  const kl = session?.kl.find((member) => member.userId === userId);
  if (kl?.characterName) return kl.characterName;
  return displayName || "调查员";
}

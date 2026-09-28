export const SESSION_STATES = Object.freeze({
  recruiting: "RECRUITING",
  starting: "STARTING",
  active: "ACTIVE",
  ending: "ENDING",
  ended: "ENDED",
  cancelled: "CANCELLED",
});

export const DELETE_AFTER_MS = 48 * 60 * 60 * 1000;
export const SETTLED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_CHARACTER_NAME = 32;
export const MAX_TITLE = 80;
export const ALREADY_IN_SESSION_MESSAGE = "你当前已经参加了一场 CoC 跑团，请先结束或退出上一场。";

const OCCUPYING = new Set([
  SESSION_STATES.recruiting,
  SESSION_STATES.starting,
  SESSION_STATES.active,
  SESSION_STATES.ending,
]);

export function involvesUser(session, userId) {
  return session.kpUserId === userId
    || session.pl.some((member) => member.userId === userId)
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
    rolesGranted: false,
    kpUserId,
    title,
    pl: [],
    pendingMemberOp: null,
    ob: [],
    createdAt: now,
    startedAt: null,
    endedAt: null,
    deleteAt: null,
    channelDeleted: false,
  };
}

export function signupPl(sessions, session, userId, characterName) {
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
  const previous = session.pl.find((member) => member.userId === userId);
  const next = {
    ...session,
    ob: withoutUser(session.ob, userId),
    pl: [
      ...withoutUser(session.pl, userId),
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
    pl: withoutUser(session.pl, userId),
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
      pl: withoutUser(session.pl, userId),
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
  if (session.pl.length < 1) {
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
    rolesGranted: false,
    pl: session.pl.map((member) => ({
      ...member,
      originalNickname: null,
      appliedNickname: null,
    })),
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
  return [session.kpUserId, ...session.pl.map((member) => member.userId), ...session.ob.map((member) => member.userId)];
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

export function markEnding(session, now) {
  if (session.state !== SESSION_STATES.active && session.state !== SESSION_STATES.ending) return null;
  return {
    ...session,
    state: SESSION_STATES.ending,
    endedAt: session.endedAt ?? now,
    deleteAt: session.deleteAt ?? now + DELETE_AFTER_MS,
  };
}

export function markEnded(session, now) {
  return {
    ...session,
    state: SESSION_STATES.ended,
    endedAt: session.endedAt ?? now,
    deleteAt: session.deleteAt ?? now + DELETE_AFTER_MS,
  };
}

export function isPrunableSession(session, now) {
  const settledAt = session.endedAt ?? session.createdAt ?? 0;
  if (now - settledAt < SETTLED_RETENTION_MS) return false;
  if (session.state === SESSION_STATES.cancelled) return true;
  return session.state === SESSION_STATES.ended && session.channelDeleted === true;
}

export function activeSessionInChannel(sessions, channelId) {
  return sessions.find((session) => (
    session.state === SESSION_STATES.active && session.runChannelId === channelId
  )) ?? null;
}

export function speakerName(session, userId, displayName) {
  const pl = session?.pl.find((member) => member.userId === userId);
  if (pl?.characterName) return pl.characterName;
  return displayName || "调查员";
}

export const BUSY_MEMBER_MESSAGE = "小G宝正在处理上一项成员变更，请稍后再试。";

export function memberRole(session, userId) {
  if (session.kpUserId === userId) return "KP";
  if (session.pl.some((member) => member.userId === userId)) return "PL";
  if (session.ob.some((member) => member.userId === userId)) return "OB";
  return null;
}

export function gateMemberAdmin(session, actorId) {
  if (!session) return { ok: false, message: "这场跑团已经不在了。" };
  if (actorId !== session.kpUserId) return { ok: false, message: "只有本局 KP 可以管理成员。" };
  if (session.state !== SESSION_STATES.active) return { ok: false, message: "只有进行中的跑团可以管理成员。" };
  if (session.pendingMemberOp) return { ok: false, message: BUSY_MEMBER_MESSAGE };
  return { ok: true };
}

export function gateNewMember(sessions, session, targetUserId, isBot) {
  if (isBot) return { ok: false, message: "不能把机器人加进跑团。" };
  if (!targetUserId || targetUserId === session.kpUserId) {
    return { ok: false, message: "不能把 KP 再加成 PL 或 OB。" };
  }
  if (memberRole(session, targetUserId)) {
    return { ok: false, message: "该成员已经在本局中，请使用「转换身份」。" };
  }
  if (findOccupyingSession(sessions, targetUserId, session.sessionId)) {
    return { ok: false, message: "该成员当前已经参加另一场 CoC 跑团。" };
  }
  return { ok: true };
}

export function applyAddPl(session, member) {
  return {
    ...session,
    ob: withoutUser(session.ob, member.userId),
    pl: [...withoutUser(session.pl, member.userId), member],
    pendingMemberOp: null,
  };
}

export function applyAddOb(session, userId) {
  return {
    ...session,
    pl: withoutUser(session.pl, userId),
    ob: session.ob.some((member) => member.userId === userId)
      ? session.ob
      : [...session.ob, { userId }],
    pendingMemberOp: null,
  };
}

export function applyObToPl(session, member) {
  return applyAddPl(session, member);
}

export function applyPlToOb(session, userId) {
  return applyAddOb(session, userId);
}

export function applyRemoveMember(session, userId) {
  return {
    ...session,
    pl: withoutUser(session.pl, userId),
    ob: withoutUser(session.ob, userId),
    pendingMemberOp: null,
  };
}

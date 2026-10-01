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
    transcriptOptOutUserIds: [],
    transcriptOptOutSpans: [],
    transcriptSeats: [],
  };
}

export function transcriptOptOutIds(session) {
  const raw = session?.transcriptOptOutUserIds;
  if (!Array.isArray(raw)) return [];
  const ids = [];
  for (const id of raw) {
    if (typeof id === "string" && id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

function finiteTime(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function transcriptTimelineOrigin(session) {
  const times = [session?.createdAt, session?.startedAt]
    .map(finiteTime)
    .filter((value) => value != null);
  if (!times.length) return 0;
  return Math.min(...times);
}

function cleanSeatName(value, fallback) {
  if (typeof value !== "string") return fallback;
  const name = value.replace(/[\r\n\t]/g, " ").replace(/\s+/g, " ").trim();
  return name ? name.slice(0, MAX_CHARACTER_NAME) : fallback;
}

function normalizeSeat(seat) {
  if (!seat || typeof seat.userId !== "string" || !seat.userId) return null;
  if (seat.role !== "kp" && seat.role !== "pl") return null;
  const from = finiteTime(seat.from);
  if (from == null) return null;
  const until = seat.until == null ? null : finiteTime(seat.until);
  if (seat.until != null && until == null) return null;
  return {
    userId: seat.userId,
    role: seat.role,
    name: cleanSeatName(seat.name, seat.role === "kp" ? "KP" : "PL"),
    from,
    until: until != null && until < from ? from : until,
  };
}

function normalizeOptOutSpan(span) {
  if (!span || typeof span.userId !== "string" || !span.userId) return null;
  const from = finiteTime(span.from);
  if (from == null) return null;
  const until = span.until == null ? null : finiteTime(span.until);
  if (span.until != null && until == null) return null;
  return {
    userId: span.userId,
    from,
    until: until != null && until < from ? from : until,
  };
}

function recordedSeats(session) {
  if (!Array.isArray(session?.transcriptSeats)) return null;
  const seats = [];
  for (const seat of session.transcriptSeats) {
    const next = normalizeSeat(seat);
    if (next) seats.push(next);
  }
  return seats;
}

export function beginTranscriptSeats(session) {
  const from = transcriptTimelineOrigin(session);
  const seats = [{
    userId: session.kpUserId,
    role: "kp",
    name: "KP",
    from,
    until: null,
  }];
  for (const member of session.pl ?? []) {
    if (!member?.userId || member.userId === session.kpUserId) continue;
    seats.push({
      userId: member.userId,
      role: "pl",
      name: cleanSeatName(member.characterName, "PL"),
      from,
      until: null,
    });
  }
  return seats;
}

function seatsForRead(session) {
  return recordedSeats(session) ?? beginTranscriptSeats(session);
}

function closePlSeats(seats, userId, at) {
  const time = finiteTime(at);
  return seats.map((seat) => {
    if (seat.userId !== userId || seat.role !== "pl" || seat.until != null) return { ...seat };
    if (time == null) return { ...seat };
    return { ...seat, until: time >= seat.from ? time : seat.from };
  });
}

/**
 * 半开区间 [from, until)。until 为空表示这段身份还没结束。
 * @param {object} session
 * @param {string} userId
 * @param {number} timestamp
 */
export function transcriptSeatAt(session, userId, timestamp) {
  const time = finiteTime(timestamp);
  if (time == null || typeof userId !== "string" || !userId) return null;
  const matches = seatsForRead(session).filter((seat) => (
    seat.userId === userId
    && seat.from <= time
    && (seat.until == null || time < seat.until)
  ));
  matches.sort((left, right) => right.from - left.from);
  return matches[0] ?? null;
}

function recordedOptOutSpans(session) {
  if (!Array.isArray(session?.transcriptOptOutSpans)) return null;
  const spans = [];
  for (const span of session.transcriptOptOutSpans) {
    const next = normalizeOptOutSpan(span);
    if (next) spans.push(next);
  }
  return spans;
}

function spansForRead(session) {
  const recorded = recordedOptOutSpans(session);
  if (recorded) return recorded;
  const from = transcriptTimelineOrigin(session);
  return transcriptOptOutIds(session).map((userId) => ({ userId, from, until: null }));
}

export function transcriptOptedOutAt(session, userId, timestamp) {
  const time = finiteTime(timestamp);
  if (time == null || typeof userId !== "string" || !userId) return false;
  return spansForRead(session).some((span) => (
    span.userId === userId
    && span.from <= time
    && (span.until == null || time < span.until)
  ));
}

export function isTranscriptOptedOut(session, userId) {
  return spansForRead(session).some((span) => span.userId === userId && span.until == null);
}

function openOptOutIds(spans) {
  const ids = [];
  for (const span of spans) {
    if (span.until == null && !ids.includes(span.userId)) ids.push(span.userId);
  }
  return ids;
}

export function withTranscriptOptOut(session, userId, optedOut, at) {
  const spans = spansForRead(session).map((span) => ({ ...span }));
  const time = finiteTime(at) ?? transcriptTimelineOrigin(session);
  const open = spans.find((span) => span.userId === userId && span.until == null);
  if (optedOut) {
    if (!open) spans.push({ userId, from: time, until: null });
  } else if (open) {
    open.until = time >= open.from ? time : open.from;
  }
  return {
    ...session,
    transcriptOptOutSpans: spans,
    transcriptOptOutUserIds: openOptOutIds(spans),
  };
}

export function gateTranscriptPrivacy(session, userId) {
  if (!session) return { ok: false, message: "这场跑团已经不在了。" };
  if (session.state !== SESSION_STATES.active) {
    return { ok: false, message: "只有进行中的跑团可以设置团录。" };
  }
  const role = memberRole(session, userId);
  if (role === "OB") return { ok: false, message: "旁观的发言不会进入团录。" };
  if (role !== "KP" && role !== "PL") {
    return { ok: false, message: "只有本局 KP 和 PL 可以设置团录。" };
  }
  return { ok: true };
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
        ...previous,
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

export function applyAddPl(session, member, at) {
  const transcriptSeats = closePlSeats(seatsForRead(session), member.userId, at);
  const time = finiteTime(at) ?? transcriptTimelineOrigin(session);
  transcriptSeats.push({
    userId: member.userId,
    role: "pl",
    name: cleanSeatName(member.characterName, "PL"),
    from: time,
    until: null,
  });
  return {
    ...session,
    ob: withoutUser(session.ob, member.userId),
    pl: [...withoutUser(session.pl, member.userId), member],
    pendingMemberOp: null,
    transcriptSeats,
  };
}

export function applyAddOb(session, userId, at) {
  return {
    ...session,
    pl: withoutUser(session.pl, userId),
    ob: session.ob.some((member) => member.userId === userId)
      ? session.ob
      : [...session.ob, { userId }],
    pendingMemberOp: null,
    transcriptSeats: closePlSeats(seatsForRead(session), userId, at),
  };
}

export function applyObToPl(session, member, at) {
  return applyAddPl(session, member, at);
}

export function applyPlToOb(session, userId, at) {
  return applyAddOb(session, userId, at);
}

export function applyRemoveMember(session, userId, at) {
  const transcriptSeats = closePlSeats(seatsForRead(session), userId, at);
  const next = withTranscriptOptOut({ ...session, transcriptSeats }, userId, false, at);
  return {
    ...next,
    pl: withoutUser(session.pl, userId),
    ob: withoutUser(session.ob, userId),
    pendingMemberOp: null,
    transcriptSeats,
  };
}

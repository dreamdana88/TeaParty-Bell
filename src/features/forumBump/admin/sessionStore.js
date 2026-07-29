/**
 * Forum Bump 管理员面板会话（内存，10 分钟过期）。
 * customId 仅携带 sessionId，不写 Token / 状态 / 敏感配置。
 */

import { randomBytes } from "crypto";

export const FORUM_BUMP_PANEL_SESSION_TTL_MS = 10 * 60 * 1000;

/**
 * @param {{ now?: () => number, ttlMs?: number }} [options]
 */
export function createForumBumpPanelSessionStore({
  now = () => Date.now(),
  ttlMs = FORUM_BUMP_PANEL_SESSION_TTL_MS,
} = {}) {
  /** @type {Map<string, object>} */
  const sessions = new Map();

  function purge() {
    const t = now();
    for (const [id, s] of sessions) {
      if (!s || s.expiresAt <= t) sessions.delete(id);
    }
  }

  function createSession({
    actorId,
    guildId,
    dynamicConfigRevision,
    draft,
  }) {
    purge();
    if (typeof actorId !== "string" || !actorId) {
      throw new TypeError("session 需要 actorId");
    }
    if (typeof guildId !== "string" || !guildId) {
      throw new TypeError("session 需要 guildId");
    }
    const sessionId = randomBytes(8).toString("hex");
    const session = {
      sessionId,
      actorId,
      guildId,
      dynamicConfigRevision: dynamicConfigRevision ?? null,
      draft: {
        dailyLimit: draft?.dailyLimit ?? null,
        activeStart: draft?.activeStart ?? null,
        activeEnd: draft?.activeEnd ?? null,
        silenceDays: draft?.silenceDays ?? null,
        forumChannelIds: Array.isArray(draft?.forumChannelIds)
          ? [...draft.forumChannelIds]
          : [],
      },
      createdAt: now(),
      expiresAt: now() + ttlMs,
    };
    sessions.set(sessionId, session);
    return { ...session, draft: { ...session.draft, forumChannelIds: [...session.draft.forumChannelIds] } };
  }

  function get(sessionId) {
    purge();
    if (typeof sessionId !== "string") return null;
    const s = sessions.get(sessionId);
    if (!s) return null;
    if (s.expiresAt <= now()) {
      sessions.delete(sessionId);
      return null;
    }
    return {
      ...s,
      draft: {
        ...s.draft,
        forumChannelIds: [...s.draft.forumChannelIds],
      },
    };
  }

  /**
   * 校验 actor / guild / 未过期。
   * @returns {{ ok: true, session } | { ok: false, errorCode: string }}
   */
  function assertOwner(sessionId, { actorId, guildId }) {
    const s = get(sessionId);
    if (!s) {
      return { ok: false, errorCode: "SESSION_EXPIRED" };
    }
    if (s.actorId !== actorId) {
      return { ok: false, errorCode: "SESSION_ACTOR_MISMATCH" };
    }
    if (s.guildId !== guildId) {
      return { ok: false, errorCode: "SESSION_GUILD_MISMATCH" };
    }
    return { ok: true, session: s };
  }

  function updateDraft(sessionId, patch) {
    purge();
    const s = sessions.get(sessionId);
    if (!s || s.expiresAt <= now()) return null;
    if (patch.dailyLimit !== undefined) s.draft.dailyLimit = patch.dailyLimit;
    if (patch.activeStart !== undefined) s.draft.activeStart = patch.activeStart;
    if (patch.activeEnd !== undefined) s.draft.activeEnd = patch.activeEnd;
    if (patch.silenceDays !== undefined) s.draft.silenceDays = patch.silenceDays;
    if (patch.forumChannelIds !== undefined) {
      s.draft.forumChannelIds = [...patch.forumChannelIds];
    }
    // 滑动过期
    s.expiresAt = now() + ttlMs;
    return get(sessionId);
  }

  /**
   * 打开编辑时锚定当前 dynamicConfigRevision，防止旧会话覆盖。
   */
  function touchRevision(sessionId, revision) {
    purge();
    const s = sessions.get(sessionId);
    if (!s || s.expiresAt <= now()) return null;
    s.dynamicConfigRevision = revision ?? null;
    s.expiresAt = now() + ttlMs;
    return get(sessionId);
  }

  function deleteSession(sessionId) {
    sessions.delete(sessionId);
  }

  function clear() {
    sessions.clear();
  }

  function size() {
    purge();
    return sessions.size;
  }

  return {
    createSession,
    get,
    assertOwner,
    updateDraft,
    touchRevision,
    deleteSession,
    clear,
    size,
  };
}

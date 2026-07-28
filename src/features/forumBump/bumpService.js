/**
 * 生产级单帖 Forum Bump Service（环境无关）。
 *
 * 不检查 NODE_ENV / TEST_MODE；不负责 login/destroy。
 * 完整成功 = send 成功且 delete 同一消息成功。
 */

import { ChannelType, PermissionFlagsBits } from "discord.js";
import { isDiscordSnowflake } from "./activityTime.js";
import {
  FORUM_BUMP_AFTER_DELETE_SETTLE_MS,
  FORUM_BUMP_ALLOWED_MENTIONS,
  FORUM_BUMP_CONTENT,
  FORUM_BUMP_CONTENT_LENGTH,
  FORUM_BUMP_DELETE_DELAY_MS,
} from "./bumpConstants.js";
import { evaluateThreadCandidate, SKIP_REASONS } from "./candidateRules.js";
import {
  captureThreadSnapshot,
  forceFetchChannel,
  forceRefreshThreadSnapshot,
} from "./threadSnapshot.js";

function defaultClock() {
  return { now: () => Date.now() };
}

async function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortSignalLike(signal) {
  return signal != null
    && typeof signal === "object"
    && typeof signal.aborted === "boolean";
}

function isAborted(signal) {
  return signal != null && signal.aborted === true;
}

/**
 * 可中断 sleep：使用注入的 sleep，已 abort 时尽快返回。
 * 不依赖真实 setTimeout，便于离线测试。
 */
async function sleepMaybeAbort(sleep, ms, signal) {
  if (isAborted(signal)) return;
  if (!signal || typeof signal.addEventListener !== "function") {
    await sleep(ms);
    return;
  }

  let settled = false;
  await new Promise((resolve) => {
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        signal.removeEventListener?.("abort", onAbort);
      } catch {
        // ignore
      }
      resolve();
    };
    const onAbort = () => finish();
    try {
      signal.addEventListener("abort", onAbort, { once: true });
    } catch {
      // ignore listener failure
    }
    Promise.resolve()
      .then(() => sleep(ms))
      .then(finish, finish);
  });
}

function emptyResultBase() {
  return {
    operation: "forum-bump",
    status: "failed",
    success: false,
    skipped: false,
    cleanupRequired: false,
    diagnosticsComplete: false,
    guildId: null,
    forumChannelId: null,
    threadId: null,
    sentMessageId: null,
    activityAt: null,
    activitySource: null,
    silenceDaysExact: null,
    skipReason: null,
    errorCode: null,
    warnings: [],
    before: null,
    afterSend: null,
    afterDelete: null,
    durationMs: 0,
    abortedAfterSend: false,
  };
}

function isPinnedThread(thread) {
  if (thread?.pinned === true) return true;
  if (thread?.flags && typeof thread.flags.has === "function") {
    try {
      if (thread.flags.has("Pinned") || thread.flags.has(2)) return true;
    } catch {
      // ignore
    }
  }
  if (typeof thread?.flags?.bitfield === "number" && (thread.flags.bitfield & 2) !== 0) {
    return true;
  }
  return false;
}

function readPermissions(thread, botUser) {
  if (!botUser || typeof thread?.permissionsFor !== "function") {
    return { viewChannel: null, sendMessagesInThreads: null };
  }
  let permissions;
  try {
    permissions = thread.permissionsFor(botUser);
  } catch {
    return { viewChannel: null, sendMessagesInThreads: null };
  }
  if (!permissions || typeof permissions.has !== "function") {
    return { viewChannel: null, sendMessagesInThreads: null };
  }
  try {
    return {
      viewChannel: permissions.has(PermissionFlagsBits.ViewChannel),
      sendMessagesInThreads: permissions.has(PermissionFlagsBits.SendMessagesInThreads),
    };
  } catch {
    return { viewChannel: null, sendMessagesInThreads: null };
  }
}

function validateArgs({ guildId, forumChannelId, threadId, policy, signal }) {
  if (!isDiscordSnowflake(guildId)
    || !isDiscordSnowflake(forumChannelId)
    || !isDiscordSnowflake(threadId)) {
    return "BUMP_ARGUMENT_INVALID";
  }
  if (!policy || typeof policy !== "object") {
    return "BUMP_ARGUMENT_INVALID";
  }
  const silenceDays = policy.silenceDays;
  if (!Number.isFinite(silenceDays) || silenceDays <= 0) {
    return "BUMP_ARGUMENT_INVALID";
  }
  const excludedTagIds = policy.excludedTagIds ?? [];
  if (!Array.isArray(excludedTagIds)
    || excludedTagIds.some((id) => !isDiscordSnowflake(String(id)))) {
    return "BUMP_ARGUMENT_INVALID";
  }
  if (policy.skipPinned !== undefined && typeof policy.skipPinned !== "boolean") {
    return "BUMP_ARGUMENT_INVALID";
  }
  if (signal !== undefined && signal !== null && !isAbortSignalLike(signal)) {
    return "BUMP_ARGUMENT_INVALID";
  }
  return null;
}

function mapSkipToErrorCode(skipReason) {
  if (!skipReason) return null;
  if (Object.values(SKIP_REASONS).includes(skipReason)) {
    if (skipReason === SKIP_REASONS.THREAD_WRONG_GUILD) return "WRONG_GUILD";
    if (skipReason === SKIP_REASONS.THREAD_WRONG_PARENT) return "WRONG_FORUM";
    if (skipReason === SKIP_REASONS.THREAD_WRONG_TYPE) return "WRONG_THREAD_TYPE";
    return skipReason;
  }
  return skipReason;
}

async function tryDeleteOnce(sentMessage) {
  if (!sentMessage || typeof sentMessage.delete !== "function") return false;
  try {
    await sentMessage.delete();
    return true;
  } catch {
    return false;
  }
}

function safeDiscordMeta(error) {
  return {
    errorName: typeof error?.name === "string" && error.name.length > 0 ? error.name : "Error",
    discordCode: error?.code ?? null,
  };
}

/**
 * @param {object} options
 * @param {object} options.client
 * @param {object} [options.logger]
 * @param {{ now: () => number }} [options.clock]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @param {string} [options.content] 仅测试注入；生产勿用公开 API 覆盖
 */
export function createForumBumpService({
  client,
  logger,
  clock = defaultClock(),
  sleep = defaultSleep,
  content = FORUM_BUMP_CONTENT,
} = {}) {
  if (!client) {
    throw new TypeError("createForumBumpService 需要 client");
  }

  const contentLength = [...content].length;

  /**
   * @param {object} params
   */
  async function bumpThread({
    guildId,
    forumChannelId,
    threadId,
    policy = {},
    signal,
  } = {}) {
    const startedAt = clock.now();
    const base = emptyResultBase();
    base.guildId = guildId ?? null;
    base.forumChannelId = forumChannelId ?? null;
    base.threadId = threadId ?? null;

    const argError = validateArgs({ guildId, forumChannelId, threadId, policy, signal });
    if (argError) {
      base.status = "failed";
      base.errorCode = argError;
      base.durationMs = Math.max(0, clock.now() - startedAt);
      return base;
    }

    const silenceDays = policy.silenceDays;
    const excludedTagIds = (policy.excludedTagIds ?? []).map(String);
    const skipPinned = policy.skipPinned !== false;

    if (isAborted(signal)) {
      base.status = "cancelled";
      base.errorCode = "BUMP_ABORTED";
      base.durationMs = Math.max(0, clock.now() - startedAt);
      return base;
    }

    if (!client.channels?.fetch) {
      base.status = "failed";
      base.errorCode = "BUMP_UNEXPECTED_FAILED";
      base.durationMs = Math.max(0, clock.now() - startedAt);
      return base;
    }

    // ---- force fetch ----
    let thread;
    let parentForum;
    let before;
    try {
      thread = await forceFetchChannel(client, threadId, { force: true });
      const parentId = thread.parentId ?? thread.parent?.id ?? null;
      if (parentId) {
        try {
          parentForum = await forceFetchChannel(client, parentId, { force: true });
        } catch {
          parentForum = thread.parent ?? null;
        }
      } else {
        parentForum = thread.parent ?? null;
      }
      before = captureThreadSnapshot(thread, parentForum, clock);
      base.before = before;
    } catch (error) {
      base.status = "failed";
      base.errorCode = error?.code === "THREAD_NOT_FOUND" ? "THREAD_NOT_FOUND" : "THREAD_REFRESH_FAILED";
      base.durationMs = Math.max(0, clock.now() - startedAt);
      return base;
    }

    // ---- structural target checks ----
    const actualGuildId = thread.guildId ?? thread.guild?.id ?? null;
    if (actualGuildId !== guildId) {
      base.status = "skipped";
      base.skipped = true;
      base.skipReason = SKIP_REASONS.THREAD_WRONG_GUILD;
      base.errorCode = "WRONG_GUILD";
      base.durationMs = Math.max(0, clock.now() - startedAt);
      return base;
    }

    const actualParentId = thread.parentId ?? thread.parent?.id ?? null;
    if (actualParentId !== forumChannelId) {
      base.status = "skipped";
      base.skipped = true;
      base.skipReason = SKIP_REASONS.THREAD_WRONG_PARENT;
      base.errorCode = "WRONG_FORUM";
      base.durationMs = Math.max(0, clock.now() - startedAt);
      return base;
    }

    if (!parentForum || parentForum.type !== ChannelType.GuildForum) {
      base.status = "skipped";
      base.skipped = true;
      base.skipReason = SKIP_REASONS.THREAD_WRONG_PARENT;
      base.errorCode = "WRONG_FORUM";
      base.durationMs = Math.max(0, clock.now() - startedAt);
      return base;
    }

    if (thread.type !== ChannelType.PublicThread && thread.type !== 11) {
      base.status = "skipped";
      base.skipped = true;
      base.skipReason = SKIP_REASONS.THREAD_WRONG_TYPE;
      base.errorCode = "WRONG_THREAD_TYPE";
      base.durationMs = Math.max(0, clock.now() - startedAt);
      return base;
    }

    // ---- eligibility (D-1 rules) ----
    const permissions = readPermissions(thread, client.user);
    const evaluation = evaluateThreadCandidate({
      id: thread.id,
      type: thread.type,
      guildId: actualGuildId,
      parentId: actualParentId,
      name: thread.name,
      archived: thread.archived,
      locked: thread.locked,
      pinned: isPinnedThread(thread),
      lastMessageId: thread.lastMessageId,
      archiveTimestamp: thread.archiveTimestamp,
      appliedTags: thread.appliedTags,
      autoArchiveDuration: thread.autoArchiveDuration,
      messageCount: thread.messageCount,
      totalMessageSent: thread.totalMessageSent,
    }, {
      guildId,
      forumChannelId,
      silenceDays,
      nowMs: clock.now(),
      excludedTagIds,
      skipPinned,
      permissions,
    });

    base.activityAt = evaluation.activityAt;
    base.activitySource = evaluation.activitySource;
    base.silenceDaysExact = evaluation.silenceDaysExact;

    if (!evaluation.eligible) {
      base.status = "skipped";
      base.skipped = true;
      base.skipReason = evaluation.skipReason;
      base.errorCode = mapSkipToErrorCode(evaluation.skipReason);
      base.durationMs = Math.max(0, clock.now() - startedAt);
      try {
        logger?.info?.("[ForumBump] bump skipped", {
          operation: "forum-bump",
          status: "skipped",
          guildId,
          forumChannelId,
          threadId,
          skipReason: evaluation.skipReason,
          activityAt: evaluation.activityAt,
          silenceDaysExact: evaluation.silenceDaysExact,
        });
      } catch {
        // ignore
      }
      return base;
    }

    if (isAborted(signal)) {
      base.status = "cancelled";
      base.errorCode = "BUMP_ABORTED";
      base.durationMs = Math.max(0, clock.now() - startedAt);
      return base;
    }

    // ---- send ----
    let sentMessage = null;
    let sentMessageId = null;
    try {
      sentMessage = await thread.send({
        content,
        allowedMentions: {
          parse: [],
          users: [],
          roles: [],
          repliedUser: false,
        },
      });
    } catch (error) {
      base.status = "failed";
      base.errorCode = "SEND_FAILED";
      base.durationMs = Math.max(0, clock.now() - startedAt);
      try {
        logger?.warn?.("[ForumBump] send failed", {
          operation: "forum-bump",
          status: "failed",
          guildId,
          forumChannelId,
          threadId,
          errorCode: "SEND_FAILED",
          contentLength,
          ...safeDiscordMeta(error),
        });
      } catch {
        // ignore
      }
      return base;
    }

    sentMessageId = typeof sentMessage?.id === "string" && sentMessage.id.length > 0
      ? sentMessage.id
      : null;
    if (!sentMessageId) {
      base.status = "failed";
      base.errorCode = "SEND_FAILED";
      base.durationMs = Math.max(0, clock.now() - startedAt);
      return base;
    }
    base.sentMessageId = sentMessageId;

    // ---- afterSend snapshot (diagnostic only) ----
    const warnings = [];
    let afterSend = null;
    try {
      const refreshed = await forceRefreshThreadSnapshot(client, threadId, clock);
      afterSend = refreshed.snapshot;
    } catch {
      warnings.push("AFTER_SEND_SNAPSHOT_FAILED");
      afterSend = null;
    }
    base.afterSend = afterSend;

    // ---- wait then delete (abort → skip remaining wait, still delete) ----
    await sleepMaybeAbort(sleep, FORUM_BUMP_DELETE_DELAY_MS, signal);
    const abortedAfterSend = isAborted(signal);

    let deleted = false;
    try {
      if (typeof sentMessage.delete !== "function") {
        throw new Error("message.delete unavailable");
      }
      await sentMessage.delete();
      deleted = true;
    } catch (error) {
      base.status = "failed";
      base.success = false;
      base.cleanupRequired = true;
      base.errorCode = "DELETE_FAILED";
      base.warnings = warnings;
      base.diagnosticsComplete = false;
      base.abortedAfterSend = abortedAfterSend;
      base.durationMs = Math.max(0, clock.now() - startedAt);
      try {
        logger?.error?.("[ForumBump] delete failed", {
          operation: "forum-bump",
          status: "failed",
          guildId,
          forumChannelId,
          threadId,
          sentMessageId,
          cleanupRequired: true,
          errorCode: "DELETE_FAILED",
          ...safeDiscordMeta(error),
        });
      } catch {
        // ignore
      }
      return base;
    }

    // ---- afterDelete settle + snapshot ----
    await sleepMaybeAbort(sleep, FORUM_BUMP_AFTER_DELETE_SETTLE_MS, signal);

    let afterDelete = null;
    let diagnosticsComplete = true;
    try {
      const refreshed = await forceRefreshThreadSnapshot(client, threadId, clock);
      afterDelete = refreshed.snapshot;
    } catch {
      warnings.push("AFTER_DELETE_SNAPSHOT_FAILED");
      afterDelete = null;
      diagnosticsComplete = false;
    }

    if (warnings.includes("AFTER_SEND_SNAPSHOT_FAILED")) {
      diagnosticsComplete = false;
    }

    base.status = "succeeded";
    base.success = true;
    base.cleanupRequired = false;
    base.diagnosticsComplete = diagnosticsComplete;
    base.afterDelete = afterDelete;
    base.warnings = warnings;
    base.abortedAfterSend = abortedAfterSend;
    base.durationMs = Math.max(0, clock.now() - startedAt);

    try {
      logger?.info?.("[ForumBump] bump succeeded", {
        operation: "forum-bump",
        status: "succeeded",
        guildId,
        forumChannelId,
        threadId,
        sentMessageId,
        contentLength,
        durationMs: base.durationMs,
        cleanupRequired: false,
        diagnosticsComplete,
        warnings,
        abortedAfterSend,
      });
    } catch {
      // ignore
    }

    // deleted used for lint; ensure path was taken
    void deleted;
    return base;
  }

  return { bumpThread };
}

export {
  FORUM_BUMP_CONTENT,
  FORUM_BUMP_CONTENT_LENGTH,
  FORUM_BUMP_DELETE_DELAY_MS,
  FORUM_BUMP_AFTER_DELETE_SETTLE_MS,
  FORUM_BUMP_ALLOWED_MENTIONS,
};

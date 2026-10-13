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

function defaultSleep(ms) {
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
 * Client 在任何 Discord fetch/send 前必须可用且 ready。
 * fake client 可实现 isReady() => true。
 * @param {object|null|undefined} client
 * @returns {boolean}
 */
export function isClientReadyForBump(client) {
  if (!client || typeof client.channels?.fetch !== "function") {
    return false;
  }
  if (typeof client.isReady === "function") {
    try {
      if (client.isReady() === false) return false;
    } catch {
      return false;
    }
  }
  if (!client.user) {
    return false;
  }
  return true;
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
    // Array.from 把空槽展开为 undefined，避免 .some 跳过稀疏数组空槽
    || Array.from(excludedTagIds).some((id) => !isDiscordSnowflake(String(id)))) {
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

const SKIP_ERROR_CODES = Object.freeze({
  [SKIP_REASONS.THREAD_WRONG_GUILD]: "WRONG_GUILD",
  [SKIP_REASONS.THREAD_WRONG_PARENT]: "WRONG_FORUM",
  [SKIP_REASONS.THREAD_WRONG_TYPE]: "WRONG_THREAD_TYPE",
});

/** 跳过原因 → errorCode：三种结构性原因有专用码，其余原样。 */
function mapSkipToErrorCode(skipReason) {
  if (!skipReason) return null;
  return Object.hasOwn(SKIP_ERROR_CODES, skipReason) ? SKIP_ERROR_CODES[skipReason] : skipReason;
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
  clock = { now: () => Date.now() },
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
    lifecycle,
  } = {}) {
    const startedAt = clock.now();
    const base = emptyResultBase();
    base.guildId = guildId ?? null;
    base.forumChannelId = forumChannelId ?? null;
    base.threadId = threadId ?? null;

    /** 写入结果字段与耗时并返回（base 默认 status=failed / success=false / cleanupRequired=false）。 */
    const finish = (fields) => {
      Object.assign(base, fields);
      base.durationMs = Math.max(0, clock.now() - startedAt);
      return base;
    };
    const cancelled = () => finish({ status: "cancelled", errorCode: "BUMP_ABORTED" });
    const skip = (skipReason, errorCode) => finish({ status: "skipped", skipped: true, skipReason, errorCode });

    const argError = validateArgs({ guildId, forumChannelId, threadId, policy, signal });
    if (argError) {
      return finish({ errorCode: argError });
    }

    const silenceDays = policy.silenceDays;
    const excludedTagIds = (policy.excludedTagIds ?? []).map(String);
    const skipPinned = policy.skipPinned !== false;

    if (isAborted(signal)) {
      return cancelled();
    }

    if (!isClientReadyForBump(client)) {
      finish({ errorCode: "CLIENT_NOT_READY" });
      logger?.warn?.("[ForumBump] client not ready", {
        operation: "forum-bump",
        status: "failed",
        guildId,
        forumChannelId,
        threadId,
        errorCode: "CLIENT_NOT_READY",
      });
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
      return finish({ errorCode: error?.code === "THREAD_NOT_FOUND" ? "THREAD_NOT_FOUND" : "THREAD_REFRESH_FAILED" });
    }

    // ---- structural target checks ----
    const actualGuildId = thread.guildId ?? thread.guild?.id ?? null;
    if (actualGuildId !== guildId) {
      return skip(SKIP_REASONS.THREAD_WRONG_GUILD, "WRONG_GUILD");
    }

    const actualParentId = thread.parentId ?? thread.parent?.id ?? null;
    if (actualParentId !== forumChannelId
      || !parentForum || parentForum.type !== ChannelType.GuildForum) {
      return skip(SKIP_REASONS.THREAD_WRONG_PARENT, "WRONG_FORUM");
    }

    // ChannelType.PublicThread === 11
    if (thread.type !== ChannelType.PublicThread) {
      return skip(SKIP_REASONS.THREAD_WRONG_TYPE, "WRONG_THREAD_TYPE");
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
      skip(evaluation.skipReason, mapSkipToErrorCode(evaluation.skipReason));
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
      return base;
    }

    if (isAborted(signal)) {
      return cancelled();
    }

    // ---- lifecycle: onBeforeSend（资格通过后、send 前）----
    if (lifecycle && typeof lifecycle.onBeforeSend === "function") {
      try {
        await lifecycle.onBeforeSend({
          guildId,
          forumChannelId,
          threadId,
          before,
        });
      } catch {
        return finish({ errorCode: "LIFECYCLE_BEFORE_SEND_FAILED" });
      }
    }

    if (isAborted(signal)) {
      return cancelled();
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
      finish({ errorCode: "SEND_FAILED" });
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
      return base;
    }

    sentMessageId = typeof sentMessage?.id === "string" && sentMessage.id.length > 0
      ? sentMessage.id
      : null;
    if (!sentMessageId) {
      // send 已返回对象但缺少合法 id：尝试清理一次，不得当普通 SEND_FAILED 直接返回。
      if (sentMessage && typeof sentMessage.delete === "function") {
        const cleaned = await tryDeleteOnce(sentMessage);
        finish({
          cleanupRequired: !cleaned,
          errorCode: cleaned ? "SEND_RESULT_INVALID" : "DELETE_FAILED",
        });
        logger?.error?.("[ForumBump] send result missing message id", {
          operation: "forum-bump",
          status: "failed",
          guildId,
          forumChannelId,
          threadId,
          errorCode: base.errorCode,
          cleanupRequired: base.cleanupRequired,
          contentLength,
        });
        return base;
      }

      finish({ errorCode: "SEND_RESULT_INVALID" });
      logger?.error?.("[ForumBump] send result missing message id and delete", {
        operation: "forum-bump",
        status: "failed",
        guildId,
        forumChannelId,
        threadId,
        errorCode: "SEND_RESULT_INVALID",
        cleanupRequired: false,
        contentLength,
      });
      return base;
    }
    base.sentMessageId = sentMessageId;

    // ---- lifecycle: onMessageSent ----
    if (lifecycle && typeof lifecycle.onMessageSent === "function") {
      try {
        await lifecycle.onMessageSent({
          guildId,
          forumChannelId,
          threadId,
          sentMessageId,
        });
      } catch {
        const cleaned = await tryDeleteOnce(sentMessage);
        return finish({
          cleanupRequired: !cleaned,
          errorCode: cleaned ? "LIFECYCLE_AFTER_SEND_FAILED" : "DELETE_FAILED",
        });
      }
    }

    // ---- afterSend snapshot (diagnostic only) ----
    const warnings = [];
    try {
      base.afterSend = (await forceRefreshThreadSnapshot(client, threadId, clock)).snapshot;
    } catch {
      warnings.push("AFTER_SEND_SNAPSHOT_FAILED");
    }

    // ---- wait then delete (abort → skip remaining wait, still delete) ----
    await sleepMaybeAbort(sleep, FORUM_BUMP_DELETE_DELAY_MS, signal);
    const abortedAfterSend = isAborted(signal);

    try {
      if (typeof sentMessage.delete !== "function") {
        throw new Error("message.delete unavailable");
      }
      await sentMessage.delete();
    } catch (error) {
      finish({ cleanupRequired: true, errorCode: "DELETE_FAILED", warnings, abortedAfterSend });
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
      return base;
    }

    // ---- lifecycle: onMessageDeleted（delete 成功后、afterDelete 诊断前）----
    if (lifecycle && typeof lifecycle.onMessageDeleted === "function") {
      try {
        await lifecycle.onMessageDeleted({
          guildId,
          forumChannelId,
          threadId,
          sentMessageId,
        });
      } catch {
        return finish({ errorCode: "LIFECYCLE_AFTER_DELETE_FAILED", warnings, abortedAfterSend });
      }
    }

    // ---- afterDelete settle + snapshot ----
    await sleepMaybeAbort(sleep, FORUM_BUMP_AFTER_DELETE_SETTLE_MS, signal);

    let afterDelete = null;
    try {
      afterDelete = (await forceRefreshThreadSnapshot(client, threadId, clock)).snapshot;
    } catch {
      warnings.push("AFTER_DELETE_SNAPSHOT_FAILED");
    }
    // 任一诊断快照失败 → diagnosticsComplete=false
    const diagnosticsComplete = warnings.length === 0;

    finish({
      status: "succeeded",
      success: true,
      diagnosticsComplete,
      afterDelete,
      warnings,
      abortedAfterSend,
    });

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

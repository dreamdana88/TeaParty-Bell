/**
 * Forum 临时消息顶帖（发送后删除同一条消息）。
 *
 * 默认 dry-run；仅 --execute 且通过全部安全门后才写 Discord。
 */

import { createForumPocError, isForumPocError } from "./errors.js";
import { blankClientObservations, captureThreadSnapshot } from "./snapshot.js";
import {
  assertBotThreadPermissions,
  assertDevConfigGate,
  loadValidatedForumThread,
  forceRefreshThreadSnapshot,
} from "./threadGate.js";

/** 固定测试文案，不允许 CLI 自定义。 */
export const BUMP_MESSAGE_CONTENT = "【小G宝自动顶帖测试】此消息将自动删除。";

export const BUMP_MESSAGE_CONTENT_LENGTH = [...BUMP_MESSAGE_CONTENT].length;

/** 发送后删除前、删除后采集 afterDelete 前的固定等待（毫秒）。 */
export const BUMP_DELETE_DELAY_MS = 1000;

/** 严格禁止一切 mention 解析。 */
export const BUMP_ALLOWED_MENTIONS = Object.freeze({
  parse: Object.freeze([]),
  users: Object.freeze([]),
  roles: Object.freeze([]),
  repliedUser: false,
});

const MANUAL_CLEANUP_HINT = "临时顶帖消息未能自动删除，请管理员手动清理。";

function defaultClock() {
  return { now: () => Date.now() };
}

async function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeDiscordMeta(error) {
  return {
    errorName: typeof error?.name === "string" && error.name.length > 0 ? error.name : "Error",
    discordCode: error?.code ?? null,
  };
}

/**
 * 发送成功后尝试删除同一条消息（最多一次），用于快照失败时的清理。
 * @returns {Promise<boolean>} 是否删除成功
 */
async function tryDeleteOnce(sentMessage) {
  if (!sentMessage || typeof sentMessage.delete !== "function") {
    return false;
  }
  try {
    await sentMessage.delete();
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {object} options
 * @param {object} options.client
 * @param {object} options.config
 * @param {string} options.threadId
 * @param {string} options.confirmGuild
 * @param {boolean} [options.execute]
 * @param {object} [options.logger]
 * @param {{ now: () => number }} [options.clock]
 * @param {(ms: number) => Promise<void>} [options.sleep]
 * @returns {Promise<object>}
 */
export async function bumpForumThreadMessage({
  client,
  config,
  threadId,
  confirmGuild,
  execute = false,
  logger,
  clock = defaultClock(),
  sleep = defaultSleep,
} = {}) {
  assertDevConfigGate(config, confirmGuild);

  const { thread, parentForum } = await loadValidatedForumThread(
    client,
    config,
    threadId,
    { requireUnlocked: true },
  );

  if (execute) {
    assertBotThreadPermissions(thread, client);
  }

  const before = captureThreadSnapshot(thread, parentForum, clock);
  const clientObservations = blankClientObservations();

  if (!execute) {
    const dryRunResult = {
      operation: "bump-message",
      success: true,
      dryRun: true,
      execute: false,
      plannedAction: {
        sendContentLength: BUMP_MESSAGE_CONTENT_LENGTH,
        allowedMentions: { ...BUMP_ALLOWED_MENTIONS, parse: [], users: [], roles: [] },
        deleteDelayMs: BUMP_DELETE_DELAY_MS,
        afterDeleteSettleMs: BUMP_DELETE_DELAY_MS,
      },
      before,
      afterSend: null,
      afterDelete: null,
      sentMessageId: null,
      cleanupRequired: false,
      clientObservations,
    };

    try {
      logger?.info?.("[ForumPoc] bump-message dry-run", {
        operation: "bump-message",
        dryRun: true,
        guildId: before.guildId,
        forumChannelId: before.forumChannelId,
        threadId: before.threadId,
        contentLength: BUMP_MESSAGE_CONTENT_LENGTH,
        success: true,
      });
    } catch {
      // ignore logger failure
    }

    return dryRunResult;
  }

  const startedAt = clock.now();
  let sentMessage = null;
  let sentMessageId = null;

  try {
    sentMessage = await thread.send({
      content: BUMP_MESSAGE_CONTENT,
      allowedMentions: {
        parse: [],
        users: [],
        roles: [],
        repliedUser: false,
      },
    });
  } catch (error) {
    try {
      logger?.warn?.("[ForumPoc] send failed", {
        operation: "bump-message",
        dryRun: false,
        guildId: before.guildId,
        forumChannelId: before.forumChannelId,
        threadId: before.threadId,
        ...safeDiscordMeta(error),
        errorCode: "SEND_FAILED",
        success: false,
        cleanupRequired: false,
      });
    } catch {
      // ignore
    }
    throw createForumPocError("SEND_FAILED", error);
  }

  sentMessageId =
    sentMessage && typeof sentMessage.id === "string" && sentMessage.id.length > 0
      ? sentMessage.id
      : null;

  if (!sentMessageId) {
    throw createForumPocError("SEND_FAILED");
  }

  let afterSend;
  try {
    const refreshed = await forceRefreshThreadSnapshot(
      client,
      threadId,
      clock,
      captureThreadSnapshot,
    );
    afterSend = refreshed.snapshot;
  } catch (error) {
    const deleted = await tryDeleteOnce(sentMessage);
    const failResult = {
      operation: "bump-message",
      success: false,
      dryRun: false,
      execute: true,
      cleanupRequired: !deleted,
      sentMessageId,
      guildId: before.guildId,
      forumChannelId: before.forumChannelId,
      threadId: before.threadId,
      before,
      afterSend: null,
      afterDelete: null,
      durationMs: Math.max(0, clock.now() - startedAt),
      errorCode: "SNAPSHOT_FAILED",
      safeMessage: createForumPocError("SNAPSHOT_FAILED", error).safeMessage,
      manualCleanupHint: deleted ? null : MANUAL_CLEANUP_HINT,
      clientObservations,
    };

    try {
      logger?.error?.("[ForumPoc] afterSend snapshot refresh failed", {
        operation: "bump-message",
        dryRun: false,
        guildId: failResult.guildId,
        forumChannelId: failResult.forumChannelId,
        threadId: failResult.threadId,
        sentMessageId,
        durationMs: failResult.durationMs,
        before,
        afterSend: null,
        afterDelete: null,
        success: false,
        cleanupRequired: failResult.cleanupRequired,
        errorCode: "SNAPSHOT_FAILED",
        ...safeDiscordMeta(error),
      });
    } catch {
      // ignore
    }

    return failResult;
  }

  await sleep(BUMP_DELETE_DELAY_MS);

  try {
    if (typeof sentMessage.delete !== "function") {
      throw new Error("message.delete unavailable");
    }
    await sentMessage.delete();
  } catch (error) {
    const failResult = {
      operation: "bump-message",
      success: false,
      dryRun: false,
      execute: true,
      cleanupRequired: true,
      sentMessageId,
      guildId: before.guildId,
      forumChannelId: before.forumChannelId,
      threadId: before.threadId,
      before,
      afterSend,
      afterDelete: null,
      durationMs: Math.max(0, clock.now() - startedAt),
      errorCode: "DELETE_FAILED",
      safeMessage: createForumPocError("DELETE_FAILED", error).safeMessage,
      manualCleanupHint: MANUAL_CLEANUP_HINT,
      clientObservations,
    };

    try {
      logger?.error?.("[ForumPoc] delete failed; manual cleanup required", {
        operation: "bump-message",
        dryRun: false,
        guildId: failResult.guildId,
        forumChannelId: failResult.forumChannelId,
        threadId: failResult.threadId,
        sentMessageId,
        durationMs: failResult.durationMs,
        before,
        afterSend,
        afterDelete: null,
        success: false,
        cleanupRequired: true,
        errorCode: "DELETE_FAILED",
        ...safeDiscordMeta(error),
      });
    } catch {
      // ignore
    }

    return failResult;
  }

  // 删除成功后固定等待，再强制刷新 afterDelete（禁止读缓存伪装）。
  await sleep(BUMP_DELETE_DELAY_MS);

  let afterDelete;
  try {
    const refreshed = await forceRefreshThreadSnapshot(
      client,
      threadId,
      clock,
      captureThreadSnapshot,
    );
    afterDelete = refreshed.snapshot;
  } catch (error) {
    const failResult = {
      operation: "bump-message",
      success: false,
      dryRun: false,
      execute: true,
      cleanupRequired: false,
      sentMessageId,
      guildId: before.guildId,
      forumChannelId: before.forumChannelId,
      threadId: before.threadId,
      before,
      afterSend,
      afterDelete: null,
      durationMs: Math.max(0, clock.now() - startedAt),
      errorCode: "SNAPSHOT_FAILED",
      safeMessage: createForumPocError("SNAPSHOT_FAILED", error).safeMessage,
      messageDeleted: true,
      clientObservations,
    };

    try {
      logger?.error?.("[ForumPoc] afterDelete snapshot refresh failed", {
        operation: "bump-message",
        dryRun: false,
        guildId: failResult.guildId,
        forumChannelId: failResult.forumChannelId,
        threadId: failResult.threadId,
        sentMessageId,
        durationMs: failResult.durationMs,
        before,
        afterSend,
        afterDelete: null,
        success: false,
        cleanupRequired: false,
        errorCode: "SNAPSHOT_FAILED",
        ...safeDiscordMeta(error),
      });
    } catch {
      // ignore
    }

    return failResult;
  }

  const durationMs = Math.max(0, clock.now() - startedAt);

  const successResult = {
    operation: "bump-message",
    success: true,
    dryRun: false,
    execute: true,
    cleanupRequired: false,
    sentMessageId,
    guildId: before.guildId,
    forumChannelId: before.forumChannelId,
    threadId: before.threadId,
    before,
    afterSend,
    afterDelete,
    durationMs,
    clientObservations,
  };

  try {
    logger?.info?.("[ForumPoc] bump-message success", {
      operation: "bump-message",
      dryRun: false,
      guildId: successResult.guildId,
      forumChannelId: successResult.forumChannelId,
      threadId: successResult.threadId,
      sentMessageId,
      durationMs,
      before,
      afterSend,
      afterDelete,
      success: true,
      cleanupRequired: false,
      contentLength: BUMP_MESSAGE_CONTENT_LENGTH,
    });
  } catch {
    // ignore
  }

  return successResult;
}

/**
 * 将业务错误统一包装（供 CLI 使用）。
 * @param {unknown} error
 * @returns {import("./errors.js").ForumPocError}
 */
export function normalizeBumpError(error) {
  if (isForumPocError(error)) return error;
  return createForumPocError("SEND_FAILED", error);
}

export { MANUAL_CLEANUP_HINT };

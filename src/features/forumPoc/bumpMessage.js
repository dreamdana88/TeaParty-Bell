/**
 * Forum 临时消息顶帖 POC 层。
 *
 * 保留 Dev Gate、dry-run 与 CLI 输出兼容。
 * 真实发送/删除/资格复核委托正式 forumBump/bumpService。
 */

import {
  FORUM_BUMP_AFTER_DELETE_SETTLE_MS,
  FORUM_BUMP_ALLOWED_MENTIONS,
  FORUM_BUMP_CONTENT,
  FORUM_BUMP_CONTENT_LENGTH,
  FORUM_BUMP_DELETE_DELAY_MS,
  createForumBumpService,
} from "../forumBump/bumpService.js";
import { createForumPocError, isForumPocError } from "./errors.js";
import { blankClientObservations, captureThreadSnapshot } from "./snapshot.js";
import {
  assertBotThreadPermissions,
  assertDevConfigGate,
  loadValidatedForumThread,
} from "./threadGate.js";

/** @deprecated POC 展示用；真实发送使用生产常量 FORUM_BUMP_CONTENT */
export const BUMP_MESSAGE_CONTENT = FORUM_BUMP_CONTENT;
export const BUMP_MESSAGE_CONTENT_LENGTH = FORUM_BUMP_CONTENT_LENGTH;
export const BUMP_DELETE_DELAY_MS = FORUM_BUMP_DELETE_DELAY_MS;
export const BUMP_ALLOWED_MENTIONS = FORUM_BUMP_ALLOWED_MENTIONS;

const MANUAL_CLEANUP_HINT = "临时顶帖消息未能自动删除，请管理员手动清理。";

/**
 * POC 内部默认沉默门槛：1 秒（正有限天数）。
 * 正式调度器会传入真实 silenceDays；POC 仅验证机制与权限。
 */
export const POC_DEFAULT_SILENCE_DAYS = 1 / 86_400;

function defaultClock() {
  return { now: () => Date.now() };
}

async function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * @param {object} options
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
  silenceDays = POC_DEFAULT_SILENCE_DAYS,
  createBumpServiceFn = createForumBumpService,
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
  const forumChannelId = parentForum?.id ?? thread.parentId ?? null;

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
        afterDeleteSettleMs: FORUM_BUMP_AFTER_DELETE_SETTLE_MS,
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
      // ignore
    }

    return dryRunResult;
  }

  if (!forumChannelId) {
    throw createForumPocError("SEND_FAILED");
  }

  const service = createBumpServiceFn({
    client,
    logger,
    clock,
    sleep,
    content: FORUM_BUMP_CONTENT,
  });

  const result = await service.bumpThread({
    guildId: config.discordGuildId,
    forumChannelId,
    threadId,
    policy: {
      silenceDays,
      excludedTagIds: [],
      skipPinned: true,
    },
  });

  // 映射为 POC CLI 兼容结构
  if (result.status === "skipped") {
    const mapped = {
      operation: "bump-message",
      success: false,
      dryRun: false,
      execute: true,
      status: "skipped",
      cleanupRequired: false,
      sentMessageId: null,
      guildId: result.guildId,
      forumChannelId: result.forumChannelId,
      threadId: result.threadId,
      before: result.before ?? before,
      afterSend: null,
      afterDelete: null,
      durationMs: result.durationMs,
      errorCode: result.errorCode,
      skipReason: result.skipReason,
      diagnosticsComplete: false,
      warnings: result.warnings ?? [],
      clientObservations,
    };
    return mapped;
  }

  if (result.status === "cancelled") {
    return {
      operation: "bump-message",
      success: false,
      dryRun: false,
      execute: true,
      status: "cancelled",
      cleanupRequired: false,
      sentMessageId: result.sentMessageId,
      guildId: result.guildId,
      forumChannelId: result.forumChannelId,
      threadId: result.threadId,
      before: result.before ?? before,
      afterSend: result.afterSend,
      afterDelete: result.afterDelete,
      durationMs: result.durationMs,
      errorCode: result.errorCode ?? "BUMP_ABORTED",
      diagnosticsComplete: false,
      warnings: result.warnings ?? [],
      clientObservations,
    };
  }

  if (result.success === true) {
    return {
      operation: "bump-message",
      success: true,
      dryRun: false,
      execute: true,
      status: "succeeded",
      cleanupRequired: false,
      sentMessageId: result.sentMessageId,
      guildId: result.guildId,
      forumChannelId: result.forumChannelId,
      threadId: result.threadId,
      before: result.before ?? before,
      afterSend: result.afterSend,
      afterDelete: result.afterDelete,
      durationMs: result.durationMs,
      diagnosticsComplete: result.diagnosticsComplete,
      warnings: result.warnings ?? [],
      abortedAfterSend: result.abortedAfterSend ?? false,
      clientObservations,
    };
  }

  // failed
  if (result.errorCode === "SEND_FAILED") {
    throw createForumPocError("SEND_FAILED");
  }

  if (result.cleanupRequired) {
    return {
      operation: "bump-message",
      success: false,
      dryRun: false,
      execute: true,
      status: "failed",
      cleanupRequired: true,
      sentMessageId: result.sentMessageId,
      guildId: result.guildId,
      forumChannelId: result.forumChannelId,
      threadId: result.threadId,
      before: result.before ?? before,
      afterSend: result.afterSend,
      afterDelete: null,
      durationMs: result.durationMs,
      errorCode: "DELETE_FAILED",
      safeMessage: createForumPocError("DELETE_FAILED").safeMessage,
      manualCleanupHint: MANUAL_CLEANUP_HINT,
      diagnosticsComplete: false,
      warnings: result.warnings ?? [],
      clientObservations,
    };
  }

  return {
    operation: "bump-message",
    success: false,
    dryRun: false,
    execute: true,
    status: "failed",
    cleanupRequired: false,
    sentMessageId: result.sentMessageId,
    guildId: result.guildId,
    forumChannelId: result.forumChannelId,
    threadId: result.threadId,
    before: result.before ?? before,
    afterSend: result.afterSend,
    afterDelete: result.afterDelete,
    durationMs: result.durationMs,
    errorCode: result.errorCode ?? "SEND_FAILED",
    diagnosticsComplete: result.diagnosticsComplete ?? false,
    warnings: result.warnings ?? [],
    clientObservations,
  };
}

export function normalizeBumpError(error) {
  if (isForumPocError(error)) return error;
  return createForumPocError("SEND_FAILED", error);
}

export { MANUAL_CLEANUP_HINT };

/**
 * Forum Thread 只读 inspect。
 */

import { createForumPocError, isForumPocError } from "./errors.js";
import { blankClientObservations, captureThreadSnapshot } from "./snapshot.js";
import { assertDevConfigGate, loadValidatedForumThread } from "./threadGate.js";

/**
 * @param {object} options
 * @param {object} options.client
 * @param {object} options.config
 * @param {string} options.threadId
 * @param {string} options.confirmGuild
 * @param {object} [options.logger]
 * @param {{ now: () => number }} [options.clock]
 * @returns {Promise<object>}
 */
export async function inspectForumThread({
  client,
  config,
  threadId,
  confirmGuild,
  logger,
  clock = { now: () => Date.now() },
} = {}) {
  assertDevConfigGate(config, confirmGuild);

  try {
    const { thread, parentForum } = await loadValidatedForumThread(
      client,
      config,
      threadId,
      { requireUnlocked: false },
    );

    const snapshot = captureThreadSnapshot(thread, parentForum, clock);
    const result = {
      operation: "inspect",
      success: true,
      dryRun: true,
      snapshot,
      clientObservations: blankClientObservations(),
    };

    try {
      logger?.info?.("[ForumPoc] inspect", {
        operation: "inspect",
        dryRun: true,
        guildId: snapshot.guildId,
        forumChannelId: snapshot.forumChannelId,
        threadId: snapshot.threadId,
        success: true,
      });
    } catch {
      // 日志失败不得影响 inspect 结果
    }

    return result;
  } catch (error) {
    if (isForumPocError(error)) throw error;
    throw createForumPocError("INSPECT_FAILED", error);
  }
}

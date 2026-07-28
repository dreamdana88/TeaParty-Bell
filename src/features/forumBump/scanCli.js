/**
 * Forum 候选扫描 CLI 编排。
 */

import { loadConfig } from "../../config/index.js";
import { createClient as defaultCreateClient } from "../../discord/client.js";
import { logger as defaultLogger } from "../../utils/logger.js";
import { isDiscordSnowflake } from "./activityTime.js";
import { createForumBumpError, isForumBumpError } from "./errors.js";
import { scanForumCandidates } from "./forumScanner.js";

const DEFAULT_DISPLAY_LIMIT = 20;

function createWriter(target) {
  if (typeof target === "function") return target;
  if (target && typeof target.write === "function") {
    return (message) => {
      target.write(`${message}\n`);
    };
  }
  return () => {};
}

/**
 * @param {string[]} argv
 */
export function parseForumScanArgs(argv = []) {
  if (!Array.isArray(argv)) {
    throw createForumBumpError("INVALID_ARGUMENT");
  }

  const forumIds = [];
  const excludedTagIds = [];
  let confirmGuild;
  let silenceDays;
  let displayLimit = DEFAULT_DISPLAY_LIMIT;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--forum") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw createForumBumpError("INVALID_FORUM_ID");
      }
      if (!isDiscordSnowflake(value)) {
        throw createForumBumpError("INVALID_FORUM_ID");
      }
      forumIds.push(value);
      index += 1;
      continue;
    }

    if (argument === "--exclude-tag") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw createForumBumpError("INVALID_EXCLUDED_TAG_ID");
      }
      if (!isDiscordSnowflake(value)) {
        throw createForumBumpError("INVALID_EXCLUDED_TAG_ID");
      }
      excludedTagIds.push(value);
      index += 1;
      continue;
    }

    if (argument === "--confirm-guild") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw createForumBumpError("GUILD_CONFIRMATION_REQUIRED");
      }
      confirmGuild = value;
      index += 1;
      continue;
    }

    if (argument === "--silence-days") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw createForumBumpError("INVALID_SILENCE_DAYS");
      }
      const num = Number(value);
      if (!Number.isFinite(num) || num <= 0) {
        throw createForumBumpError("INVALID_SILENCE_DAYS");
      }
      silenceDays = num;
      index += 1;
      continue;
    }

    if (argument === "--display-limit") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw createForumBumpError("INVALID_DISPLAY_LIMIT");
      }
      const num = Number(value);
      if (!Number.isInteger(num) || num <= 0) {
        throw createForumBumpError("INVALID_DISPLAY_LIMIT");
      }
      displayLimit = num;
      index += 1;
      continue;
    }

    throw createForumBumpError("INVALID_ARGUMENT");
  }

  // Forum 去重，保持首次出现顺序
  const uniqueForums = [];
  const seenForums = new Set();
  for (const id of forumIds) {
    if (seenForums.has(id)) continue;
    seenForums.add(id);
    uniqueForums.push(id);
  }

  const uniqueTags = [];
  const seenTags = new Set();
  for (const id of excludedTagIds) {
    if (seenTags.has(id)) continue;
    seenTags.add(id);
    uniqueTags.push(id);
  }

  if (uniqueForums.length === 0) {
    throw createForumBumpError("FORUM_REQUIRED");
  }
  if (silenceDays == null) {
    throw createForumBumpError("INVALID_SILENCE_DAYS");
  }

  return {
    forumIds: uniqueForums,
    excludedTagIds: uniqueTags,
    confirmGuild,
    silenceDays,
    displayLimit,
  };
}

/**
 * CLI 专用 Dev 安全门（扫描核心环境无关）。
 * @param {object} config
 * @param {string|undefined} confirmGuild
 */
export function assertScanCliDevGate(config, confirmGuild) {
  if (config?.nodeEnv !== "development") {
    throw createForumBumpError("NOT_DEVELOPMENT");
  }
  if (config?.testMode !== true) {
    throw createForumBumpError("TEST_MODE_REQUIRED");
  }
  if (!confirmGuild || typeof confirmGuild !== "string" || confirmGuild.trim().length === 0) {
    throw createForumBumpError("GUILD_CONFIRMATION_REQUIRED");
  }
  if (confirmGuild !== config.discordGuildId) {
    throw createForumBumpError("GUILD_CONFIRMATION_MISMATCH");
  }
}

function safeErrorMessage(error) {
  if (isForumBumpError(error)) return error.safeMessage;
  return "Forum 扫描失败。";
}

function safeErrorCode(error) {
  if (isForumBumpError(error)) return error.code;
  return "SCAN_FAILED";
}

async function safelyDestroy(destroyFn, logger) {
  if (typeof destroyFn !== "function") return;
  try {
    await destroyFn();
  } catch (error) {
    try {
      logger?.warn?.("[ForumBump] client destroy failed", {
        operation: "destroy",
        errorName: typeof error?.name === "string" ? error.name : "Error",
        discordCode: error?.code ?? null,
      });
    } catch {
      // ignore
    }
  }
}

/**
 * 剥离内部字段后再输出。
 * @param {object} report
 */
export function publicScanReport(report) {
  if (!report || typeof report !== "object") return report;
  const { _allEligibleSorted, ...publicReport } = report;
  return publicReport;
}

/**
 * @param {object} [options]
 */
export async function runForumScan({
  argv = [],
  loadConfigFn = loadConfig,
  createClientFn = defaultCreateClient,
  scanFn = scanForumCandidates,
  stdout = process.stdout,
  stderr = process.stderr,
  logger = defaultLogger,
  clock = { now: () => Date.now() },
  fetchActiveThreads,
  fetchArchivedPage,
} = {}) {
  const writeOut = createWriter(stdout);
  const writeErr = createWriter(stderr);

  let args;
  try {
    args = parseForumScanArgs(argv);
  } catch (error) {
    writeErr(safeErrorMessage(error));
    return { exitCode: 2, errorCode: safeErrorCode(error) };
  }

  let config;
  try {
    config = loadConfigFn();
  } catch {
    writeErr("配置读取失败。");
    return { exitCode: 1, errorCode: "INVALID_ARGUMENT" };
  }

  try {
    assertScanCliDevGate(config, args.confirmGuild);
  } catch (error) {
    writeErr(safeErrorMessage(error));
    return { exitCode: 1, errorCode: safeErrorCode(error) };
  }

  const clientBundle = createClientFn();
  const client = clientBundle?.client;
  const login = clientBundle?.login;
  const destroy = clientBundle?.destroy;

  let result;
  let operationError;

  try {
    if (typeof login !== "function") {
      throw createForumBumpError("SCAN_FAILED");
    }
    try {
      logger?.info?.("正在登录 Discord...");
    } catch {
      // ignore
    }
    await login(config.discordBotToken);
    try {
      logger?.info?.("Discord BOT 已就绪");
    } catch {
      // ignore
    }

    result = await scanFn({
      client,
      guildId: config.discordGuildId,
      forumIds: args.forumIds,
      silenceDays: args.silenceDays,
      excludedTagIds: args.excludedTagIds,
      skipPinned: true,
      displayLimit: args.displayLimit,
      logger,
      clock,
      fetchActiveThreads,
      fetchArchivedPage,
    });
  } catch (error) {
    operationError = error;
  }

  await safelyDestroy(destroy, logger);

  if (operationError) {
    writeErr(safeErrorMessage(operationError));
    return {
      exitCode: 1,
      errorCode: safeErrorCode(operationError),
    };
  }

  const publicResult = publicScanReport(result);
  writeOut(JSON.stringify(publicResult, null, 2));
  return { exitCode: 0, result: publicResult };
}

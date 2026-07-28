/**
 * Forum POC CLI 编排：参数解析、生命周期、安全输出。
 *
 * 不直接 process.exit；由入口设置 exitCode。
 */

import { loadConfig } from "../../config/index.js";
import { createClient as defaultCreateClient } from "../../discord/client.js";
import { logger as defaultLogger } from "../../utils/logger.js";
import { bumpForumThreadMessage, MANUAL_CLEANUP_HINT } from "./bumpMessage.js";
import { isForumPocError } from "./errors.js";
import { inspectForumThread } from "./inspect.js";
import { assertDevConfigGate } from "./threadGate.js";

const COMMANDS = new Set(["inspect", "bump-message"]);

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
 * @returns {{ command: string, threadId: string, confirmGuild: string|undefined, execute: boolean }}
 */
export function parseForumPocArgs(argv = []) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error("INVALID_ARGUMENT");
  }

  const command = argv[0];
  if (!COMMANDS.has(command)) {
    throw new Error("INVALID_ARGUMENT");
  }

  let threadId;
  let confirmGuild;
  let execute = false;

  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--execute") {
      if (command !== "bump-message") {
        throw new Error("INVALID_ARGUMENT");
      }
      execute = true;
      continue;
    }
    if (argument === "--thread") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("INVALID_ARGUMENT");
      }
      threadId = value;
      index += 1;
      continue;
    }
    if (argument === "--confirm-guild") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("INVALID_ARGUMENT");
      }
      confirmGuild = value;
      index += 1;
      continue;
    }
    throw new Error("INVALID_ARGUMENT");
  }

  if (!threadId) {
    throw new Error("INVALID_ARGUMENT");
  }

  return { command, threadId, confirmGuild, execute };
}

function safeErrorMessage(error) {
  if (isForumPocError(error)) return error.safeMessage;
  if (error?.message === "INVALID_ARGUMENT") {
    return "Forum POC 参数无效。用法：inspect|bump-message --thread <id> --confirm-guild <guildId> [--execute]";
  }
  return "Forum POC 操作失败。";
}

function safeErrorCode(error) {
  if (isForumPocError(error)) return error.code;
  if (error?.message === "INVALID_ARGUMENT") return "INVALID_ARGUMENT";
  return "INSPECT_FAILED";
}

async function safelyDestroy(destroyFn, logger) {
  if (typeof destroyFn !== "function") return;
  try {
    await destroyFn();
  } catch (error) {
    try {
      logger?.warn?.("[ForumPoc] client destroy failed", {
        operation: "destroy",
        errorName: typeof error?.name === "string" ? error.name : "Error",
        discordCode: error?.code ?? null,
      });
    } catch {
      // destroy 失败不得抛出覆盖业务结果
    }
  }
}

/**
 * @param {object} [options]
 * @returns {Promise<{ exitCode: number, result?: object, errorCode?: string }>}
 */
export async function runForumPoc({
  argv = [],
  loadConfigFn = loadConfig,
  createClientFn = defaultCreateClient,
  inspectFn = inspectForumThread,
  bumpFn = bumpForumThreadMessage,
  stdout = process.stdout,
  stderr = process.stderr,
  logger = defaultLogger,
  clock = { now: () => Date.now() },
  sleep,
} = {}) {
  const writeOut = createWriter(stdout);
  const writeErr = createWriter(stderr);

  let args;
  try {
    args = parseForumPocArgs(argv);
  } catch (error) {
    writeErr(safeErrorMessage(error));
    return { exitCode: 2, errorCode: "INVALID_ARGUMENT" };
  }

  let config;
  try {
    config = loadConfigFn();
  } catch {
    writeErr("配置读取失败。");
    return { exitCode: 1, errorCode: "INVALID_ARGUMENT" };
  }

  // 安全门必须在 createClient / login 之前，拒绝时不得接触 Discord。
  try {
    assertDevConfigGate(config, args.confirmGuild);
  } catch (error) {
    writeErr(safeErrorMessage(error));
    return {
      exitCode: 1,
      errorCode: isForumPocError(error) ? error.code : "INVALID_ARGUMENT",
    };
  }

  const clientBundle = createClientFn();
  const client = clientBundle?.client;
  const login = clientBundle?.login;
  const destroy = clientBundle?.destroy;

  let operationResult;
  let operationError;

  try {
    if (typeof login !== "function") {
      throw new Error("client login unavailable");
    }
    await login(config.discordBotToken);

    if (args.command === "inspect") {
      operationResult = await inspectFn({
        client,
        config,
        threadId: args.threadId,
        confirmGuild: args.confirmGuild,
        logger,
        clock,
      });
    } else {
      operationResult = await bumpFn({
        client,
        config,
        threadId: args.threadId,
        confirmGuild: args.confirmGuild,
        execute: args.execute,
        logger,
        clock,
        sleep,
      });
    }
  } catch (error) {
    operationError = error;
  }

  await safelyDestroy(destroy, logger);

  if (operationError) {
    const code = safeErrorCode(operationError);
    writeErr(safeErrorMessage(operationError));
    return {
      exitCode: code === "INVALID_ARGUMENT" ? 2 : 1,
      errorCode: code,
    };
  }

  if (operationResult && operationResult.success === false) {
    writeOut(JSON.stringify(operationResult, null, 2));
    if (operationResult.cleanupRequired) {
      writeErr(operationResult.manualCleanupHint || MANUAL_CLEANUP_HINT);
    } else if (operationResult.safeMessage) {
      writeErr(operationResult.safeMessage);
    }
    return {
      exitCode: 1,
      result: operationResult,
      errorCode: operationResult.errorCode || "DELETE_FAILED",
    };
  }

  writeOut(JSON.stringify(operationResult, null, 2));
  return { exitCode: 0, result: operationResult };
}

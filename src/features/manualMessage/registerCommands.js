import { Routes } from "discord.js";
import { logger as defaultLogger } from "../../utils/logger.js";
import { allAdminCommandDefinitions } from "../adminCommands.js";

const SAFE_REGISTRATION_ERROR_MESSAGE = "Guild 命令注册失败。";

export class AdminCommandRegistrationError extends Error {
  constructor(code, safeMessage = SAFE_REGISTRATION_ERROR_MESSAGE, cause) {
    super(safeMessage);
    this.name = "AdminCommandRegistrationError";
    this.code = code;
    this.safeMessage = safeMessage;
    this.cause = cause;
  }
}

function safeErrorFields(error) {
  return {
    errorName: typeof error?.name === "string" ? error.name : "Error",
    errorCode: error?.code ?? "COMMAND_REGISTRATION_FAILED",
    errorMessage: SAFE_REGISTRATION_ERROR_MESSAGE,
  };
}

function toCommandJson(definition) {
  if (definition && typeof definition.toJSON === "function") return definition.toJSON();
  if (definition && typeof definition === "object") return { ...definition };
  throw new AdminCommandRegistrationError("INVALID_COMMAND_DEFINITIONS");
}

/**
 * 接受 1+ 个命令定义；不再写死数量为 2。
 * 每项必须含 name。
 */
function normalizeCommandDefinitions(commandDefinitions) {
  if (!Array.isArray(commandDefinitions) || commandDefinitions.length < 1) {
    throw new AdminCommandRegistrationError("INVALID_COMMAND_DEFINITIONS");
  }
  const body = commandDefinitions.map(toCommandJson);
  for (const cmd of body) {
    if (!cmd || typeof cmd.name !== "string" || cmd.name.trim().length === 0) {
      throw new AdminCommandRegistrationError("INVALID_COMMAND_DEFINITIONS");
    }
  }
  return body;
}

export async function registerAdminCommands({
  rest,
  applicationId,
  guildId,
  commandDefinitions = allAdminCommandDefinitions,
  logger = defaultLogger,
} = {}) {
  if (!rest || typeof rest.put !== "function") {
    throw new AdminCommandRegistrationError("INVALID_REST_CLIENT");
  }
  if (typeof applicationId !== "string" || applicationId.trim().length === 0) {
    throw new AdminCommandRegistrationError("INVALID_APPLICATION_ID");
  }
  if (typeof guildId !== "string" || guildId.trim().length === 0) {
    throw new AdminCommandRegistrationError("INVALID_GUILD_ID");
  }

  let body;
  try {
    body = normalizeCommandDefinitions(commandDefinitions);
  } catch (error) {
    if (error instanceof AdminCommandRegistrationError) throw error;
    throw new AdminCommandRegistrationError("INVALID_COMMAND_DEFINITIONS", undefined, error);
  }

  const route = Routes.applicationGuildCommands(applicationId, guildId);
  try {
    await rest.put(route, { body });
  } catch (error) {
    try {
      logger?.error?.("[ManualMessage] Guild 命令同步失败", safeErrorFields(error));
    } catch {
      // 安全诊断日志失败不能改变注册失败语义。
    }
    throw new AdminCommandRegistrationError("COMMAND_REGISTRATION_FAILED", undefined, error);
  }

  return {
    applicationId,
    guildId,
    count: body.length,
    names: body.map((command) => command.name),
  };
}

import { REST } from "discord.js";
import { resolve } from "path";
import { pathToFileURL } from "url";
import { loadConfig } from "../src/config/index.js";
import { logger as defaultLogger } from "../src/utils/logger.js";
import { adminCommandDefinitions } from "../src/features/manualMessage/commands.js";
import {
  AdminCommandRegistrationError,
  registerAdminCommands,
} from "../src/features/manualMessage/registerCommands.js";

const SAFE_CLI_ERROR = "管理员命令注册失败。";

export function parseRegisterCommandArgs(argv = []) {
  let dryRun = false;
  let confirmGuild;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--confirm-guild") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("INVALID_CONFIRM_GUILD");
      }
      confirmGuild = value;
      index += 1;
      continue;
    }
    throw new Error("UNKNOWN_ARGUMENT");
  }

  return { dryRun, confirmGuild };
}

function createWriter(target) {
  if (typeof target === "function") return target;
  if (target && typeof target.write === "function") {
    return (message) => target.write(`${message}\n`);
  }
  return () => {};
}

function createDiscordRest({ token }) {
  return new REST({ version: "10" }).setToken(token);
}

function commandSummary(definitions) {
  return definitions.map((command) => ({
    name: command.name,
    type: command.type,
    default_member_permissions: command.default_member_permissions,
  }));
}

function safeConfigError() {
  return "配置读取失败。";
}

function safeRegistrationError(error) {
  if (error instanceof AdminCommandRegistrationError) return error.safeMessage;
  return SAFE_CLI_ERROR;
}

export async function runRegisterCommands({
  argv = process.argv.slice(2),
  loadConfigFn = loadConfig,
  restFactory = createDiscordRest,
  registerFn = registerAdminCommands,
  stdout = process.stdout,
  stderr = process.stderr,
  logger = defaultLogger,
} = {}) {
  const writeOut = createWriter(stdout);
  const writeErr = createWriter(stderr);

  let args;
  try {
    args = parseRegisterCommandArgs(argv);
  } catch {
    writeErr("参数错误。");
    return { exitCode: 2 };
  }

  let config;
  try {
    config = loadConfigFn();
  } catch {
    writeErr(safeConfigError());
    return { exitCode: 1 };
  }

  if (args.dryRun) {
    writeOut(JSON.stringify({
      mode: "dry-run",
      applicationId: config.discordApplicationId,
      guildId: config.discordGuildId,
      commands: commandSummary(adminCommandDefinitions),
    }));
    return { exitCode: 0, count: adminCommandDefinitions.length };
  }

  if (!args.confirmGuild || args.confirmGuild !== config.discordGuildId) {
    writeErr("必须使用与配置一致的 --confirm-guild 才能注册。");
    return { exitCode: 2 };
  }

  try {
    const rest = restFactory({ token: config.discordBotToken });
    const result = await registerFn({
      rest,
      applicationId: config.discordApplicationId,
      guildId: config.discordGuildId,
      commandDefinitions: adminCommandDefinitions,
      logger,
    });
    writeOut(`已同步 ${result.count} 个 Guild 命令：${result.names.join("、")}`);
    return { exitCode: 0, result };
  } catch (error) {
    writeErr(safeRegistrationError(error));
    return { exitCode: 1 };
  }
}

function isMainModule() {
  if (!process.argv[1]) return false;
  return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}

if (isMainModule()) {
  runRegisterCommands().then(({ exitCode }) => {
    process.exitCode = exitCode;
  }).catch(() => {
    process.stderr.write(`${SAFE_CLI_ERROR}\n`);
    process.exitCode = 1;
  });
}

/**
 * Forum Bump 状态 CLI：init / inspect。
 *
 * 不登录 Discord，不读取 Bot Token，不执行真实顶帖。
 *
 * 用法：
 *   node scripts/forum-bump-state.js init --confirm-guild <id> [--state-path <path>]
 *   node scripts/forum-bump-state.js inspect [--state-path <path>]
 */

import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { existsSync, readFileSync, statSync } from "fs";
import dotenv from "dotenv";
import { createForumBumpStateStore } from "../src/features/forumBump/stateStore.js";
import { getLocalDate } from "../src/features/forumBump/businessTime.js";
import { FORUM_BUMP_STATE_PATH } from "../src/features/forumBump/stateSchema.js";
import { loadForumBumpConfig } from "../src/config/forumBumpConfig.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
dotenv.config({ path: resolve(projectRoot, ".env") });

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--confirm-guild") {
      args.confirmGuild = argv[++i];
    } else if (a === "--state-path") {
      args.statePath = argv[++i];
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    } else if (a.startsWith("--")) {
      args.unknown = a;
    } else {
      args._.push(a);
    }
  }
  return args;
}

function usage() {
  console.log(`Usage:
  npm run forum:state -- init --confirm-guild <DISCORD_GUILD_ID> [--state-path <path>]
  npm run forum:state -- inspect [--state-path <path>]

Notes:
  - Does not login to Discord or read Bot Token
  - init refuses to overwrite existing state (no --force)
`);
}

/**
 * @param {string[]} argv
 * @param {object} [deps]
 */
export async function runForumBumpStateCli(argv, deps = {}) {
  const {
    env = process.env,
    cwd = projectRoot,
    log = console,
    createStore = createForumBumpStateStore,
    nowMs = () => Date.now(),
    exitFn = null,
  } = deps;

  const args = parseArgs(argv);
  if (args.help || args._.length === 0) {
    usage();
    if (exitFn) exitFn(args.help ? 0 : 1);
    return { ok: false, code: "USAGE" };
  }
  if (args.unknown) {
    log.error(`未知参数：${args.unknown}`);
    if (exitFn) exitFn(1);
    return { ok: false, code: "UNKNOWN_ARG" };
  }

  const command = args._[0];
  let fb;
  try {
    fb = loadForumBumpConfig(env, { projectRoot: cwd });
  } catch (err) {
    // init/inspect 仍可用业务时区默认值；guild 校验用 env
    fb = {
      timezone: (env.FORUM_BUMP_TIMEZONE || "Asia/Shanghai").trim() || "Asia/Shanghai",
      statePath: resolve(cwd, (env.FORUM_BUMP_STATE_PATH || FORUM_BUMP_STATE_PATH).trim() || FORUM_BUMP_STATE_PATH),
      guildId: (env.DISCORD_GUILD_ID || "").trim() || null,
    };
    if (command === "init" && err?.code?.startsWith?.("forum_bump") && err.code !== "forum_bump_forum_required" && err.code !== "forum_bump_guild_required") {
      // 非法配置仍应失败；forum 缺失对 init 可接受
      log.error(`配置错误：${err.message}`);
      if (exitFn) exitFn(err.exitCode ?? 78);
      return { ok: false, code: err.code };
    }
  }

  const statePath = args.statePath
    ? resolve(cwd, args.statePath)
    : fb.statePath;

  if (command === "init") {
    const confirmGuild = (args.confirmGuild || "").trim();
    const configGuild = (env.DISCORD_GUILD_ID || "").trim();
    if (!confirmGuild) {
      log.error("init 需要 --confirm-guild <DISCORD_GUILD_ID>");
      if (exitFn) exitFn(1);
      return { ok: false, code: "CONFIRM_GUILD_REQUIRED" };
    }
    if (!configGuild) {
      log.error("环境变量 DISCORD_GUILD_ID 未设置");
      if (exitFn) exitFn(78);
      return { ok: false, code: "GUILD_NOT_CONFIGURED" };
    }
    if (confirmGuild !== configGuild) {
      log.error("--confirm-guild 与 DISCORD_GUILD_ID 不一致");
      if (exitFn) exitFn(78);
      return { ok: false, code: "GUILD_MISMATCH" };
    }
    if (existsSync(statePath)) {
      log.error(`状态文件已存在，拒绝覆盖：${statePath}`);
      if (exitFn) exitFn(1);
      return { ok: false, code: "STATE_ALREADY_EXISTS", statePath };
    }

    const timezone = fb.timezone || "Asia/Shanghai";
    const localDate = getLocalDate(nowMs(), timezone);
    const store = createStore({
      statePath,
      logger: {
        info: () => {},
        warn: () => {},
        error: (...a) => log.error(...a),
      },
    });
    const result = await store.initialize({ localDate });
    if (!result.success) {
      log.error(`initialize 失败：${result.errorCode}`);
      if (exitFn) exitFn(1);
      return { ok: false, code: result.errorCode, statePath };
    }
    log.log(JSON.stringify({
      ok: true,
      command: "init",
      statePath,
      localDate,
      timezone,
      revision: result.revision,
    }, null, 2));
    if (exitFn) exitFn(0);
    return { ok: true, command: "init", statePath, localDate, revision: result.revision };
  }

  if (command === "inspect") {
    if (!existsSync(statePath)) {
      log.error(`状态文件不存在：${statePath}`);
      if (exitFn) exitFn(1);
      return { ok: false, code: "STATE_NOT_FOUND", statePath };
    }

    // 只读：不调用会写盘的 recover
    let raw;
    try {
      raw = readFileSync(statePath, "utf8");
    } catch (err) {
      log.error(`读取失败：${err.message}`);
      if (exitFn) exitFn(1);
      return { ok: false, code: "STATE_READ_FAILED" };
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      log.error("JSON 解析失败（schema 无效）");
      if (exitFn) exitFn(1);
      return { ok: false, code: "STATE_PARSE_FAILED" };
    }

    const store = createStore({
      statePath,
      logger: { info() {}, warn() {}, error() {} },
    });
    const loaded = await store.load();
    if (!loaded.success) {
      log.error(`状态校验失败：${loaded.errorCode}`);
      if (exitFn) exitFn(1);
      return { ok: false, code: loaded.errorCode, statePath };
    }

    const s = loaded.state;
    const mtime = statSync(statePath).mtime.toISOString();
    const report = {
      ok: true,
      command: "inspect",
      statePath,
      exists: true,
      schemaValid: true,
      mtime,
      revision: s.revision,
      localDate: s.localDate,
      successCount: s.successCount,
      lastSuccessAt: s.lastSuccessAt,
      nextEligibleAt: s.nextEligibleAt,
      paused: s.paused,
      pauseReason: s.pauseReason,
      inFlightPhase: s.inFlight?.phase ?? null,
      hasSentMessageId: Boolean(s.inFlight?.sentMessageId),
      // 不输出 Token / 完整 env / stack
    };
    log.log(JSON.stringify(report, null, 2));
    if (exitFn) exitFn(0);
    return report;
  }

  log.error(`未知命令：${command}`);
  usage();
  if (exitFn) exitFn(1);
  return { ok: false, code: "UNKNOWN_COMMAND" };
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runForumBumpStateCli(process.argv.slice(2), {
    exitFn: (code) => process.exit(code),
  }).catch((err) => {
    console.error(`CLI 异常：${err?.message ?? String(err)}`);
    process.exit(1);
  });
}

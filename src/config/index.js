import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..", "..");
dotenv.config({ path: resolve(projectRoot, ".env") });

const REQUIRED_CONFIG = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_APPLICATION_ID",
  "DISCORD_GUILD_ID",
  "DISCORD_THANKS_CHANNEL_ID",
];

const VALID_NODE_ENVS = new Set(["development", "test", "production"]);

/**
 * 配置错误类型，携带建议退出码。
 */
export class ConfigError extends Error {
  /**
   * @param {string} message
   * @param {string} code
   * @param {number} [exitCode=1]
   */
  constructor(message, code, exitCode = 1) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.exitCode = exitCode;
  }
}

export function loadConfig() {
  // ---- NODE_ENV ----
  const rawNodeEnv = (process.env.NODE_ENV || "").trim().toLowerCase();

  let nodeEnv;
  if (!rawNodeEnv) {
    // 完全未设置 → 默认 development
    nodeEnv = "development";
  } else if (VALID_NODE_ENVS.has(rawNodeEnv)) {
    nodeEnv = rawNodeEnv;
  } else {
    // 显式设置了非法值 → 永久配置错误 (exit 78)
    throw new ConfigError(
      `非法的 NODE_ENV "${rawNodeEnv}"。合法值：development | test | production`,
      "invalid_node_env",
      78
    );
  }

  const config = {
    nodeEnv,
    isProduction: nodeEnv === "production",

    // Discord
    discordBotToken: process.env.DISCORD_BOT_TOKEN,
    discordApplicationId: process.env.DISCORD_APPLICATION_ID,
    discordGuildId: process.env.DISCORD_GUILD_ID,
    discordThanksChannelId: process.env.DISCORD_THANKS_CHANNEL_ID,

    // DeepSeek
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
    deepseekBaseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
    deepseekModel: process.env.DEEPSEEK_MODEL || "deepseek-v4-flash",
    deepseekTimeoutMs: validatePositiveInt(
      process.env.DEEPSEEK_TIMEOUT_MS,
      30000
    ),

    // 应用行为
    testMode: stringToBool(process.env.TEST_MODE, false),
    logLevel: process.env.LOG_LEVEL || "info",
    reactionCount: normalizeReactionCount(process.env.REACTION_COUNT),

    // 聚合
    boostAggregationWindowMs: validatePositiveInt(
      process.env.BOOST_AGGREGATION_WINDOW_MS,
      15000
    ),
  };

  const missing = REQUIRED_CONFIG.filter(
    (key) => !process.env[key]
  );

  if (missing.length > 0) {
    throw new ConfigError(
      `缺少必要的环境变量（请检查 .env）：${missing.join(", ")}`,
      "missing_required_config",
      78
    );
  }

  return config;
}

function stringToBool(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  return value === "true" || value === "1";
}

function validatePositiveInt(value, defaultValue) {
  if (value === undefined || value === null || value === "") {
    return defaultValue;
  }
  const num = Number(value);
  if (!Number.isInteger(num) || num <= 0) {
    return defaultValue;
  }
  return num;
}

const REACTION_COUNT_DEFAULT = 10;
const REACTION_COUNT_MIN = 8;
const REACTION_COUNT_MAX = 10;

function normalizeReactionCount(value) {
  if (value === undefined || value === null || value === "") {
    return REACTION_COUNT_DEFAULT;
  }
  const num = Number(value);
  if (!Number.isInteger(num)) {
    return REACTION_COUNT_DEFAULT;
  }
  if (num < REACTION_COUNT_MIN) {
    return REACTION_COUNT_MIN;
  }
  if (num > REACTION_COUNT_MAX) {
    return REACTION_COUNT_MAX;
  }
  return num;
}

import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// 从项目根目录加载 .env
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..", "..");
dotenv.config({ path: resolve(projectRoot, ".env") });

/**
 * Phase 1 必填配置项（Discord 核心）。任何一项缺失都将导致启动失败。
 *
 * DEEPSEEK_API_KEY 不在此列：缺少时 Discord BOT 仍可正常启动，
 * 仅 AI 功能不可用（调用时抛出明确错误）。
 */
const REQUIRED_CONFIG = [
  "DISCORD_BOT_TOKEN",
  "DISCORD_APPLICATION_ID",
  "DISCORD_GUILD_ID",
  "DISCORD_THANKS_CHANNEL_ID",
];

/**
 * 读取配置并校验必填项。
 *
 * @returns {object} 完整配置对象
 * @throws {Error} 如有必填配置缺失
 */
export function loadConfig() {
  const config = {
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
    throw new Error(
      `缺少必要的环境变量（请检查 .env）：${missing.join(", ")}`
    );
  }

  return config;
}

/**
 * 安全地将字符串解析为布尔值。
 * 仅 "true" / "1" 视为 true，其余视为 false。
 */
function stringToBool(value, defaultValue) {
  if (value === undefined || value === null) return defaultValue;
  return value === "true" || value === "1";
}

/**
 * 正整数校验。
 * 非数字、0、负数、非整数均回退到 defaultValue。
 *
 * @param {string|undefined|null} value - 环境变量原始值
 * @param {number} defaultValue - 默认值
 * @returns {number} 有效的正整数
 */
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

/**
 * Reaction 数量归一化（Phase 7）。
 *
 * 业务规则：每条感谢消息 8～10 个 Reaction。
 * 非法值均回退到默认值 10，再钳制到 [8, 10]。
 *
 * @param {string|undefined|null} value - 环境变量 REACTION_COUNT 原始值
 * @returns {number} 8～10 之间的整数
 */
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

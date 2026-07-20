import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// 从项目根目录加载 .env
const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..", "..");
dotenv.config({ path: resolve(projectRoot, ".env") });

/**
 * Phase 1 必填配置项。任何一项缺失都将导致启动失败。
 *
 * DEEPSEEK_API_KEY 在 Phase 4（DeepSeek 接入）之前不强制要求。
 * Phase 4 时将其加入此列表。
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

    // 应用行为
    testMode: stringToBool(process.env.TEST_MODE, false),
    logLevel: process.env.LOG_LEVEL || "info",
    reactionCount: parseInt(process.env.REACTION_COUNT, 10) || 8,
  };

  const missing = REQUIRED_CONFIG.filter(
    (key) => !process.env[key]
  );

  if (missing.length > 0) {
    throw new Error(
      `缺少必要的环境变量（请检查 .env）：${missing.join(", ")}`
    );
  }

  // Phase 4 之前 DeepSeek 未接入，仅提示不阻断
  if (!process.env.DEEPSEEK_API_KEY) {
    console.warn(
      "[WARN] 未设置 DEEPSEEK_API_KEY。Phase 4 接入 DeepSeek 后此项将变为必填。"
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

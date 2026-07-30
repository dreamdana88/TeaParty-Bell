import dotenv from "dotenv";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { ConfigError } from "./configError.js";
import { loadForumBumpConfig } from "./forumBumpConfig.js";
import { logger } from "../utils/logger.js";

export { ConfigError } from "./configError.js";
export { loadForumBumpConfig, FORUM_BUMP_DEFAULTS, FORUM_BUMP_MODES } from "./forumBumpConfig.js";

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
const AI_PROTOCOL = "openai_compatible";
const AI_ENV_KEYS = [
  "AI_PROTOCOL",
  "AI_BASE_URL",
  "AI_CHAT_COMPLETIONS_URL",
  "AI_API_KEY",
  "AI_MODEL",
  "AI_TIMEOUT_MS",
  "AI_AUTH_HEADER",
  "AI_AUTH_SCHEME",
  "AI_BACKEND_LABEL",
  "AI_EXTRA_HEADERS_JSON",
  "AI_EXTRA_BODY_JSON",
];
const LEGACY_AI_ENV_KEYS = [
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "DEEPSEEK_MODEL",
  "DEEPSEEK_TIMEOUT_MS",
];
const PROTECTED_EXTRA_HEADERS = new Set(["content-type", "host", "content-length"]);
const PROTECTED_EXTRA_BODY_FIELDS = new Set(["model", "messages", "stream"]);
let legacyAiDeprecationLogged = false;

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

    // AI Provider（新 AI_* 配置优先；旧 DEEPSEEK_* 仅作兼容读取）
    ...loadAiProviderConfig(process.env),

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

  // Forum Bump（disabled 时不要求 Forum ID；dry_run/execute 严格校验）
  config.forumBump = loadForumBumpConfig(process.env, { projectRoot });

  // TEST_MODE 与 Forum Execute 互斥：不得静默降级为 dry_run
  if (config.testMode === true && config.forumBump.mode === "execute") {
    throw new ConfigError(
      "TEST_MODE=true 时禁止 FORUM_BUMP_MODE=execute。"
      + " Forum Execute 需要 TEST_MODE=false，并使用 Dev Bot / Dev Guild 做人工冒烟。"
      + " 本地无副作用扫描请使用 FORUM_BUMP_MODE=dry_run。",
      "forum_bump_execute_requires_test_mode_false",
      78,
    );
  }

  return config;
}

function loadAiProviderConfig(env) {
  const hasNewAiConfig = AI_ENV_KEYS.some((key) => Object.hasOwn(env, key));
  const hasLegacyAiConfig = LEGACY_AI_ENV_KEYS.some((key) => Object.hasOwn(env, key));

  if (hasNewAiConfig && hasLegacyAiConfig) {
    throw new ConfigError(
      "AI_* 与 DEEPSEEK_* 配置不得混用。请完整迁移到 AI_*，或仅保留旧 DEEPSEEK_* 配置。",
      "mixed_ai_config",
      78,
    );
  }

  if (hasNewAiConfig) return loadNewAiProviderConfig(env);
  return loadLegacyAiProviderConfig(env, hasLegacyAiConfig);
}

function loadNewAiProviderConfig(env) {
  const protocol = normalizedEnv(env, "AI_PROTOCOL") || AI_PROTOCOL;
  if (protocol !== AI_PROTOCOL) {
    throw new ConfigError(
      `不支持的 AI_PROTOCOL "${protocol}"。当前仅支持 ${AI_PROTOCOL}。`,
      "unsupported_ai_protocol",
      78,
    );
  }

  const baseUrl = normalizedEnv(env, "AI_BASE_URL");
  const explicitEndpoint = normalizedEnv(env, "AI_CHAT_COMPLETIONS_URL");
  const model = normalizedEnv(env, "AI_MODEL");
  if (!model || (!baseUrl && !explicitEndpoint)) {
    throw new ConfigError(
      "AI_* 配置不完整：必须设置 AI_MODEL，并设置 AI_BASE_URL 或 AI_CHAT_COMPLETIONS_URL。",
      "incomplete_ai_config",
      78,
    );
  }

  const authHeader = normalizedEnv(env, "AI_AUTH_HEADER") || "Authorization";
  assertSafeAuthHeader(authHeader);
  const extraHeaders = parseExtraHeaders(env.AI_EXTRA_HEADERS_JSON, authHeader);
  const extraBody = parseExtraBody(env.AI_EXTRA_BODY_JSON);

  return {
    aiProtocol: protocol,
    aiBaseUrl: baseUrl,
    aiChatCompletionsUrl: explicitEndpoint || buildChatCompletionsUrl(baseUrl),
    aiApiKey: normalizedEnv(env, "AI_API_KEY"),
    aiRequireApiKey: false,
    aiModel: model,
    aiTimeoutMs: validatePositiveInt(env.AI_TIMEOUT_MS, 30000),
    aiAuthHeader: authHeader,
    aiAuthScheme: normalizedEnv(env, "AI_AUTH_SCHEME") ?? "Bearer",
    aiBackendLabel: normalizedEnv(env, "AI_BACKEND_LABEL") || "OpenAI Compatible",
    aiExtraHeaders: extraHeaders,
    aiExtraBody: extraBody,
    aiConfigSource: "ai",
  };
}

function loadLegacyAiProviderConfig(env, hasLegacyAiConfig) {
  if (hasLegacyAiConfig && !legacyAiDeprecationLogged) {
    legacyAiDeprecationLogged = true;
    logger.warn("DEEPSEEK_* 配置已弃用；请迁移到通用 AI_* 配置。", {
      backendLabel: "DeepSeek (legacy configuration)",
    });
  }

  return {
    aiProtocol: AI_PROTOCOL,
    aiBaseUrl: normalizedEnv(env, "DEEPSEEK_BASE_URL") || "https://api.deepseek.com",
    aiChatCompletionsUrl: buildChatCompletionsUrl(
      normalizedEnv(env, "DEEPSEEK_BASE_URL") || "https://api.deepseek.com",
    ),
    aiApiKey: normalizedEnv(env, "DEEPSEEK_API_KEY"),
    aiRequireApiKey: true,
    aiModel: normalizedEnv(env, "DEEPSEEK_MODEL") || "deepseek-v4-flash",
    aiTimeoutMs: validatePositiveInt(env.DEEPSEEK_TIMEOUT_MS, 30000),
    aiAuthHeader: "Authorization",
    aiAuthScheme: "Bearer",
    aiBackendLabel: "DeepSeek (legacy configuration)",
    aiExtraHeaders: {},
    aiExtraBody: {},
    aiConfigSource: "legacy_deepseek",
  };
}

export function buildChatCompletionsUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
}

function normalizedEnv(env, key) {
  const value = env[key];
  return value === undefined || value === null ? undefined : String(value).trim();
}

function parseJsonObject(value, key) {
  if (value === undefined || value === null || String(value).trim() === "") return {};
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ConfigError(`${key} 必须是合法 JSON 对象。`, "invalid_ai_extra_json", 78);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ConfigError(`${key} 必须是 JSON 对象。`, "invalid_ai_extra_json", 78);
  }
  return parsed;
}

function assertSafeAuthHeader(authHeader) {
  if (PROTECTED_EXTRA_HEADERS.has(authHeader.toLowerCase())) {
    throw new ConfigError(
      "AI_AUTH_HEADER 不得使用 Content-Type、Host 或 Content-Length。",
      "invalid_ai_auth_header",
      78,
    );
  }
}

function parseExtraHeaders(value, authHeader) {
  const parsed = parseJsonObject(value, "AI_EXTRA_HEADERS_JSON");
  for (const [key, headerValue] of Object.entries(parsed)) {
    const lowerKey = key.toLowerCase();
    if (typeof headerValue !== "string") {
      throw new ConfigError(
        "AI_EXTRA_HEADERS_JSON 的所有值必须为字符串。",
        "invalid_ai_extra_headers",
        78,
      );
    }
    if (PROTECTED_EXTRA_HEADERS.has(lowerKey) || lowerKey === authHeader.toLowerCase()) {
      throw new ConfigError(
        "AI_EXTRA_HEADERS_JSON 不得覆盖 Content-Type、Host、Content-Length 或当前鉴权 Header。",
        "protected_ai_extra_header",
        78,
      );
    }
  }
  return parsed;
}

function parseExtraBody(value) {
  const parsed = parseJsonObject(value, "AI_EXTRA_BODY_JSON");
  for (const key of Object.keys(parsed)) {
    if (PROTECTED_EXTRA_BODY_FIELDS.has(key)) {
      throw new ConfigError(
        "AI_EXTRA_BODY_JSON 不得覆盖 model、messages 或 stream。",
        "protected_ai_extra_body",
        78,
      );
    }
  }
  return parsed;
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

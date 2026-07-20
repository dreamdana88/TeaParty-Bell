/**
 * 简易结构化日志模块。
 *
 * 提供 error / warn / info / debug 四个日志等级。
 * 日志等级由配置控制：debug < info < warn < error。
 *
 * 自动过滤已知敏感字段，防止 Token / Key 等进入日志。
 */

const LOG_LEVELS = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const SENSITIVE_KEYS = new Set([
  "token",
  "apiKey",
  "api_key",
  "discordBotToken",
  "deepseekApiKey",
  "authorization",
  "password",
  "secret",
]);

let currentLevel = "info";

/**
 * 由外部注入当前日志等级。
 */
export function setLogLevel(level) {
  const normalized = level.toLowerCase();
  if (!(normalized in LOG_LEVELS)) {
    console.warn(`无效的日志等级 "${level}"，保持当前等级 "${currentLevel}"`);
    return;
  }
  currentLevel = normalized;
}

/**
 * 是否应输出指定等级。
 */
function shouldLog(level) {
  return LOG_LEVELS[level] <= LOG_LEVELS[currentLevel];
}

/**
 * 格式化时间戳（UTC ISO 字符串）。
 */
function timestamp() {
  return new Date().toISOString();
}

/**
 * 对对象中疑似敏感的字段做脱敏处理。
 * 返回浅脱敏后的新对象，不修改原始对象。
 */
function sanitize(obj) {
  if (!obj || typeof obj !== "object") return obj;
  const sanitized = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_KEYS.has(key)) {
      sanitized[key] = "***REDACTED***";
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

/**
 * 格式化日志为单行字符串。
 */
function format(level, message, meta) {
  const ts = timestamp();
  const base = `[${ts}] [${level.toUpperCase()}] ${message}`;
  if (meta !== undefined) {
    const safe = sanitize(meta);
    return `${base} ${JSON.stringify(safe)}`;
  }
  return base;
}

export const logger = {
  error(message, meta) {
    if (shouldLog("error")) console.error(format("error", message, meta));
  },
  warn(message, meta) {
    if (shouldLog("warn")) console.warn(format("warn", message, meta));
  },
  info(message, meta) {
    if (shouldLog("info")) console.info(format("info", message, meta));
  },
  debug(message, meta) {
    if (shouldLog("debug")) console.debug(format("debug", message, meta));
  },
};

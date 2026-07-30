/**
 * config/index.js 自动测试（NODE_ENV + ConfigError）。
 *
 * 运行：node src/config/index.test.js
 */

import { loadConfig, ConfigError } from "./index.js";

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  if (actual === expected) { passed++; console.log(`  PASS: ${label} (${JSON.stringify(expected)})`); }
  else { failed++; console.error(`  FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

const SAVED_ENV = { ...process.env };
function setEnv(key, value) {
  if (value == null) delete process.env[key];
  else process.env[key] = value;
}
function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in SAVED_ENV)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(SAVED_ENV)) {
    process.env[key] = value;
  }
}
function setRequired() {
  setEnv("DISCORD_BOT_TOKEN", "t");
  setEnv("DISCORD_APPLICATION_ID", "t");
  // 合法 Snowflake：避免 .env 中 FORUM_BUMP_MODE=dry_run/execute 时 guild 校验失败
  setEnv("DISCORD_GUILD_ID", "1047080654573158420");
  setEnv("DISCORD_THANKS_CHANNEL_ID", "t");
  // 配置单测默认禁用 Forum，避免依赖真实 Forum ID
  setEnv("FORUM_BUMP_MODE", "disabled");
  clearAiEnv();
}

function clearAiEnv() {
  for (const key of [
    "AI_PROTOCOL", "AI_BASE_URL", "AI_CHAT_COMPLETIONS_URL", "AI_API_KEY", "AI_MODEL",
    "AI_TIMEOUT_MS", "AI_AUTH_HEADER", "AI_AUTH_SCHEME", "AI_BACKEND_LABEL",
    "AI_EXTRA_HEADERS_JSON", "AI_EXTRA_BODY_JSON",
    "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL", "DEEPSEEK_MODEL", "DEEPSEEK_TIMEOUT_MS",
  ]) setEnv(key, null);
}

// ============================
// NODE_ENV=production
// ============================
{ restoreEnv(); setRequired(); setEnv("NODE_ENV", "production");
  const c = loadConfig(); assertEqual(c.nodeEnv, "production", "production"); assert(c.isProduction); }

// NODE_ENV=development
{ restoreEnv(); setRequired(); setEnv("NODE_ENV", "development");
  const c = loadConfig(); assertEqual(c.nodeEnv, "development", "development"); assert(!c.isProduction); }

// NODE_ENV=test
{ restoreEnv(); setRequired(); setEnv("NODE_ENV", "test");
  const c = loadConfig(); assertEqual(c.nodeEnv, "test", "test"); assert(!c.isProduction); }

// NODE_ENV 未设置 → 默认 development
{ restoreEnv(); setRequired(); setEnv("NODE_ENV", null);
  const c = loadConfig(); assertEqual(c.nodeEnv, "development", "未设置→development"); assert(!c.isProduction); }

// 非法 NODE_ENV → 抛出 ConfigError with exitCode 78
{ restoreEnv(); setRequired(); setEnv("NODE_ENV", "staging");
  try {
    loadConfig();
    failed++; console.error("  FAIL: 非法 NODE_ENV 应抛出 ConfigError");
  } catch (err) {
    assert(err instanceof ConfigError, "抛出 ConfigError");
    assertEqual(err.code, "invalid_node_env", "code=invalid_node_env");
    assertEqual(err.exitCode, 78, "exitCode=78");
    passed++; console.log("  PASS: 非法 NODE_ENV 抛出 ConfigError（exit 78）");
  }
}

// NODE_ENV=PRODUCTION（大小写）→ production
{ restoreEnv(); setRequired(); setEnv("NODE_ENV", "PRODUCTION");
  const c = loadConfig(); assertEqual(c.nodeEnv, "production", "PRODUCTION 归一化"); }

// 缺失必填配置 → ConfigError exit 78
{ restoreEnv();
  // 清除所有 Discord 必填配置（restoreEnv 可能从 .env 恢复了这些值）
  setEnv("DISCORD_BOT_TOKEN", null);
  setEnv("DISCORD_APPLICATION_ID", null);
  setEnv("DISCORD_GUILD_ID", null);
  setEnv("DISCORD_THANKS_CHANNEL_ID", null);
  setEnv("NODE_ENV", "production");
  try {
    loadConfig();
    failed++; console.error("  FAIL: 缺失必填配置应抛出");
  } catch (err) {
    assert(err instanceof ConfigError, "抛出 ConfigError");
    assert(err.message.includes("缺少必要的环境变量"), "提示缺少变量");
    assertEqual(err.exitCode, 78, "missing config exit 78");
    passed++; console.log("  PASS: 缺失必填配置 ConfigError exit 78");
  }
}

// ============================
// 通用 AI Provider 配置
// ============================
{ restoreEnv(); setRequired();
  setEnv("AI_PROTOCOL", "openai_compatible");
  setEnv("AI_BASE_URL", "https://proxy.example/v1/");
  setEnv("AI_API_KEY", "test-key");
  setEnv("AI_MODEL", "vendor/model");
  setEnv("AI_TIMEOUT_MS", "12345");
  setEnv("AI_BACKEND_LABEL", "Proxy");
  const c = loadConfig();
  assertEqual(c.aiConfigSource, "ai", "完整 AI_* 正常加载");
  assertEqual(c.aiChatCompletionsUrl, "https://proxy.example/v1/chat/completions", "Base URL 正确拼接");
  assertEqual(c.aiModel, "vendor/model", "AI_MODEL 正常加载");
  assertEqual(c.aiTimeoutMs, 12345, "AI_TIMEOUT_MS 正常加载");
}

{ restoreEnv(); setRequired();
  setEnv("AI_BASE_URL", "https://proxy.example/v1");
  setEnv("AI_CHAT_COMPLETIONS_URL", "https://override.example/custom/chat");
  setEnv("AI_MODEL", "m");
  const c = loadConfig();
  assertEqual(c.aiChatCompletionsUrl, "https://override.example/custom/chat", "完整 Endpoint 覆盖 Base URL");
}

{ restoreEnv(); setRequired(); setEnv("AI_MODEL", "m");
  try { loadConfig(); assert(false, "部分 AI_* 应拒绝启动"); }
  catch (err) { assert(err instanceof ConfigError && err.code === "incomplete_ai_config", "部分 AI_* 拒绝启动"); }
}

{ restoreEnv(); setRequired();
  setEnv("AI_BASE_URL", "https://proxy.example/v1"); setEnv("AI_MODEL", "m");
  setEnv("DEEPSEEK_API_KEY", "old-key");
  try { loadConfig(); assert(false, "两套 AI 配置混用应拒绝启动"); }
  catch (err) { assert(err instanceof ConfigError && err.code === "mixed_ai_config", "不允许两套配置混用"); }
}

{ restoreEnv(); setRequired();
  setEnv("DEEPSEEK_API_KEY", "old-key"); setEnv("DEEPSEEK_BASE_URL", "https://legacy.example/"); setEnv("DEEPSEEK_MODEL", "legacy-model");
  const c = loadConfig();
  assertEqual(c.aiConfigSource, "legacy_deepseek", "旧 DEEPSEEK_* 正常兼容");
  assertEqual(c.aiChatCompletionsUrl, "https://legacy.example/chat/completions", "旧 Base URL 走通用 Endpoint");
}

{ restoreEnv(); setRequired();
  setEnv("AI_BASE_URL", "https://proxy.example/v1"); setEnv("AI_MODEL", "m");
  setEnv("AI_AUTH_HEADER", "X-API-Key"); setEnv("AI_AUTH_SCHEME", "Token");
  setEnv("AI_EXTRA_HEADERS_JSON", '{"X-Trace":"test"}'); setEnv("AI_EXTRA_BODY_JSON", '{"top_p":0.8}');
  const c = loadConfig();
  assertEqual(c.aiAuthHeader, "X-API-Key", "自定义鉴权 Header");
  assertEqual(c.aiAuthScheme, "Token", "自定义鉴权 Scheme");
  assert(JSON.stringify(c.aiExtraHeaders) === JSON.stringify({ "X-Trace": "test" }), "Extra Headers 正常注入");
  assert(JSON.stringify(c.aiExtraBody) === JSON.stringify({ top_p: 0.8 }), "Extra Body 正常注入");
}

for (const [key, value, code] of [
  ["AI_EXTRA_HEADERS_JSON", "{", "invalid_ai_extra_json"],
  ["AI_EXTRA_HEADERS_JSON", '["bad"]', "invalid_ai_extra_json"],
  ["AI_EXTRA_HEADERS_JSON", '{"X-Number":1}', "invalid_ai_extra_headers"],
  ["AI_EXTRA_BODY_JSON", "{", "invalid_ai_extra_json"],
  ["AI_EXTRA_BODY_JSON", '{"model":"override"}', "protected_ai_extra_body"],
  ["AI_EXTRA_HEADERS_JSON", '{"Authorization":"override"}', "protected_ai_extra_header"],
]) {
  restoreEnv(); setRequired(); setEnv("AI_BASE_URL", "https://proxy.example/v1"); setEnv("AI_MODEL", "m"); setEnv(key, value);
  try { loadConfig(); assert(false, `${key} 非法值应拒绝`); }
  catch (err) { assert(err instanceof ConfigError && err.code === code, `${key} 非法值拒绝`); }
}

restoreEnv();
console.log(`\n[config.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);

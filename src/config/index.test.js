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
  setEnv("DISCORD_GUILD_ID", "t");
  setEnv("DISCORD_THANKS_CHANNEL_ID", "t");
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

restoreEnv();
console.log(`\n[config.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);

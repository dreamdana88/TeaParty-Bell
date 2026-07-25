/**
 * config/index.js 自动测试（NODE_ENV 支持）。
 *
 * 运行：node src/config/index.test.js
 *
 * 注意：config 模块在 import 时即执行 dotenv.config()，
 * 测试通过直接操作 process.env 来验证。
 */

import { loadConfig } from "./index.js";

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

// ---- 保存/恢复 process.env ----
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

// ---- 设置必要配置（避免必填校验失败）----
function setRequiredConfig() {
  setEnv("DISCORD_BOT_TOKEN", "test-token");
  setEnv("DISCORD_APPLICATION_ID", "test-app-id");
  setEnv("DISCORD_GUILD_ID", "test-guild-id");
  setEnv("DISCORD_THANKS_CHANNEL_ID", "test-channel-id");
}

// ============================
// Test: NODE_ENV=production
// ============================

{
  restoreEnv();
  setRequiredConfig();
  setEnv("NODE_ENV", "production");

  const config = loadConfig();
  assertEqual(config.nodeEnv, "production", "NODE_ENV=production → nodeEnv=production");
  assert(config.isProduction, "NODE_ENV=production → isProduction=true");
}

// ============================
// Test: NODE_ENV=development
// ============================

{
  restoreEnv();
  setRequiredConfig();
  setEnv("NODE_ENV", "development");

  const config = loadConfig();
  assertEqual(config.nodeEnv, "development", "NODE_ENV=development → nodeEnv=development");
  assert(!config.isProduction, "NODE_ENV=development → isProduction=false");
}

// ============================
// Test: NODE_ENV=test
// ============================

{
  restoreEnv();
  setRequiredConfig();
  setEnv("NODE_ENV", "test");

  const config = loadConfig();
  assertEqual(config.nodeEnv, "test", "NODE_ENV=test → nodeEnv=test");
  assert(!config.isProduction, "NODE_ENV=test → isProduction=false");
}

// ============================
// Test: NODE_ENV 未设置 → 默认 development
// ============================

{
  restoreEnv();
  setRequiredConfig();
  setEnv("NODE_ENV", null);

  const config = loadConfig();
  assertEqual(config.nodeEnv, "development", "NODE_ENV 未设置 → 默认 development");
  assert(!config.isProduction, "默认 isProduction=false");
}

// ============================
// Test: 非法 NODE_ENV → 默认 development + warning
// ============================

{
  restoreEnv();
  setRequiredConfig();
  setEnv("NODE_ENV", "staging");

  // 非法值应回退到 development
  const config = loadConfig();
  assertEqual(config.nodeEnv, "development", "非法 NODE_ENV → 回退 development");
  assert(!config.isProduction, "非法 NODE_ENV → isProduction=false");
}

// ============================
// Test: NODE_ENV 大小写
// ============================

{
  restoreEnv();
  setRequiredConfig();
  setEnv("NODE_ENV", "PRODUCTION");

  const config = loadConfig();
  assertEqual(config.nodeEnv, "production", "NODE_ENV=PRODUCTION → 归一化为 production");
}

{
  restoreEnv();
  setRequiredConfig();
  setEnv("NODE_ENV", "Production");

  const config = loadConfig();
  assertEqual(config.nodeEnv, "production", "NODE_ENV=Production → 归一化为 production");
}

// ============================
// 清理
// ============================

restoreEnv();

console.log(`\n[config.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);

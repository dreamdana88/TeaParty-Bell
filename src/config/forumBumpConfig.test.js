/**
 * Forum Bump 配置解析测试。
 */
import {
  loadForumBumpConfig,
  parseSnowflakeList,
  parseStrictBool,
  parseStrictInt,
  FORUM_BUMP_DEFAULTS,
} from "./forumBumpConfig.js";
import { ConfigError } from "./configError.js";

let passed = 0;
let failed = 0;
function assert(c, l) {
  if (c) { passed++; console.log(`  PASS: ${l}`); }
  else { failed++; console.error(`  FAIL: ${l}`); }
}
function assertEqual(a, e, l) {
  assert(a === e, `${l} (got ${JSON.stringify(a)})`);
}

const G = "1047080654573158420";
const F = "1420375965963653180";
const F2 = "1420375965963653181";

function baseEnv(extra = {}) {
  return {
    DISCORD_GUILD_ID: G,
    ...extra,
  };
}

console.log("\n=== forumBumpConfig ===\n");

// 默认 disabled
{
  const c = loadForumBumpConfig(baseEnv({}), { projectRoot: "/tmp/proj" });
  assertEqual(c.mode, "disabled", "默认 mode=disabled");
  assertEqual(c.forumChannelIds.length, 0, "disabled 时 Forum 可空");
  assertEqual(c.dailyLimit, 3, "默认 dailyLimit=3");
  assertEqual(c.cooldownMs, 40 * 60 * 1000, "默认 cooldown 40min");
  assert(c.statePath.replace(/\\/g, "/").endsWith("data/runtime/forum-bump/state.json"), "默认 statePath");
}

// disabled 不要求 forum
{
  const c = loadForumBumpConfig(baseEnv({ FORUM_BUMP_MODE: "disabled" }), { projectRoot: "/tmp" });
  assertEqual(c.mode, "disabled", "显式 disabled");
  assertEqual(c.forumChannelIds.length, 0, "disabled 无 forum ok");
}

// dry_run 无 forum 失败
{
  try {
    loadForumBumpConfig(baseEnv({ FORUM_BUMP_MODE: "dry_run" }), { projectRoot: "/tmp" });
    failed++; console.error("  FAIL: dry_run 无 forum 应抛");
  } catch (e) {
    assert(e instanceof ConfigError, "dry_run 无 forum ConfigError");
    assertEqual(e.code, "forum_bump_forum_required", "dry_run forum required code");
  }
}

// execute 无 forum 失败
{
  try {
    loadForumBumpConfig(baseEnv({ FORUM_BUMP_MODE: "execute" }), { projectRoot: "/tmp" });
    failed++; console.error("  FAIL: execute 无 forum 应抛");
  } catch (e) {
    assertEqual(e.code, "forum_bump_forum_required", "execute forum required");
  }
}

// 未知 mode
{
  try {
    loadForumBumpConfig(baseEnv({ FORUM_BUMP_MODE: "prod" }), { projectRoot: "/tmp" });
    failed++; console.error("  FAIL: 未知 mode 应抛");
  } catch (e) {
    assertEqual(e.code, "forum_bump_mode_invalid", "未知 mode");
  }
}

// Snowflake 列表 trim / 去重
{
  const list = parseSnowflakeList(` ${F}, ${F2} , ${F} ,,`, "X");
  assertEqual(list.length, 2, "去重后 2");
  assertEqual(list[0], F, "保序 first");
  assertEqual(list[1], F2, "保序 second");
}

// 非法 Snowflake
{
  try {
    parseSnowflakeList("not-a-id", "X");
    failed++; console.error("  FAIL: 非法 snowflake");
  } catch (e) {
    assert(e instanceof ConfigError, "非法 snowflake ConfigError");
  }
}

// dailyLimit 边界
{
  const c1 = loadForumBumpConfig(baseEnv({
    FORUM_BUMP_MODE: "execute",
    FORUM_BUMP_FORUM_CHANNEL_IDS: F,
    FORUM_BUMP_DAILY_LIMIT: "1",
  }), { projectRoot: "/tmp" });
  assertEqual(c1.dailyLimit, 1, "dailyLimit=1");

  const c10 = loadForumBumpConfig(baseEnv({
    FORUM_BUMP_MODE: "execute",
    FORUM_BUMP_FORUM_CHANNEL_IDS: F,
    FORUM_BUMP_DAILY_LIMIT: "10",
  }), { projectRoot: "/tmp" });
  assertEqual(c10.dailyLimit, 10, "dailyLimit=10");

  try {
    loadForumBumpConfig(baseEnv({
      FORUM_BUMP_MODE: "execute",
      FORUM_BUMP_FORUM_CHANNEL_IDS: F,
      FORUM_BUMP_DAILY_LIMIT: "0",
    }), { projectRoot: "/tmp" });
    failed++; console.error("  FAIL: dailyLimit=0");
  } catch (e) {
    assert(e instanceof ConfigError, "dailyLimit=0 失败");
  }

  try {
    loadForumBumpConfig(baseEnv({
      FORUM_BUMP_MODE: "execute",
      FORUM_BUMP_FORUM_CHANNEL_IDS: F,
      FORUM_BUMP_DAILY_LIMIT: "11",
    }), { projectRoot: "/tmp" });
    failed++; console.error("  FAIL: dailyLimit=11");
  } catch (e) {
    assert(e instanceof ConfigError, "dailyLimit>10 失败");
  }
}

// 非法布尔 / 时区 / 时间窗 / 数字不回退
{
  try {
    parseStrictBool("yes", true, "B");
    failed++; console.error("  FAIL: 非法 bool");
  } catch (e) {
    assert(e instanceof ConfigError, "非法 bool");
  }

  try {
    loadForumBumpConfig(baseEnv({ FORUM_BUMP_TIMEZONE: "Not/AZone" }), { projectRoot: "/tmp" });
    failed++; console.error("  FAIL: 非法时区");
  } catch (e) {
    assert(e instanceof ConfigError, "非法时区");
  }

  try {
    loadForumBumpConfig(baseEnv({
      FORUM_BUMP_ACTIVE_START: "22:00",
      FORUM_BUMP_ACTIVE_END: "10:00",
    }), { projectRoot: "/tmp" });
    failed++; console.error("  FAIL: 非法时间窗");
  } catch (e) {
    assert(e instanceof ConfigError, "非法时间窗");
  }

  try {
    parseStrictInt("abc", 3, "N");
    failed++; console.error("  FAIL: 非法数字回退");
  } catch (e) {
    assert(e instanceof ConfigError, "非法数字不回退");
  }
}

// dry_run 完整配置成功
{
  const c = loadForumBumpConfig(baseEnv({
    FORUM_BUMP_MODE: "dry_run",
    FORUM_BUMP_FORUM_CHANNEL_IDS: F,
  }), { projectRoot: "/tmp/p" });
  assertEqual(c.mode, "dry_run", "dry_run ok");
  assertEqual(c.forumChannelIds[0], F, "forum id");
}

// TEST_MODE × execute 跨字段约束（经 loadConfig）
{
  const SAVED = { ...process.env };
  function set(k, v) {
    if (v == null) delete process.env[k];
    else process.env[k] = v;
  }
  function restore() {
    for (const k of Object.keys(process.env)) {
      if (!(k in SAVED)) delete process.env[k];
    }
    Object.assign(process.env, SAVED);
  }
  const { loadConfig } = await import("./index.js");

  function setBase() {
    set("DISCORD_BOT_TOKEN", "t");
    set("DISCORD_APPLICATION_ID", "t");
    set("DISCORD_GUILD_ID", G);
    set("DISCORD_THANKS_CHANNEL_ID", "111111111111111111");
    set("NODE_ENV", "development");
  }

  // true + disabled
  {
    restore(); setBase();
    set("TEST_MODE", "true");
    set("FORUM_BUMP_MODE", "disabled");
    const c = loadConfig();
    assertEqual(c.testMode, true, "TEST_MODE true");
    assertEqual(c.forumBump.mode, "disabled", "disabled 允许");
  }
  // true + dry_run
  {
    restore(); setBase();
    set("TEST_MODE", "true");
    set("FORUM_BUMP_MODE", "dry_run");
    set("FORUM_BUMP_FORUM_CHANNEL_IDS", F);
    const c = loadConfig();
    assertEqual(c.forumBump.mode, "dry_run", "dry_run + TEST_MODE 允许");
  }
  // true + execute → ConfigError 78
  {
    restore(); setBase();
    set("TEST_MODE", "true");
    set("FORUM_BUMP_MODE", "execute");
    set("FORUM_BUMP_FORUM_CHANNEL_IDS", F);
    try {
      loadConfig();
      failed++; console.error("  FAIL: TEST_MODE+execute 应抛");
    } catch (e) {
      assert(e instanceof ConfigError, "ConfigError");
      assertEqual(e.code, "forum_bump_execute_requires_test_mode_false", "code");
      assertEqual(e.exitCode, 78, "exit 78");
      assert(String(e.message).includes("TEST_MODE"), "消息含 TEST_MODE");
    }
  }
  // false + execute
  {
    restore(); setBase();
    set("TEST_MODE", "false");
    set("FORUM_BUMP_MODE", "execute");
    set("FORUM_BUMP_FORUM_CHANNEL_IDS", F);
    const c = loadConfig();
    assertEqual(c.forumBump.mode, "execute", "false+execute 允许");
  }
  restore();
}

void FORUM_BUMP_DEFAULTS;
console.log(`\nforumBumpConfig: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

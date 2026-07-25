/**
 * startupPreflight.js 自动测试。
 *
 * 使用 fake client、fake guild、fake channel、fake permissions。
 * 禁止真实 Discord 连接。
 *
 * 运行：node src/core/startupPreflight.test.js
 */

import { createStartupPreflight, PreflightResult } from "./startupPreflight.js";

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

function makeMockLogger() {
  const calls = [];
  return {
    calls,
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
  };
}

function makeFakePermissions(flags = {}) {
  return {
    has(flag) {
      if (typeof flag === "string") return flags[flag] ?? false;
      return false;
    },
  };
}

// 返回 true 的默认权限
function fullPermissions() {
  return makeFakePermissions({
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    AddReactions: true,
    Administrator: true,
  });
}

// ---- 辅助：创建 fake client 和 config ----

function makeBaseConfig(overrides = {}) {
  return {
    discordGuildId: "111111111111",
    discordThanksChannelId: "222222222222",
    nodeEnv: "development",
    isProduction: false,
    testMode: false,
    ...overrides,
  };
}

function makeFakeClient(guildOpts = {}, systemChannelOpts = {}, thanksChannelOpts = {}) {
  const guild = {
    id: "111111111111",
    name: "Test Guild",
    systemChannelId: "333333333333",
    systemChannelFlags: 0, // SuppressPremiumSubscriptions 未启用
    ...guildOpts,
  };

  const systemChannel = {
    id: "333333333333",
    guildId: "111111111111",
    guild: { id: "111111111111" },
    type: 0, // GuildText
    permissionsFor: () => fullPermissions(),
    ...systemChannelOpts,
  };

  const thanksChannel = {
    id: "222222222222",
    guildId: "111111111111",
    guild: { id: "111111111111" },
    type: 0, // GuildText
    permissionsFor: () => fullPermissions(),
    ...thanksChannelOpts,
  };

  return {
    guilds: {
      async fetch(id) {
        if (id === "111111111111") return guild;
        throw new Error(`Unknown Guild: ${id}`);
      },
    },
    channels: {
      async fetch(id) {
        if (id === "333333333333") return systemChannel;
        if (id === "222222222222") return thanksChannel;
        throw new Error(`Unknown Channel: ${id}`);
      },
    },
    user: {
      id: "bot123",
    },
  };
}

// ============================
// Test 1: 完整通过
// ============================

{
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };
  const failures = [];
  const warnings = [];
  const client = makeFakeClient();
  const config = makeBaseConfig();
  const emojiProvider = {
    fetchEmojis: async () => [{ id: "emoji1", name: "heart" }],
  };

  const preflight = createStartupPreflight({
    client,
    config,
    logger: makeMockLogger(),
    emojiProvider,
    notifyFailure: async (t, m, d) => { failures.push({ t, m, d }); },
    notifyWarning: async (t, m, d) => { warnings.push({ t, m, d }); },
    exitFn,
  });

  const result = await preflight.run();
  assert(result.passed, "完整检查通过");
  assertEqual(result.fatal.length, 0, "无 fatal");
  assertEqual(exitCode, null, "通过时不调用 exitFn");
}

// ============================
// Test 2: Guild 不存在 → fatal
// ============================

{
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };
  const failures = [];
  const client = makeFakeClient();
  // 返回不存在
  client.guilds.fetch = async () => { throw new Error("Unknown Guild"); };
  const config = makeBaseConfig();

  const preflight = createStartupPreflight({
    client, config,
    logger: makeMockLogger(),
    notifyFailure: async (t, m, d) => { failures.push({ t, m, d }); },
    notifyWarning: async () => {},
    exitFn,
  });

  const result = await preflight.run();
  assert(!result.passed, "Guild 不存在时 failed");
  assert(result.fatal.length > 0, "Guild 不存在产生 fatal");
  assertEqual(exitCode, 78, "Guild 不存在 → exit(78)");
  assert(failures.some((f) => f.t === "startup_preflight_failed"), "产生 preflight failed 告警");
}

// ============================
// Test 3: System Messages Channel 不存在 → fatal
// ============================

{
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };
  const failures = [];
  const client = makeFakeClient({ systemChannelId: null }, {}, {});
  const config = makeBaseConfig();

  const preflight = createStartupPreflight({
    client, config,
    logger: makeMockLogger(),
    notifyFailure: async (t, m, d) => { failures.push({ t, m, d }); },
    notifyWarning: async () => {},
    exitFn,
  });

  const result = await preflight.run();
  assert(!result.passed, "System Channel 缺失 → failed");
  assertEqual(exitCode, 78, "System Channel 缺失 → exit(78)");
}

// ============================
// Test 4: 系统频道缺少 ViewChannel → fatal
// ============================

{
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };
  const failures = [];
  const noView = makeFakePermissions({
    ViewChannel: false,
    ReadMessageHistory: true,
  });
  const client = makeFakeClient(
    {},
    { permissionsFor: () => noView },
  );
  const config = makeBaseConfig();

  const preflight = createStartupPreflight({
    client, config,
    logger: makeMockLogger(),
    notifyFailure: async (t, m, d) => { failures.push({ t, m, d }); },
    notifyWarning: async () => {},
    exitFn,
  });

  const result = await preflight.run();
  assert(!result.passed, "系统频道缺 ViewChannel → failed");
  assertEqual(exitCode, 78, "系统频道缺 ViewChannel → exit(78)");
}

// ============================
// Test 5: 感谢频道缺失 → fatal
// ============================

{
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };
  const client = makeFakeClient();
  // 感谢频道获取失败
  client.channels.fetch = async (id) => {
    if (id === "333333333333") {
      return { id: "333333333333", guildId: "111111111111", guild: { id: "111111111111" }, type: 0, permissionsFor: () => fullPermissions() };
    }
    throw new Error("Unknown Channel");
  };
  const config = makeBaseConfig();

  const preflight = createStartupPreflight({
    client, config,
    logger: makeMockLogger(),
    notifyFailure: async () => {},
    notifyWarning: async () => {},
    exitFn,
  });

  const result = await preflight.run();
  assert(!result.passed, "感谢频道缺失 → failed");
  assertEqual(exitCode, 78, "感谢频道缺失 → exit(78)");
}

// ============================
// Test 6: 感谢频道属于错误 Guild
// ============================

{
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };
  const client = makeFakeClient(
    {},
    {},
    { guildId: "999999999999", guild: { id: "999999999999" } },
  );
  const config = makeBaseConfig();

  const preflight = createStartupPreflight({
    client, config,
    logger: makeMockLogger(),
    notifyFailure: async () => {},
    notifyWarning: async () => {},
    exitFn,
  });

  const result = await preflight.run();
  assert(!result.passed, "感谢频道属于错误 Guild → failed");
  assertEqual(exitCode, 78, "感谢频道属于错误 Guild → exit(78)");
}

// ============================
// Test 7: 感谢频道缺 SendMessages → fatal
// ============================

{
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };
  const noSend = makeFakePermissions({
    ViewChannel: true,
    SendMessages: false,
    ReadMessageHistory: true,
    AddReactions: true,
  });
  const client = makeFakeClient(
    {},
    {},
    { permissionsFor: () => noSend },
  );
  const config = makeBaseConfig();

  const preflight = createStartupPreflight({
    client, config,
    logger: makeMockLogger(),
    notifyFailure: async () => {},
    notifyWarning: async () => {},
    exitFn,
  });

  const result = await preflight.run();
  assert(!result.passed, "感谢频道缺 SendMessages → failed");
  assertEqual(exitCode, 78, "感谢频道缺 SendMessages → exit(78)");
}

// ============================
// Test 8: 感谢频道缺 AddReactions → warning (非致命降级)
// ============================

{
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };
  const noReaction = makeFakePermissions({
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    AddReactions: false,
  });
  const warnings = [];
  const client = makeFakeClient(
    {},
    {},
    { permissionsFor: () => noReaction },
  );
  const config = makeBaseConfig();
  const emojiProvider = {
    fetchEmojis: async () => [{ id: "e1", name: "heart" }],
  };

  const preflight = createStartupPreflight({
    client, config,
    logger: makeMockLogger(),
    emojiProvider,
    notifyFailure: async () => {},
    notifyWarning: async (t, m) => { warnings.push({ t, m }); },
    exitFn,
  });

  const result = await preflight.run();
  assert(result.passed, "缺 AddReactions → 主检查仍通过（降级）");
  assertEqual(exitCode, null, "缺 AddReactions → 不退出");
  assert(warnings.some((w) => w.t === "thanks_channel"), "缺 AddReactions 产生 warning");
}

// ============================
// Test 9: Application Emoji 不可用 → warning
// ============================

{
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };
  const warnings = [];
  const client = makeFakeClient();
  const config = makeBaseConfig();
  const badProvider = {
    fetchEmojis: async () => null, // 获取失败
  };

  const preflight = createStartupPreflight({
    client, config,
    logger: makeMockLogger(),
    emojiProvider: badProvider,
    notifyFailure: async () => {},
    notifyWarning: async (t, m) => { warnings.push({ t, m }); },
    exitFn,
  });

  const result = await preflight.run();
  assert(result.passed, "Emoji 不可用 → 主检查通过");
  assertEqual(exitCode, null, "Emoji 不可用 → 不退出");
  assert(warnings.some((w) => w.t === "application_emojis"), "Emoji 不可用产生 warning");
}

// ============================
// Test 10: production + TEST_MODE=false → pass
// ============================

{
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };
  const client = makeFakeClient();
  const config = makeBaseConfig({ isProduction: true, nodeEnv: "production", testMode: false });
  const emojiProvider = {
    fetchEmojis: async () => [{ id: "e1", name: "heart" }],
  };

  const preflight = createStartupPreflight({
    client, config,
    logger: makeMockLogger(),
    emojiProvider,
    notifyFailure: async () => {},
    notifyWarning: async () => {},
    exitFn,
  });

  const result = await preflight.run();
  assert(result.passed, "production + TEST_MODE=false → pass");
  assertEqual(exitCode, null, "不退出");
}

// ============================
// Test 11: production + TEST_MODE=true → fatal
// ============================

{
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };
  const client = makeFakeClient();
  const config = makeBaseConfig({ isProduction: true, nodeEnv: "production", testMode: true });
  const emojiProvider = {
    fetchEmojis: async () => [{ id: "e1", name: "heart" }],
  };

  const preflight = createStartupPreflight({
    client, config,
    logger: makeMockLogger(),
    emojiProvider,
    notifyFailure: async () => {},
    notifyWarning: async () => {},
    exitFn,
  });

  const result = await preflight.run();
  assert(!result.passed, "production + TEST_MODE=true → failed");
  assertEqual(exitCode, 78, "production + TEST_MODE=true → exit(78)");
}

// ============================
// Test 12: development + TEST_MODE=true → pass
// ============================

{
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };
  const client = makeFakeClient();
  const config = makeBaseConfig({ isProduction: false, nodeEnv: "development", testMode: true });
  const emojiProvider = {
    fetchEmojis: async () => [{ id: "e1", name: "heart" }],
  };

  const preflight = createStartupPreflight({
    client, config,
    logger: makeMockLogger(),
    emojiProvider,
    notifyFailure: async () => {},
    notifyWarning: async () => {},
    exitFn,
  });

  const result = await preflight.run();
  assert(result.passed, "development + TEST_MODE=true → pass");
  assertEqual(exitCode, null, "不退出");
}

// ============================
// Test 13: SuppressPremiumSubscriptions 已启用 → fatal
// ============================

{
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };
  const failures = [];
  // systemChannelFlags = 2 (SuppressPremiumSubscriptions)
  const client = makeFakeClient({ systemChannelFlags: 2 });
  const config = makeBaseConfig();

  const preflight = createStartupPreflight({
    client, config,
    logger: makeMockLogger(),
    notifyFailure: async (t, m, d) => { failures.push({ t, m, d }); },
    notifyWarning: async () => {},
    exitFn,
  });

  const result = await preflight.run();
  assert(!result.passed, "SuppressPremiumSubscriptions 启用 → failed");
  assertEqual(exitCode, 78, "SuppressPremiumSubscriptions → exit(78)");
  const match = failures.some((f) =>
    f.t === "startup_preflight_failed" &&
    f.m.includes("Boost 系统消息")
  );
  assert(match, "告警消息提及 Boost 系统消息");
}

// ============================
// Test 14: Preflight 失败不向 Discord 频道发消息
// ============================

{
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };

  // 确认 createStartupPreflight 不接受任何 Discord 发送能力
  // 它只接受 exitFn、notifyFailure、notifyWarning、logger
  // 没有任何 channel.send 或 sendMessage 的地方

  const client = makeFakeClient();
  const config = makeBaseConfig();

  // 模拟 Guild 不可访问的场景
  client.guilds.fetch = async () => { throw new Error("No access"); };

  const preflight = createStartupPreflight({
    client, config,
    logger: makeMockLogger(),
    notifyFailure: async () => {},
    notifyWarning: async () => {},
    exitFn,
  });

  await preflight.run();
  assertEqual(exitCode, 78, "Preflight 失败调用 exitFn(78)");

  // 验证 preflight 没有任何 Discord 消息发送接口
  assert(typeof preflight.run === "function", "preflight 只有 run 方法");
  assert(!preflight.sendMessage, "preflight 无 sendMessage");
  assert(!preflight.channel, "preflight 无 channel");
}

// ============================
// Test 15: 永久性配置故障使用 exit(78) 而非 exit(1)
// ============================

{
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };
  const client = makeFakeClient();
  client.guilds.fetch = async () => { throw new Error("No access"); };
  const config = makeBaseConfig();

  const preflight = createStartupPreflight({
    client, config,
    logger: makeMockLogger(),
    notifyFailure: async () => {},
    notifyWarning: async () => {},
    exitFn,
  });

  await preflight.run();
  assertEqual(exitCode, 78, "永久性配置故障 → exit(78)");
  assert(exitCode !== 1, "永久性配置故障 ≠ exit(1)");
}

// ============================
// 结果
// ============================

console.log(`\n[startupPreflight.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);

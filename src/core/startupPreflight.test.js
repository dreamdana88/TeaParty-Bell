/**
 * startupPreflight.js 自动测试（永久 vs 可恢复错误区分）。
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

function makeMockLogger() { return { calls:[], info:()=>{}, error:()=>{}, warn:()=>{}, debug:()=>{} }; }

function fullPermissions() {
  return {
    has(flag) {
      return ["ViewChannel","SendMessages","ReadMessageHistory","AddReactions","Administrator"].includes(flag);
    },
  };
}

function noViewPermission() {
  return { has(f) { return f !== "ViewChannel" && fullPermissions().has(f); } };
}
function noSendPermission() {
  return { has(f) { return f !== "SendMessages" && fullPermissions().has(f); } };
}
function noReactionPermission() {
  return { has(f) { return f !== "AddReactions" && fullPermissions().has(f); } };
}

function makeBaseConfig(overrides = {}) {
  return { discordGuildId:"111111111111", discordThanksChannelId:"222222222222",
    nodeEnv:"development", isProduction:false, testMode:false, ...overrides };
}

function makeFakeClient(guildOverride = null, systemChOverride = null, thanksChOverride = null) {
  const guild = guildOverride || {
    id: "111111111111", name: "Test Guild",
    systemChannelId: "333333333333",
    systemChannelFlags: { has() { return false; } },
  };
  const sysCh = systemChOverride || {
    id: "333333333333", guildId: "111111111111", guild: { id: "111111111111" },
    type: 0, permissionsFor: () => fullPermissions(),
  };
  const thxCh = thanksChOverride || {
    id: "222222222222", guildId: "111111111111", guild: { id: "111111111111" },
    type: 0, permissionsFor: () => fullPermissions(),
  };

  return {
    guilds: { async fetch(id) { if (id==="111111111111") return guild; throw Object.assign(new Error("Unknown Guild"), { code: 10004 }); } },
    channels: { async fetch(id) { if (id==="333333333333") return sysCh; if (id==="222222222222") return thxCh; throw Object.assign(new Error("Unknown Channel"), { code: 10003 }); } },
    user: { id: "bot123" },
  };
}

// ===== Test 1: 全通过 =====
{
  let exitCode = null;
  const p = createStartupPreflight({ client: makeFakeClient(), config: makeBaseConfig(),
    logger: makeMockLogger(), emojiProvider: { fetchEmojis: async () => [{id:"e1",name:"h"}] },
    notifyFailure: async () => {}, notifyWarning: async () => {}, exitFn: c => { exitCode = c; } });
  const r = await p.run();
  assert(r.passed, "全通过"); assertEqual(exitCode, null, "不退出");
}

// ===== Test 2: Unknown Guild (code 10004) → exit 78 =====
{
  let exitCode = null;
  const client = makeFakeClient();
  client.guilds.fetch = async () => { throw Object.assign(new Error("Unknown Guild"), { code: 10004 }); };
  const p = createStartupPreflight({ client, config: makeBaseConfig(), logger: makeMockLogger(),
    notifyFailure: async () => {}, notifyWarning: async () => {}, exitFn: c => { exitCode = c; } });
  await p.run();
  assertEqual(exitCode, 78, "Discord code 10004 → exit 78");
}

// ===== Test 3: Missing Access (code 50001) → exit 78 =====
{
  let exitCode = null;
  const client = makeFakeClient();
  client.guilds.fetch = async () => { throw Object.assign(new Error("Missing Access"), { code: 50001 }); };
  const p = createStartupPreflight({ client, config: makeBaseConfig(), logger: makeMockLogger(),
    notifyFailure: async () => {}, notifyWarning: async () => {}, exitFn: c => { exitCode = c; } });
  await p.run();
  assertEqual(exitCode, 78, "Discord code 50001 → exit 78");
}

// ===== Test 4: 网络错误 → exit 1（可恢复）=====
{
  let exitCode = null;
  const client = makeFakeClient();
  client.guilds.fetch = async () => { throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }); };
  const p = createStartupPreflight({ client, config: makeBaseConfig(), logger: makeMockLogger(),
    notifyFailure: async () => {}, notifyWarning: async () => {}, exitFn: c => { exitCode = c; } });
  await p.run();
  assertEqual(exitCode, 1, "ETIMEDOUT → exit 1（可恢复）");
}

// ===== Test 5: ECONNREFUSED → exit 1 =====
{
  let exitCode = null;
  const client = makeFakeClient();
  client.guilds.fetch = async () => { throw Object.assign(new Error("ECONNREFUSED"), { code: "ECONNREFUSED" }); };
  const p = createStartupPreflight({ client, config: makeBaseConfig(), logger: makeMockLogger(),
    notifyFailure: async () => {}, notifyWarning: async () => {}, exitFn: c => { exitCode = c; } });
  await p.run();
  assertEqual(exitCode, 1, "ECONNREFUSED → exit 1");
}

// ===== Test 6: SuppressPremiumSubscriptions → exit 78 =====
{
  let exitCode = null;
  const guild = { id: "111111111111", name: "Test", systemChannelId: "333333333333",
    systemChannelFlags: { has(f) { return f === 1<<1; /* SuppressPremiumSubscriptions */ } } };
  const p = createStartupPreflight({ client: makeFakeClient(guild), config: makeBaseConfig(),
    logger: makeMockLogger(), notifyFailure: async () => {}, notifyWarning: async () => {}, exitFn: c => { exitCode = c; } });
  await p.run();
  assertEqual(exitCode, 78, "SuppressPremiumSubscriptions → exit 78");
}

// ===== Test 7: 系统频道缺 ViewChannel → exit 78 =====
{
  let exitCode = null;
  const sysCh = { id: "333333333333", guildId: "111111111111", guild:{id:"111111111111"}, type:0, permissionsFor: () => noViewPermission() };
  const p = createStartupPreflight({ client: makeFakeClient(null, sysCh), config: makeBaseConfig(),
    logger: makeMockLogger(), notifyFailure: async () => {}, notifyWarning: async () => {}, exitFn: c => { exitCode = c; } });
  await p.run();
  assertEqual(exitCode, 78, "缺 ViewChannel → exit 78");
}

// ===== Test 8: 感谢频道缺 SendMessages → exit 78 =====
{
  let exitCode = null;
  const thxCh = { id: "222222222222", guildId: "111111111111", guild:{id:"111111111111"}, type:0, permissionsFor: () => noSendPermission() };
  const p = createStartupPreflight({ client: makeFakeClient(null, null, thxCh), config: makeBaseConfig(),
    logger: makeMockLogger(), notifyFailure: async () => {}, notifyWarning: async () => {}, exitFn: c => { exitCode = c; } });
  await p.run();
  assertEqual(exitCode, 78, "缺 SendMessages → exit 78");
}

// ===== Test 9: 缺 AddReactions → warning + 不退出 =====
{
  let exitCode = null;
  const warnings = [];
  const thxCh = { id: "222222222222", guildId: "111111111111", guild:{id:"111111111111"}, type:0, permissionsFor: () => noReactionPermission() };
  const p = createStartupPreflight({ client: makeFakeClient(null, null, thxCh), config: makeBaseConfig(),
    logger: makeMockLogger(), emojiProvider: { fetchEmojis: async () => [{id:"e1",name:"h"}] },
    notifyFailure: async () => {}, notifyWarning: async (t,m) => { warnings.push({t,m}); }, exitFn: c => { exitCode = c; } });
  const r = await p.run();
  assert(r.passed, "缺 AddReactions → 主检查通过"); assertEqual(exitCode, null, "不退出");
  assert(warnings.some(w => w.t === "thanks_channel"), "产生 warning");
}

// ===== Test 10: production + TEST_MODE=true → exit 78 =====
{
  let exitCode = null;
  const p = createStartupPreflight({ client: makeFakeClient(), config: makeBaseConfig({ isProduction:true, nodeEnv:"production", testMode:true }),
    logger: makeMockLogger(), emojiProvider: { fetchEmojis: async () => [{id:"e1"}] },
    notifyFailure: async () => {}, notifyWarning: async () => {}, exitFn: c => { exitCode = c; } });
  await p.run();
  assertEqual(exitCode, 78, "production+TEST_MODE=true → exit 78");
}

// ===== Test 11: development + TEST_MODE=true → pass =====
{
  let exitCode = null;
  const p = createStartupPreflight({ client: makeFakeClient(), config: makeBaseConfig({ testMode:true }),
    logger: makeMockLogger(), emojiProvider: { fetchEmojis: async () => [{id:"e1"}] },
    notifyFailure: async () => {}, notifyWarning: async () => {}, exitFn: c => { exitCode = c; } });
  const r = await p.run();
  assert(r.passed, "development+TEST_MODE=true → pass"); assertEqual(exitCode, null, "不退出");
}

// ===== Test 12: systemChannelFlags 读失败 → WARNING（非 PASS）=====
{
  const guild = { id: "111111111111", name: "Test", systemChannelId: "333333333333",
    systemChannelFlags: { has() { throw new Error("permission denied"); } } };
  const p = createStartupPreflight({ client: makeFakeClient(guild), config: makeBaseConfig(),
    logger: makeMockLogger(), notifyFailure: async () => {}, notifyWarning: async () => {}, exitFn: () => {} });
  const r = await p.run();
  const flagsCheck = r.all.find(x => x.check === "suppress_premium_subscriptions");
  assertEqual(flagsCheck.result, PreflightResult.WARNING, "systemChannelFlags 读失败 → WARNING（非 PASS）");
}

// ===== Test 13: Guild 只 fetch 一次 =====
{
  let fetchCount = 0;
  const client = makeFakeClient();
  const origFetch = client.guilds.fetch;
  client.guilds.fetch = async (id) => { fetchCount++; return origFetch(id); };
  const p = createStartupPreflight({ client, config: makeBaseConfig(),
    logger: makeMockLogger(), emojiProvider: { fetchEmojis: async () => [{id:"e1"}] },
    notifyFailure: async () => {}, notifyWarning: async () => {}, exitFn: () => {} });
  await p.run();
  assertEqual(fetchCount, 1, "Guild 只 fetch 一次（后续检查复用缓存）");
}

// ===== Test 14: 感谢频道 404 → exit 78 =====
{
  let exitCode = null;
  const client = makeFakeClient();
  client.channels.fetch = async (id) => { if (id==="222222222222") throw Object.assign(new Error("Unknown Channel"), { code: 10003, httpStatus: 404 }); return { id:"333333333333", guildId:"111111111111", type:0, permissionsFor:()=>fullPermissions() }; };
  const p = createStartupPreflight({ client, config: makeBaseConfig(),
    logger: makeMockLogger(), notifyFailure: async () => {}, notifyWarning: async () => {}, exitFn: c => { exitCode = c; } });
  await p.run();
  assertEqual(exitCode, 78, "Unknown Channel (404) → exit 78");
}

// ===== Test 15: Recoverable 告警写盘失败 → exit 78 =====
{
  let exitCode = null;
  const client = makeFakeClient();
  client.guilds.fetch = async () => { throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }); };
  const p = createStartupPreflight({ client, config: makeBaseConfig(), logger: makeMockLogger(),
    notifyFailure: async () => { throw new Error("disk full"); },
    notifyWarning: async () => {}, exitFn: c => { exitCode = c; } });
  await p.run();
  assertEqual(exitCode, 78, "recoverable 告警持久化失败 → exit 78");
}

console.log(`\n[startupPreflight.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);

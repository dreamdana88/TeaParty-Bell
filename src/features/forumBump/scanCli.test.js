import { ChannelType, PermissionFlagsBits } from "discord.js";
import {
  assertScanCliDevGate,
  parseForumScanArgs,
  runForumScan,
} from "./scanCli.js";
import { isForumBumpError } from "./errors.js";

const GUILD = "111111111111111111";
const FORUM = "222222222222222222";
const TAG = "333333333333333333";
const TOKEN = "BOT_TOKEN_SECRET_VALUE";
const OLD_MSG = "1429163615671423037";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label} (got ${JSON.stringify(actual)})`);
}

function outputBuffer() {
  const lines = [];
  return { lines, write: (c) => lines.push(String(c)) };
}

function baseConfig(overrides = {}) {
  return {
    nodeEnv: "development",
    testMode: true,
    discordGuildId: GUILD,
    discordBotToken: TOKEN,
    ...overrides,
  };
}

function makeHarness() {
  let clientCreated = 0;
  let loginCalled = 0;
  let destroyCalled = 0;
  let destroyFail = false;
  let sendCount = 0;

  const forum = {
    id: FORUM,
    name: "f",
    type: ChannelType.GuildForum,
    guildId: GUILD,
    permissionsFor() {
      return {
        has: (flag) => flag === PermissionFlagsBits.ViewChannel,
      };
    },
  };

  const thread = {
    id: "444444444444444444",
    parentId: FORUM,
    type: ChannelType.PublicThread,
    guildId: GUILD,
    name: "old",
    archived: true,
    locked: false,
    pinned: false,
    lastMessageId: OLD_MSG,
    archiveTimestamp: 1_700_000_000_000,
    appliedTags: [],
    permissionsFor() {
      return {
        has: (flag) =>
          flag === PermissionFlagsBits.ViewChannel
          || flag === PermissionFlagsBits.SendMessagesInThreads,
      };
    },
    send: async () => { sendCount += 1; },
    edit: async () => {},
    setArchived: async () => {},
  };

  const client = {
    user: { id: "bot" },
    channels: {
      fetch: async (id) => {
        if (id === FORUM) return forum;
        return null;
      },
    },
  };

  return {
    get clientCreated() { return clientCreated; },
    get loginCalled() { return loginCalled; },
    get destroyCalled() { return destroyCalled; },
    get sendCount() { return sendCount; },
    setDestroyFail(v) { destroyFail = v; },
    createClientFn() {
      clientCreated += 1;
      return {
        client,
        login: async () => { loginCalled += 1; },
        destroy: async () => {
          destroyCalled += 1;
          if (destroyFail) throw new Error("destroy boom");
        },
      };
    },
    thread,
  };
}

console.log("\n=== ForumBump scanCli ===\n");

// 参数解析
{
  const args = parseForumScanArgs([
    "--forum", FORUM,
    "--forum", FORUM,
    "--forum", "555555555555555555",
    "--silence-days", "30",
    "--confirm-guild", GUILD,
    "--exclude-tag", TAG,
    "--display-limit", "5",
  ]);
  assertEqual(args.forumIds.length, 2, "Forum 去重保序");
  assertEqual(args.forumIds[0], FORUM, "首个 forum");
  assertEqual(args.silenceDays, 30, "silenceDays");
  assertEqual(args.displayLimit, 5, "displayLimit");
  assertEqual(args.excludedTagIds[0], TAG, "exclude tag");
}

// 非法参数
for (const [argv, code] of [
  [[], "FORUM_REQUIRED"],
  [["--forum", "bad"], "INVALID_FORUM_ID"],
  [["--forum", FORUM], "INVALID_SILENCE_DAYS"],
  [["--forum", FORUM, "--silence-days", "0"], "INVALID_SILENCE_DAYS"],
  [["--forum", FORUM, "--silence-days", "30", "--display-limit", "0"], "INVALID_DISPLAY_LIMIT"],
  [["--forum", FORUM, "--silence-days", "30", "--exclude-tag", "x"], "INVALID_EXCLUDED_TAG_ID"],
]) {
  try {
    parseForumScanArgs(argv);
    assert(false, `应失败 ${code}`);
  } catch (error) {
    assert(isForumBumpError(error) && error.code === code, `拒绝 ${code}`);
  }
}

// Dev gate
try {
  assertScanCliDevGate(baseConfig({ nodeEnv: "production" }), GUILD);
  assert(false, "prod gate");
} catch (error) {
  assert(error.code === "NOT_DEVELOPMENT", "production gate");
}

// CLI 安全门不 createClient
for (const [config, confirm, label, code] of [
  [baseConfig({ nodeEnv: "production" }), GUILD, "production", "NOT_DEVELOPMENT"],
  [baseConfig({ testMode: false }), GUILD, "TEST_MODE=false", "TEST_MODE_REQUIRED"],
  [baseConfig(), undefined, "缺 confirm", "GUILD_CONFIRMATION_REQUIRED"],
  [baseConfig(), "wrong", "confirm 不匹配", "GUILD_CONFIRMATION_MISMATCH"],
]) {
  const h = makeHarness();
  const result = await runForumScan({
    argv: ["--forum", FORUM, "--silence-days", "30", ...(confirm ? ["--confirm-guild", confirm] : [])],
    loadConfigFn: () => config,
    createClientFn: h.createClientFn,
    stderr: outputBuffer(),
  });
  assert(result.exitCode !== 0, `${label} 非 0`);
  assertEqual(h.clientCreated, 0, `${label} 不 createClient`);
  assertEqual(h.loginCalled, 0, `${label} 不 login`);
  assertEqual(h.destroyCalled, 0, `${label} 不 destroy`);
  assertEqual(result.errorCode, code, `${label} code`);
}

// 缺 forum
{
  const h = makeHarness();
  const result = await runForumScan({
    argv: ["--silence-days", "30", "--confirm-guild", GUILD],
    loadConfigFn: () => baseConfig(),
    createClientFn: h.createClientFn,
    stderr: outputBuffer(),
  });
  assert(result.exitCode !== 0, "缺 forum 非 0");
  assertEqual(h.clientCreated, 0, "缺 forum 不 createClient");
}

// 成功扫描
{
  const h = makeHarness();
  const stdout = outputBuffer();
  const result = await runForumScan({
    argv: ["--forum", FORUM, "--silence-days", "30", "--confirm-guild", GUILD, "--display-limit", "10"],
    loadConfigFn: () => baseConfig(),
    createClientFn: h.createClientFn,
    stdout,
    stderr: outputBuffer(),
    clock: { now: () => 1_800_000_000_000 },
    fetchActiveThreads: async () => [h.thread],
    fetchArchivedPage: async () => ({ threads: [], hasMore: false }),
  });
  assertEqual(result.exitCode, 0, "成功退出 0");
  assertEqual(h.loginCalled, 1, "login");
  assertEqual(h.destroyCalled, 1, "destroy");
  assertEqual(h.sendCount, 0, "无 send");
  const out = stdout.lines.join("");
  assert(out.includes("forum-scan"), "输出报告");
  assert(!out.includes(TOKEN), "输出无 Token");
  assert(!out.includes("_allEligibleSorted"), "不泄露内部字段");
}

// 扫描失败仍 destroy
{
  const h = makeHarness();
  const result = await runForumScan({
    argv: ["--forum", FORUM, "--silence-days", "30", "--confirm-guild", GUILD],
    loadConfigFn: () => baseConfig(),
    createClientFn: h.createClientFn,
    scanFn: async () => { throw new Error("boom"); },
    stderr: outputBuffer(),
  });
  assert(result.exitCode !== 0, "扫描失败非 0");
  assertEqual(h.destroyCalled, 1, "失败仍 destroy");
}

// destroy 失败不覆盖成功
{
  const h = makeHarness();
  h.setDestroyFail(true);
  const result = await runForumScan({
    argv: ["--forum", FORUM, "--silence-days", "30", "--confirm-guild", GUILD],
    loadConfigFn: () => baseConfig(),
    createClientFn: h.createClientFn,
    stdout: outputBuffer(),
    stderr: outputBuffer(),
    clock: { now: () => 1_800_000_000_000 },
    fetchActiveThreads: async () => [h.thread],
    fetchArchivedPage: async () => ({ threads: [], hasMore: false }),
  });
  assertEqual(result.exitCode, 0, "destroy 失败不覆盖成功");
}

console.log(`\nForumBump scanCli: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

import { ChannelType, PermissionFlagsBits } from "discord.js";
import { parseForumPocArgs, runForumPoc } from "./cli.js";
import { BUMP_MESSAGE_CONTENT } from "./bumpMessage.js";

const GUILD_ID = "111111111111111111";
const FORUM_ID = "222222222222222222";
const THREAD_ID = "333333333333333333";
const MESSAGE_ID = "444444444444444444";
const TOKEN = "BOT_TOKEN_MUST_NOT_APPEAR";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function outputBuffer() {
  const lines = [];
  return {
    lines,
    write(chunk) {
      lines.push(String(chunk));
    },
  };
}

function baseConfig(overrides = {}) {
  return {
    nodeEnv: "development",
    testMode: true,
    discordGuildId: GUILD_ID,
    discordBotToken: TOKEN,
    ...overrides,
  };
}

function makeHarness({
  locked = false,
  sendImpl,
  deleteImpl,
  permissions,
} = {}) {
  let loginCalled = 0;
  let destroyCalled = 0;
  let destroyShouldFail = false;

  const parent = {
    id: FORUM_ID,
    type: ChannelType.GuildForum,
    defaultSortOrder: 0,
  };

  const state = {
    lastMessageId: "old",
    messageCount: 1,
    totalMessageSent: 1,
  };

  const message = {
    id: MESSAGE_ID,
    delete: deleteImpl || (async () => {
      state.messageCount = Math.max(0, state.messageCount - 1);
    }),
  };

  const thread = {
    id: THREAD_ID,
    type: ChannelType.PublicThread,
    guildId: GUILD_ID,
    parentId: FORUM_ID,
    parent,
    name: "cli-thread",
    archived: false,
    locked,
    autoArchiveDuration: 1440,
    archiveTimestamp: 1,
    get lastMessageId() { return state.lastMessageId; },
    get messageCount() { return state.messageCount; },
    get totalMessageSent() { return state.totalMessageSent; },
    appliedTags: [],
    permissionsFor() {
      if (permissions) return permissions;
      return {
        has(flag) {
          return flag === PermissionFlagsBits.ViewChannel
            || flag === PermissionFlagsBits.SendMessagesInThreads;
        },
      };
    },
    send: sendImpl || (async (payload) => {
      state.lastMessageId = MESSAGE_ID;
      state.messageCount += 1;
      state.totalMessageSent += 1;
      message._payload = payload;
      return message;
    }),
  };

  const client = {
    user: { id: "bot" },
    channels: {
      fetch: async (id) => {
        if (id === THREAD_ID) return thread;
        if (id === FORUM_ID) return parent;
        return null;
      },
    },
  };

  function createClientFn() {
    return {
      client,
      login: async () => {
        loginCalled += 1;
      },
      destroy: async () => {
        destroyCalled += 1;
        if (destroyShouldFail) throw new Error("destroy fail");
      },
    };
  }

  return {
    thread,
    message,
    createClientFn,
    get loginCalled() { return loginCalled; },
    get destroyCalled() { return destroyCalled; },
    setDestroyFail(v) { destroyShouldFail = v; },
  };
}

console.log("\n=== ForumPoc CLI ===\n");

// 参数解析
{
  const args = parseForumPocArgs([
    "inspect",
    "--thread", THREAD_ID,
    "--confirm-guild", GUILD_ID,
  ]);
  assertEqual(args.command, "inspect", "解析 inspect");
  assertEqual(args.threadId, THREAD_ID, "解析 thread");
  assertEqual(args.confirmGuild, GUILD_ID, "解析 confirm-guild");
  assertEqual(args.execute, false, "inspect 无 execute");
}

{
  const args = parseForumPocArgs([
    "bump-message",
    "--thread", THREAD_ID,
    "--confirm-guild", GUILD_ID,
    "--execute",
  ]);
  assertEqual(args.command, "bump-message", "解析 bump-message");
  assertEqual(args.execute, true, "解析 --execute");
}

for (const argv of [
  [],
  ["unknown"],
  ["inspect"],
  ["inspect", "--thread"],
  ["bump-message", "--thread", THREAD_ID, "--all"],
  ["inspect", "--thread", THREAD_ID, "--confirm-guild", GUILD_ID, "--execute"],
]) {
  try {
    parseForumPocArgs(argv);
    assert(false, `非法参数应失败: ${JSON.stringify(argv)}`);
  } catch {
    assert(true, `非法参数拒绝: ${JSON.stringify(argv)}`);
  }
}

// development + TEST_MODE 允许 inspect
{
  const h = makeHarness();
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  const result = await runForumPoc({
    argv: ["inspect", "--thread", THREAD_ID, "--confirm-guild", GUILD_ID],
    loadConfigFn: () => baseConfig(),
    createClientFn: h.createClientFn,
    stdout,
    stderr,
  });
  assertEqual(result.exitCode, 0, "inspect 退出 0");
  assertEqual(h.loginCalled, 1, "inspect login");
  assertEqual(h.destroyCalled, 1, "inspect destroy");
  assert(stdout.lines.join("").includes(THREAD_ID), "inspect 输出 threadId");
  assert(!stdout.lines.join("").includes(TOKEN), "inspect 输出无 Token");
  assert(!stderr.lines.join("").includes(TOKEN), "inspect 错误流无 Token");
}

// production 拒绝
{
  const h = makeHarness();
  const stderr = outputBuffer();
  const result = await runForumPoc({
    argv: ["inspect", "--thread", THREAD_ID, "--confirm-guild", GUILD_ID],
    loadConfigFn: () => baseConfig({ nodeEnv: "production" }),
    createClientFn: h.createClientFn,
    stderr,
  });
  assert(result.exitCode !== 0, "production 非 0");
  assertEqual(h.destroyCalled, 1, "production 失败仍 destroy");
  assert(!stderr.lines.join("").includes(TOKEN), "production 拒绝无 Token");
}

// TEST_MODE=false 拒绝
{
  const h = makeHarness();
  const result = await runForumPoc({
    argv: ["bump-message", "--thread", THREAD_ID, "--confirm-guild", GUILD_ID, "--execute"],
    loadConfigFn: () => baseConfig({ testMode: false }),
    createClientFn: h.createClientFn,
    stderr: outputBuffer(),
  });
  assert(result.exitCode !== 0, "TEST_MODE=false 拒绝");
  assertEqual(h.destroyCalled, 1, "TEST_MODE 失败仍 destroy");
}

// 缺少 / 不匹配 confirm-guild
{
  const h = makeHarness();
  const result = await runForumPoc({
    argv: ["inspect", "--thread", THREAD_ID],
    loadConfigFn: () => baseConfig(),
    createClientFn: h.createClientFn,
    stderr: outputBuffer(),
  });
  assert(result.exitCode !== 0, "缺少 confirm-guild 拒绝");
}

{
  const h = makeHarness();
  const result = await runForumPoc({
    argv: ["inspect", "--thread", THREAD_ID, "--confirm-guild", "wrong"],
    loadConfigFn: () => baseConfig(),
    createClientFn: h.createClientFn,
    stderr: outputBuffer(),
  });
  assert(result.exitCode !== 0, "confirm-guild 不匹配拒绝");
}

// dry-run 不 send
{
  let sendCalled = 0;
  const h = makeHarness({
    sendImpl: async () => {
      sendCalled += 1;
      return { id: MESSAGE_ID, delete: async () => {} };
    },
  });
  const stdout = outputBuffer();
  const result = await runForumPoc({
    argv: ["bump-message", "--thread", THREAD_ID, "--confirm-guild", GUILD_ID],
    loadConfigFn: () => baseConfig(),
    createClientFn: h.createClientFn,
    stdout,
    stderr: outputBuffer(),
  });
  assertEqual(result.exitCode, 0, "dry-run 退出 0");
  assertEqual(sendCalled, 0, "缺 execute 保持 dry-run 不 send");
  assert(stdout.lines.join("").includes("\"dryRun\": true") || stdout.lines.join("").includes("\"dryRun\":true"), "输出 dryRun");
}

// execute 成功生命周期
{
  const h = makeHarness();
  let sleepCount = 0;
  const stdout = outputBuffer();
  const result = await runForumPoc({
    argv: ["bump-message", "--thread", THREAD_ID, "--confirm-guild", GUILD_ID, "--execute"],
    loadConfigFn: () => baseConfig(),
    createClientFn: h.createClientFn,
    stdout,
    stderr: outputBuffer(),
    sleep: async () => { sleepCount += 1; },
  });
  assertEqual(result.exitCode, 0, "execute 成功退出 0");
  assertEqual(result.result.success, true, "result.success");
  assertEqual(sleepCount, 1, "CLI 注入 sleep 一次");
  assertEqual(h.destroyCalled, 1, "成功时 destroy");
  assertEqual(h.message._payload.content, BUMP_MESSAGE_CONTENT, "固定文案经 CLI");
  const out = stdout.lines.join("");
  assert(!out.includes(TOKEN), "成功输出无 Token");
  assert(!out.includes(BUMP_MESSAGE_CONTENT), "成功输出不含正文（仅快照字段）");
}

// 删除失败 cleanup
{
  const h = makeHarness({
    deleteImpl: async () => {
      const err = new Error("nope");
      err.code = 50013;
      throw err;
    },
  });
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  const result = await runForumPoc({
    argv: ["bump-message", "--thread", THREAD_ID, "--confirm-guild", GUILD_ID, "--execute"],
    loadConfigFn: () => baseConfig(),
    createClientFn: h.createClientFn,
    stdout,
    stderr,
    sleep: async () => {},
  });
  assert(result.exitCode !== 0, "删除失败非 0");
  assertEqual(result.result.cleanupRequired, true, "cleanupRequired");
  assertEqual(result.result.sentMessageId, MESSAGE_ID, "CLI 返回 sentMessageId");
  assert(stderr.lines.join("").includes("手动清理"), "提示管理员手动清理");
  assertEqual(h.destroyCalled, 1, "删除失败仍 destroy");
}

// destroy 失败不覆盖结果
{
  const h = makeHarness();
  h.setDestroyFail(true);
  const result = await runForumPoc({
    argv: ["inspect", "--thread", THREAD_ID, "--confirm-guild", GUILD_ID],
    loadConfigFn: () => baseConfig(),
    createClientFn: h.createClientFn,
    stdout: outputBuffer(),
    stderr: outputBuffer(),
  });
  assertEqual(result.exitCode, 0, "destroy 失败不覆盖成功结果");
  assertEqual(h.destroyCalled, 1, "仍尝试 destroy");
}

// 参数错误不 login
{
  let created = false;
  const result = await runForumPoc({
    argv: ["nope"],
    loadConfigFn: () => baseConfig(),
    createClientFn: () => {
      created = true;
      return { client: {}, login: async () => {}, destroy: async () => {} };
    },
    stderr: outputBuffer(),
  });
  assert(result.exitCode !== 0, "非法命令非 0");
  // 参数错误在 config 前返回，可能不创建 client
  assertEqual(created, false, "非法参数不创建 client");
}

console.log(`\nForumPoc CLI: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

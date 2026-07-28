import { ChannelType, PermissionFlagsBits } from "discord.js";
import {
  BUMP_ALLOWED_MENTIONS,
  BUMP_DELETE_DELAY_MS,
  BUMP_MESSAGE_CONTENT,
  bumpForumThreadMessage,
  MANUAL_CLEANUP_HINT,
} from "./bumpMessage.js";
import { isForumPocError } from "./errors.js";

const GUILD_ID = "111111111111111111";
const FORUM_ID = "222222222222222222";
const THREAD_ID = "333333333333333333";
const MESSAGE_ID = "444444444444444444";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

function baseConfig(overrides = {}) {
  return {
    nodeEnv: "development",
    testMode: true,
    discordGuildId: GUILD_ID,
    discordBotToken: "TOKEN_SECRET_VALUE",
    ...overrides,
  };
}

function makeParentForum() {
  return {
    id: FORUM_ID,
    type: ChannelType.GuildForum,
    defaultSortOrder: 0,
  };
}

function makePermissions(flags) {
  const set = new Set(flags);
  return {
    has(flag) {
      return set.has(flag);
    },
  };
}

function makeThread(overrides = {}) {
  const parent = overrides.parent ?? makeParentForum();
  const state = {
    lastMessageId: "old-msg",
    messageCount: 2,
    totalMessageSent: 2,
  };
  const thread = {
    id: THREAD_ID,
    type: ChannelType.PublicThread,
    guildId: GUILD_ID,
    parentId: FORUM_ID,
    parent,
    name: "bump-target",
    archived: false,
    locked: false,
    autoArchiveDuration: 1440,
    archiveTimestamp: 1700000000000,
    get lastMessageId() { return state.lastMessageId; },
    set lastMessageId(v) { state.lastMessageId = v; },
    get messageCount() { return state.messageCount; },
    set messageCount(v) { state.messageCount = v; },
    get totalMessageSent() { return state.totalMessageSent; },
    set totalMessageSent(v) { state.totalMessageSent = v; },
    appliedTags: [],
    permissionsFor() {
      return makePermissions([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessagesInThreads,
      ]);
    },
    send: async () => {
      throw new Error("send not stubbed");
    },
    ...overrides,
    parent: overrides.parent === null ? null : (overrides.parent ?? parent),
  };
  return { thread, state };
}

function makeClient(thread, { onFetch } = {}) {
  return {
    user: { id: "bot-1" },
    channels: {
      fetch: async (id) => {
        if (onFetch) onFetch(id);
        if (id === THREAD_ID) return thread;
        if (id === FORUM_ID) return thread.parent;
        return null;
      },
    },
  };
}

const fixedClock = {
  t: 1_700_000_000_000,
  now() { return this.t; },
};

console.log("\n=== ForumPoc bumpMessage ===\n");

// ---- 安全门 ----
for (const [config, code, label] of [
  [baseConfig({ nodeEnv: "production" }), "NOT_DEVELOPMENT", "production 拒绝 bump"],
  [baseConfig({ testMode: false }), "TEST_MODE_REQUIRED", "TEST_MODE=false 拒绝 bump"],
]) {
  const { thread } = makeThread();
  try {
    await bumpForumThreadMessage({
      client: makeClient(thread),
      config,
      threadId: THREAD_ID,
      confirmGuild: GUILD_ID,
      execute: true,
      clock: fixedClock,
      sleep: async () => {},
    });
    assert(false, label);
  } catch (error) {
    assert(isForumPocError(error) && error.code === code, label);
  }
}

try {
  const { thread } = makeThread();
  await bumpForumThreadMessage({
    client: makeClient(thread),
    config: baseConfig(),
    threadId: THREAD_ID,
    confirmGuild: "nope",
    execute: false,
    clock: fixedClock,
    sleep: async () => {},
  });
  assert(false, "mismatch 应失败");
} catch (error) {
  assert(error.code === "GUILD_CONFIRMATION_MISMATCH", "confirm-guild 不匹配拒绝");
}

try {
  const { thread } = makeThread();
  await bumpForumThreadMessage({
    client: makeClient(thread),
    config: baseConfig(),
    threadId: THREAD_ID,
    confirmGuild: undefined,
    execute: false,
    clock: fixedClock,
    sleep: async () => {},
  });
  assert(false, "缺 confirm 应失败");
} catch (error) {
  assert(error.code === "GUILD_CONFIRMATION_REQUIRED", "缺少 confirm-guild 拒绝");
}

// ---- Thread 验证 ----
{
  const { thread } = makeThread({ guildId: "other-guild" });
  try {
    await bumpForumThreadMessage({
      client: makeClient(thread),
      config: baseConfig(),
      threadId: THREAD_ID,
      confirmGuild: GUILD_ID,
      execute: false,
      clock: fixedClock,
      sleep: async () => {},
    });
    assert(false, "wrong guild 应失败");
  } catch (error) {
    assert(error.code === "WRONG_GUILD", "Thread guild 不匹配拒绝");
  }
}

{
  const { thread } = makeThread({ type: ChannelType.PrivateThread });
  try {
    await bumpForumThreadMessage({
      client: makeClient(thread),
      config: baseConfig(),
      threadId: THREAD_ID,
      confirmGuild: GUILD_ID,
      execute: false,
      clock: fixedClock,
      sleep: async () => {},
    });
    assert(false, "private thread 应失败");
  } catch (error) {
    assert(error.code === "WRONG_THREAD_TYPE", "Private Thread 拒绝");
  }
}

{
  const { thread } = makeThread({
    parent: { id: FORUM_ID, type: ChannelType.GuildText },
  });
  try {
    await bumpForumThreadMessage({
      client: makeClient(thread),
      config: baseConfig(),
      threadId: THREAD_ID,
      confirmGuild: GUILD_ID,
      execute: false,
      clock: fixedClock,
      sleep: async () => {},
    });
    assert(false, "非 forum parent 应失败");
  } catch (error) {
    assert(error.code === "NOT_FORUM_THREAD", "父频道非 GuildForum 拒绝");
  }
}

{
  const { thread } = makeThread({ locked: true });
  try {
    await bumpForumThreadMessage({
      client: makeClient(thread),
      config: baseConfig(),
      threadId: THREAD_ID,
      confirmGuild: GUILD_ID,
      execute: true,
      clock: fixedClock,
      sleep: async () => {},
    });
    assert(false, "locked 应失败");
  } catch (error) {
    assert(error.code === "THREAD_LOCKED", "锁定 Thread 拒绝");
  }
}

{
  const { thread } = makeThread({
    permissionsFor() {
      return makePermissions([PermissionFlagsBits.ViewChannel]);
    },
  });
  try {
    await bumpForumThreadMessage({
      client: makeClient(thread),
      config: baseConfig(),
      threadId: THREAD_ID,
      confirmGuild: GUILD_ID,
      execute: true,
      clock: fixedClock,
      sleep: async () => {},
    });
    assert(false, "缺 SendMessagesInThreads 应失败");
  } catch (error) {
    assert(error.code === "BOT_MISSING_PERMISSION", "缺少 SendMessagesInThreads 拒绝");
  }
}

{
  const { thread } = makeThread({
    permissionsFor() {
      return makePermissions([PermissionFlagsBits.SendMessagesInThreads]);
    },
  });
  try {
    await bumpForumThreadMessage({
      client: makeClient(thread),
      config: baseConfig(),
      threadId: THREAD_ID,
      confirmGuild: GUILD_ID,
      execute: true,
      clock: fixedClock,
      sleep: async () => {},
    });
    assert(false, "缺 ViewChannel 应失败");
  } catch (error) {
    assert(error.code === "BOT_MISSING_PERMISSION", "缺少 ViewChannel 拒绝");
  }
}

// ---- Dry run ----
{
  let sendCalled = 0;
  let deleteCalled = 0;
  const { thread } = makeThread({
    send: async () => {
      sendCalled += 1;
      return { id: MESSAGE_ID, delete: async () => { deleteCalled += 1; } };
    },
  });
  const result = await bumpForumThreadMessage({
    client: makeClient(thread),
    config: baseConfig(),
    threadId: THREAD_ID,
    confirmGuild: GUILD_ID,
    execute: false,
    clock: fixedClock,
    sleep: async () => { throw new Error("dry-run must not sleep"); },
  });
  assertEqual(result.dryRun, true, "dry-run 标记");
  assertEqual(result.success, true, "dry-run success");
  assertEqual(result.sentMessageId, null, "dry-run 无 sentMessageId");
  assertEqual(sendCalled, 0, "dry-run 不调用 send");
  assertEqual(deleteCalled, 0, "dry-run 不调用 delete");
  assert(result.before && result.before.threadId === THREAD_ID, "dry-run 有 before 快照");
  assertEqual(result.afterSend, null, "dry-run 无 afterSend");
  assertEqual(result.plannedAction.deleteDelayMs, BUMP_DELETE_DELAY_MS, "计划延迟 1000ms");
}

// ---- Execute 成功 ----
{
  let sendCalls = 0;
  let deleteCalls = 0;
  let sleepCalls = 0;
  let sleepMs = null;
  let sentPayload = null;
  const deletedIds = [];

  const { thread, state } = makeThread();
  thread.send = async (payload) => {
    sendCalls += 1;
    sentPayload = payload;
    state.lastMessageId = MESSAGE_ID;
    state.messageCount += 1;
    state.totalMessageSent += 1;
    return {
      id: MESSAGE_ID,
      delete: async () => {
        deleteCalls += 1;
        deletedIds.push(MESSAGE_ID);
        state.messageCount = Math.max(0, state.messageCount - 1);
      },
    };
  };

  const logs = [];
  const result = await bumpForumThreadMessage({
    client: makeClient(thread),
    config: baseConfig(),
    threadId: THREAD_ID,
    confirmGuild: GUILD_ID,
    execute: true,
    clock: fixedClock,
    sleep: async (ms) => {
      sleepCalls += 1;
      sleepMs = ms;
    },
    logger: {
      info: (m, meta) => logs.push({ level: "info", m, meta }),
      warn: (m, meta) => logs.push({ level: "warn", m, meta }),
      error: (m, meta) => logs.push({ level: "error", m, meta }),
    },
  });

  assertEqual(sendCalls, 1, "send 只调用一次");
  assertEqual(deleteCalls, 1, "delete 只调用一次");
  assertEqual(sleepCalls, 1, "sleep 调用一次");
  assertEqual(sleepMs, 1000, "sleep(1000)");
  assertEqual(sentPayload.content, BUMP_MESSAGE_CONTENT, "固定测试文案");
  assertEqual(JSON.stringify(sentPayload.allowedMentions.parse), "[]", "allowedMentions.parse 空");
  assertEqual(JSON.stringify(sentPayload.allowedMentions.users), "[]", "allowedMentions.users 空");
  assertEqual(JSON.stringify(sentPayload.allowedMentions.roles), "[]", "allowedMentions.roles 空");
  assertEqual(sentPayload.allowedMentions.repliedUser, false, "repliedUser false");
  assertEqual(result.success, true, "execute success");
  assertEqual(result.cleanupRequired, false, "cleanupRequired false");
  assertEqual(result.sentMessageId, MESSAGE_ID, "sentMessageId");
  assert(result.before && result.afterSend && result.afterDelete, "三段快照齐全");
  assertEqual(deletedIds[0], MESSAGE_ID, "删除同一消息 id");
  assertEqual(result.clientObservations.observedSortPositionAfter, null, "不伪装 UI 排序");

  const logBlob = JSON.stringify(logs);
  assert(!logBlob.includes("TOKEN_SECRET_VALUE"), "日志无 Token");
  assert(!logBlob.includes(BUMP_MESSAGE_CONTENT), "日志无固定消息正文");
  assert(!logBlob.includes("stack"), "日志无 stack 字段滥用");
  assert(!logBlob.includes("\"headers\""), "日志无请求头");
}

// ---- 发送失败 ----
{
  let deleteCalled = 0;
  const { thread } = makeThread({
    send: async () => {
      const err = new Error("boom");
      err.code = 50013;
      throw err;
    },
  });
  try {
    await bumpForumThreadMessage({
      client: makeClient(thread),
      config: baseConfig(),
      threadId: THREAD_ID,
      confirmGuild: GUILD_ID,
      execute: true,
      clock: fixedClock,
      sleep: async () => {},
    });
    assert(false, "send fail 应抛错");
  } catch (error) {
    assert(error.code === "SEND_FAILED", "SEND_FAILED");
    assertEqual(deleteCalled, 0, "发送失败不 delete");
    assert(!JSON.stringify(error.safeMessage).includes("TOKEN"), "错误安全");
  }
}

// ---- 删除失败 ----
{
  let sendCalls = 0;
  let deleteCalls = 0;
  const { thread, state } = makeThread();
  thread.send = async () => {
    sendCalls += 1;
    state.lastMessageId = MESSAGE_ID;
    return {
      id: MESSAGE_ID,
      delete: async () => {
        deleteCalls += 1;
        const err = new Error("delete denied");
        err.code = 50013;
        throw err;
      },
    };
  };

  const result = await bumpForumThreadMessage({
    client: makeClient(thread),
    config: baseConfig(),
    threadId: THREAD_ID,
    confirmGuild: GUILD_ID,
    execute: true,
    clock: fixedClock,
    sleep: async () => {},
  });

  assertEqual(sendCalls, 1, "删除失败时不重复发送");
  assertEqual(deleteCalls, 1, "只 delete 一次");
  assertEqual(result.success, false, "delete fail success=false");
  assertEqual(result.cleanupRequired, true, "cleanupRequired true");
  assertEqual(result.sentMessageId, MESSAGE_ID, "返回 sentMessageId");
  assertEqual(result.manualCleanupHint, MANUAL_CLEANUP_HINT, "手动清理提示");
  assertEqual(result.errorCode, "DELETE_FAILED", "errorCode DELETE_FAILED");
  assert(result.afterDelete === null, "删除失败无 afterDelete");
}

// allowedMentions 常量冻结检查
assertEqual(BUMP_ALLOWED_MENTIONS.repliedUser, false, "常量 repliedUser false");
assertEqual(BUMP_DELETE_DELAY_MS, 1000, "延迟固定 1000");

console.log(`\nForumPoc bumpMessage: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

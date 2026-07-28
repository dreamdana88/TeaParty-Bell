import { ChannelType, PermissionFlagsBits } from "discord.js";
import { isForumPocError } from "./errors.js";
import { inspectForumThread } from "./inspect.js";

const GUILD_ID = "111111111111111111";
const FORUM_ID = "222222222222222222";
const THREAD_ID = "333333333333333333";

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
    discordBotToken: "TOKEN_SECRET_SHOULD_NOT_LOG",
    ...overrides,
  };
}

function makeParentForum(overrides = {}) {
  return {
    id: FORUM_ID,
    type: ChannelType.GuildForum,
    defaultSortOrder: 0,
    ...overrides,
  };
}

function makeThread(overrides = {}) {
  const parent = overrides.parent ?? makeParentForum();
  return {
    id: THREAD_ID,
    type: ChannelType.PublicThread,
    guildId: GUILD_ID,
    parentId: FORUM_ID,
    parent,
    name: "test-post",
    archived: false,
    locked: false,
    autoArchiveDuration: 1440,
    archiveTimestamp: 1700000000000,
    lastMessageId: "999",
    messageCount: 3,
    totalMessageSent: 5,
    appliedTags: ["tag-1"],
    permissionsFor() {
      return {
        has(flag) {
          return flag === PermissionFlagsBits.ViewChannel
            || flag === PermissionFlagsBits.SendMessagesInThreads;
        },
      };
    },
    send: async () => { throw new Error("inspect must not send"); },
    ...overrides,
    parent: overrides.parent === null ? null : (overrides.parent ?? parent),
  };
}

function makeClient(thread, { onFetch, failForce } = {}) {
  return {
    user: { id: "bot-1" },
    channels: {
      fetch: async (id, options) => {
        if (onFetch) onFetch(id, options);
        if (failForce && options?.force === true && id === THREAD_ID) {
          const err = new Error("force failed");
          err.code = 500;
          throw err;
        }
        if (id === THREAD_ID) return thread;
        if (id === FORUM_ID) return thread.parent;
        return null;
      },
    },
  };
}

const fixedClock = { now: () => 1_700_000_000_000 };

console.log("\n=== ForumPoc inspect ===\n");

{
  const thread = makeThread();
  const logs = [];
  const result = await inspectForumThread({
    client: makeClient(thread),
    config: baseConfig(),
    threadId: THREAD_ID,
    confirmGuild: GUILD_ID,
    clock: fixedClock,
    logger: { info: (m, meta) => logs.push({ m, meta }) },
  });
  assertEqual(result.success, true, "inspect 成功");
  assertEqual(result.operation, "inspect", "operation");
  assertEqual(result.snapshot.threadId, THREAD_ID, "snapshot.threadId");
  assertEqual(result.snapshot.forumChannelId, FORUM_ID, "snapshot.forumChannelId");
  assertEqual(result.snapshot.guildId, GUILD_ID, "snapshot.guildId");
  assertEqual(result.snapshot.threadName, "test-post", "snapshot.threadName");
  assertEqual(result.snapshot.lastMessageId, "999", "snapshot.lastMessageId");
  assertEqual(result.snapshot.messageCount, 3, "snapshot.messageCount");
  assertEqual(result.snapshot.totalMessageSent, 5, "snapshot.totalMessageSent");
  assertEqual(result.snapshot.defaultSortOrder, 0, "snapshot.defaultSortOrder");
  assertEqual(result.snapshot.appliedTagIds.join(","), "tag-1", "appliedTagIds");
  assertEqual(result.clientObservations.observedSortPositionBefore, null, "客户端观察留空");
  assertEqual(result.clientObservations.unreadObserved, null, "unread 留空");
  assert(logs.every((l) => !JSON.stringify(l).includes("TOKEN_SECRET")), "日志无 Token");
}

{
  const sparse = makeThread({
    name: undefined,
    archived: undefined,
    locked: undefined,
    autoArchiveDuration: undefined,
    archiveTimestamp: undefined,
    lastMessageId: undefined,
    messageCount: undefined,
    totalMessageSent: undefined,
    appliedTags: undefined,
    parent: makeParentForum({ defaultSortOrder: undefined }),
  });
  const result = await inspectForumThread({
    client: makeClient(sparse),
    config: baseConfig(),
    threadId: THREAD_ID,
    confirmGuild: GUILD_ID,
    clock: fixedClock,
  });
  assertEqual(result.snapshot.threadName, null, "空 name 序列化为 null");
  assertEqual(result.snapshot.archived, null, "空 archived 序列化为 null");
  assertEqual(result.snapshot.lastMessageId, null, "空 lastMessageId 序列化为 null");
  assert(Array.isArray(result.snapshot.appliedTagIds) && result.snapshot.appliedTagIds.length === 0, "空 tags 为 []");
}

for (const [config, code, label] of [
  [baseConfig({ nodeEnv: "production" }), "NOT_DEVELOPMENT", "production 拒绝"],
  [baseConfig({ testMode: false }), "TEST_MODE_REQUIRED", "TEST_MODE=false 拒绝"],
]) {
  try {
    await inspectForumThread({
      client: makeClient(makeThread()),
      config,
      threadId: THREAD_ID,
      confirmGuild: GUILD_ID,
      clock: fixedClock,
    });
    assert(false, label);
  } catch (error) {
    assert(isForumPocError(error) && error.code === code, label);
  }
}

try {
  await inspectForumThread({
    client: makeClient(makeThread()),
    config: baseConfig(),
    threadId: THREAD_ID,
    confirmGuild: undefined,
    clock: fixedClock,
  });
  assert(false, "缺少 confirm-guild 应失败");
} catch (error) {
  assert(error.code === "GUILD_CONFIRMATION_REQUIRED", "缺少 confirm-guild 拒绝");
}

try {
  await inspectForumThread({
    client: makeClient(makeThread()),
    config: baseConfig(),
    threadId: THREAD_ID,
    confirmGuild: "wrong",
    clock: fixedClock,
  });
  assert(false, "confirm mismatch 应失败");
} catch (error) {
  assert(error.code === "GUILD_CONFIRMATION_MISMATCH", "confirm-guild 不匹配拒绝");
}

{
  let sendCalled = false;
  const thread = makeThread({
    send: async () => { sendCalled = true; },
  });
  await inspectForumThread({
    client: makeClient(thread),
    config: baseConfig(),
    threadId: THREAD_ID,
    confirmGuild: GUILD_ID,
    clock: fixedClock,
  });
  assertEqual(sendCalled, false, "inspect 不发送消息");
}

{
  const client = {
    channels: {
      fetch: async () => {
        const err = new Error("unknown");
        err.code = 10003;
        throw err;
      },
    },
  };
  try {
    await inspectForumThread({
      client,
      config: baseConfig(),
      threadId: THREAD_ID,
      confirmGuild: GUILD_ID,
      clock: fixedClock,
    });
    assert(false, "不存在 thread 应失败");
  } catch (error) {
    assert(error.code === "THREAD_NOT_FOUND", "Thread 不存在");
  }
}

{
  const fetchCalls = [];
  const thread = makeThread();
  await inspectForumThread({
    client: makeClient(thread, {
      onFetch: (id, options) => fetchCalls.push({ id, force: options?.force === true }),
    }),
    config: baseConfig(),
    threadId: THREAD_ID,
    confirmGuild: GUILD_ID,
    clock: fixedClock,
  });
  const threadFetches = fetchCalls.filter((c) => c.id === THREAD_ID);
  assert(threadFetches.length >= 1, "inspect 至少 fetch 一次 Thread");
  assert(threadFetches.every((c) => c.force === true), "inspect Thread fetch 使用 force:true");
  const forumFetches = fetchCalls.filter((c) => c.id === FORUM_ID);
  assert(forumFetches.every((c) => c.force === true), "inspect 父 Forum force:true");
}

{
  try {
    await inspectForumThread({
      client: makeClient(makeThread(), { failForce: true }),
      config: baseConfig(),
      threadId: THREAD_ID,
      confirmGuild: GUILD_ID,
      clock: fixedClock,
    });
    assert(false, "force 刷新失败应拒绝");
  } catch (error) {
    assert(
      error.code === "INSPECT_FAILED" || error.code === "SNAPSHOT_FAILED" || error.code === "THREAD_NOT_FOUND",
      "inspect force 失败返回明确错误",
    );
    assert(error.safeMessage && !error.safeMessage.includes("TOKEN"), "inspect 失败错误安全");
  }
}

console.log(`\nForumPoc inspect: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

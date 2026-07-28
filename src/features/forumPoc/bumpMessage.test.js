import { ChannelType, PermissionFlagsBits } from "discord.js";
import {
  BUMP_DELETE_DELAY_MS,
  BUMP_MESSAGE_CONTENT,
  bumpForumThreadMessage,
  MANUAL_CLEANUP_HINT,
  POC_DEFAULT_SILENCE_DAYS,
} from "./bumpMessage.js";
import { isForumPocError } from "./errors.js";

const GUILD_ID = "111111111111111111";
const FORUM_ID = "222222222222222222";
const THREAD_ID = "333333333333333333";
const MESSAGE_ID = "444444444444444444";
const OLD_MSG = "1429163615671423037";
const NOW = 1_800_000_000_000;

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label} (got ${JSON.stringify(actual)})`);
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

function makePermissions(flags) {
  const set = new Set(flags);
  return { has: (flag) => set.has(flag) };
}

function makeThread(overrides = {}) {
  const parent = overrides.parent ?? {
    id: FORUM_ID,
    type: ChannelType.GuildForum,
    defaultSortOrder: 0,
  };
  return {
    id: THREAD_ID,
    type: ChannelType.PublicThread,
    guildId: GUILD_ID,
    parentId: FORUM_ID,
    parent,
    name: "bump-target",
    archived: false,
    locked: false,
    autoArchiveDuration: 1440,
    archiveTimestamp: 1_700_000_000_000,
    lastMessageId: OLD_MSG,
    messageCount: 2,
    totalMessageSent: 2,
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
}

function makeClient(thread) {
  return {
    user: { id: "bot-1" },
    channels: {
      fetch: async (id, options) => {
        if (!options?.force) throw new Error("force required");
        if (id === THREAD_ID) return thread;
        if (id === FORUM_ID) return thread.parent;
        return null;
      },
    },
  };
}

const fixedClock = { now: () => NOW };

console.log("\n=== ForumPoc bumpMessage (delegates service) ===\n");

// 安全门
for (const [config, code, label] of [
  [baseConfig({ nodeEnv: "production" }), "NOT_DEVELOPMENT", "production 拒绝 bump"],
  [baseConfig({ testMode: false }), "TEST_MODE_REQUIRED", "TEST_MODE=false 拒绝 bump"],
]) {
  try {
    await bumpForumThreadMessage({
      client: makeClient(makeThread()),
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
  await bumpForumThreadMessage({
    client: makeClient(makeThread()),
    config: baseConfig(),
    threadId: THREAD_ID,
    confirmGuild: "nope",
    execute: false,
    clock: fixedClock,
    sleep: async () => {},
  });
  assert(false, "mismatch");
} catch (error) {
  assert(error.code === "GUILD_CONFIRMATION_MISMATCH", "confirm 不匹配");
}

// Dry run 不调用 service 发送
{
  let serviceCalled = false;
  const result = await bumpForumThreadMessage({
    client: makeClient(makeThread()),
    config: baseConfig(),
    threadId: THREAD_ID,
    confirmGuild: GUILD_ID,
    execute: false,
    clock: fixedClock,
    sleep: async () => { throw new Error("no sleep"); },
    createBumpServiceFn: () => {
      serviceCalled = true;
      return { bumpThread: async () => { throw new Error("no"); } };
    },
  });
  assertEqual(result.dryRun, true, "dry-run");
  assertEqual(result.success, true, "dry-run success");
  assertEqual(serviceCalled, false, "dry-run 不创建 service");
  assertEqual(result.plannedAction.deleteDelayMs, BUMP_DELETE_DELAY_MS, "计划延迟");
}

// execute 委托正式 service
{
  let received = null;
  const result = await bumpForumThreadMessage({
    client: makeClient(makeThread()),
    config: baseConfig(),
    threadId: THREAD_ID,
    confirmGuild: GUILD_ID,
    execute: true,
    clock: fixedClock,
    sleep: async () => {},
    createBumpServiceFn: ({ client, content }) => {
      assert(client, "注入 client");
      assertEqual(content, BUMP_MESSAGE_CONTENT, "生产固定文案注入");
      return {
        bumpThread: async (params) => {
          received = params;
          return {
            operation: "forum-bump",
            status: "succeeded",
            success: true,
            skipped: false,
            cleanupRequired: false,
            diagnosticsComplete: true,
            guildId: GUILD_ID,
            forumChannelId: FORUM_ID,
            threadId: THREAD_ID,
            sentMessageId: MESSAGE_ID,
            activityAt: 1,
            activitySource: "last_message_snowflake",
            silenceDaysExact: 40,
            skipReason: null,
            errorCode: null,
            warnings: [],
            before: { threadId: THREAD_ID },
            afterSend: { threadId: THREAD_ID },
            afterDelete: { threadId: THREAD_ID },
            durationMs: 12,
            abortedAfterSend: false,
          };
        },
      };
    },
  });
  assertEqual(result.success, true, "委托成功");
  assertEqual(result.status, "succeeded", "status succeeded");
  assertEqual(result.sentMessageId, MESSAGE_ID, "sentMessageId");
  assertEqual(result.diagnosticsComplete, true, "diagnosticsComplete");
  assertEqual(received.guildId, GUILD_ID, "service guildId");
  assertEqual(received.forumChannelId, FORUM_ID, "service forumId");
  assertEqual(received.policy.silenceDays, POC_DEFAULT_SILENCE_DAYS, "默认 silenceDays");
  assertEqual(received.policy.skipPinned, true, "skipPinned");
}

// 删除失败映射
{
  const result = await bumpForumThreadMessage({
    client: makeClient(makeThread()),
    config: baseConfig(),
    threadId: THREAD_ID,
    confirmGuild: GUILD_ID,
    execute: true,
    clock: fixedClock,
    sleep: async () => {},
    createBumpServiceFn: () => ({
      bumpThread: async () => ({
        operation: "forum-bump",
        status: "failed",
        success: false,
        skipped: false,
        cleanupRequired: true,
        diagnosticsComplete: false,
        guildId: GUILD_ID,
        forumChannelId: FORUM_ID,
        threadId: THREAD_ID,
        sentMessageId: MESSAGE_ID,
        activityAt: 1,
        activitySource: "last_message_snowflake",
        silenceDaysExact: 40,
        skipReason: null,
        errorCode: "DELETE_FAILED",
        warnings: [],
        before: { threadId: THREAD_ID },
        afterSend: { threadId: THREAD_ID },
        afterDelete: null,
        durationMs: 9,
        abortedAfterSend: false,
      }),
    }),
  });
  assertEqual(result.success, false, "delete fail");
  assertEqual(result.cleanupRequired, true, "cleanupRequired");
  assertEqual(result.sentMessageId, MESSAGE_ID, "保留 id");
  assertEqual(result.manualCleanupHint, MANUAL_CLEANUP_HINT, "手动清理提示");
}

// 发送失败 throw
{
  try {
    await bumpForumThreadMessage({
      client: makeClient(makeThread()),
      config: baseConfig(),
      threadId: THREAD_ID,
      confirmGuild: GUILD_ID,
      execute: true,
      clock: fixedClock,
      sleep: async () => {},
      createBumpServiceFn: () => ({
        bumpThread: async () => ({
          operation: "forum-bump",
          status: "failed",
          success: false,
          cleanupRequired: false,
          sentMessageId: null,
          errorCode: "SEND_FAILED",
          guildId: GUILD_ID,
          forumChannelId: FORUM_ID,
          threadId: THREAD_ID,
          before: null,
          afterSend: null,
          afterDelete: null,
          warnings: [],
          durationMs: 1,
        }),
      }),
    });
    assert(false, "send fail 应 throw");
  } catch (error) {
    assert(error.code === "SEND_FAILED", "SEND_FAILED throw");
  }
}

// 集成：真实 service 路径无写状态
{
  let send = 0;
  let del = 0;
  const thread = makeThread();
  thread.send = async (payload) => {
    send += 1;
    assertEqual(payload.content, BUMP_MESSAGE_CONTENT, "集成固定文案");
    return {
      id: MESSAGE_ID,
      delete: async () => { del += 1; },
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
  assertEqual(result.success, true, "集成 success");
  assertEqual(send, 1, "集成 send 1");
  assertEqual(del, 1, "集成 delete 1");
  assert(Array.isArray(result.warnings), "warnings 数组");
}

console.log(`\nForumPoc bumpMessage: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

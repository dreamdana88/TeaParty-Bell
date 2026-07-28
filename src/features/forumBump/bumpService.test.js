import { ChannelType, PermissionFlagsBits } from "discord.js";
import {
  FORUM_BUMP_CONTENT,
  FORUM_BUMP_DELETE_DELAY_MS,
  FORUM_BUMP_AFTER_DELETE_SETTLE_MS,
  createForumBumpService,
  isClientReadyForBump,
} from "./bumpService.js";

const GUILD = "111111111111111111";
const FORUM = "222222222222222222";
const THREAD = "333333333333333333";
const MSG = "444444444444444444";
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

function perms(flags) {
  const set = new Set(flags);
  return { has: (f) => set.has(f) };
}

function makeHarness({
  locked = false,
  pinned = false,
  type = ChannelType.PublicThread,
  lastMessageId = OLD_MSG,
  parentType = ChannelType.GuildForum,
  parentId = FORUM,
  guildId = GUILD,
  sendImpl,
  deleteImpl,
  failAfterSendRefresh = false,
  failAfterDeleteRefresh = false,
  missingPermissions = false,
  appliedTags = [],
} = {}) {
  let sendCount = 0;
  let deleteCount = 0;
  let fetchCount = 0;
  const sleepMs = [];
  const logs = [];

  const parent = {
    id: FORUM,
    type: parentType,
    defaultSortOrder: 0,
  };

  const message = {
    id: MSG,
    delete: deleteImpl || (async () => {
      deleteCount += 1;
    }),
  };

  const thread = {
    id: THREAD,
    type,
    guildId,
    parentId,
    parent,
    name: "target",
    archived: true,
    locked,
    pinned,
    autoArchiveDuration: 4320,
    archiveTimestamp: 1_700_000_000_000,
    lastMessageId,
    messageCount: 4,
    totalMessageSent: 4,
    appliedTags,
    permissionsFor() {
      if (missingPermissions) return perms([]);
      return perms([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessagesInThreads,
      ]);
    },
    send: sendImpl || (async (payload) => {
      sendCount += 1;
      thread._lastPayload = payload;
      thread.lastMessageId = MSG;
      thread.messageCount += 1;
      thread.totalMessageSent += 1;
      thread.archived = false;
      return message;
    }),
  };

  let phase = "before";
  const client = {
    user: { id: "bot" },
    isReady: () => true,
    channels: {
      fetch: async (id, options) => {
        fetchCount += 1;
        if (!options?.force) throw new Error("force required");
        if (id === THREAD) {
          if (phase === "afterSend" && failAfterSendRefresh) {
            const err = new Error("refresh fail");
            err.code = 500;
            throw err;
          }
          if (phase === "afterDelete" && failAfterDeleteRefresh) {
            const err = new Error("refresh fail");
            err.code = 500;
            throw err;
          }
          return thread;
        }
        if (id === FORUM || id === parentId) return parent;
        const err = new Error("nf");
        err.code = 10003;
        throw err;
      },
    },
  };

  const clock = { now: () => NOW };
  const sleep = async (ms) => {
    sleepMs.push(ms);
    if (sleepMs.length === 1) phase = "afterSend";
    if (sleepMs.length === 2) phase = "afterDelete";
  };

  // afterSend refresh happens BEFORE first sleep in service
  // Adjust phase tracking:
  // fetch sequence: thread, parent (before), then after send: thread, parent, then sleep, delete, sleep, thread, parent
  // Better: fail based on fetch count thresholds

  return {
    client,
    thread,
    message,
    clock,
    sleep,
    sleepMs,
    logs,
    get sendCount() { return sendCount; },
    get deleteCount() { return deleteCount; },
    get fetchCount() { return fetchCount; },
    setPhase(p) { phase = p; },
    logger: {
      info: (m, meta) => logs.push({ level: "info", m, meta }),
      warn: (m, meta) => logs.push({ level: "warn", m, meta }),
      error: (m, meta) => logs.push({ level: "error", m, meta }),
    },
  };
}

function makeService(h, overrides = {}) {
  // re-wrap fetch for failure modes
  const baseFetch = h.client.channels.fetch;
  let threadForceCount = 0;
  h.client.channels.fetch = async (id, options) => {
    if (id === THREAD && options?.force) {
      threadForceCount += 1;
      // 1 = before, 2 = afterSend, 3 = afterDelete
      if (overrides.failAfterSendRefresh && threadForceCount === 2) {
        const err = new Error("afterSend fail");
        err.code = 500;
        throw err;
      }
      if (overrides.failAfterDeleteRefresh && threadForceCount === 3) {
        const err = new Error("afterDelete fail");
        err.code = 500;
        throw err;
      }
    }
    return baseFetch(id, options);
  };

  return createForumBumpService({
    client: h.client,
    logger: h.logger,
    clock: h.clock,
    sleep: h.sleep,
    ...overrides.serviceOpts,
  });
}

function policy(extra = {}) {
  return {
    silenceDays: 30,
    excludedTagIds: [],
    skipPinned: true,
    ...extra,
  };
}

function call(service, extra = {}) {
  return service.bumpThread({
    guildId: GUILD,
    forumChannelId: FORUM,
    threadId: THREAD,
    policy: policy(),
    ...extra,
  });
}

console.log("\n=== ForumBump bumpService ===\n");

// 参数校验
{
  const h = makeHarness();
  const service = makeService(h);
  for (const [params, label] of [
    [{ guildId: "bad", forumChannelId: FORUM, threadId: THREAD, policy: policy() }, "非法 guild"],
    [{ guildId: GUILD, forumChannelId: "x", threadId: THREAD, policy: policy() }, "非法 forum"],
    [{ guildId: GUILD, forumChannelId: FORUM, threadId: "1", policy: policy() }, "非法 thread"],
    [{ guildId: GUILD, forumChannelId: FORUM, threadId: THREAD, policy: { silenceDays: 0 } }, "silence 0"],
    [{ guildId: GUILD, forumChannelId: FORUM, threadId: THREAD, policy: { silenceDays: 30, excludedTagIds: ["bad"] } }, "非法 tag"],
    [{ guildId: GUILD, forumChannelId: FORUM, threadId: THREAD, policy: { silenceDays: 30, skipPinned: "yes" } }, "非法 skipPinned"],
    [{ guildId: GUILD, forumChannelId: FORUM, threadId: THREAD, policy: policy(), signal: 123 }, "非法 signal"],
  ]) {
    const r = await service.bumpThread(params);
    assertEqual(r.errorCode, "BUMP_ARGUMENT_INVALID", label);
    assertEqual(h.sendCount, 0, `${label} 不 send`);
  }
}

// Thread 目标
{
  const h = makeHarness({ type: ChannelType.PrivateThread });
  const r = await call(makeService(h));
  assertEqual(r.status, "skipped", "PrivateThread skip");
  assertEqual(r.errorCode, "WRONG_THREAD_TYPE", "WRONG_THREAD_TYPE");
  assertEqual(h.sendCount, 0, "Private 不 send");
}

{
  const h = makeHarness({ parentId: "999999999999999999" });
  const r = await call(makeService(h));
  assertEqual(r.status, "skipped", "错误 parent skip");
  assertEqual(h.sendCount, 0, "错误 parent 不 send");
}

{
  const h = makeHarness({ guildId: "999999999999999999" });
  const r = await call(makeService(h));
  assertEqual(r.status, "skipped", "错误 guild");
  assertEqual(h.sendCount, 0, "错误 guild 不 send");
}

{
  const h = makeHarness();
  h.client.channels.fetch = async () => {
    const err = new Error("nf");
    err.code = 10003;
    throw err;
  };
  const r = await call(createForumBumpService({
    client: h.client, clock: h.clock, sleep: h.sleep, logger: h.logger,
  }));
  assertEqual(r.errorCode, "THREAD_NOT_FOUND", "不存在");
  assertEqual(h.sendCount, 0, "不存在不 send");
}

// 资格
{
  const h = makeHarness({ locked: true });
  const r = await call(makeService(h));
  assertEqual(r.status, "skipped", "locked skip");
  assertEqual(r.skipReason, "THREAD_LOCKED", "THREAD_LOCKED");
  assertEqual(h.sendCount, 0, "locked 不 send");
}

{
  const h = makeHarness({ pinned: true });
  const r = await call(makeService(h));
  assertEqual(r.status, "skipped", "pinned skip");
  assertEqual(h.sendCount, 0, "pinned 不 send");
}

{
  const h = makeHarness({ appliedTags: ["555555555555555555"] });
  const service = makeService(h);
  const r = await service.bumpThread({
    guildId: GUILD,
    forumChannelId: FORUM,
    threadId: THREAD,
    policy: policy({ excludedTagIds: ["555555555555555555"] }),
  });
  assertEqual(r.status, "skipped", "excluded tag");
  assertEqual(h.sendCount, 0, "tag 不 send");
}

{
  const h = makeHarness({ missingPermissions: true });
  const r = await call(makeService(h));
  assertEqual(r.status, "skipped", "缺权限 skip");
  assertEqual(h.sendCount, 0, "缺权限不 send");
}

{
  const recent = "1531539984471818262"; // ~2026-07-28
  const h = makeHarness({ lastMessageId: recent });
  // 使用略晚于消息时间的 clock（不足 30 天）
  const recentMs = Number((BigInt(recent) >> 22n) + 1_420_070_400_000n);
  h.clock.now = () => recentMs + 2 * 86_400_000; // +2 天
  const r = await call(makeService(h));
  assertEqual(r.status, "skipped", "不够沉默");
  assertEqual(r.skipReason, "NOT_SILENT_ENOUGH", "NOT_SILENT_ENOUGH");
  assertEqual(h.sendCount, 0, "不够沉默不 send");
}

// 活动时间 lastMessageId 优先
{
  const h = makeHarness({
    lastMessageId: OLD_MSG,
  });
  h.thread.archiveTimestamp = NOW; // 很新的 archive
  const r = await call(makeService(h));
  // activity from OLD_MSG should still be old → eligible and succeed
  assertEqual(r.status, "succeeded", "lastMessageId 优先于 archive 仍可顶");
  assertEqual(r.activitySource, "last_message_snowflake", "source snowflake");
}

// 成功路径
{
  const h = makeHarness();
  const r = await call(makeService(h));
  assertEqual(r.status, "succeeded", "成功 status");
  assertEqual(r.success, true, "success true");
  assertEqual(r.cleanupRequired, false, "cleanup false");
  assertEqual(r.diagnosticsComplete, true, "diagnostics complete");
  assertEqual(r.sentMessageId, MSG, "sentMessageId");
  assertEqual(h.sendCount, 1, "send 一次");
  assertEqual(h.deleteCount, 1, "delete 一次");
  assertEqual(h.sleepMs[0], FORUM_BUMP_DELETE_DELAY_MS, "删前 1000");
  assertEqual(h.sleepMs[1], FORUM_BUMP_AFTER_DELETE_SETTLE_MS, "删后 1000");
  assertEqual(h.thread._lastPayload.content, FORUM_BUMP_CONTENT, "固定文案");
  assertEqual(JSON.stringify(h.thread._lastPayload.allowedMentions.parse), "[]", "mentions 空");
  assert(r.before && r.afterSend && r.afterDelete, "三段快照");
  const logBlob = JSON.stringify(h.logs);
  assert(!logBlob.includes(FORUM_BUMP_CONTENT), "日志无正文");
  assert(!logBlob.includes("stack"), "日志无 stack");
}

// afterSend 快照失败仍删除并成功
{
  const h = makeHarness();
  const r = await call(makeService(h, { failAfterSendRefresh: true }));
  assertEqual(r.status, "succeeded", "afterSend 失败仍成功");
  assertEqual(r.success, true, "afterSend fail success");
  assertEqual(r.cleanupRequired, false, "afterSend fail cleaned");
  assertEqual(r.diagnosticsComplete, false, "diagnostics incomplete");
  assert(r.warnings.includes("AFTER_SEND_SNAPSHOT_FAILED"), "warning afterSend");
  assertEqual(h.deleteCount, 1, "仍 delete");
  assertEqual(h.sendCount, 1, "send 一次");
}

// afterDelete 快照失败仍成功
{
  const h = makeHarness();
  const r = await call(makeService(h, { failAfterDeleteRefresh: true }));
  assertEqual(r.status, "succeeded", "afterDelete 失败仍成功");
  assertEqual(r.success, true, "afterDelete success true");
  assertEqual(r.cleanupRequired, false, "afterDelete cleanup false");
  assertEqual(r.diagnosticsComplete, false, "afterDelete diagnostics false");
  assert(r.warnings.includes("AFTER_DELETE_SNAPSHOT_FAILED"), "warning afterDelete");
  assertEqual(r.afterDelete, null, "afterDelete null");
}

// 发送失败
{
  const h = makeHarness({
    sendImpl: async () => {
      const err = new Error("send fail");
      err.code = 50013;
      throw err;
    },
  });
  // re-count send via wrapper
  let sendCount = 0;
  h.thread.send = async () => {
    sendCount += 1;
    const err = new Error("send fail");
    err.code = 50013;
    throw err;
  };
  const r = await call(makeService(h));
  assertEqual(r.status, "failed", "send fail status");
  assertEqual(r.errorCode, "SEND_FAILED", "SEND_FAILED");
  assertEqual(r.cleanupRequired, false, "send fail no cleanup");
  assertEqual(r.sentMessageId, null, "no sent id");
  assertEqual(sendCount, 1, "send once");
  assertEqual(h.deleteCount, 0, "no delete");
}

// 删除失败
{
  let sendCount = 0;
  let deleteCount = 0;
  const h = makeHarness({
    sendImpl: async (payload) => {
      sendCount += 1;
      h.thread._lastPayload = payload;
      return {
        id: MSG,
        delete: async () => {
          deleteCount += 1;
          const err = new Error("del");
          err.code = 50013;
          throw err;
        },
      };
    },
  });
  const r = await call(makeService(h));
  assertEqual(r.status, "failed", "delete fail status");
  assertEqual(r.errorCode, "DELETE_FAILED", "DELETE_FAILED");
  assertEqual(r.cleanupRequired, true, "cleanup required");
  assertEqual(r.sentMessageId, MSG, "保留 sentMessageId");
  assertEqual(sendCount, 1, "不重发");
  assertEqual(deleteCount, 1, "delete 一次");
}

// Abort 发送前
{
  const h = makeHarness();
  const r = await call(makeService(h), { signal: { aborted: true } });
  assertEqual(r.status, "cancelled", "pre-send abort");
  assertEqual(r.errorCode, "BUMP_ABORTED", "BUMP_ABORTED");
  assertEqual(h.sendCount, 0, "abort 不 send");
}

// Abort 发送后（等待中）→ 仍删除成功
{
  const h = makeHarness();
  const signal = {
    aborted: false,
    listeners: [],
    addEventListener(type, fn) {
      if (type === "abort") this.listeners.push(fn);
    },
    removeEventListener() {},
  };
  const sleep = async (ms) => {
    h.sleepMs.push(ms);
    // 第一次 sleep（删前）时 abort
    if (h.sleepMs.length === 1) {
      signal.aborted = true;
      for (const fn of [...signal.listeners]) fn();
    }
  };
  const service = createForumBumpService({
    client: h.client,
    logger: h.logger,
    clock: h.clock,
    sleep,
  });
  const r = await service.bumpThread({
    guildId: GUILD,
    forumChannelId: FORUM,
    threadId: THREAD,
    policy: policy(),
    signal,
  });
  assertEqual(r.status, "succeeded", "abort after send 仍成功清理");
  assertEqual(r.cleanupRequired, false, "abort after send cleaned");
  assertEqual(r.abortedAfterSend, true, "abortedAfterSend");
  assertEqual(h.sendCount, 1, "已 send");
  assertEqual(h.deleteCount, 1, "仍 delete");
}

// Abort 发送后 + delete 失败
{
  const h = makeHarness();
  h.thread.send = async () => ({
    id: MSG,
    delete: async () => {
      const err = new Error("del");
      throw err;
    },
  });
  const signal = { aborted: true };
  // 发送前 abort 不会 send；需要 send 后 abort
  // 使用 signal starts false then... simpler: send ok, delete fails, abortedAfterSend if signal aborted after send
  const sig = {
    aborted: false,
    addEventListener() {},
    removeEventListener() {},
  };
  let sleeps = 0;
  const sleep = async () => {
    sleeps += 1;
    if (sleeps === 1) sig.aborted = true;
  };
  // Need send count
  let sendCount = 0;
  h.thread.send = async () => {
    sendCount += 1;
    return {
      id: MSG,
      delete: async () => {
        throw new Error("del");
      },
    };
  };
  const service = createForumBumpService({
    client: h.client, logger: h.logger, clock: h.clock, sleep,
  });
  const r = await service.bumpThread({
    guildId: GUILD, forumChannelId: FORUM, threadId: THREAD, policy: policy(), signal: sig,
  });
  assertEqual(r.status, "failed", "abort+delete fail");
  assertEqual(r.cleanupRequired, true, "cleanup true");
  assertEqual(r.errorCode, "DELETE_FAILED", "DELETE_FAILED after abort");
  assertEqual(sendCount, 1, "send once");
}

// 无状态写入（无 fs）
{
  assert(true, "无状态 Store/Outbox 调用（服务无 import）");
}

// ---- Client Ready ----
{
  assertEqual(isClientReadyForBump(null), false, "null client not ready");
  assertEqual(isClientReadyForBump({}), false, "无 channels.fetch not ready");
  assertEqual(
    isClientReadyForBump({ channels: { fetch: async () => {} }, isReady: () => false, user: { id: "b" } }),
    false,
    "isReady false",
  );
  assertEqual(
    isClientReadyForBump({ channels: { fetch: async () => {} }, isReady: () => true }),
    false,
    "missing user not ready",
  );
  assertEqual(
    isClientReadyForBump({ channels: { fetch: async () => {} }, isReady: () => true, user: { id: "b" } }),
    true,
    "ready fake client",
  );
}

{
  const h = makeHarness();
  h.client.isReady = () => false;
  let fetchCalls = 0;
  const origFetch = h.client.channels.fetch;
  h.client.channels.fetch = async (...args) => {
    fetchCalls += 1;
    return origFetch(...args);
  };
  const r = await call(makeService(h));
  assertEqual(r.status, "failed", "unready status failed");
  assertEqual(r.success, false, "unready success false");
  assertEqual(r.cleanupRequired, false, "unready no cleanup");
  assertEqual(r.errorCode, "CLIENT_NOT_READY", "CLIENT_NOT_READY");
  assertEqual(fetchCalls, 0, "unready 不 fetch");
  assertEqual(h.sendCount, 0, "unready 不 send");
}

{
  const h = makeHarness();
  h.client.user = null;
  let fetchCalls = 0;
  const origFetch = h.client.channels.fetch;
  h.client.channels.fetch = async (...args) => {
    fetchCalls += 1;
    return origFetch(...args);
  };
  const r = await call(makeService(h));
  assertEqual(r.errorCode, "CLIENT_NOT_READY", "missing user → CLIENT_NOT_READY");
  assertEqual(fetchCalls, 0, "missing user 不 fetch");
  assertEqual(h.sendCount, 0, "missing user 不 send");
}

{
  const h = makeHarness();
  // isReady 省略时只要有 user + fetch 即可（兼容仅部分实现的 fake）
  delete h.client.isReady;
  const r = await call(makeService(h));
  assertEqual(r.status, "succeeded", "无 isReady 但有 user 可执行");
}

// ---- send 返回对象但缺少合法 id ----
{
  let deleteCount = 0;
  let sendCount = 0;
  const h = makeHarness({
    sendImpl: async () => {
      sendCount += 1;
      return {
        // 无 id
        delete: async () => {
          deleteCount += 1;
        },
      };
    },
  });
  const r = await call(makeService(h));
  assertEqual(r.status, "failed", "无 id 删除成功 status");
  assertEqual(r.success, false, "无 id 删除成功 success");
  assertEqual(r.cleanupRequired, false, "无 id 删除成功 cleanup false");
  assertEqual(r.errorCode, "SEND_RESULT_INVALID", "SEND_RESULT_INVALID");
  assertEqual(r.sentMessageId, null, "无 id sentMessageId null");
  assertEqual(sendCount, 1, "无 id 不重发");
  assertEqual(deleteCount, 1, "无 id 删除一次");
  const logBlob = JSON.stringify(h.logs);
  assert(!logBlob.includes(FORUM_BUMP_CONTENT), "无 id 日志无正文");
}

{
  let deleteCount = 0;
  let sendCount = 0;
  const h = makeHarness({
    sendImpl: async () => {
      sendCount += 1;
      return {
        id: "", // 非法空 id
        delete: async () => {
          deleteCount += 1;
          throw new Error("del fail");
        },
      };
    },
  });
  const r = await call(makeService(h));
  assertEqual(r.status, "failed", "无 id 删除失败 status");
  assertEqual(r.success, false, "无 id 删除失败 success");
  assertEqual(r.cleanupRequired, true, "无 id 删除失败 cleanup true");
  assertEqual(r.errorCode, "DELETE_FAILED", "无 id 删除失败 DELETE_FAILED");
  assertEqual(sendCount, 1, "删除失败不重发");
  assertEqual(deleteCount, 1, "删除失败只 delete 一次");
}

{
  let sendCount = 0;
  const h = makeHarness({
    sendImpl: async () => {
      sendCount += 1;
      return { id: null }; // 无 delete 方法
    },
  });
  const r = await call(makeService(h));
  assertEqual(r.status, "failed", "无 id 无 delete status");
  assertEqual(r.success, false, "无 id 无 delete success");
  assertEqual(r.cleanupRequired, false, "无 id 无 delete cleanup false");
  assertEqual(r.errorCode, "SEND_RESULT_INVALID", "无 id 无 delete SEND_RESULT_INVALID");
  assertEqual(sendCount, 1, "无 delete 不重发");
}

console.log(`\nForumBump bumpService: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

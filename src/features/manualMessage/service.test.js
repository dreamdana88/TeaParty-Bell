/** Manual Message Service 离线测试，不连接真实 Discord。 */

import { ChannelType, PermissionFlagsBits } from "discord.js";
import { createManualMessageService } from "./service.js";

const TARGET_GUILD = "guild-1";
const ACTOR = { id: "actor-1", username: "admin", displayName: "管理员" };

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label} (${JSON.stringify(expected)})`);
}
async function expectCode(promise, code, label) {
  try {
    await promise;
    failed++; console.error(`  FAIL: ${label} — expected ${code}`);
  } catch (error) {
    assertEqual(error.code, code, label);
    assert(typeof error.safeMessage === "string", `${label} 有 safeMessage`);
    assert(!error.safeMessage.includes("secret"), `${label} safeMessage 不泄露内部信息`);
  }
}

function makePermissions(extra = []) {
  const allowed = new Set(extra);
  return { has: (permission) => allowed.has(permission) };
}

function makeLogger() {
  const calls = [];
  return {
    calls,
    info: (message, data) => calls.push({ level: "info", message, data }),
    warn: (message, data) => calls.push({ level: "warn", message, data }),
    error: (message, data) => calls.push({ level: "error", message, data }),
    debug: () => {},
  };
}

function makeChannel({
  id = "channel-1",
  type = ChannelType.GuildText,
  guildId = TARGET_GUILD,
  permissions = makePermissions([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.ReadMessageHistory,
  ]),
  locked = false,
  sentMessage = { id: "sent-1" },
  send = async () => sentMessage,
  messages = { fetch: async () => ({ id: "target-1", guildId, channelId: id, reply: async () => ({ id: "reply-1" }) }) },
} = {}) {
  return {
    id,
    type,
    guildId,
    locked,
    permissionsFor: () => permissions,
    send,
    messages,
  };
}

function makeHarness(channel, audit = null) {
  const logger = makeLogger();
  const client = {
    user: { id: "bot-1" },
    channels: { fetch: async () => channel },
  };
  const service = createManualMessageService({
    client,
    config: { discordGuildId: TARGET_GUILD },
    logger,
    ...(audit ? { audit } : {}),
  });
  return { service, client, logger };
}

function assertSafeDiscordLog(logger, label) {
  const log = logger.calls.find((call) => call.level === "warn");
  assert(Boolean(log), `${label} 产生安全 warn 日志`);
  if (!log) return;
  assertEqual(
    JSON.stringify(Object.keys(log.data).sort()),
    JSON.stringify(["discordCode", "errorMessage", "errorName"]),
    `${label} 日志仅包含允许字段`,
  );
  assert(!("stack" in log.data), `${label} 日志不包含 stack`);
  assert(!("requestHeaders" in log.data), `${label} 日志不包含请求头`);
}

function request(overrides = {}) {
  return {
    guildId: TARGET_GUILD,
    channelId: "channel-1",
    content: "人工发言 🫖",
    actor: ACTOR,
    source: "discord_slash",
    ...overrides,
  };
}

console.log("\n=== Manual Message Service ===\n");

// actor 必须先于任何 Discord 调用完成验证；失败仍产生安全失败审计。
for (const [actor, label] of [
  [undefined, "actor 缺失"],
  [null, "actor=null"],
  [{}, "actor.id 缺失"],
  [{ id: "" }, "actor.id 空字符串"],
  [{ id: "   " }, "actor.id 空白"],
  [{ id: "actor-1", username: 123 }, "username 非字符串"],
  [{ id: "actor-1", displayName: 123 }, "displayName 非字符串"],
]) {
  const auditCalls = [];
  let fetchCount = 0;
  const { service, client } = makeHarness(makeChannel(), { record: (entry) => auditCalls.push(entry) });
  client.channels.fetch = async () => { fetchCount++; return makeChannel(); };
  await expectCode(service.send(request({ actor })), "INVALID_ACTOR", `${label} 拒绝`);
  assertEqual(fetchCount, 0, `${label} 在 Discord 调用前拒绝`);
  assertEqual(auditCalls.length, 1, `${label} 产生失败审计`);
  assertEqual(auditCalls[0].success, false, `${label} 审计 success=false`);
  assertEqual(auditCalls[0].errorCode, "INVALID_ACTOR", `${label} 审计 errorCode`);
  assert(typeof auditCalls[0].actorId === "string" && auditCalls[0].actorId.trim().length > 0, `${label} 审计 actorId 非空`);
}

{
  const auditCalls = [];
  const { service } = makeHarness(makeChannel(), { record: (entry) => auditCalls.push(entry) });
  const result = await service.send(request({ actor: { id: "actor-valid" } }));
  assertEqual(result.messageId, "sent-1", "合法 actor 发送成功");
  assertEqual(auditCalls[0].actorId, "actor-valid", "合法 actor 审计 actorId");
}

// Send：普通文字频道成功、审计、返回 messageId
{
  const channel = makeChannel();
  const auditCalls = [];
  const { service } = makeHarness(channel, { record: (entry) => auditCalls.push(entry) });
  const result = await service.send(request());
  assertEqual(result.messageId, "sent-1", "普通文字频道返回 sentMessageId");
  assertEqual(result.guildId, TARGET_GUILD, "返回 guildId");
  assertEqual(result.channelId, "channel-1", "返回 channelId");
  assertEqual(result.action, "send", "返回 action=send");
  assertEqual(auditCalls.length, 1, "成功动作审计一次");
  assertEqual(auditCalls[0].success, true, "成功审计 success=true");
}

// Send：公告频道、允许的 Thread 类型
for (const [type, label] of [
  [ChannelType.GuildAnnouncement, "公告频道"],
  [ChannelType.PublicThread, "PublicThread"],
  [ChannelType.PrivateThread, "PrivateThread"],
  [ChannelType.AnnouncementThread, "AnnouncementThread"],
]) {
  const channel = makeChannel({ type });
  const { service } = makeHarness(channel);
  const result = await service.send(request({ source: "discord_context_menu" }));
  assertEqual(result.messageId, "sent-1", `${label}发送成功`);
}

// Send：Forum 父频道拒绝
{
  const { service } = makeHarness(makeChannel({ type: ChannelType.GuildForum }));
  await expectCode(service.send(request()), "WRONG_CHANNEL_TYPE", "Forum 父频道拒绝");
}

// Send：锁定 Thread、错误 Guild、频道不存在
{
  const { service } = makeHarness(makeChannel({ type: ChannelType.PublicThread, locked: true }));
  await expectCode(service.send(request()), "THREAD_LOCKED", "锁定 Thread 拒绝");
}
{
  const permissions = makePermissions([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.ManageThreads,
    PermissionFlagsBits.ReadMessageHistory,
  ]);
  const { service } = makeHarness(makeChannel({ type: ChannelType.PublicThread, locked: true, permissions }));
  const result = await service.send(request());
  assertEqual(result.messageId, "sent-1", "锁定 Thread + ManageThreads 允许发送");
}
{
  const permissions = makePermissions([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.SendMessagesInThreads,
    PermissionFlagsBits.ManageThreads,
    PermissionFlagsBits.ReadMessageHistory,
  ]);
  const channel = makeChannel({
    type: ChannelType.PublicThread,
    locked: true,
    permissions,
    messages: {
      fetch: async () => ({
        id: "target-1", guildId: TARGET_GUILD, channelId: "channel-1",
        reply: async () => ({ id: "locked-reply-1" }),
      }),
    },
  });
  const { service } = makeHarness(channel);
  const result = await service.reply(request({ targetMessageId: "target-1" }));
  assertEqual(result.messageId, "locked-reply-1", "锁定 Thread + ManageThreads 允许回复");
}
{
  const { service } = makeHarness(makeChannel({ guildId: "other-guild" }));
  await expectCode(service.send(request()), "WRONG_GUILD", "Channel Guild 不匹配拒绝");
}
{
  const { service } = makeHarness(makeChannel());
  await expectCode(service.send(request({ guildId: "other-guild" })), "WRONG_GUILD", "错误 Guild 拒绝");
}
{
  const { service } = makeHarness(makeChannel());
  await expectCode(service.send(request({ source: "unknown_source" })), "INVALID_SOURCE", "未知 source 拒绝");
}
{
  const channel = makeChannel();
  const { service, client } = makeHarness(channel);
  client.channels.fetch = async () => null;
  await expectCode(service.send(request()), "CHANNEL_NOT_FOUND", "Channel 不存在拒绝");
}

for (const [error, expected, label] of [
  [Object.assign(new Error("Unknown Channel"), { name: "DiscordAPIError", code: 10003 }), "CHANNEL_NOT_FOUND", "channel 10003"],
  [Object.assign(new Error("Missing Access"), { name: "DiscordAPIError", code: 50001 }), "BOT_MISSING_PERMISSION", "channel 50001"],
  [Object.assign(new Error("Missing Permissions"), { name: "DiscordAPIError", code: 50013 }), "BOT_MISSING_PERMISSION", "channel 50013"],
  [Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }), "CHANNEL_FETCH_FAILED", "channel ETIMEDOUT"],
  [Object.assign(new Error("unexpected channel failure"), { code: 99999 }), "CHANNEL_FETCH_FAILED", "channel unknown error"],
]) {
  const { service, client, logger } = makeHarness(makeChannel());
  client.channels.fetch = async () => { throw error; };
  await expectCode(service.send(request()), expected, `${label} 分类`);
  assertSafeDiscordLog(logger, label);
}

// Send：权限矩阵
{
  const permissions = makePermissions([PermissionFlagsBits.SendMessages]);
  const { service } = makeHarness(makeChannel({ permissions }));
  await expectCode(service.send(request()), "BOT_MISSING_PERMISSION", "普通频道缺少 ViewChannel 拒绝");
}
{
  const permissions = makePermissions([PermissionFlagsBits.ViewChannel]);
  const { service } = makeHarness(makeChannel({ permissions }));
  await expectCode(service.send(request()), "BOT_MISSING_PERMISSION", "普通频道缺少 SendMessages 拒绝");
}
{
  const permissions = makePermissions([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
  const { service } = makeHarness(makeChannel({ type: ChannelType.PublicThread, permissions }));
  await expectCode(service.send(request()), "BOT_MISSING_PERMISSION", "Thread 缺少 SendMessagesInThreads 拒绝");
}

// Send：Discord reject、allowedMentions、失败审计
{
  let payload;
  const auditCalls = [];
  const channel = makeChannel({
    send: async (value) => { payload = value; return { id: "sent-mention" }; },
  });
  const { service } = makeHarness(channel, { record: (entry) => auditCalls.push(entry) });
  const result = await service.send(request({ content: "请联系 <@123> <@123>" }));
  assertEqual(result.messageId, "sent-mention", "User Mention 发送成功");
  assertEqual(JSON.stringify(payload.allowedMentions), JSON.stringify({
    parse: [], users: ["123"], roles: [], repliedUser: false,
  }), "send allowedMentions 正确");
  assert(!("token" in auditCalls[0]), "审计不含 token 字段");
}
{
  const auditCalls = [];
  const channel = makeChannel({ send: async () => { throw new Error("secret send detail"); } });
  const { service } = makeHarness(channel, { record: (entry) => auditCalls.push(entry) });
  await expectCode(service.send(request()), "SEND_FAILED", "Discord send reject 分类");
  assertEqual(auditCalls[0].errorCode, "SEND_FAILED", "发送失败审计 errorCode");
  assertEqual(auditCalls[0].success, false, "发送失败审计 success=false");
}

// Reply：普通频道、Thread、repliedUser=false、成功审计
for (const [type, label] of [
  [ChannelType.GuildText, "普通频道消息"],
  [ChannelType.PublicThread, "Thread 消息"],
]) {
  let payload;
  const auditCalls = [];
  const channel = makeChannel({
    type,
    messages: {
      fetch: async () => ({
        id: "target-1",
        guildId: TARGET_GUILD,
        channelId: "channel-1",
        reply: async (value) => { payload = value; return { id: "reply-1" }; },
      }),
    },
  });
  const { service } = makeHarness(channel, { record: (entry) => auditCalls.push(entry) });
  const result = await service.reply(request({ source: "discord_context_menu", targetMessageId: "target-1" }));
  assertEqual(result.messageId, "reply-1", `${label}回复成功`);
  assertEqual(payload.allowedMentions.repliedUser, false, `${label} repliedUser=false`);
  assertEqual(auditCalls[0].targetMessageId, "target-1", `${label}审计目标消息`);
}

// Reply：目标不存在、目标 Guild/Channel 不匹配、缺少 ReadMessageHistory
{
  const channel = makeChannel({ messages: { fetch: async () => null } });
  const { service } = makeHarness(channel);
  await expectCode(service.reply(request({ targetMessageId: "missing" })), "TARGET_MESSAGE_NOT_FOUND", "目标消息不存在拒绝");
}
{
  const channel = makeChannel({ messages: { fetch: async () => ({ id: "target", guildId: "other-guild", channelId: "channel-1", reply: async () => ({ id: "x" }) }) } });
  const { service } = makeHarness(channel);
  await expectCode(service.reply(request({ targetMessageId: "target" })), "WRONG_GUILD", "目标消息 Guild 不匹配拒绝");
}
{
  const channel = makeChannel({ messages: { fetch: async () => ({ id: "target", guildId: TARGET_GUILD, channelId: "other-channel", reply: async () => ({ id: "x" }) }) } });
  const { service } = makeHarness(channel);
  await expectCode(service.reply(request({ targetMessageId: "target" })), "TARGET_MESSAGE_NOT_FOUND", "目标消息 Channel 不匹配拒绝");
}
{
  const permissions = makePermissions([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]);
  const { service } = makeHarness(makeChannel({ permissions }));
  await expectCode(service.reply(request({ targetMessageId: "target" })), "BOT_MISSING_PERMISSION", "Reply 缺少 ReadMessageHistory 拒绝");
}

for (const [error, expected, label] of [
  [Object.assign(new Error("Unknown Message"), { name: "DiscordAPIError", code: 10008 }), "TARGET_MESSAGE_NOT_FOUND", "message 10008"],
  [Object.assign(new Error("Missing Access"), { name: "DiscordAPIError", code: 50001 }), "BOT_MISSING_PERMISSION", "message 50001"],
  [Object.assign(new Error("Missing Permissions"), { name: "DiscordAPIError", code: 50013 }), "BOT_MISSING_PERMISSION", "message 50013"],
  [Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }), "TARGET_MESSAGE_FETCH_FAILED", "message ETIMEDOUT"],
  [Object.assign(new Error("unexpected message failure"), { code: 99999 }), "TARGET_MESSAGE_FETCH_FAILED", "message unknown error"],
]) {
  const auditCalls = [];
  const channel = makeChannel({ messages: { fetch: async () => { throw error; } } });
  const { service, logger } = makeHarness(channel, { record: (entry) => auditCalls.push(entry) });
  await expectCode(service.reply(request({ targetMessageId: "target-1" })), expected, `${label} 分类`);
  assertSafeDiscordLog(logger, label);
  assertEqual(auditCalls[0].errorCode, expected, `${label} 失败审计 errorCode`);
}
{
  const auditCalls = [];
  const channel = makeChannel({
    messages: {
      fetch: async () => ({
        id: "target-1", guildId: TARGET_GUILD, channelId: "channel-1",
        reply: async () => { throw new Error("secret reply detail"); },
      }),
    },
  });
  const { service } = makeHarness(channel, { record: (entry) => auditCalls.push(entry) });
  await expectCode(service.reply(request({ targetMessageId: "target-1" })), "REPLY_FAILED", "Discord reply reject 分类");
  assertEqual(auditCalls[0].errorCode, "REPLY_FAILED", "回复失败审计 errorCode");
  assertEqual(auditCalls[0].success, false, "回复失败审计 success=false");
}

// 注入的审计实现失败也不能改变已成功发送的结果
{
  const channel = makeChannel();
  const { service } = makeHarness(channel, { record: () => { throw new Error("audit failure"); } });
  const result = await service.send(request());
  assertEqual(result.messageId, "sent-1", "审计失败不伪造发送失败");
}

console.log(`\n[service.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);

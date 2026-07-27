import { EventEmitter } from "events";
import { PermissionFlagsBits } from "discord.js";
import { ManualMessageError } from "./errors.js";
import { createManualInteractionRouter } from "./interactionRouter.js";

const GUILD_ID = "111111111111111111";
const CHANNEL_ID = "222222222222222222";
const TARGET_MESSAGE_ID = "333333333333333333";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label} (${JSON.stringify(expected)})`);
}
function makeLogger() {
  const calls = [];
  return {
    calls,
    info: (message, data) => calls.push({ level: "info", message, data }),
    warn: (message, data) => calls.push({ level: "warn", message, data }),
    error: (message, data) => calls.push({ level: "error", message, data }),
  };
}
function makeClient() {
  return new EventEmitter();
}
function makeInteraction({ kind, id = `interaction-${Math.random()}`, ...overrides } = {}) {
  const calls = [];
  const interaction = {
    id,
    type: kind === "context" ? 3 : kind === "modal" ? 5 : 2,
    commandName: kind === "context" ? "小G宝回复" : undefined,
    customId: kind === "modal" ? `manual:v1:reply:${CHANNEL_ID}:${TARGET_MESSAGE_ID}` : undefined,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    targetId: TARGET_MESSAGE_ID,
    user: { id: "444444444444444444", username: "admin", globalName: "管理员" },
    member: { displayName: "服务器管理员" },
    memberPermissions: { has: (permission) => permission === PermissionFlagsBits.Administrator },
    fields: { getTextInputValue: () => "回复内容 🫖" },
    replied: false,
    deferred: false,
    isMessageContextMenuCommand: () => kind === "context",
    isModalSubmit: () => kind === "modal",
    inGuild: () => true,
    reply: async (payload) => {
      calls.push({ method: "reply", payload });
      interaction.replied = true;
    },
    followUp: async (payload) => {
      calls.push({ method: "followUp", payload });
    },
    deferReply: async (payload) => {
      calls.push({ method: "deferReply", payload });
      interaction.deferred = true;
    },
    editReply: async (payload) => {
      calls.push({ method: "editReply", payload });
    },
    showModal: async (modal) => {
      calls.push({ method: "showModal", modal });
    },
    ...overrides,
  };
  interaction.calls = calls;
  return interaction;
}
async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
function makeHarness(service = null, options = {}) {
  const client = makeClient();
  const logger = makeLogger();
  const replyCalls = [];
  const manualMessageService = service ?? {
    reply: async (request) => {
      replyCalls.push(request);
      return { messageId: "sent-1", ...request, action: "reply" };
    },
  };
  const router = createManualInteractionRouter({
    client,
    manualMessageService,
    guildId: GUILD_ID,
    logger,
    ...options,
  });
  router.start();
  return { client, logger, router, replyCalls };
}

console.log("\n=== Manual Interaction Router ===\n");

// Context Menu 只打开 Modal，不读取目标正文，也不直接调用 Service。
{
  const { client, router, replyCalls } = makeHarness();
  const interaction = makeInteraction({ kind: "context", id: "ctx-1" });
  client.emit("interactionCreate", interaction);
  await flush();
  assertEqual(replyCalls.length, 0, "Context Menu 不直接调用 Service");
  assertEqual(interaction.calls[0]?.method, "showModal", "Context Menu 打开 Modal");
  assertEqual(interaction.calls[0]?.modal.toJSON().custom_id, `manual:v1:reply:${CHANNEL_ID}:${TARGET_MESSAGE_ID}`, "Modal 绑定频道与目标消息");
  router.destroy();
}

// Guild、服务器和管理员权限均在打开 Modal 前检查。
for (const [overrides, expected, label] of [
  [{ inGuild: () => false }, "该操作只能在服务器内使用。", "DM 拒绝"],
  [{ guildId: "999999999999999999" }, "该操作不能用于当前服务器。", "错误 Guild 拒绝"],
  [{ memberPermissions: { has: () => false } }, "只有管理员可以使用该操作。", "非管理员拒绝"],
]) {
  const { client, router, replyCalls } = makeHarness();
  const interaction = makeInteraction({ kind: "context", id: `ctx-${label}`, ...overrides });
  client.emit("interactionCreate", interaction);
  await flush();
  assertEqual(replyCalls.length, 0, `${label} 不调用 Service`);
  assertEqual(interaction.calls[0]?.payload?.content, expected, label);
  assertEqual(interaction.calls[0]?.payload?.ephemeral, true, `${label} ephemeral`);
  router.destroy();
}

// 未知交互与其它 Modal 必须静默忽略。
{
  const { client, router, replyCalls } = makeHarness();
  const slash = makeInteraction({ kind: "slash", id: "unknown-slash", commandName: "其它命令" });
  const otherModal = makeInteraction({ kind: "other", id: "unknown-modal", customId: "other:v1:modal" });
  client.emit("interactionCreate", slash);
  client.emit("interactionCreate", otherModal);
  await flush();
  assertEqual(slash.calls.length, 0, "未知 Slash 静默忽略");
  assertEqual(otherModal.calls.length, 0, "未知 Modal 静默忽略");
  assertEqual(replyCalls.length, 0, "未知交互不调用 Service");
  router.destroy();
}

// Modal Submit：立即 defer，传递固定 source 与 actor，成功后编辑 ephemeral 回复。
{
  const order = [];
  const service = { reply: async (request) => { order.push("service"); return { messageId: "sent-1" }; } };
  const { client, router, replyCalls } = makeHarness(service);
  const interaction = makeInteraction({
    kind: "modal",
    id: "modal-1",
    deferReply: async (payload) => { order.push("defer"); interaction.deferred = true; interaction.calls.push({ method: "deferReply", payload }); },
  });
  client.emit("interactionCreate", interaction);
  await flush();
  assertEqual(order.join(","), "defer,service", "Modal 先 defer 再调用 Service");
  assertEqual(replyCalls.length, 0, "替换 Service 时不记录默认调用");
  assertEqual(interaction.calls.at(-1)?.method, "editReply", "成功后 editReply");
  const request = service.request;
  assert(interaction.calls.some((call) => call.method === "deferReply" && call.payload.ephemeral === true), "deferReply 为 ephemeral");
  router.destroy();
}

// 精确核对 Service 参数。
{
  let request;
  const service = { reply: async (value) => { request = value; return { messageId: "sent-1" }; } };
  const { client, router } = makeHarness(service);
  const interaction = makeInteraction({ kind: "modal", id: "modal-params" });
  client.emit("interactionCreate", interaction);
  await flush();
  assertEqual(request.guildId, GUILD_ID, "Service guildId 使用 Modal Guild");
  assertEqual(request.channelId, CHANNEL_ID, "Service channelId 来自 customId");
  assertEqual(request.targetMessageId, TARGET_MESSAGE_ID, "Service targetMessageId 来自 customId");
  assertEqual(request.source, "discord_context_menu", "Service source 固定为 context menu");
  assertEqual(request.actor.id, "444444444444444444", "Service actor.id");
  assertEqual(request.actor.username, "admin", "Service actor.username");
  assertEqual(request.actor.displayName, "服务器管理员", "Service actor.displayName 优先 member");
  assertEqual(request.content, "回复内容 🫖", "Service content");
  router.destroy();
}

// Modal Submit 重新检查权限与 Guild，并严格拒绝失效上下文。
for (const [overrides, expected, label] of [
  [{ inGuild: () => false }, "该操作只能在服务器内使用。", "Modal DM 拒绝"],
  [{ guildId: "999999999999999999" }, "该操作不能用于当前服务器。", "Modal 错误 Guild 拒绝"],
  [{ memberPermissions: { has: () => false } }, "只有管理员可以使用该操作。", "Modal 非管理员拒绝"],
  [{ customId: "manual:v1:reply:bad:bad" }, "该操作已失效，请重新打开。", "Modal 失效上下文拒绝"],
  [{ customId: "manual:v1:reply" }, "该操作已失效，请重新打开。", "Modal 缺失上下文拒绝"],
]) {
  const { client, router, replyCalls } = makeHarness();
  const interaction = makeInteraction({ kind: "modal", id: `invalid-${label}`, ...overrides });
  client.emit("interactionCreate", interaction);
  await flush();
  assertEqual(replyCalls.length, 0, `${label} 不调用 Service`);
  assertEqual(interaction.calls[0]?.payload?.content, expected, label);
  router.destroy();
}

// Service 业务错误使用 safeMessage，未知错误使用通用安全文案，并写有限字段日志。
for (const [error, expected, label] of [
  [Object.assign(new ManualMessageError("REPLY_FAILED", "安全失败提示", Object.assign(new Error("secret cause"), { code: 50013 })), { discordCode: 50013 }), "安全失败提示", "业务错误 safeMessage"],
  [Object.assign(new Error("secret body"), { code: 50013 }), "处理人工回复失败，请稍后重试。", "未知错误通用文案"],
]) {
  const service = { reply: async () => { throw error; } };
  const { client, router, logger } = makeHarness(service);
  const interaction = makeInteraction({ kind: "modal", id: `failure-${label}` });
  client.emit("interactionCreate", interaction);
  await flush();
  assertEqual(interaction.calls.at(-1)?.payload?.content, expected, label);
  const diagnostic = logger.calls.find((call) => call.message.includes("Service 回复失败"));
  assert(Boolean(diagnostic), `${label} 产生安全诊断日志`);
  if (diagnostic) {
    if (isManualMessageErrorForTest(error)) {
      assertEqual(diagnostic.data.errorCode, "REPLY_FAILED", `${label} 记录 errorCode`);
      assertEqual(diagnostic.data.discordCode, 50013, `${label} 记录 discordCode`);
      assertEqual("errorMessage" in diagnostic.data, false, `${label} 不记录原始 message`);
    } else {
      assertEqual(diagnostic.data.errorMessage, "Interaction Router operation failed.", `${label} 使用固定安全摘要`);
      assertEqual(diagnostic.data.discordCode, 50013, `${label} 记录 discordCode`);
    }
    assert(!("stack" in diagnostic.data), `${label} 不记录 stack`);
    const serialized = JSON.stringify(logger.calls);
    assert(!serialized.includes("secret body"), `${label} 日志不包含原始错误正文`);
    assert(!serialized.includes("回复内容 🫖"), `${label} 日志不包含 Modal 正文`);
    assert(!serialized.includes("token"), `${label} 日志不包含 token`);
    assert(!serialized.includes("headers"), `${label} 日志不包含 headers`);
  }
  router.destroy();
}

function isManualMessageErrorForTest(error) {
  return error instanceof ManualMessageError;
}

// defer / reply / 顶层 dispatch 的错误路径使用同一套安全摘要。
for (const [interactionOptions, label] of [
  [{ fields: { getTextInputValue: () => { throw new Error("modal secret"); } } }, "defer 前读取失败"],
  [{ inGuild: () => false, reply: async () => { throw new Error("token secret"); } }, "reply 失败"],
]) {
  const { client, router, logger } = makeHarness();
  const interaction = makeInteraction({ kind: label === "reply 失败" ? "context" : "modal", id: `safe-${label}`, ...interactionOptions });
  client.emit("interactionCreate", interaction);
  await flush();
  const serialized = JSON.stringify(logger.calls);
  assert(serialized.includes("Interaction Router operation failed."), `${label} 写固定安全摘要`);
  assert(!serialized.includes("secret"), `${label} 不记录原始错误正文`);
  assert(!serialized.includes("回复内容 🫖"), `${label} 不记录 Modal 正文`);
  router.destroy();
}

{
  const { client, router, logger } = makeHarness();
  const interaction = makeInteraction({
    kind: "other",
    id: "top-level-catch",
    isMessageContextMenuCommand: () => { throw new Error("dispatch secret"); },
  });
  client.emit("interactionCreate", interaction);
  await flush();
  const serialized = JSON.stringify(logger.calls);
  assert(serialized.includes("Interaction Router operation failed."), "顶层 dispatch catch 写固定安全摘要");
  assert(!serialized.includes("dispatch secret"), "顶层 dispatch catch 不记录原始错误正文");
  router.destroy();
}

// showModal 失败不能抛出到 Client 事件循环。
{
  const { client, router } = makeHarness();
  const interaction = makeInteraction({ kind: "context", id: "show-failure", showModal: async () => { throw new Error("expired"); } });
  client.emit("interactionCreate", interaction);
  await flush();
  assertEqual(interaction.calls[0]?.payload?.content, "处理人工回复失败，请稍后重试。", "showModal 失败安全响应");
  router.destroy();
}

// 同一个 Interaction ID 只允许一次处理；destroy 后不再处理新事件，且可安全重复调用。
{
  let serviceCount = 0;
  const service = { reply: async () => { serviceCount++; return { messageId: "sent-1" }; } };
  const { client, router } = makeHarness(service);
  const first = makeInteraction({ kind: "modal", id: "duplicate-1" });
  const second = makeInteraction({ kind: "modal", id: "duplicate-1" });
  client.emit("interactionCreate", first);
  client.emit("interactionCreate", second);
  await flush();
  assertEqual(serviceCount, 1, "重复 Interaction 不重复调用 Service");
  assertEqual(second.calls[0]?.payload?.content, "该操作已经处理。", "重复 Interaction ephemeral 提示");
  router.destroy();
  router.destroy();
  const afterDestroy = makeInteraction({ kind: "modal", id: "after-destroy" });
  client.emit("interactionCreate", afterDestroy);
  await flush();
  assertEqual(afterDestroy.calls.length, 0, "destroy 后忽略新 Interaction");
}

// TTL 到期后可以重新处理，start 重复调用不重复注册 listener。
{
  let current = 100;
  let serviceCount = 0;
  const service = { reply: async () => { serviceCount++; return { messageId: "sent-1" }; } };
  const { client, router } = makeHarness(service, { now: () => current, handledInteractionTtlMs: 10 });
  router.start();
  client.emit("interactionCreate", makeInteraction({ kind: "modal", id: "ttl-1" }));
  await flush();
  current = 111;
  client.emit("interactionCreate", makeInteraction({ kind: "modal", id: "ttl-1" }));
  await flush();
  assertEqual(serviceCount, 2, "TTL 到期后允许重新处理");
  router.destroy();
}

console.log(`\n[interactionRouter.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);

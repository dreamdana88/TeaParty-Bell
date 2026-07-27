import { EventEmitter } from "events";
import { MessageFlags, PermissionFlagsBits } from "discord.js";
import { ManualMessageError } from "./errors.js";
import { SLASH_SEND_COMMAND_NAME } from "./commands.js";
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
  const isSendModal = kind === "send-modal";
  const isModal = kind === "modal" || isSendModal;
  const interaction = {
    id,
    createdTimestamp: Date.now() - 25,
    type: kind === "context" ? 3 : isModal ? 5 : 2,
    commandName: kind === "context" ? "小G宝回复" : kind === "slash" ? SLASH_SEND_COMMAND_NAME : undefined,
    customId: isSendModal
      ? `manual:v1:send:${CHANNEL_ID}`
      : kind === "modal" ? `manual:v1:reply:${CHANNEL_ID}:${TARGET_MESSAGE_ID}` : undefined,
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
    isChatInputCommand: () => kind === "slash",
    isModalSubmit: () => isModal,
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
    deleteReply: async () => {
      calls.push({ method: "deleteReply" });
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
    send: async (request) => {
      replyCalls.push(request);
      return { messageId: "sent-1", ...request, action: "send" };
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

function expectRouterTypeError(service, label) {
  const client = makeClient();
  let error;
  try {
    createManualInteractionRouter({
      client,
      manualMessageService: service,
      guildId: GUILD_ID,
      logger: makeLogger(),
    });
  } catch (caught) {
    error = caught;
  }
  assert(error instanceof TypeError, `${label} 构造阶段抛出 TypeError`);
  assertEqual(client.listenerCount("interactionCreate"), 0, `${label} 不注册 InteractionCreate listener`);
}

console.log("\n=== Manual Interaction Router ===\n");

// Router 构造阶段严格要求共享 Service 同时具备 send 与 reply。
for (const [service, label] of [
  [undefined, "Service 缺失"],
  [null, "Service=null"],
  [{ send: async () => {} }, "reply 缺失"],
  [{ reply: async () => {} }, "send 缺失"],
  [{ reply: "not-a-function", send: async () => {} }, "reply 非函数"],
  [{ reply: async () => {}, send: "not-a-function" }, "send 非函数"],
]) {
  expectRouterTypeError(service, label);
}

{
  const client = makeClient();
  const router = createManualInteractionRouter({
    client,
    manualMessageService: { reply: async () => {}, send: async () => {} },
    guildId: GUILD_ID,
    logger: makeLogger(),
  });
  assert(typeof router.start === "function" && typeof router.destroy === "function", "同时具备 send/reply 时成功创建 Router");
  assertEqual(client.listenerCount("interactionCreate"), 0, "构造成功但 start 前不注册 listener");
  router.destroy();
}

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

// Slash Command 只打开当前频道的 Send Modal，不直接调用 Service。
{
  const { client, router, replyCalls } = makeHarness();
  const interaction = makeInteraction({ kind: "slash", id: "slash-1" });
  client.emit("interactionCreate", interaction);
  await flush();
  assertEqual(replyCalls.length, 0, "Slash Command 不直接调用 Service");
  assertEqual(interaction.calls[0]?.method, "showModal", "Slash Command 打开 Send Modal");
  const modal = interaction.calls[0]?.modal.toJSON();
  assertEqual(modal.custom_id, `manual:v1:send:${CHANNEL_ID}`, "Send Modal 使用当前频道 ID");
  assertEqual(modal.title, "让小G宝发言", "Send Modal 标题");
  assertEqual(modal.components[0].components[0].label, "发言内容", "Send Modal label");
  router.destroy();
}

for (const [overrides, expected, label] of [
  [{ inGuild: () => false }, "该操作只能在服务器内使用。", "Slash DM 拒绝"],
  [{ guildId: "999999999999999999" }, "该操作不能用于当前服务器。", "Slash 错误 Guild 拒绝"],
  [{ memberPermissions: { has: () => false } }, "只有管理员可以使用该操作。", "Slash 非管理员拒绝"],
]) {
  const { client, router, replyCalls } = makeHarness();
  const interaction = makeInteraction({ kind: "slash", id: `slash-${label}`, ...overrides });
  client.emit("interactionCreate", interaction);
  await flush();
  assertEqual(replyCalls.length, 0, `${label} 不调用 Service`);
  assertEqual(interaction.calls[0]?.payload?.content, expected, label);
  assertEqual(interaction.calls[0]?.payload?.flags, MessageFlags.Ephemeral, `${label} flags`);
  assertEqual("ephemeral" in (interaction.calls[0]?.payload ?? {}), false, `${label} 不使用 deprecated ephemeral`);
  router.destroy();
}

{
  const { client, router } = makeHarness();
  const interaction = makeInteraction({ kind: "slash", id: "slash-show-failure", showModal: async () => { throw new Error("slash token secret"); } });
  client.emit("interactionCreate", interaction);
  await flush();
  assertEqual(interaction.calls[0]?.payload?.content, "处理人工发言失败，请稍后重试。", "Slash showModal 失败安全响应");
  router.destroy();
}

// 首次响应时序记录接收年龄、开始响应年龄和 Discord REST 响应耗时。
{
  const performanceValues = [1000, 1020, 1055];
  const { client, router, logger } = makeHarness(null, {
    performanceNow: () => performanceValues.shift(),
  });
  const interaction = makeInteraction({
    kind: "context",
    id: "timing-context",
    createdTimestamp: Date.now() - 5000,
  });
  client.emit("interactionCreate", interaction);
  await flush();
  const timing = logger.calls.find((call) => call.message.includes("Interaction 首次响应时序"));
  assert(Boolean(timing), "记录 Interaction 首次响应时序");
  assert(timing && timing.data.interactionAgeAtReceiveMs >= 4900, "记录 receive age");
  assert(timing && timing.data.interactionAgeAtAckStartMs >= 4900, "记录 ack start age");
  assertEqual(timing?.data?.ackDurationMs, 35, "记录 ack duration");
  assertEqual(timing?.data?.ackOperation, "show_reply_modal", "记录 show reply ack operation");
  assertEqual(timing?.data?.discordCode, null, "成功响应 discordCode 为空");
  router.destroy();
}

// Discord 10062 只记录一次安全 WARN，不进行第二次响应，也不调用 Service。
for (const [kind, operation, label] of [
  ["context", "show_reply_modal", "showModal"],
  ["send-modal", "defer_send_submit", "deferReply"],
]) {
  let serviceCalls = 0;
  const service = {
    reply: async () => { serviceCalls++; },
    send: async () => { serviceCalls++; },
  };
  const { client, router, logger } = makeHarness(service);
  const expiredError = Object.assign(new Error("secret body"), {
    name: "DiscordAPIError",
    code: 10062,
    stack: "secret stack",
  });
  const interaction = makeInteraction({
    kind,
    id: `expired-${label}`,
    ...(label === "showModal"
      ? { showModal: async () => { throw expiredError; } }
      : { deferReply: async (payload) => { interaction.calls.push({ method: "deferReply", payload }); throw expiredError; } }),
  });
  client.emit("interactionCreate", interaction);
  await flush();
  const warnings = logger.calls.filter((call) => call.level === "warn");
  assertEqual(warnings.length, 1, `${label} 10062 只记录一条 WARN`);
  assertEqual(warnings[0]?.data?.errorCode, "INTERACTION_EXPIRED", `${label} 10062 归类为 INTERACTION_EXPIRED`);
  assertEqual(warnings[0]?.data?.discordCode, 10062, `${label} 记录 Discord code`);
  assertEqual(warnings[0]?.data?.ackOperation, operation, `${label} 记录 ack operation`);
  assertEqual(serviceCalls, 0, `${label} 10062 不调用 Service`);
  assert(!interaction.calls.some((call) => ["reply", "followUp", "editReply"].includes(call.method)), `${label} 10062 不进行第二次响应`);
  const serialized = JSON.stringify(logger.calls);
  assert(!serialized.includes("secret body"), `${label} 10062 日志不包含原始错误正文`);
  assert(!serialized.includes("secret stack"), `${label} 10062 日志不包含 stack`);
  router.destroy();
}

// 成功消息已发送时只删除临时回复；deleteReply 失败不改变业务成功结果，也不再次响应。
{
  let serviceCalls = 0;
  const service = {
    reply: async () => ({ messageId: "unused" }),
    send: async () => { serviceCalls++; return { messageId: "sent-1" }; },
  };
  const { client, router, logger } = makeHarness(service);
  const interaction = makeInteraction({
    kind: "send-modal",
    id: "delete-reply-failure",
    deleteReply: async () => {
      interaction.calls.push({ method: "deleteReply" });
      throw new Error("delete secret body");
    },
  });
  client.emit("interactionCreate", interaction);
  await flush();
  assertEqual(serviceCalls, 1, "deleteReply 失败前 Service 已成功调用");
  assert(interaction.calls.some((call) => call.method === "deleteReply"), "成功后尝试 deleteReply");
  assert(!interaction.calls.some((call) => ["reply", "followUp", "editReply"].includes(call.method)), "deleteReply 失败不重复响应");
  assert(logger.calls.some((call) => call.message.includes("删除成功确认失败")), "deleteReply 失败写安全日志");
  assert(!JSON.stringify(logger.calls).includes("delete secret body"), "deleteReply 失败日志不包含原始错误正文");
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
  assertEqual(interaction.calls[0]?.payload?.flags, MessageFlags.Ephemeral, `${label} flags`);
  assertEqual("ephemeral" in (interaction.calls[0]?.payload ?? {}), false, `${label} 不使用 deprecated ephemeral`);
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

// Modal Submit：立即 defer，传递固定 source 与 actor，成功后删除 ephemeral 回复。
{
  const order = [];
  const service = {
    reply: async (request) => { order.push("service"); return { messageId: "sent-1" }; },
    send: async () => ({ messageId: "unused" }),
  };
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
  assertEqual(interaction.calls.at(-1)?.method, "deleteReply", "成功后 deleteReply");
  const request = service.request;
  assert(interaction.calls.some((call) => call.method === "deferReply" && call.payload.flags === MessageFlags.Ephemeral), "deferReply 使用 Ephemeral flags");
  assert(interaction.calls.every((call) => !call.payload || !("ephemeral" in call.payload)), "响应不使用 deprecated ephemeral");
  router.destroy();
}

// 精确核对 Service 参数。
{
  let request;
  const service = {
    reply: async (value) => { request = value; return { messageId: "sent-1" }; },
    send: async () => ({ messageId: "unused" }),
  };
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

// Send Modal Submit：先 defer，再调用 send，并使用 discord_slash source。
{
  let request;
  const service = {
    reply: async () => ({ messageId: "unused" }),
    send: async (value) => { request = value; return { messageId: "sent-send-1" }; },
  };
  const { client, router } = makeHarness(service);
  const interaction = makeInteraction({
    kind: "send-modal",
    id: "send-modal-params",
    member: undefined,
    fields: { getTextInputValue: () => "发送正文 🫖" },
  });
  client.emit("interactionCreate", interaction);
  await flush();
  assertEqual(interaction.calls[0]?.method, "deferReply", "Send Modal 先 deferReply");
  assertEqual(interaction.calls.at(-1)?.method, "deleteReply", "Send 成功后 deleteReply");
  assert(interaction.calls.every((call) => call.method !== "editReply"), "Send 成功不显示多余确认卡片");
  assertEqual(request.guildId, GUILD_ID, "Send Service guildId");
  assertEqual(request.channelId, CHANNEL_ID, "Send Service channelId 来自 Modal Context");
  assertEqual(request.content, "发送正文 🫖", "Send Service content");
  assertEqual(request.actor.id, "444444444444444444", "Send actor.id");
  assertEqual(request.actor.username, "admin", "Send actor.username");
  assertEqual(request.actor.displayName, "管理员", "Send displayName 回退到 globalName");
  assertEqual(request.source, "discord_slash", "Send source 固定为 discord_slash");
  assert(interaction.calls.every((call) => !call.payload || !("ephemeral" in call.payload)), "Send 响应不使用 deprecated ephemeral");
  router.destroy();
}

for (const [overrides, label] of [
  [{ inGuild: () => false }, "Send 提交 DM 拒绝"],
  [{ guildId: "999999999999999999" }, "Send 提交错误 Guild 拒绝"],
  [{ memberPermissions: { has: () => false } }, "Send 提交权限撤销拒绝"],
  [{ customId: "manual:v1:send:bad" }, "Send 非法 customId 拒绝"],
]) {
  const serviceCalls = [];
  const service = {
    reply: async () => ({ messageId: "unused" }),
    send: async (value) => { serviceCalls.push(value); return { messageId: "sent-1" }; },
  };
  const { client, router } = makeHarness(service);
  const interaction = makeInteraction({ kind: "send-modal", id: `send-invalid-${label}`, ...overrides });
  client.emit("interactionCreate", interaction);
  await flush();
  assertEqual(serviceCalls.length, 0, `${label} 不调用 send`);
  assertEqual(interaction.calls[0]?.payload?.flags, MessageFlags.Ephemeral, `${label} flags`);
  assertEqual("ephemeral" in (interaction.calls[0]?.payload ?? {}), false, `${label} 不使用 deprecated ephemeral`);
  router.destroy();
}

for (const [error, expected, label] of [
  [new ManualMessageError("CHANNEL_NOT_FOUND"), "目标频道不存在或无法访问。", "Send 频道删除错误"],
  [new ManualMessageError("BOT_MISSING_PERMISSION"), "小G宝缺少在目标频道发言所需的权限。", "Send 权限变化错误"],
  [new ManualMessageError("THREAD_LOCKED"), "目标 Thread 已锁定，无法发言。", "Send locked Thread 错误"],
  [new Error("send secret body"), "处理人工发言失败，请稍后重试。", "Send 未知错误"],
]) {
  const service = {
    reply: async () => ({ messageId: "unused" }),
    send: async () => { throw error; },
  };
  const { client, router, logger } = makeHarness(service);
  const interaction = makeInteraction({ kind: "send-modal", id: `send-error-${label}` });
  client.emit("interactionCreate", interaction);
  await flush();
  assertEqual(interaction.calls.at(-1)?.payload?.content, expected, label);
  const serialized = JSON.stringify(logger.calls);
  assert(!serialized.includes("send secret body"), `${label} 日志不包含原始正文`);
  assert(!serialized.includes("回复内容 🫖"), `${label} 日志不包含 Modal 正文`);
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
  const service = {
    reply: async () => { throw error; },
    send: async () => ({ messageId: "unused" }),
  };
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
for (const [interactionOptions, label, expected] of [
  [{ fields: { getTextInputValue: () => { throw new Error("reply modal secret"); } } }, "Reply Modal 读取失败", "处理人工回复失败，请稍后重试。"],
  [{ fields: { getTextInputValue: () => { throw new Error("send modal secret"); } } }, "Send Modal 读取失败", "处理人工发言失败，请稍后重试。"],
  [{ inGuild: () => false, reply: async () => { throw new Error("token secret"); } }, "reply 失败", null],
]) {
  const { client, router, logger } = makeHarness();
  const kind = label === "reply 失败"
    ? "context"
    : label.startsWith("Send") ? "send-modal" : "modal";
  const interaction = makeInteraction({ kind, id: `safe-${label}`, ...interactionOptions });
  client.emit("interactionCreate", interaction);
  await flush();
  if (expected) assertEqual(interaction.calls.at(-1)?.payload?.content, expected, `${label} 安全文案`);
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
  const service = {
    reply: async () => { serviceCount++; return { messageId: "sent-1" }; },
    send: async () => ({ messageId: "unused" }),
  };
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

{
  let sendCount = 0;
  const service = {
    reply: async () => ({ messageId: "unused" }),
    send: async () => { sendCount++; return { messageId: "sent-send-1" }; },
  };
  const { client, router } = makeHarness(service);
  client.emit("interactionCreate", makeInteraction({ kind: "send-modal", id: "send-duplicate-1" }));
  client.emit("interactionCreate", makeInteraction({ kind: "send-modal", id: "send-duplicate-1" }));
  await flush();
  assertEqual(sendCount, 1, "重复 Send Modal 不重复调用 send");
  router.destroy();
  client.emit("interactionCreate", makeInteraction({ kind: "send-modal", id: "send-duplicate-1" }));
  await flush();
  assertEqual(sendCount, 1, "destroy 后忽略 Send Modal");
}

// TTL 到期后可以重新处理，start 重复调用不重复注册 listener。
{
  let current = 100;
  let serviceCount = 0;
  const service = {
    reply: async () => { serviceCount++; return { messageId: "sent-1" }; },
    send: async () => ({ messageId: "unused" }),
  };
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

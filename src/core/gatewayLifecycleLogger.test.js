/**
 * gatewayLifecycleLogger.js 自动测试。
 *
 * 使用 EventEmitter fake client。
 *
 * 运行：node src/core/gatewayLifecycleLogger.test.js
 */

import { EventEmitter } from "events";
import { setupGatewayLifecycleLogger } from "./gatewayLifecycleLogger.js";

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

function makeMockLogger() {
  const calls = [];
  return {
    calls,
    info: (msg, data) => calls.push({ level: "info", msg, data }),
    error: (msg, data) => calls.push({ level: "error", msg, data }),
    warn: (msg, data) => calls.push({ level: "warn", msg, data }),
    debug: () => {},
  };
}

function makeFakeClient() {
  const emitter = new EventEmitter();
  emitter.ws = { status: 0, ping: 48 };
  emitter.isReady = () => true;
  emitter.guilds = { cache: { size: 1 } };
  return emitter;
}

// ============================
// Test 1: 注册所有事件监听器
// ============================

{
  const client = makeFakeClient();
  const logger = makeMockLogger();
  const cleanup = setupGatewayLifecycleLogger({ client, logger });

  // 触发各事件
  client.emit("shardReady", 0, new Set());
  client.emit("shardDisconnect", { code: 1001, reason: "CloudFlare", wasClean: true }, 0);
  client.emit("shardReconnecting", 0);
  client.emit("shardResume", 0, 5);
  client.emit("shardError", new Error("test error"), 0);
  client.emit("invalidated");

  assert(logger.calls.length >= 6, "所有 6 个生命周期事件均被记录");

  // 检查具体事件
  const msgs = logger.calls.map((c) => c.msg);
  assert(msgs.some((m) => m.includes("shardReady")), "记录 shardReady");
  assert(msgs.some((m) => m.includes("shardDisconnect")), "记录 shardDisconnect");
  assert(msgs.some((m) => m.includes("shardReconnecting")), "记录 shardReconnecting");
  assert(msgs.some((m) => m.includes("shardResume")), "记录 shardResume");
  assert(msgs.some((m) => m.includes("shardError")), "记录 shardError");
  assert(msgs.some((m) => m.includes("invalidated")), "记录 invalidated");

  // check closeCode in shardDisconnect
  const discLog = logger.calls.find((c) => c.msg.includes("shardDisconnect"));
  assert(discLog.data.closeCode === 1001, "shardDisconnect 记录 closeCode");
  assert(discLog.data.closeReason === "CloudFlare", "shardDisconnect 记录 closeReason");

  // check replayedEvents in shardResume
  const resumeLog = logger.calls.find((c) => c.msg.includes("shardResume"));
  assertEqual(resumeLog.data.replayedEvents, 5, "shardResume 记录 replayedEvents");

  // check error in shardError
  const errLog = logger.calls.find((c) => c.msg.includes("shardError"));
  assertEqual(errLog.data.name, "Error", "shardError 记录 error name");
  assertEqual(errLog.data.message, "test error", "shardError 记录 error message");

  cleanup.destroy();
}

// ============================
// Test 2: destroy() 移除监听器
// ============================

{
  const client = makeFakeClient();
  const logger = makeMockLogger();
  const cleanup = setupGatewayLifecycleLogger({ client, logger });

  cleanup.destroy();

  // 清空
  logger.calls.length = 0;

  // 触发事件
  client.emit("shardReady", 0, new Set());
  client.emit("shardError", new Error("should not log"), 0);

  // destroy 后不应再记录
  assertEqual(logger.calls.length, 0, "destroy() 后不再记录生命周期事件");
}

// ============================
// Test 3: 不记录 Token 等敏感信息
// ============================

{
  const client = makeFakeClient();
  const logger = makeMockLogger();
  const cleanup = setupGatewayLifecycleLogger({ client, logger });

  client.emit("shardReady", 0, new Set());

  const json = JSON.stringify(logger.calls);
  assert(!json.includes("token"), "日志中不含 token");
  assert(!json.includes("Bearer"), "日志中不含 Bearer");
  assert(!json.includes("apiKey"), "日志中不含 apiKey");

  cleanup.destroy();
}

// ============================
// Test 4: Error 对象安全提取
// ============================

{
  const client = makeFakeClient();
  const logger = makeMockLogger();
  const cleanup = setupGatewayLifecycleLogger({ client, logger });

  // 模拟一个可能包含敏感信息的 Error
  const errorWithExtra = new Error("test");
  errorWithExtra.name = "DiscordAPIError";
  errorWithExtra.request = { headers: { Authorization: "Bearer secret" } };
  errorWithExtra.response = { status: 401 };

  client.emit("shardError", errorWithExtra, 0);

  const errLog = logger.calls.find((c) => c.msg.includes("shardError"));
  assertEqual(errLog.data.name, "DiscordAPIError", "记录 error name");
  assertEqual(errLog.data.message, "test", "记录 error message");
  assert(!errLog.data.request, "不记录完整 request 对象");
  assert(!errLog.data.response, "不记录完整 response 对象");

  const json = JSON.stringify(errLog.data);
  assert(!json.includes("secret"), "不记录敏感请求头值");

  cleanup.destroy();
}

// ============================
// 结果
// ============================

console.log(`\n[gatewayLifecycleLogger.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);

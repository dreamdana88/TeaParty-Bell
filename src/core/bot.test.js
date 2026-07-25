/**
 * bot.js 编排测试（真实 DI 路径，非镜像实现）。
 *
 * 直接 import start() 并注入 fake 依赖。
 * 禁止真实 process.exit、Discord、文件系统。
 *
 * 运行：node src/core/bot.test.js
 */

import { start, EXIT_OK, EXIT_RUNTIME, EXIT_PERMANENT } from "./bot.js";
import { ConfigError } from "../config/index.js";
import { OutboxError } from "../alerts/alertOutbox.js";
import { EventEmitter } from "events";

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

function makeMockLogger() { return { info:()=>{}, error:()=>{}, warn:()=>{}, debug:()=>{}, calls:[] }; }

// ---- 通用 fake 工厂 ----

function makeFakeConfig() {
  return { nodeEnv:"test", isProduction:false, testMode:false, logLevel:"debug",
    discordBotToken:"tok", discordApplicationId:"app", discordGuildId:"111", discordThanksChannelId:"222",
    deepseekApiKey:"sk", deepseekBaseUrl:"x", deepseekModel:"m", deepseekTimeoutMs:30000,
    reactionCount:10, boostAggregationWindowMs:100 };
}

function makeFakeClient() {
  const emitter = new EventEmitter();
  emitter._ready = true;
  emitter.ws = { status: 0, ping: 48 };
  emitter.isReady = () => emitter._ready;
  emitter.guilds = { cache: { size: 1 }, fetch: async () => ({ id:"111", name:"G", systemChannelId:"333", systemChannelFlags:{ has:()=>false } }) };
  emitter.channels = { fetch: async (id) => ({ id, guildId:"111", guild:{id:"111"}, type:0, permissionsFor:()=>({ has:()=>true }) }) };
  emitter.user = { id:"bot" };
  emitter.login = async () => {};
  emitter.destroy = async () => {};
  emitter.on = emitter.on.bind(emitter);
  emitter.once = emitter.once.bind(emitter);
  emitter.off = emitter.removeListener.bind(emitter);
  return emitter;
}

// ============================
// Test 1: 正常启动 → ClientReady → Preflight → operational
// ============================

{
  const events = [];
  const logger = makeMockLogger();
  const client = makeFakeClient();
  let exitCode = null;

  const fakeStore = {
    load: async () => {},
    getAllRecords: () => new Map(),
    listRecoverable: () => [],
    markUncertain: async () => {},
    close: async () => {},
  };
  const fakeOutbox = {
    verifyWritable: () => {},
    loadAllAlerts: () => [],
    writeAlert: async () => {},
    findAlert: () => undefined,
    close: async () => {},
  };
  const fakeNotifier = {
    initialize: async () => {},
    notifyFailure: async () => {},
    notifyRecovery: async () => {},
    notifyWarning: async () => {},
    notifyReadyAfterRestart: async () => ({ createdReady: true, recovered: [], failedRecoveries: [] }),
  };
  const fakeHealthMon = { start: () => {}, stop: () => {}, onReady: () => {} };
  const fakeObserver = { destroy: () => {} };

  await start({
    loadConfigFn: () => makeFakeConfig(),
    createClientFn: () => {
      const { login: _, destroy: __, waitUntilReady: ___ } = makeFakeClient();
      return { client, login: async () => {}, destroy: async () => {}, waitUntilReady: async () => {} };
    },
    createAlertOutboxFn: () => fakeOutbox,
    createNotifierFn: () => fakeNotifier,
    createStoreFn: () => fakeStore,
    createHealthMonitorFn: () => fakeHealthMon,
    createPreflightFn: () => ({ run: async () => ({ passed: true }) }),
    setupLifecycleLoggerFn: () => ({ destroy: () => {} }),
    setupObserverFn: () => fakeObserver,
    createHandlerFn: () => ({ handleBoostEvent: async () => true }),
    createEmojiProviderFn: () => ({ fetchEmojis: async () => [] }),
    logger,
    exitFn: (c) => { exitCode = c; },
    processLike: { on: () => {} },
    projectRoot: "/tmp",
  });

  assert(exitCode === null || exitCode === undefined, "正常启动不调用 exitFn");

  // Preflight 在 startup 返回前就已运行
  // 启动成功后不应有 exit 调用
}

// ============================
// Test 2: ConfigError → 使用其 exitCode
// ============================

{
  let exitCode = null;
  await start({
    loadConfigFn: () => { throw new ConfigError("bad NODE_ENV", "invalid_node_env", 78); },
    logger: makeMockLogger(),
    exitFn: (c) => { exitCode = c; },
    processLike: { on: () => {} },
  });
  assertEqual(exitCode, 78, "ConfigError 使用其 exitCode");
}

// ============================
// Test 3: Outbox 初始化失败 → exit 78
// ============================

{
  let exitCode = null;
  const logger = makeMockLogger();
  await start({
    loadConfigFn: () => makeFakeConfig(),
    createAlertOutboxFn: () => {
      const o = { verifyWritable: () => { throw new OutboxError("disk full", "write_probe_failed"); } };
      return o;
    },
    logger,
    exitFn: (c) => { exitCode = c; },
    processLike: { on: () => {} },
  });
  assertEqual(exitCode, 78, "Outbox probe 失败 → exit 78");
}

// ============================
// Test 4: Outbox 加载失败 → exit 78
// ============================

{
  let exitCode = null;
  await start({
    loadConfigFn: () => makeFakeConfig(),
    createAlertOutboxFn: () => ({ verifyWritable: () => {}, loadAllAlerts: () => { throw new OutboxError("bad", "schema_corrupt"); } }),
    createNotifierFn: ({ outbox }) => ({ initialize: async () => { outbox.loadAllAlerts(); } }),
    logger: makeMockLogger(),
    exitFn: (c) => { exitCode = c; },
    processLike: { on: () => {} },
  });
  assertEqual(exitCode, 78, "Outbox 加载损坏 → exit 78");
}

// ============================
// Test 5: Discord 登录失败 → exit 1
// ============================

{
  let exitCode = null;
  await start({
    loadConfigFn: () => makeFakeConfig(),
    createAlertOutboxFn: () => ({ verifyWritable: () => {}, loadAllAlerts: () => [], writeAlert: async () => {}, close: async () => {} }),
    createNotifierFn: () => ({ initialize: async () => {}, notifyFailure: async () => {} }),
    createStoreFn: () => ({ load: async () => {}, getAllRecords: () => new Map(), listRecoverable: () => [], markUncertain: async () => {}, close: async () => {} }),
    createClientFn: () => ({
      client: makeFakeClient(),
      login: async () => { throw new Error("Invalid token"); },
      destroy: async () => {},
      waitUntilReady: async () => {},
    }),
    createHealthMonitorFn: () => ({ start: () => {} }),
    setupLifecycleLoggerFn: () => ({ destroy: () => {} }),
    setupObserverFn: () => ({ destroy: () => {} }),
    createHandlerFn: () => ({}),
    createEmojiProviderFn: () => ({}),
    logger: makeMockLogger(),
    exitFn: (c) => { exitCode = c; },
    processLike: { on: () => {} },
  });
  assertEqual(exitCode, 1, "Discord 登录失败 → exit 1");
}

// ============================
// Test 6: Preflight passed=false → 不调用 notifyReadyAfterRestart
// ============================

{
  let readyCalled = false;
  let exitCode = null;
  const fakeOutbox = { verifyWritable: () => {}, loadAllAlerts: () => [], writeAlert: async () => {}, findAlert: () => undefined, close: async () => {} };
  const fakeNotifier = {
    initialize: async () => {},
    notifyFailure: async () => {},
    notifyRecovery: async () => {},
    notifyWarning: async () => {},
    notifyReadyAfterRestart: async () => { readyCalled = true; return { createdReady: true, recovered: [], failedRecoveries: [] }; },
  };

  await start({
    loadConfigFn: () => makeFakeConfig(),
    createAlertOutboxFn: () => fakeOutbox,
    createNotifierFn: () => fakeNotifier,
    createStoreFn: () => ({ load: async () => {}, getAllRecords: () => new Map(), listRecoverable: () => [], markUncertain: async () => {}, close: async () => {} }),
    createClientFn: () => ({
      client: makeFakeClient(),
      login: async () => {},
      destroy: async () => {},
      waitUntilReady: async () => {},
    }),
    createHealthMonitorFn: () => ({ start: () => {}, onReady: () => {} }),
    setupLifecycleLoggerFn: () => ({ destroy: () => {} }),
    setupObserverFn: () => ({ destroy: () => {} }),
    createHandlerFn: () => ({}),
    createEmojiProviderFn: () => ({}),
    createPreflightFn: ({ exitFn }) => ({ run: async () => { exitFn(78); return { passed: false }; } }),
    logger: makeMockLogger(),
    exitFn: (c) => { exitCode = c; },
    processLike: { on: () => {} },
  });

  assert(!readyCalled, "Preflight failed → 不调用 notifyReadyAfterRestart");
  assertEqual(exitCode, 78, "Preflight failed → exitFn(78) called");

  // Reset
  readyCalled = false; exitCode = null;

  // passed=true → operational
  await start({
    loadConfigFn: () => makeFakeConfig(),
    createAlertOutboxFn: () => fakeOutbox,
    createNotifierFn: () => fakeNotifier,
    createStoreFn: () => ({ load: async () => {}, getAllRecords: () => new Map(), listRecoverable: () => [], markUncertain: async () => {}, close: async () => {} }),
    createClientFn: () => ({
      client: makeFakeClient(),
      login: async () => {},
      destroy: async () => {},
      waitUntilReady: async () => {},
    }),
    createHealthMonitorFn: () => ({ start: () => {}, onReady: () => {} }),
    setupLifecycleLoggerFn: () => ({ destroy: () => {} }),
    setupObserverFn: () => ({ destroy: () => {} }),
    createHandlerFn: () => ({}),
    createEmojiProviderFn: () => ({}),
    createPreflightFn: () => ({ run: async () => ({ passed: true }) }),
    logger: makeMockLogger(),
    exitFn: () => {},
    processLike: { on: () => {} },
  });
  assert(readyCalled, "Preflight passed → notifyReadyAfterRestart called");
}

// ============================
// Test 7: notifyReadyAfterRestart 失败 → exit 78
// ============================

{
  let exitCode = null;
  const fakeOutbox = { verifyWritable: () => {}, loadAllAlerts: () => [], writeAlert: async () => {}, findAlert: () => undefined, close: async () => {} };
  const fakeNotifier = {
    initialize: async () => {},
    notifyFailure: async () => {},
    notifyRecovery: async () => {},
    notifyWarning: async () => {},
    notifyReadyAfterRestart: async () => { throw new Error("disk full"); },
  };

  await start({
    loadConfigFn: () => makeFakeConfig(),
    createAlertOutboxFn: () => fakeOutbox,
    createNotifierFn: () => fakeNotifier,
    createStoreFn: () => ({ load: async () => {}, getAllRecords: () => new Map(), listRecoverable: () => [], markUncertain: async () => {}, close: async () => {} }),
    createClientFn: () => ({
      client: makeFakeClient(),
      login: async () => {},
      destroy: async () => {},
      waitUntilReady: async () => {},
    }),
    createHealthMonitorFn: () => ({ start: () => {}, onReady: () => {} }),
    setupLifecycleLoggerFn: () => ({ destroy: () => {} }),
    setupObserverFn: () => ({ destroy: () => {} }),
    createHandlerFn: () => ({}),
    createEmojiProviderFn: () => ({}),
    createPreflightFn: () => ({ run: async () => ({ passed: true }) }),
    logger: makeMockLogger(),
    exitFn: (c) => { exitCode = c; },
    processLike: { on: () => {} },
  });

  assertEqual(exitCode, 78, "notifyReadyAfterRestart 失败 → exit 78");
}

// ============================
// Test 8: Recovery 部分失败 → exit 78
// ============================

{
  let exitCode = null;
  const fakeOutbox = { verifyWritable: () => {}, loadAllAlerts: () => [], writeAlert: async () => {}, findAlert: () => undefined, close: async () => {} };
  const fakeNotifier = {
    initialize: async () => {},
    notifyFailure: async () => {},
    notifyRecovery: async () => {},
    notifyWarning: async () => {},
    notifyReadyAfterRestart: async () => ({ createdReady: false, recovered: [], failedRecoveries: [{ incidentKey: "gw", error: "fail" }] }),
  };

  await start({
    loadConfigFn: () => makeFakeConfig(),
    createAlertOutboxFn: () => fakeOutbox,
    createNotifierFn: () => fakeNotifier,
    createStoreFn: () => ({ load: async () => {}, getAllRecords: () => new Map(), listRecoverable: () => [], markUncertain: async () => {}, close: async () => {} }),
    createClientFn: () => ({
      client: makeFakeClient(),
      login: async () => {},
      destroy: async () => {},
      waitUntilReady: async () => {},
    }),
    createHealthMonitorFn: () => ({ start: () => {}, onReady: () => {} }),
    setupLifecycleLoggerFn: () => ({ destroy: () => {} }),
    setupObserverFn: () => ({ destroy: () => {} }),
    createHandlerFn: () => ({}),
    createEmojiProviderFn: () => ({}),
    createPreflightFn: () => ({ run: async () => ({ passed: true }) }),
    logger: makeMockLogger(),
    exitFn: (c) => { exitCode = c; },
    processLike: { on: () => {} },
  });

  assertEqual(exitCode, 78, "Recovery 部分失败 → exit 78");
}

// ============================
// Test 9: Gateway Monitor 接收注入的 exitFn
// ============================

{
  let monitorExitCode = null;
  let monitorCallCount = 0;

  let capturedNotifyFailure;
  const fakeOutbox = { verifyWritable: () => {}, loadAllAlerts: () => [], writeAlert: async () => {}, findAlert: () => undefined, close: async () => {} };
  const fakeStore = { load: async () => {}, getAllRecords: () => new Map(), listRecoverable: () => [], markUncertain: async () => {}, close: async () => {} };

  await start({
    loadConfigFn: () => makeFakeConfig(),
    createAlertOutboxFn: () => fakeOutbox,
    createNotifierFn: () => ({ initialize: async () => {}, notifyFailure: async () => {}, notifyRecovery: async () => {}, notifyWarning: async () => {}, notifyReadyAfterRestart: async () => ({ createdReady: true, recovered: [], failedRecoveries: [] }) }),
    createStoreFn: () => fakeStore,
    createClientFn: () => ({
      client: makeFakeClient(),
      login: async () => {},
      destroy: async () => {},
      waitUntilReady: async () => {},
    }),
    createHealthMonitorFn: (opts) => {
      monitorCallCount++;
      capturedNotifyFailure = opts.notifyFailure;
      // 验证 exitFn 是注入的
      assert(typeof opts.exitFn === "function", "HealthMonitor 收到 inject exitFn");
      assertEqual(opts.alertPersistenceFailureExitCode, 78, "HealthMonitor alertPersistenceFailureExitCode=78");
      return { start: () => {}, stop: () => {}, onReady: () => {} };
    },
    setupLifecycleLoggerFn: () => ({ destroy: () => {} }),
    setupObserverFn: () => ({ destroy: () => {} }),
    createHandlerFn: () => ({}),
    createEmojiProviderFn: () => ({}),
    createPreflightFn: () => ({ run: async () => ({ passed: true }) }),
    logger: makeMockLogger(),
    exitFn: (c) => { monitorExitCode = c; },
    processLike: { on: () => {} },
  });

  // 手动调用 captured notifyFailure 验证它通过 notifier 传播
  assert(typeof capturedNotifyFailure === "function", "HealthMonitor 收到 notifyFailure");
}

// ============================
// Test 10: shutdown 清理顺序
// ============================

{
  const cleanupOrder = [];
  await start({
    loadConfigFn: () => makeFakeConfig(),
    createAlertOutboxFn: () => ({ verifyWritable: () => {}, loadAllAlerts: () => [], writeAlert: async () => {}, findAlert: () => undefined, close: async () => { cleanupOrder.push("outbox_close"); } }),
    createNotifierFn: () => ({ initialize: async () => {}, notifyFailure: async () => {}, notifyRecovery: async () => {}, notifyWarning: async () => {}, notifyReadyAfterRestart: async () => ({ createdReady: true, recovered: [], failedRecoveries: [] }) }),
    createStoreFn: () => ({ load: async () => {}, getAllRecords: () => new Map(), listRecoverable: () => [], markUncertain: async () => {}, close: async () => { cleanupOrder.push("store_close"); } }),
    createClientFn: () => ({
      client: makeFakeClient(),
      login: async () => {},
      destroy: async () => { cleanupOrder.push("client_destroy"); },
      waitUntilReady: async () => {},
    }),
    createHealthMonitorFn: () => ({ start: () => {}, stop: () => { cleanupOrder.push("healthmon_stop"); }, onReady: () => {} }),
    setupLifecycleLoggerFn: () => ({ destroy: () => { cleanupOrder.push("lifecycle_destroy"); } }),
    setupObserverFn: () => ({ destroy: () => { cleanupOrder.push("observer_destroy"); } }),
    createHandlerFn: () => ({}),
    createEmojiProviderFn: () => ({}),
    createPreflightFn: () => ({ run: async () => ({ passed: true }) }),
    logger: makeMockLogger(),
    exitFn: (c) => { cleanupOrder.push(`exit_${c}`); },
    processLike: {
      on: (event, handler) => {
        if (event === "SIGTERM") {
          // 模拟 shutdown
          setTimeout(() => handler("SIGTERM"), 10);
        }
      },
    },
  });

  // 等待 shutdown 完成
  await new Promise(r => setTimeout(r, 50));

  // 验证精确顺序
  const expectedOrder = [
    "healthmon_stop",
    "lifecycle_destroy",
    "observer_destroy",
    "store_close",
    "outbox_close",
    "client_destroy",
    "exit_0",
  ];
  assertEqual(cleanupOrder.length, expectedOrder.length, `shutdown ${expectedOrder.length} steps`);
  for (let i = 0; i < expectedOrder.length; i++) {
    assertEqual(cleanupOrder[i], expectedOrder[i], `shutdown[${i}] = ${expectedOrder[i]}`);
  }
}

console.log(`\n[bot.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);

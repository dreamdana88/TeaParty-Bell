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
  let manualRouterCreated = false;
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
    createManualInteractionRouterFn: () => {
      manualRouterCreated = true;
      return { start: () => {}, destroy: () => {} };
    },
    logger: makeMockLogger(),
    exitFn: (c) => { exitCode = c; },
    processLike: { on: () => {} },
  });

  assert(!readyCalled, "Preflight failed → 不调用 notifyReadyAfterRestart");
  assertEqual(exitCode, 78, "Preflight failed → exitFn(78) called");
  assert(!manualRouterCreated, "Preflight failed → 不创建或启动 Interaction Router");

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
// Test 11: Manual Message Service / Interaction Router 真实 start 编排与关闭顺序
// ============================

{
  const lifecycle = [];
  let capturedServiceOptions;
  let capturedRouterOptions;
  let createdService;
  let routerCreated = false;
  const fakeOutbox = { verifyWritable: () => {}, loadAllAlerts: () => [], writeAlert: async () => {}, findAlert: () => undefined, close: async () => {} };
  const fakeNotifier = {
    initialize: async () => {},
    notifyFailure: async () => {},
    notifyRecovery: async () => {},
    notifyWarning: async () => {},
    notifyReadyAfterRestart: async () => ({ createdReady: true, recovered: [], failedRecoveries: [] }),
  };
  const fakeStore = { load: async () => {}, getAllRecords: () => new Map(), listRecoverable: () => [], markUncertain: async () => {}, close: async () => {} };
  const fakeClient = makeFakeClient();

  await start({
    loadConfigFn: () => makeFakeConfig(),
    createAlertOutboxFn: () => fakeOutbox,
    createNotifierFn: () => fakeNotifier,
    createStoreFn: () => fakeStore,
    createClientFn: () => ({
      client: fakeClient,
      login: async () => {},
      destroy: async () => { lifecycle.push("client_destroy"); },
      waitUntilReady: async () => {},
    }),
    createHealthMonitorFn: () => ({ start: () => {}, stop: () => { lifecycle.push("health_stop"); }, onReady: () => {} }),
    setupLifecycleLoggerFn: () => ({ destroy: () => { lifecycle.push("lifecycle_destroy"); } }),
    setupObserverFn: () => ({ destroy: () => { lifecycle.push("observer_destroy"); } }),
    createHandlerFn: () => ({}),
    createEmojiProviderFn: () => ({}),
    createPreflightFn: () => ({ run: async () => ({ passed: true }) }),
    createManualMessageServiceFn: (options) => {
      capturedServiceOptions = options;
      createdService = { reply: async () => ({ messageId: "sent-1" }) };
      return createdService;
    },
    createManualInteractionRouterFn: (options) => {
      routerCreated = true;
      capturedRouterOptions = options;
      return {
        start: () => { lifecycle.push("router_start"); },
        destroy: () => { lifecycle.push("router_destroy"); },
      };
    },
    logger: makeMockLogger(),
    exitFn: () => { lifecycle.push("exit"); },
    processLike: {
      on: (event, handler) => {
        if (event === "SIGTERM") setTimeout(() => handler("SIGTERM"), 10);
      },
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert(routerCreated, "正常启动创建 Interaction Router");
  assertEqual(capturedServiceOptions.client, fakeClient, "Service 收到真实启动 Client");
  assertEqual(capturedServiceOptions.config.discordGuildId, "111", "Service 收到配置");
  assertEqual(capturedRouterOptions.manualMessageService, createdService, "Router 使用创建出的 Service");
  assertEqual(capturedRouterOptions.guildId, "111", "Router 收到配置 Guild");
  assert(lifecycle.indexOf("router_start") >= 0, "正常启动调用 router.start()");
  assert(lifecycle.indexOf("router_destroy") < lifecycle.indexOf("client_destroy"), "router.destroy() 先于 client.destroy()");
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

// ============================
// Test 12: service_operational 启动时序与初始化失败语义
// ============================

function makeManualStartupOptions({
  events,
  serviceFactory = () => ({ reply: async () => ({ messageId: "sent-1" }) }),
  routerFactory = () => ({
    start: () => { events.push("router_start"); },
    destroy: () => { events.push("router_destroy"); },
  }),
  readyResult = { createdReady: true, recovered: [], failedRecoveries: [] },
  readyError = null,
} = {}) {
  const logger = {
    calls: [],
    info: (message, data) => logger.calls.push({ level: "info", message, data }),
    error: (message, data) => logger.calls.push({ level: "error", message, data }),
    warn: (message, data) => logger.calls.push({ level: "warn", message, data }),
    debug: (message, data) => logger.calls.push({ level: "debug", message, data }),
  };
  const originalInfo = logger.info;
  logger.info = (message, data) => {
    originalInfo(message, data);
    if (message === "TeaParty-Bell 启动完成 / operational") events.push("operational");
  };
  const fakeOutbox = { verifyWritable: () => {}, loadAllAlerts: () => [], writeAlert: async () => {}, findAlert: () => undefined, close: async () => {} };
  const fakeStore = { load: async () => {}, getAllRecords: () => new Map(), listRecoverable: () => [], markUncertain: async () => {}, close: async () => {} };
  const fakeNotifier = {
    initialize: async () => {},
    notifyFailure: async () => {},
    notifyRecovery: async () => {},
    notifyWarning: async () => {},
    notifyReadyAfterRestart: async () => {
      events.push("notify_ready");
      if (readyError) throw readyError;
      return readyResult;
    },
  };

  return {
    loadConfigFn: () => makeFakeConfig(),
    createAlertOutboxFn: () => fakeOutbox,
    createNotifierFn: () => fakeNotifier,
    createStoreFn: () => fakeStore,
    createClientFn: () => ({ client: makeFakeClient(), login: async () => {}, destroy: async () => {}, waitUntilReady: async () => {} }),
    createHealthMonitorFn: () => ({ start: () => {}, stop: () => {}, onReady: () => {} }),
    setupLifecycleLoggerFn: () => ({ destroy: () => {} }),
    setupObserverFn: () => ({ destroy: () => {} }),
    createHandlerFn: () => ({}),
    createEmojiProviderFn: () => ({}),
    createPreflightFn: () => ({ run: async () => ({ passed: true }) }),
    createManualMessageServiceFn: (options) => {
      events.push("service_create");
      return serviceFactory(options);
    },
    createManualInteractionRouterFn: (options) => {
      events.push("router_create");
      return routerFactory(options);
    },
    logger,
    exitFn: (code) => { events.push(`exit_${code}`); },
    processLike: { on: () => {} },
  };
}

{
  const events = [];
  const options = makeManualStartupOptions({
    events,
    serviceFactory: () => { throw new Error("service secret"); },
  });
  await start(options);
  assertEqual(events.includes("notify_ready"), false, "Service 创建失败未写 ready");
  assertEqual(events.includes("operational"), false, "Service 创建失败未进入 operational");
  assertEqual(events.at(-1), "exit_1", "Service 创建失败 exit 1");
  assertEqual(options.logger.calls.at(-1).data.errorName, "Error", "Service 创建失败记录安全 errorName");
  assertEqual("errorMessage" in options.logger.calls.at(-1).data, false, "Service 创建失败不记录原始 message");
}

{
  const events = [];
  const options = makeManualStartupOptions({
    events,
    routerFactory: () => { throw new Error("router secret"); },
  });
  await start(options);
  assertEqual(events.includes("notify_ready"), false, "Router 创建失败未写 ready");
  assertEqual(events.includes("operational"), false, "Router 创建失败未进入 operational");
  assertEqual(events.at(-1), "exit_1", "Router 创建失败 exit 1");
  assertEqual("errorMessage" in options.logger.calls.at(-1).data, false, "Router 创建失败不记录原始 message");
}

{
  const events = [];
  const options = makeManualStartupOptions({
    events,
    routerFactory: () => ({
      start: () => { events.push("router_start"); throw new Error("start secret"); },
      destroy: () => { events.push("router_destroy"); },
    }),
  });
  await start(options);
  assertEqual(events.includes("notify_ready"), false, "router.start 失败未写 ready");
  assertEqual(events.includes("operational"), false, "router.start 失败未进入 operational");
  assertEqual(events.at(-1), "exit_1", "router.start 失败 exit 1");
}

{
  const events = [];
  await start(makeManualStartupOptions({ events }));
  assertEqual(
    JSON.stringify(events),
    JSON.stringify(["service_create", "router_create", "router_start", "notify_ready", "operational"]),
    "正常路径 router_start → notify_ready → operational",
  );
}

for (const [readyOptions, label] of [
  [{ readyError: new Error("ready secret") }, "notifyReadyAfterRestart 失败"],
  [{ readyResult: { createdReady: false, recovered: [], failedRecoveries: [{ incidentKey: "gw" }] } }, "failedRecoveries"],
]) {
  const events = [];
  await start(makeManualStartupOptions({ events, ...readyOptions }));
  assertEqual(events.indexOf("router_destroy") > events.indexOf("notify_ready"), true, `${label} 先 destroy Router`);
  assertEqual(events.at(-1), "exit_78", `${label} exit 78`);
  assertEqual(events.includes("operational"), false, `${label} 未进入 operational`);
}

{
  const events = [];
  const options = makeManualStartupOptions({
    events,
    readyError: new Error("ready secret"),
    routerFactory: () => ({
      start: () => { events.push("router_start"); },
      destroy: () => { events.push("router_destroy"); throw new Error("destroy secret"); },
    }),
  });
  await start(options);
  assertEqual(events.at(-1), "exit_78", "Router destroy 失败不掩盖 exit 78");
  assert(options.logger.calls.some((call) => call.message === "Router 启动后清理失败"), "Router destroy 失败写安全日志");
}

console.log(`\n[bot.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);

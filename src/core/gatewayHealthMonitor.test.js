/**
 * gatewayHealthMonitor.js 自动测试。
 *
 * 使用 fake client、fake timer、fake exitFn、fake notifier。
 * 禁止真实 process.exit、真实 Discord 连接。
 *
 * 运行：node src/core/gatewayHealthMonitor.test.js
 */

import { createGatewayHealthMonitor } from "./gatewayHealthMonitor.js";

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
    info: () => {},
    error: () => {},
    warn: () => {},
    debug: () => {},
  };
}

function makeFakeClient(opts = {}) {
  return {
    _ready: opts.ready ?? true,
    _wsStatus: opts.wsStatus ?? 0,
    _ping: opts.ping ?? 48,
    isReady() { return this._ready; },
    get ws() {
      return { status: this._wsStatus, ping: this._ping };
    },
    guilds: { cache: { size: 1 } },
  };
}

// ============================
// Test 1: Ready 状态不退出
// ============================

{
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };
  const client = makeFakeClient({ ready: true, wsStatus: 0, ping: 48 });
  const failures = [];
  const recoveries = [];
  const monitor = createGatewayHealthMonitor({
    client,
    notifyFailure: async (t, m) => { failures.push({ t, m }); },
    notifyRecovery: async (t, m) => { recoveries.push({ t, m }); },
    exitFn,
    logger: makeMockLogger(),
    checkIntervalMs: 50,
    startupGraceMs: 5000,
    unhealthyThresholdMs: 5000,
    healthySummaryIntervalMs: 60000,
  });

  monitor.start();
  monitor.onReady(); // 标记已 Ready

  await new Promise((r) => setTimeout(r, 200));

  const status = monitor.getStatus();
  assert(status.healthy, "Ready 状态判定为 healthy");
  assertEqual(exitCode, null, "Ready 时不调用 exitFn");
  assertEqual(failures.length, 0, "Ready 时不产生告警");
  assertEqual(recoveries.length, 0, "Ready 时不产生恢复告警");

  monitor.stop();
}

// ============================
// Test 2: 启动宽限期内未 Ready 不退出
// ============================

{
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };
  const client = makeFakeClient({ ready: false, wsStatus: 1, ping: null });
  const failures = [];
  const monitor = createGatewayHealthMonitor({
    client,
    notifyFailure: async (t, m) => { failures.push({ t, m }); },
    notifyRecovery: async () => {},
    exitFn,
    logger: makeMockLogger(),
    checkIntervalMs: 50,
    startupGraceMs: 5000,
    unhealthyThresholdMs: 2000,
  });

  monitor.start();
  // 不调用 onReady() —— 模拟 Gateway 未 Ready

  await new Promise((r) => setTimeout(r, 300));

  assertEqual(exitCode, null, "宽限期内未 Ready 不退出");
  assertEqual(failures.length, 0, "宽限期内不产生告警");

  monitor.stop();
}

// ============================
// Test 3: 宽限期耗尽仍未 Ready → exit(1)
// ============================

{
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };
  const client = makeFakeClient({ ready: false, wsStatus: 1, ping: null });
  const failures = [];
  const monitor = createGatewayHealthMonitor({
    client,
    notifyFailure: async (t, m) => { failures.push({ t, m }); },
    notifyRecovery: async () => {},
    exitFn,
    logger: makeMockLogger(),
    checkIntervalMs: 30,
    startupGraceMs: 80, // 短宽限期
    unhealthyThresholdMs: 200,
  });

  monitor.start();

  await new Promise((r) => setTimeout(r, 200));

  assertEqual(exitCode, 1, "宽限期耗尽 → exit(1)");
  assert(failures.length >= 1, "宽限期耗尽 → 至少一条告警");
  assert(failures.some((f) => f.t === "gateway_startup_timeout"), "告警类型为 gateway_startup_timeout");

  monitor.stop();
}

// ============================
// Test 4: 短暂断线不足阈值不退出
// ============================

{
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };
  const client = makeFakeClient({ ready: true, wsStatus: 0, ping: 48 });
  const failures = [];
  const monitor = createGatewayHealthMonitor({
    client,
    notifyFailure: async (t, m) => { failures.push({ t, m }); },
    notifyRecovery: async () => {},
    exitFn,
    logger: makeMockLogger(),
    checkIntervalMs: 30,
    startupGraceMs: 5000,
    unhealthyThresholdMs: 5000, // 长阈值
  });

  monitor.start();
  monitor.onReady();

  // 模拟短暂断线
  client._ready = false;
  client._wsStatus = 1;

  await new Promise((r) => setTimeout(r, 150));

  // 恢复
  client._ready = true;
  client._wsStatus = 0;

  await new Promise((r) => setTimeout(r, 100));

  assertEqual(exitCode, null, "短暂断线不足阈值不退出");
  assertEqual(failures.length, 0, "短暂断线不足阈值不产生告警（未到阈值就恢复了）");

  const status = monitor.getStatus();
  assert(status.healthy, "恢复后状态为 healthy");

  monitor.stop();
}

// ============================
// Test 5: 持续异常达到阈值 → exit(1) + failure alert
// ============================

{
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };
  const client = makeFakeClient({ ready: true, wsStatus: 0, ping: 48 });
  const failures = [];
  const monitor = createGatewayHealthMonitor({
    client,
    notifyFailure: async (t, m) => { failures.push({ t, m }); },
    notifyRecovery: async () => {},
    exitFn,
    logger: makeMockLogger(),
    checkIntervalMs: 30,
    startupGraceMs: 5000,
    unhealthyThresholdMs: 100,
  });

  monitor.start();
  monitor.onReady();

  // 断线
  client._ready = false;
  client._wsStatus = 1;

  await new Promise((r) => setTimeout(r, 250));

  assertEqual(exitCode, 1, "持续异常超过阈值 → exit(1)");
  assert(failures.length >= 1, "持续异常 → 至少一条告警");
  assert(failures.some((f) => f.t === "gateway_unhealthy"), "告警类型 gateway_unhealthy");

  monitor.stop();
}

// ============================
// Test 6: 持续异常不重复 exit
// ============================

{
  let exitCount = 0;
  const exitFn = () => { exitCount++; };
  const client = makeFakeClient({ ready: true, wsStatus: 0, ping: 48 });
  const failures = [];
  const monitor = createGatewayHealthMonitor({
    client,
    notifyFailure: async (t, m) => { failures.push({ t, m }); },
    notifyRecovery: async () => {},
    exitFn,
    logger: makeMockLogger(),
    checkIntervalMs: 30,
    startupGraceMs: 5000,
    unhealthyThresholdMs: 60,
  });

  monitor.start();
  monitor.onReady();
  client._ready = false;
  client._wsStatus = 1;

  await new Promise((r) => setTimeout(r, 250));

  assert(exitCount <= 1, "exitFn 最多调用一次（不重复退出）");
  assert(failures.find((f) => f.t === "gateway_unhealthy") !== undefined,
    "产生至少一条 gateway_unhealthy 告警");

  monitor.stop();
}

// ============================
// Test 7: 高 ping 但 Ready 时不退出
// ============================

{
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };
  const client = makeFakeClient({ ready: true, wsStatus: 0, ping: 9999 });
  const failures = [];
  const monitor = createGatewayHealthMonitor({
    client,
    notifyFailure: async (t, m) => { failures.push({ t, m }); },
    notifyRecovery: async () => {},
    exitFn,
    logger: makeMockLogger(),
    checkIntervalMs: 30,
    startupGraceMs: 5000,
    unhealthyThresholdMs: 200,
  });

  monitor.start();
  monitor.onReady();

  await new Promise((r) => setTimeout(r, 250));

  assertEqual(exitCode, null, "高 ping 但 Ready 时不退出");
  assertEqual(failures.length, 0, "高 ping 但 Ready 时不产生告警");

  monitor.stop();
}

// ============================
// Test 8: ping 无效但 Ready 时不退出
// ============================

{
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };

  // ping = -1
  {
    const client = makeFakeClient({ ready: true, wsStatus: 0, ping: -1 });
    const monitor = createGatewayHealthMonitor({
      client,
      notifyFailure: async () => {},
      notifyRecovery: async () => {},
      exitFn,
      logger: makeMockLogger(),
      checkIntervalMs: 30,
      startupGraceMs: 5000,
      unhealthyThresholdMs: 200,
    });
    monitor.start();
    monitor.onReady();
    await new Promise((r) => setTimeout(r, 150));
    assertEqual(exitCode, null, "ping=-1 但 Ready 时不退出");
    monitor.stop();
  }

  // ping = Infinity
  exitCode = null;
  {
    const client = makeFakeClient({ ready: true, wsStatus: 0, ping: Infinity });
    const monitor = createGatewayHealthMonitor({
      client,
      notifyFailure: async () => {},
      notifyRecovery: async () => {},
      exitFn,
      logger: makeMockLogger(),
      checkIntervalMs: 30,
      startupGraceMs: 5000,
      unhealthyThresholdMs: 200,
    });
    monitor.start();
    monitor.onReady();
    await new Promise((r) => setTimeout(r, 150));
    assertEqual(exitCode, null, "ping=Infinity 但 Ready 时不退出");
    monitor.stop();
  }
}

// ============================
// Test 9: stop() 后不再检查
// ============================

{
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };
  const client = makeFakeClient({ ready: true, wsStatus: 0, ping: 48 });
  const monitor = createGatewayHealthMonitor({
    client,
    notifyFailure: async () => {},
    notifyRecovery: async () => {},
    exitFn,
    logger: makeMockLogger(),
    checkIntervalMs: 30,
    startupGraceMs: 5000,
    unhealthyThresholdMs: 100,
  });

  monitor.start();
  monitor.onReady();
  monitor.stop();

  // 模拟不健康
  client._ready = false;

  await new Promise((r) => setTimeout(r, 200));

  assertEqual(exitCode, null, "stop() 后不再触发检查");

  // verify stopped flag
  const status = monitor.getStatus();
  assert(status.stopped, "状态为 stopped");
}

// ============================
// Test 10: 多次 start() 不创建重复 interval
// ============================

{
  const client = makeFakeClient({ ready: true, wsStatus: 0, ping: 48 });
  const monitor = createGatewayHealthMonitor({
    client,
    notifyFailure: async () => {},
    notifyRecovery: async () => {},
    exitFn: () => {},
    logger: makeMockLogger(),
    checkIntervalMs: 30,
    startupGraceMs: 5000,
    unhealthyThresholdMs: 5000,
  });

  monitor.start();
  monitor.start(); // 第二次
  monitor.start(); // 第三次
  // 不应抛出，不应创建重复

  const status = monitor.getStatus();
  assert(status.started, "start 后状态为 started");

  monitor.stop();
}

// ============================
// Test 11: 恢复后 unhealthySince 清零
// ============================

{
  let exitCode = null;
  const exitFn = (code) => { exitCode = code; };
  const client = makeFakeClient({ ready: true, wsStatus: 0, ping: 48 });
  const failures = [];
  const recoveries = [];
  const monitor = createGatewayHealthMonitor({
    client,
    notifyFailure: async (t, m) => { failures.push({ t, m }); },
    notifyRecovery: async (t, m) => { recoveries.push({ t, m }); },
    exitFn,
    logger: makeMockLogger(),
    checkIntervalMs: 30,
    startupGraceMs: 5000,
    unhealthyThresholdMs: 5000,
  });

  monitor.start();
  monitor.onReady();

  // 断线
  client._ready = false;
  client._wsStatus = 1;

  await new Promise((r) => setTimeout(r, 150));

  let status = monitor.getStatus();
  assert(status.unhealthySince !== null, "断线后 unhealthySince 已设置");

  // 恢复
  client._ready = true;
  client._wsStatus = 0;

  await new Promise((r) => setTimeout(r, 150));

  status = monitor.getStatus();
  assert(status.unhealthySince === null, "恢复后 unhealthySince 清零");
  assertEqual(exitCode, null, "恢复后不退出");

  // 短暂断线不足阈值，未产生 failure alert，所以 recovery 也不应该发送
  assertEqual(recoveries.length, 0, "短暂断线不发送 recovery");

  monitor.stop();
}

// ============================
// 结果
// ============================

console.log(`\n[gatewayHealthMonitor.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);

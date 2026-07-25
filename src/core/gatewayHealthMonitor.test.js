/**
 * gatewayHealthMonitor.js 自动测试。
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

function makeFakeClient(opts = {}) {
  return {
    _ready: opts.ready ?? true, _wsStatus: opts.wsStatus ?? 0, _ping: opts.ping ?? 48,
    isReady() { return this._ready; },
    get ws() { return { status: this._wsStatus, ping: this._ping }; },
    guilds: { cache: { size: 1 } },
  };
}

// Test 1: Ready 不退出
{
  let exitCode = null;
  const client = makeFakeClient({ ready: true, wsStatus: 0, ping: 48 });
  const failures = []; const recoveries = [];
  const m = createGatewayHealthMonitor({ client, notifyFailure: async (t,msg) => { failures.push({t,msg}); },
    notifyRecovery: async (t,msg) => { recoveries.push({t,msg}); }, exitFn: c => { exitCode = c; },
    logger: { info:()=>{},error:()=>{},warn:()=>{},debug:()=>{} },
    checkIntervalMs: 50, startupGraceMs: 5000, unhealthyThresholdMs: 5000, healthySummaryIntervalMs: 60000 });
  m.start(); m.onReady();
  await new Promise(r => setTimeout(r, 200));
  assert(m.getStatus().healthy, "Ready 判定为 healthy");
  assertEqual(exitCode, null, "不退出"); assertEqual(failures.length, 0, "无告警");
  m.stop();
}

// Test 2: 宽限期内未 Ready 不退出
{
  let exitCode = null;
  const client = makeFakeClient({ ready: false, wsStatus: 1, ping: null });
  const failures = [];
  const m = createGatewayHealthMonitor({ client, notifyFailure: async (t,msg) => { failures.push({t,msg}); },
    notifyRecovery: async () => {}, exitFn: c => { exitCode = c; },
    logger: { info:()=>{},error:()=>{},warn:()=>{},debug:()=>{} },
    checkIntervalMs: 50, startupGraceMs: 5000, unhealthyThresholdMs: 2000 });
  m.start();
  await new Promise(r => setTimeout(r, 300));
  assertEqual(exitCode, null, "宽限期内不退出"); assertEqual(failures.length, 0, "无告警");
  m.stop();
}

// Test 3: 宽限期耗尽 → exit(1)
{
  let exitCode = null;
  const client = makeFakeClient({ ready: false, wsStatus: 1, ping: null });
  const failures = [];
  const m = createGatewayHealthMonitor({ client, notifyFailure: async (t,msg) => { failures.push({t,msg}); },
    notifyRecovery: async () => {}, exitFn: c => { exitCode = c; },
    logger: { info:()=>{},error:()=>{},warn:()=>{},debug:()=>{} },
    checkIntervalMs: 30, startupGraceMs: 80, unhealthyThresholdMs: 200 });
  m.start();
  await new Promise(r => setTimeout(r, 200));
  assertEqual(exitCode, 1, "宽限期耗尽 → exit 1");
  assert(failures.some(f => f.t === "gateway_startup_timeout"), "告警 gateway_startup_timeout");
  m.stop();
}

// Test 4: 短暂断线不退出
{
  let exitCode = null;
  const client = makeFakeClient({ ready: true, wsStatus: 0, ping: 48 });
  const failures = [];
  const m = createGatewayHealthMonitor({ client, notifyFailure: async (t,msg) => { failures.push({t,msg}); },
    notifyRecovery: async () => {}, exitFn: c => { exitCode = c; },
    logger: { info:()=>{},error:()=>{},warn:()=>{},debug:()=>{} },
    checkIntervalMs: 30, startupGraceMs: 5000, unhealthyThresholdMs: 5000 });
  m.start(); m.onReady();
  client._ready = false; client._wsStatus = 1;
  await new Promise(r => setTimeout(r, 150));
  client._ready = true; client._wsStatus = 0;
  await new Promise(r => setTimeout(r, 100));
  assertEqual(exitCode, null, "短暂断线不退出");
  assertEqual(failures.length, 0, "不再告警");
  assert(m.getStatus().healthy, "恢复后 healthy");
  m.stop();
}

// Test 5: 持续异常 → exit(1)
{
  let exitCode = null;
  const client = makeFakeClient({ ready: true, wsStatus: 0, ping: 48 });
  const failures = [];
  const m = createGatewayHealthMonitor({ client, notifyFailure: async (t,msg) => { failures.push({t,msg}); },
    notifyRecovery: async () => {}, exitFn: c => { exitCode = c; },
    logger: { info:()=>{},error:()=>{},warn:()=>{},debug:()=>{} },
    checkIntervalMs: 30, startupGraceMs: 5000, unhealthyThresholdMs: 100 });
  m.start(); m.onReady();
  client._ready = false; client._wsStatus = 1;
  await new Promise(r => setTimeout(r, 250));
  assertEqual(exitCode, 1, "持续异常 → exit 1");
  assert(failures.some(f => f.t === "gateway_unhealthy"), "告警 gateway_unhealthy");
  m.stop();
}

// Test 6: 不重复 exit
{
  let exitCount = 0;
  const client = makeFakeClient({ ready: true, wsStatus: 0, ping: 48 });
  const m = createGatewayHealthMonitor({ client, notifyFailure: async () => {}, notifyRecovery: async () => {},
    exitFn: () => { exitCount++; },
    logger: { info:()=>{},error:()=>{},warn:()=>{},debug:()=>{} },
    checkIntervalMs: 30, startupGraceMs: 5000, unhealthyThresholdMs: 60 });
  m.start(); m.onReady();
  client._ready = false; client._wsStatus = 1;
  await new Promise(r => setTimeout(r, 250));
  assert(exitCount <= 1, "最多一次 exit");
  m.stop();
}

// Test 7: 高 ping Ready 不退出
{
  let exitCode = null;
  const client = makeFakeClient({ ready: true, wsStatus: 0, ping: 9999 });
  const m = createGatewayHealthMonitor({ client, notifyFailure: async () => {}, notifyRecovery: async () => {},
    exitFn: c => { exitCode = c; },
    logger: { info:()=>{},error:()=>{},warn:()=>{},debug:()=>{} },
    checkIntervalMs: 30, startupGraceMs: 5000, unhealthyThresholdMs: 200 });
  m.start(); m.onReady();
  await new Promise(r => setTimeout(r, 250));
  assertEqual(exitCode, null, "高 ping Ready 不退出");
  m.stop();
}

// Test 8: ping 无效 Ready 不退出
{
  let exitCode = null;
  const client = makeFakeClient({ ready: true, wsStatus: 0, ping: -1 });
  const m = createGatewayHealthMonitor({ client, notifyFailure: async () => {}, notifyRecovery: async () => {},
    exitFn: c => { exitCode = c; },
    logger: { info:()=>{},error:()=>{},warn:()=>{},debug:()=>{} },
    checkIntervalMs: 30, startupGraceMs: 5000, unhealthyThresholdMs: 200 });
  m.start(); m.onReady();
  await new Promise(r => setTimeout(r, 150));
  assertEqual(exitCode, null, "ping=-1 Ready 不退出");
  m.stop();
}

// Test 9: stop() 后不再检查
{
  let exitCode = null;
  const client = makeFakeClient({ ready: true, wsStatus: 0, ping: 48 });
  const m = createGatewayHealthMonitor({ client, notifyFailure: async () => {}, notifyRecovery: async () => {},
    exitFn: c => { exitCode = c; },
    logger: { info:()=>{},error:()=>{},warn:()=>{},debug:()=>{} },
    checkIntervalMs: 30, startupGraceMs: 5000, unhealthyThresholdMs: 100 });
  m.start(); m.onReady(); m.stop();
  client._ready = false;
  await new Promise(r => setTimeout(r, 200));
  assertEqual(exitCode, null, "stop 后不触发");
  assert(m.getStatus().stopped, "stopped=true");
}

// Test 10: 多次 start 幂等
{
  const client = makeFakeClient({ ready: true, wsStatus: 0, ping: 48 });
  const m = createGatewayHealthMonitor({ client, notifyFailure: async () => {}, notifyRecovery: async () => {},
    exitFn: () => {},
    logger: { info:()=>{},error:()=>{},warn:()=>{},debug:()=>{} },
    checkIntervalMs: 30, startupGraceMs: 5000, unhealthyThresholdMs: 5000 });
  m.start(); m.start(); m.start();
  assert(m.getStatus().started, "多次 start 幂等");
  m.stop();
}

// Test 11: 恢复后清零
{
  let exitCode = null;
  const client = makeFakeClient({ ready: true, wsStatus: 0, ping: 48 });
  const m = createGatewayHealthMonitor({ client, notifyFailure: async () => {}, notifyRecovery: async () => {},
    exitFn: c => { exitCode = c; },
    logger: { info:()=>{},error:()=>{},warn:()=>{},debug:()=>{} },
    checkIntervalMs: 30, startupGraceMs: 5000, unhealthyThresholdMs: 5000 });
  m.start(); m.onReady();
  client._ready = false; client._wsStatus = 1;
  await new Promise(r => setTimeout(r, 150));
  assert(m.getStatus().unhealthySince !== null, "断线记录 unhealthySince");
  client._ready = true; client._wsStatus = 0;
  await new Promise(r => setTimeout(r, 150));
  assertEqual(m.getStatus().unhealthySince, null, "恢复后清零");
  m.stop();
}

// ===== Test 12: startup timeout 告警写盘失败 → exit 78 =====
{
  let exitCode = null;
  const client = makeFakeClient({ ready: false, wsStatus: 1, ping: null });
  const m = createGatewayHealthMonitor({ client,
    notifyFailure: async () => { throw new Error("disk full"); },
    notifyRecovery: async () => {},
    exitFn: c => { exitCode = c; },
    logger: { info:()=>{},error:()=>{},warn:()=>{},debug:()=>{} },
    checkIntervalMs: 30, startupGraceMs: 80, unhealthyThresholdMs: 200,
    alertPersistenceFailureExitCode: 78,
  });
  m.start();
  await new Promise(r => setTimeout(r, 200));
  assertEqual(exitCode, 78, "startup timeout 告警持久化失败 → exit 78");
  m.stop();
}

// ===== Test 13: unhealthy 告警写盘失败 → exit 78 =====
{
  let exitCode = null;
  const client = makeFakeClient({ ready: true, wsStatus: 0, ping: 48 });
  const failures = [];
  const m = createGatewayHealthMonitor({ client,
    notifyFailure: async (t, msg) => { failures.push(t); throw new Error("disk full"); },
    notifyRecovery: async () => {},
    exitFn: c => { exitCode = c; },
    logger: { info:()=>{},error:()=>{},warn:()=>{},debug:()=>{} },
    checkIntervalMs: 30, startupGraceMs: 5000, unhealthyThresholdMs: 60,
    alertPersistenceFailureExitCode: 78,
  });
  m.start(); m.onReady();
  client._ready = false; client._wsStatus = 1;
  await new Promise(r => setTimeout(r, 200));
  assertEqual(exitCode, 78, "unhealthy 告警持久化失败 → exit 78");
  m.stop();
}

// ===== Test 14: Recovery 写盘失败 → exit 78 =====
{
  let exitCode = null;
  const client = makeFakeClient({ ready: true, wsStatus: 0, ping: 48 });
  let failureCreated = false;
  const m = createGatewayHealthMonitor({ client,
    notifyFailure: async (t, msg) => { failureCreated = true; },
    notifyRecovery: async () => { throw new Error("recovery write failed"); },
    exitFn: c => { exitCode = c; },
    logger: { info:()=>{},error:()=>{},warn:()=>{},debug:()=>{} },
    checkIntervalMs: 30, startupGraceMs: 5000, unhealthyThresholdMs: 50,
    alertPersistenceFailureExitCode: 78,
  });
  m.start(); m.onReady();

  // 先触发 failure
  client._ready = false; client._wsStatus = 1;
  await new Promise(r => setTimeout(r, 120));

  // 恢复
  client._ready = true; client._wsStatus = 0;
  await new Promise(r => setTimeout(r, 150));

  assert(failureCreated, "failure 已创建");
  assertEqual(exitCode, 78, "Recovery 持久化失败 → exit 78");
  m.stop();
}

// ===== Test 15: Recovery resolve → 只调用一次, failure 状态清除 =====
{
  let recoveryCallCount = 0;
  let failureCreated = false;
  const callOrder = [];
  const client = makeFakeClient({ ready: true, wsStatus: 0, ping: 48 });
  const m = createGatewayHealthMonitor({ client,
    notifyFailure: async (t, msg) => { failureCreated = true; },
    notifyRecovery: async () => { recoveryCallCount++; },
    exitFn: () => { callOrder.push("exit"); },
    logger: { info:()=>{},error:()=>{},warn:()=>{},debug:()=>{} },
    checkIntervalMs: 30, startupGraceMs: 5000, unhealthyThresholdMs: 50,
  });
  m.start(); m.onReady();

  // unhealthy → exit(1) after threshold
  client._ready = false; client._wsStatus = 1;
  await new Promise(r => setTimeout(r, 120));

  // healthy → recovery fires
  client._ready = true; client._wsStatus = 0;
  await new Promise(r => setTimeout(r, 150));

  assert(failureCreated, "failure created");
  assertEqual(recoveryCallCount, 1, "recovery called exactly once");
  // unhealthy exit(1) fires, but recovery succeeds (no additional exit)
  assert(callOrder.filter(x => x === "exit").length === 1, "exactly 1 exit call (from unhealthy)");
  m.stop();
}

console.log(`\n[gatewayHealthMonitor.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);

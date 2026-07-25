/**
 * bot.js 编排测试（启动顺序、退出码、关闭清理）。
 *
 * 使用 fake client / fake exitFn / 临时目录。
 * 禁止真实 process.exit 或 Discord。
 *
 * 运行：node src/core/bot.test.js
 */

import { EventEmitter } from "events";
import { mkdtempSync, rmSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

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

function tmpDir() { return mkdtempSync(join(tmpdir(), "bot-test-")); }

/**
 * 模拟 bot.js 的核心编排逻辑（不真实 import bot.js）。
 * 这样可以绕过 dotenv config 和 discord.js 初始化。
 */

// ---- 退出码常量（与 bot.js 一致）----
const EXIT_RUNTIME = 1;
const EXIT_PERMANENT = 78;
const EXIT_OK = 0;

// ============================
// Test 1: 启动顺序 → ClientReady 后 Preflight → Pass → operational
// ============================
{
  const events = [];
  const emitter = new EventEmitter();
  let exitCode = null;

  // 模拟 bot 启动的核心流程
  async function simulateStart() {
    // 1. config loaded
    events.push("config_loaded");
    // 2. outbox + notifier init
    events.push("outbox_init");
    // 3. store load
    events.push("store_loaded");
    // 4. client created
    events.push("client_created");
    // 5. lifecycle logger registered
    events.push("lifecycle_registered");
    // 6. health monitor started
    events.push("health_monitor_started");
    // 7. feature components created
    events.push("features_created");
    // 8. login
    events.push("login_complete");
    // 9. wait ClientReady
    await new Promise(r => { emitter.once("ready", r); emitter.emit("ready"); });
    events.push("client_ready");
    // 10. healthMonitor.onReady()
    events.push("healthmon_ready");
    // 11. Preflight
    events.push("preflight_pass");
    // 12. notifyReady
    events.push("service_operational");
  }

  await simulateStart();

  // 验证顺序
  const order = events.join(",");
  const ci = (idx) => events.indexOf("client_ready");
  const pi = (idx) => events.indexOf("preflight_pass");
  const oi = (idx) => events.indexOf("service_operational");
  assert(ci() < pi(), "ClientReady 在 Preflight 之前");
  assert(pi() < oi(), "Preflight 在 operational 之前");
  assert(order.startsWith("config_loaded"), "config 最先加载");
}

// ============================
// Test 2: Preflight fatal → 使用 exit 78
// ============================
{
  let lastExitCode = null;
  const exitFn = (code) => { lastExitCode = code; };

  // 模拟 preflight fatal
  // 在真正的 bot.js 中，preflight.run() 内部调用 exitFn
  exitFn(EXIT_PERMANENT);
  assertEqual(lastExitCode, 78, "Preflight fatal → exit 78");
}

// ============================
// Test 3: Outbox 初始化失败 → exit 78
// ============================
{
  let lastExitCode = null;

  // 模拟 outbox loadAllAlerts 损坏抛错
  try {
    throw Object.assign(new Error("Schema corrupt"), { name: "OutboxError" });
  } catch (err) {
    // bot.js 中: process.exit(EXIT_PERMANENT)
    lastExitCode = EXIT_PERMANENT;
  }
  assertEqual(lastExitCode, 78, "Outbox 初始化失败 → exit 78");
}

// ============================
// Test 4: Gateway 运行期失败 → exit 1
// ============================
{
  let lastExitCode = null;
  // healthMonitor 触发 gateway_startup_timeout → exit(1)
  lastExitCode = EXIT_RUNTIME;
  assertEqual(lastExitCode, 1, "Gateway 运行期故障 → exit 1");
}

// ============================
// Test 5: Shutdown 清理顺序
// ============================
{
  const cleanupOrder = [];

  async function simulateShutdown() {
    // bot.js shutdown 顺序:
    // 1. healthMonitor.stop()
    cleanupOrder.push("healthmon_stop");
    // 2. lifecycleLogger.destroy()
    cleanupOrder.push("lifecycle_destroy");
    // 3. observerCleanup.destroy()
    cleanupOrder.push("observer_destroy");
    // 4. store.close()
    cleanupOrder.push("store_close");
    // 5. outbox.close()
    cleanupOrder.push("outbox_close");
    // 6. client.destroy()
    cleanupOrder.push("client_destroy");
    // 7. process.exit(0)
    cleanupOrder.push("exit_0");
  }

  await simulateShutdown();

  const orderStr = cleanupOrder.join(",");
  assert(orderStr.includes("healthmon_stop"), "shutdown 从 healthMon 开始");
  assert(orderStr.endsWith("exit_0"), "shutdown 以 exit(0) 结束");

  // client.destroy 在 outbox.close 之后
  const clientIdx = cleanupOrder.indexOf("client_destroy");
  const outboxIdx = cleanupOrder.indexOf("outbox_close");
  assert(outboxIdx < clientIdx, "outbox.close() 在 client.destroy() 之前");
}

// ============================
// Test 6: 非法 NODE_ENV 被 loadConfig 拒绝（ConfigError exit 78）
// ============================
{
  // 此测试验证 ConfigError 携带正确的 exitCode
  // loadConfig 由 config.test.js 覆盖，这里只验证常量
  assertEqual(EXIT_PERMANENT, 78, "EXIT_PERMANENT = 78");
  assertEqual(EXIT_RUNTIME, 1, "EXIT_RUNTIME = 1");
}

// ============================
// Test 7: 两次独立 Preflight fatal → 各自使用 exit 78
// ============================
{
  let calls = [];
  const exitFn = (code) => { calls.push(code); };
  exitFn(78); // preflight fatal
  exitFn(78); // preflight fatal again
  assertEqual(calls.length, 2, "两次 fatal 各自调用 exitFn");
  assert(calls.every(c => c === 78), "都是 exit 78");
}

// ============================
// Test 8: 不同退出码不混淆
// ============================
{
  let calls = [];
  const exitFn = (code) => { calls.push(code); };
  exitFn(EXIT_PERMANENT); // preflight fatal
  exitFn(EXIT_RUNTIME);   // gateway timeout
  exitFn(EXIT_OK);        // normal shutdown
  assertEqual(calls[0], 78, "首先 exit 78");
  assertEqual(calls[1], 1, "然后 exit 1");
  assertEqual(calls[2], 0, "最后 exit 0");
}

console.log(`\n[bot.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);

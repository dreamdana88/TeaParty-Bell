/**
 * productionAlertNotifier.js 自动测试。
 *
 * 运行：node src/alerts/productionAlertNotifier.test.js
 */

import { createProductionAlertNotifier } from "./productionAlertNotifier.js";
import { mkdtempSync, rmSync } from "fs";
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

function assertIncludes(haystack, needle, label) {
  if (haystack.includes(needle)) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label} — "${haystack}" does not include "${needle}"`); }
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

function tmpDir() {
  return mkdtempSync(join(tmpdir(), "notifier-test-"));
}

// ---- 创建 fake outbox ----
function makeFakeOutbox() {
  const alerts = [];
  return {
    alerts,
    loadAllAlerts() {
      return [...alerts];
    },
    writeAlert(alert) {
      alerts.push({ version: 1, ...alert });
      return Promise.resolve();
    },
    updateAlert(alertId, patch) {
      const a = alerts.find((x) => x.id === alertId);
      if (a) Object.assign(a, patch, { updatedAt: Date.now() });
      return Promise.resolve();
    },
    markResolved(alertId) {
      const a = alerts.find((x) => x.id === alertId);
      if (a) Object.assign(a, { status: "resolved", recoveryAt: Date.now() });
      return Promise.resolve();
    },
  };
}

// ============================
// notifyFailure 单次
// ============================

{
  const dir = tmpDir();
  const outbox = makeFakeOutbox();
  const logger = makeMockLogger();
  const notifier = createProductionAlertNotifier({ outbox, logger });
  await notifier.initialize();

  const alert = await notifier.notifyFailure("gateway_unhealthy", "Gateway unhealthy", {
    wsStatus: "1",
    ping: 48,
  });

  assert(alert !== null, "notifyFailure 返回告警对象");
  assertEqual(alert.type, "gateway_unhealthy", "告警类型正确");
  assertEqual(alert.severity, "fatal", "严重级别为 fatal");
  assertEqual(outbox.alerts.length, 1, "outbox 中有一条告警");
  assert(notifier.hasOpenFatalIncident(), "hasOpenFatalIncident 为 true");

  await notifier.notifyFailure("gateway_unhealthy", "Should not create duplicate");
  assertEqual(outbox.alerts.length, 1, "同一轮故障不创建重复告警");

  rmSync(dir, { recursive: true, force: true });
}

// ============================
// 恢复：只对已有 failure 发送
// ============================

{
  const dir = tmpDir();
  const outbox = makeFakeOutbox();
  const logger = makeMockLogger();
  const notifier = createProductionAlertNotifier({ outbox, logger });
  await notifier.initialize();

  // 无 failure 时 recovery 不创建
  const recBefore = await notifier.notifyRecovery("gateway_unhealthy", "Recovered");
  assert(recBefore === null, "无 failure 时不创建 recovery");

  // 创建 failure
  await notifier.notifyFailure("gateway_unhealthy", "Failed");

  // 恢复
  const rec = await notifier.notifyRecovery("gateway_unhealthy", "Recovered");
  assert(rec !== null, "recovery alert 已创建");
  assert(rec.type === "gateway_recovered", "recovery alert type 正确");
  assert(!notifier.hasOpenFatalIncident(), "恢复后 hasOpenFatalIncident 为 false");
  assertEqual(outbox.alerts.length, 2, "outbox 中有 failure + recovery");

  // 再次恢复不重复
  const rec2 = await notifier.notifyRecovery("gateway_unhealthy", "Second");
  assert(rec2 === null, "再次恢复不创建重复");

  rmSync(dir, { recursive: true, force: true });
}

// ============================
// 独立故障可再次创建
// ============================

{
  const dir = tmpDir();
  const outbox = makeFakeOutbox();
  const logger = makeMockLogger();
  const notifier = createProductionAlertNotifier({ outbox, logger });
  await notifier.initialize();

  await notifier.notifyFailure("gateway_unhealthy", "Failed");
  assertEqual(outbox.alerts.length, 1, "第一条告警");

  // 恢复 gateway_unhealthy
  await notifier.notifyRecovery("gateway_unhealthy", "Recovered");
  assertEqual(outbox.alerts.length, 2, "recovery");

  // 新的独立故障
  await notifier.notifyFailure("gateway_startup_timeout", "Timeout");
  assertEqual(outbox.alerts.length, 3, "新故障创建独立告警");

  rmSync(dir, { recursive: true, force: true });
}

// ============================
// notifyWarning
// ============================

{
  const dir = tmpDir();
  const outbox = makeFakeOutbox();
  const logger = makeMockLogger();
  const notifier = createProductionAlertNotifier({ outbox, logger });
  await notifier.initialize();

  const w = await notifier.notifyWarning("application_emoji_unavailable", "Emoji missing");
  assert(w !== null, "notifyWarning 返回告警");
  assertEqual(w.severity, "warning", "警告 severity 为 warning");
  assertEqual(outbox.alerts.length, 1, "警告写入 outbox");

  // 警告不进入 open incidents
  assert(!notifier.hasOpenFatalIncident(), "warning 不触发 hasOpenFatalIncident");

  rmSync(dir, { recursive: true, force: true });
}

// ============================
// 跨重启恢复识别
// ============================

{
  const dir = tmpDir();
  const outbox = makeFakeOutbox();
  // 预置一条 pending fatal 告警（模拟重启前残留）
  outbox.alerts.push({
    version: 1,
    id: "gateway_unhealthy",
    service: "TeaParty-Bell",
    type: "gateway_unhealthy",
    severity: "fatal",
    status: "pending",
    startedAt: Date.now() - 600000,
    occurredAt: Date.now() - 300000,
    durationMs: 300000,
    guildId: null,
    wsStatus: "1",
    ping: null,
    message: "Previous failure",
    details: {},
  });

  const logger = makeMockLogger();
  const notifier = createProductionAlertNotifier({ outbox, logger });
  await notifier.initialize();

  assert(notifier.hasOpenFatalIncident(), "跨重启识别未解决告警");

  // 不应重复创建
  const dup = await notifier.notifyFailure("gateway_unhealthy", "Should be dedup");
  assert(dup === null, "跨重启同类型告警不重复");

  // 恢复
  const rec = await notifier.notifyRecovery("gateway_unhealthy", "Recovered after restart");
  assert(rec !== null, "跨重启恢复可发送");
  assert(!notifier.hasOpenFatalIncident(), "恢复后清空");

  rmSync(dir, { recursive: true, force: true });
}

// ============================
// notifyReadyAfterRestart
// ============================

{
  const dir = tmpDir();
  const outbox = makeFakeOutbox();
  const logger = makeMockLogger();
  const notifier = createProductionAlertNotifier({ outbox, logger });
  await notifier.initialize();

  // 无故障时发送 ready
  await notifier.notifyReadyAfterRestart();
  assertEqual(outbox.alerts.length, 1, "ready 通知已写入");
  const readyAlert = outbox.alerts[0];
  assert(readyAlert.id.includes("service_ready_after_restart"), "ready alert id 正确");

  rmSync(dir, { recursive: true, force: true });
}

// ============================
// notifyReadyAfterRestart with open issues
// ============================

{
  const dir = tmpDir();
  const outbox = makeFakeOutbox();
  outbox.alerts.push({
    version: 1,
    id: "gateway_unhealthy",
    service: "TeaParty-Bell",
    type: "gateway_unhealthy",
    severity: "fatal",
    status: "pending",
    startedAt: Date.now() - 600000,
    occurredAt: Date.now() - 300000,
    durationMs: 300000,
    guildId: null,
    wsStatus: "1",
    ping: null,
    message: "Previous",
    details: {},
  });

  const logger = makeMockLogger();
  const notifier = createProductionAlertNotifier({ outbox, logger });
  await notifier.initialize();

  await notifier.notifyReadyAfterRestart();
  // 应该发送了 recovery（因为 Gateway 现在是 Ready 的）
  const hasRecovery = outbox.alerts.some((a) => a.type === "gateway_recovered");
  assert(hasRecovery, "有未解决故障时 ready 改为发送 recovery");

  assert(!notifier.hasOpenFatalIncident(), "ready 后故障已关闭");

  rmSync(dir, { recursive: true, force: true });
}

// ============================
// notifier 不包含敏感信息
// ============================

{
  const dir = tmpDir();
  const outbox = makeFakeOutbox();
  const logger = makeMockLogger();
  const notifier = createProductionAlertNotifier({ outbox, logger });
  await notifier.initialize();

  const alert = await notifier.notifyFailure("gateway_unhealthy", "Test", {});
  const json = JSON.stringify(alert);
  assert(!json.includes("token"), "告警中不含 token");
  assert(!json.includes("apiKey"), "告警中不含 apiKey");

  rmSync(dir, { recursive: true, force: true });
}

// ============================
// 结果
// ============================

console.log(`\n[productionAlertNotifier.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);

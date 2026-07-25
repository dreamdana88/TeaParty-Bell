/**
 * productionAlertNotifier.js 自动测试（v2 schema）。
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

function makeMockLogger() {
  return { calls: [], info:()=>{}, error:()=>{}, warn:()=>{}, debug:()=>{} };
}

function tmpDir() { return mkdtempSync(join(tmpdir(), "notifier-test-")); }

function makeFakeOutbox() {
  const alerts = [];
  return {
    alerts,
    loadAllAlerts() { return [...alerts]; },
    findAlert(id, list) { return list.find(a => a.id === id); },
    findOpenIncidents(list) { return list.filter(a => a.incidentStatus === "open"); },
    findPendingDelivery(list) { return list.filter(a => a.deliveryStatus === "pending" || a.deliveryStatus === "delivery_failed"); },
    writeAlert(alert) {
      if (alerts.some(a => a.id === alert.id)) throw new Error("file_exists");
      alerts.push({ version: 2, ...alert });
      return Promise.resolve();
    },
    updateAlert(alertId, patch) {
      const a = alerts.find(x => x.id === alertId);
      if (!a) { const e = new Error("Not found"); e.code = "file_not_found"; throw e; }
      Object.assign(a, patch, { updatedAt: Date.now() });
      return Promise.resolve();
    },
    markResolved(alertId) {
      const a = alerts.find(x => x.id === alertId);
      if (a) Object.assign(a, { incidentStatus: "resolved", recoveryAt: Date.now() });
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
  const notifier = createProductionAlertNotifier({ outbox, logger: makeMockLogger() });
  await notifier.initialize();

  const alert = await notifier.notifyFailure("gateway_unhealthy", "Gateway unhealthy", { wsStatus: "1", ping: 48 });
  assert(alert !== null, "notifyFailure 返回告警");
  assertEqual(alert.event, "failure", "event=failure");
  assertEqual(alert.severity, "fatal", "severity=fatal");
  assertEqual(alert.deliveryStatus, "pending", "deliveryStatus=pending");
  assertEqual(alert.incidentStatus, "open", "incidentStatus=open");
  assertEqual(outbox.alerts.length, 1, "outbox 一条告警");
  assert(notifier.hasOpenFatalIncident(), "hasOpenFatalIncident=true");

  // 重复调用 → null（不创建新文件）
  const dup = await notifier.notifyFailure("gateway_unhealthy", "Should dedup");
  assertEqual(dup, null, "同 dedupeKey 重复调用返回 null");
  assertEqual(outbox.alerts.length, 1, "重复调用不创建新文件");

  rmSync(dir, { recursive: true, force: true });
}

// ============================
// 恢复只对 open failure 创建
// ============================
{
  const dir = tmpDir();
  const outbox = makeFakeOutbox();
  const notifier = createProductionAlertNotifier({ outbox, logger: makeMockLogger() });
  await notifier.initialize();

  // 无 failure → recovery 不创建
  const before = await notifier.notifyRecovery("gateway_unhealthy", "No failure");
  assertEqual(before, null, "无 failure 时不创建 recovery");

  // 创建 failure
  await notifier.notifyFailure("gateway_unhealthy", "Failed");

  // 恢复
  const rec = await notifier.notifyRecovery("gateway_unhealthy", "Recovered");
  assert(rec !== null, "recovery 已创建");
  assertEqual(rec.event, "recovery", "event=recovery");
  assertEqual(rec.severity, "info", "recovery severity=info（非 fatal）");
  assertEqual(rec.deliveryStatus, "pending", "recovery deliveryStatus=pending");
  assert(!notifier.hasOpenFatalIncident(), "恢复后 hasOpenFatalIncident=false");
  assertEqual(outbox.alerts.length, 2, "failure + recovery");

  // 再次恢复不重复
  const dup = await notifier.notifyRecovery("gateway_unhealthy", "Second");
  assertEqual(dup, null, "再恢复不重复");

  rmSync(dir, { recursive: true, force: true });
}

// ============================
// 第二轮同类型 incident 保留独立历史
// ============================
{
  const dir = tmpDir();
  const outbox = makeFakeOutbox();
  const notifier = createProductionAlertNotifier({ outbox, logger: makeMockLogger() });
  await notifier.initialize();

  await notifier.notifyFailure("gateway_unhealthy", "Round 1");
  const round1Id = outbox.alerts[0].id;
  await notifier.notifyRecovery("gateway_unhealthy", "Recovered");

  // 第二轮
  await notifier.notifyFailure("gateway_unhealthy", "Round 2");
  assertEqual(outbox.alerts.length, 3, "第二轮创建新文件");
  const round2Alert = outbox.alerts.find(a => a.event === "failure" && a.id !== round1Id);
  assert(round2Alert !== undefined, "第二轮文件 ID 不同于第一轮");
  assertEqual(round2Alert.incidentStatus, "open", "第二轮 incidentStatus=open");

  rmSync(dir, { recursive: true, force: true });
}

// ============================
// warning 不进入 open incidents
// ============================
{
  const dir = tmpDir();
  const outbox = makeFakeOutbox();
  const notifier = createProductionAlertNotifier({ outbox, logger: makeMockLogger() });
  await notifier.initialize();

  const w = await notifier.notifyWarning("application_emoji_unavailable", "Emoji missing");
  assert(w !== null, "warning 已创建");
  assertEqual(w.event, "warning", "event=warning");
  assertEqual(w.severity, "warning", "severity=warning");
  assert(!notifier.hasOpenFatalIncident(), "warning 不触发 hasOpenFatalIncident");

  rmSync(dir, { recursive: true, force: true });
}

// ============================
// 跨重启：delivered + open 的 failure 仍为 open
// ============================
{
  const dir = tmpDir();
  const outbox = makeFakeOutbox();
  // 预置一条 delivered + open 的 fatal failure
  outbox.alerts.push({
    version: 2,
    id: "gw_unhealthy_1730000000000_abc123",
    incidentKey: "gateway_unhealthy",
    dedupeKey: "gateway_unhealthy",
    event: "failure",
    service: "TeaParty-Bell",
    type: "gateway_unhealthy",
    severity: "fatal",
    deliveryStatus: "delivered",
    incidentStatus: "open",
    startedAt: Date.now() - 600000,
    occurredAt: Date.now() - 300000,
    durationMs: 300000,
    guildId: null,
    wsStatus: "1",
    ping: null,
    message: "Previous failure",
    details: {},
  });

  const notifier = createProductionAlertNotifier({ outbox, logger: makeMockLogger() });
  await notifier.initialize();

  assert(notifier.hasOpenFatalIncident(), "跨重启 delivered+open 仍识别为 open");
  const dup = await notifier.notifyFailure("gateway_unhealthy", "Should dedup");
  assertEqual(dup, null, "跨重启不重复创建");

  // 恢复
  await notifier.notifyRecovery("gateway_unhealthy", "Recovered after restart");
  assert(!notifier.hasOpenFatalIncident(), "恢复后清空");

  rmSync(dir, { recursive: true, force: true });
}

// ============================
// notifyReadyAfterRestart
// ============================
{
  const dir = tmpDir();
  const outbox = makeFakeOutbox();
  const notifier = createProductionAlertNotifier({ outbox, logger: makeMockLogger() });
  await notifier.initialize();

  await notifier.notifyReadyAfterRestart();
  const ready = outbox.alerts.find(a => a.event === "ready");
  assert(ready !== undefined, "service_operational 已创建");
  assertEqual(ready.event, "ready", "event=ready");
  assertEqual(ready.severity, "info", "severity=info");
  assertEqual(ready.deliveryStatus, "pending", "deliveryStatus=pending（待投递）");

  rmSync(dir, { recursive: true, force: true });
}

// ============================
// notifyReadyAfterRestart with open incidents → recovery
// ============================
{
  const dir = tmpDir();
  const outbox = makeFakeOutbox();
  outbox.alerts.push({
    version: 2,
    id: "old_failure_1",
    incidentKey: "gateway_unhealthy",
    dedupeKey: "gateway_unhealthy",
    event: "failure",
    service: "TeaParty-Bell",
    type: "gateway_unhealthy",
    severity: "fatal",
    deliveryStatus: "pending",
    incidentStatus: "open",
    startedAt: Date.now() - 600000,
    occurredAt: Date.now() - 300000,
    durationMs: 300000,
    guildId: null, wsStatus: "1", ping: null,
    message: "Previous", details: {},
  });

  const notifier = createProductionAlertNotifier({ outbox, logger: makeMockLogger() });
  await notifier.initialize();

  await notifier.notifyReadyAfterRestart();
  const recoveryAlerts = outbox.alerts.filter(a => a.event === "recovery");
  assert(recoveryAlerts.length >= 1, "有未解决 failure 时发送 recovery");
  assert(!notifier.hasOpenFatalIncident(), "recovery 后清空 open incidents");

  rmSync(dir, { recursive: true, force: true });
}

// ============================
// 不包含敏感信息
// ============================
{
  const dir = tmpDir();
  const outbox = makeFakeOutbox();
  const notifier = createProductionAlertNotifier({ outbox, logger: makeMockLogger() });
  await notifier.initialize();
  const alert = await notifier.notifyFailure("gateway_unhealthy", "Test");
  const json = JSON.stringify(alert);
  assert(!json.includes("token"), "不含 token");
  assert(!json.includes("apiKey"), "不含 apiKey");
  rmSync(dir, { recursive: true, force: true });
}

// ============================
// 写入失败向上抛出
// ============================
{
  const dir = tmpDir();
  const outbox = {
    loadAllAlerts() { return []; },
    writeAlert() { throw new Error("disk full"); },
  };
  const notifier = createProductionAlertNotifier({ outbox, logger: makeMockLogger() });
  await notifier.initialize();

  try {
    await notifier.notifyFailure("test", "should throw");
    failed++; console.error("  FAIL: 写盘失败应抛错");
  } catch {
    passed++; console.log("  PASS: notifyFailure 写盘失败向上抛错");
  }

  rmSync(dir, { recursive: true, force: true });
}

// ============================
console.log(`\n[productionAlertNotifier.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);

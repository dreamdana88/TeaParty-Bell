/**
 * productionAlertNotifier.js 自动测试（v2 schema + recovery idempotency）。
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

function makeMockLogger() { return { calls:[], info:()=>{}, error:()=>{}, warn:()=>{}, debug:()=>{} }; }
function tmpDir() { return mkdtempSync(join(tmpdir(), "notifier-test-")); }

function makeFakeOutbox() {
  const alerts = [];
  return {
    alerts,
    loadAllAlerts() { return [...alerts]; },
    findAlert(id, list) { return list.find(a => a.id === id); },
    findOpenIncidents(list) { return list.filter(a => a.incidentStatus === "open"); },
    writeAlert(alert) {
      if (alerts.some(a => a.id === alert.id)) { const e = new Error("file_exists"); e.name="OutboxError"; e.code="file_exists"; throw e; }
      alerts.push(alert);
      return Promise.resolve();
    },
    updateAlert(alertId, patch) {
      const a = alerts.find(x => x.id === alertId);
      if (!a) { const e = new Error("Not found"); e.name="OutboxError"; e.code="file_not_found"; throw e; }
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
// notifyFailure
// ============================
{
  const dir = tmpDir();
  const outbox = makeFakeOutbox();
  const notifier = createProductionAlertNotifier({ outbox, logger: makeMockLogger() });
  await notifier.initialize();
  const alert = await notifier.notifyFailure("gateway_unhealthy", "Gw unhealthy", { wsStatus:"1", ping:48 });
  assert(alert !== null, "notifyFailure 返回告警");
  assertEqual(alert.event, "failure", "event=failure");
  assertEqual(alert.deliveryStatus, "pending", "deliveryStatus=pending");
  assertEqual(alert.incidentStatus, "open", "incidentStatus=open");
  assertEqual(outbox.alerts.length, 1, "outbox 一条");
  assert(notifier.hasOpenFatalIncident(), "hasOpenFatalIncident=true");
  // 重复→null
  const dup = await notifier.notifyFailure("gateway_unhealthy", "dup");
  assertEqual(dup, null, "重复返回 null");
  assertEqual(outbox.alerts.length, 1, "不创建新文件");
  rmSync(dir, { recursive: true, force: true });
}

// ============================
// Recovery（一次性） + recovery idempotency
// ============================
{
  const dir = tmpDir();
  const outbox = makeFakeOutbox();
  const notifier = createProductionAlertNotifier({ outbox, logger: makeMockLogger() });
  await notifier.initialize();

  // 无 failure → recovery null
  assertEqual(await notifier.notifyRecovery("gw", "x"), null, "无 failure 无 recovery");

  // 创建 failure
  const f = await notifier.notifyFailure("gateway_unhealthy", "Failed");
  const origId = f.id;

  // 恢复
  const rec = await notifier.notifyRecovery("gateway_unhealthy", "Recovered");
  assert(rec !== null, "recovery created");
  assertEqual(rec.recoveryAlertId, `${origId}_recovery`, "recoveryAlertId 基于 originalAlertId");
  assertEqual(outbox.alerts.length, 2, "failure + recovery");
  assert(!notifier.hasOpenFatalIncident(), "恢复后 hasOpenFatalIncident=false");

  // 再次恢复 → null
  assertEqual(await notifier.notifyRecovery("gateway_unhealthy", "x"), null, "再恢复 null");

  rmSync(dir, { recursive: true, force: true });
}

// ============================
// Recovery 幂等：文件已存在 + 匹配 → 不创建第二份
// ============================
{
  const dir = tmpDir();
  const outbox = makeFakeOutbox();
  const notifier = createProductionAlertNotifier({ outbox, logger: makeMockLogger() });
  await notifier.initialize();

  const f = await notifier.notifyFailure("gateway_unhealthy", "Failed");
  const origId = f.id;
  const recoveryId = `${origId}_recovery`;

  // 预先写入 recovery 文件（模拟上次 crash 前已写入 recovery）
  outbox.alerts.push({
    id: recoveryId,
    incidentKey: "gateway_unhealthy_recovery",
    dedupeKey: "gateway_unhealthy_recovery",
    event: "recovery",
    service: "TeaParty-Bell",
    type: "gateway_recovered",
    severity: "info",
    deliveryStatus: "pending",
    incidentStatus: "resolved",
    startedAt: Date.now(),
    occurredAt: Date.now(),
    updatedAt: Date.now(),
    recoveryAt: null,
    durationMs: 1000,
    guildId: null, wsStatus: null, ping: null,
    message: "old recovery",
    details: { originalAlertId: origId },
  });

  // 再次调用 recovery → 幂等（不创建第二份）
  const rec = await notifier.notifyRecovery("gateway_unhealthy", "Recovered");
  assert(rec !== null, "幂等 recovery 成功返回");
  assert(!notifier.hasOpenFatalIncident(), "恢复后 closed");
  const recoveryFiles = outbox.alerts.filter(a => a.id === recoveryId);
  assertEqual(recoveryFiles.length, 1, "只有一份 recovery 文件（无重复）");
  assert(outbox.alerts.find(a => a.id === origId).incidentStatus === "resolved", "original 已 resolved");

  rmSync(dir, { recursive: true, force: true });
}

// ============================
// Recovery 幂等：文件已存在但 originalAlertId 不匹配 → fail closed
// ============================
{
  const dir = tmpDir();
  const outbox = makeFakeOutbox();
  const notifier = createProductionAlertNotifier({ outbox, logger: makeMockLogger() });
  await notifier.initialize();

  const f = await notifier.notifyFailure("gateway_unhealthy", "Failed");
  const origId = f.id;
  const recoveryId = `${origId}_recovery`;

  // 预先写入 recovery 但 originalAlertId 不匹配
  outbox.alerts.push({
    id: recoveryId, incidentKey:"x", dedupeKey:"x", event:"recovery", service:"t", type:"t",
    severity:"info", deliveryStatus:"pending", incidentStatus:"resolved",
    startedAt:Date.now(), occurredAt:Date.now(), updatedAt:Date.now(),
    recoveryAt:null, durationMs:0, guildId:null, wsStatus:null, ping:null,
    message:"bad", details:{ originalAlertId:"wrong_id" },
  });

  try {
    await notifier.notifyRecovery("gateway_unhealthy", "should fail");
    failed++; console.error("  FAIL: originalAlertId 不匹配应抛错");
  } catch (err) {
    assert(err.name === "OutboxError" || err.code === "schema_invalid", "originalAlertId 不匹配 → OutboxError");
    passed++; console.log("  PASS: originalAlertId 不匹配 → fail closed");
    assert(notifier.hasOpenFatalIncident(), "不匹配时 incident 仍 open");
  }

  rmSync(dir, { recursive: true, force: true });
}

// ============================
// 第二轮同类型 → 独立文件保留历史
// ============================
{
  const dir = tmpDir();
  const outbox = makeFakeOutbox();
  const notifier = createProductionAlertNotifier({ outbox, logger: makeMockLogger() });
  await notifier.initialize();
  const f1 = await notifier.notifyFailure("gateway_unhealthy", "R1");
  await notifier.notifyRecovery("gateway_unhealthy", "Rec1");
  const f2 = await notifier.notifyFailure("gateway_unhealthy", "R2");
  assert(f2.id !== f1.id, "第二轮 ID 不同");
  assertEqual(outbox.alerts.length, 3, "failure1 + recovery + failure2");
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
  const w = await notifier.notifyWarning("app_emoji", "missing");
  assert(w !== null, "warning created");
  assertEqual(w.severity, "warning", "severity=warning");
  assert(!notifier.hasOpenFatalIncident(), "warning 不进入 open incidents");
  rmSync(dir, { recursive: true, force: true });
}

// ============================
// 跨重启：delivered+open → 仍识别
// ============================
{
  const dir = tmpDir();
  const outbox = makeFakeOutbox();
  const now = Date.now();
  outbox.alerts.push({
    id:"old_f1", incidentKey:"gw", dedupeKey:"gw", event:"failure", service:"t", type:"gw",
    severity:"fatal", deliveryStatus:"delivered", incidentStatus:"open",
    startedAt:now-600000, occurredAt:now-300000, updatedAt:now-300000,
    recoveryAt:null, durationMs:300000, guildId:null, wsStatus:"1", ping:null,
    message:"Old", details:{},
  });
  const notifier = createProductionAlertNotifier({ outbox, logger: makeMockLogger() });
  await notifier.initialize();
  assert(notifier.hasOpenFatalIncident(), "delivered+open → recognized");
  const dup = await notifier.notifyFailure("gw", "dup");
  assertEqual(dup, null, "跨重启不重复");
  rmSync(dir, { recursive: true, force: true });
}

// ============================
// notifyReadyAfterRestart + recovery failed propagation
// ============================
{
  const dir = tmpDir();
  const outbox = makeFakeOutbox();
  const now = Date.now();
  outbox.alerts.push({
    id:"old_f2", incidentKey:"gw", dedupeKey:"gw", event:"failure", service:"t", type:"gw",
    severity:"fatal", deliveryStatus:"pending", incidentStatus:"open",
    startedAt:now-600000, occurredAt:now, updatedAt:now, recoveryAt:null,
    durationMs:600000, guildId:null, wsStatus:"1", ping:null,
    message:"Old", details:{},
  });
  const notifier = createProductionAlertNotifier({ outbox, logger: makeMockLogger() });
  await notifier.initialize();
  const result = await notifier.notifyReadyAfterRestart();
  assert(result.recovered.length >= 1, "recovery sent");
  assert(!notifier.hasOpenFatalIncident(), "resolved after ready");
  rmSync(dir, { recursive: true, force: true });
}

// ============================
// 干净启动 → service_operational
// ============================
{
  const dir = tmpDir();
  const outbox = makeFakeOutbox();
  const notifier = createProductionAlertNotifier({ outbox, logger: makeMockLogger() });
  await notifier.initialize();
  const result = await notifier.notifyReadyAfterRestart();
  assert(result.createdReady, "service_operational created");
  const ready = outbox.alerts.find(a => a.event === "ready");
  assertEqual(ready.severity, "info", "severity=info");
  assertEqual(ready.deliveryStatus, "pending", "deliveryStatus=pending（待投递）");
  rmSync(dir, { recursive: true, force: true });
}

// ============================
// 写盘失败向上抛
// ============================
{
  const outbox = { loadAllAlerts:()=>[], writeAlert:()=>{throw new Error("disk full");} };
  const notifier = createProductionAlertNotifier({ outbox, logger: makeMockLogger() });
  await notifier.initialize();
  try { await notifier.notifyFailure("test","x"); failed++; console.error("  FAIL: 应抛"); }
  catch { passed++; console.log("  PASS: notifyFailure 写盘失败向上抛"); }
}

// ============================
// 不含敏感信息
// ============================
{
  const outbox = makeFakeOutbox();
  const notifier = createProductionAlertNotifier({ outbox, logger: makeMockLogger() });
  await notifier.initialize();
  const a = await notifier.notifyFailure("gw","test");
  const j = JSON.stringify(a);
  assert(!j.includes("token"), "no token"); assert(!j.includes("apiKey"), "no apiKey");
}

console.log(`\n[productionAlertNotifier.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);

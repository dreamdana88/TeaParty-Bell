/**
 * alertOutbox.js 自动测试（v2 schema）。
 *
 * 运行：node src/alerts/alertOutbox.test.js
 */

import { createAlertOutbox, generateAlertId, OutboxError } from "./alertOutbox.js";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, unlinkSync, renameSync, existsSync, readdirSync } from "fs";
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
function assertThrows(fn, label) {
  try { fn(); failed++; console.error(`  FAIL: ${label} — expected throw but none`); }
  catch { passed++; console.log(`  PASS: ${label} (threw as expected)`); }
}

function makeMockLogger() {
  return { calls: [], info:()=>{}, error:()=>{}, warn:()=>{}, debug:()=>{} };
}

function tmpDir() { return mkdtempSync(join(tmpdir(), "alertOutbox-test-")); }

function makeAlert(overrides = {}) {
  const now = Date.now();
  return {
    id: generateAlertId("gateway_unhealthy"),
    incidentKey: "gateway_unhealthy",
    dedupeKey: "gateway_unhealthy",
    event: "failure",
    service: "TeaParty-Bell",
    type: "gateway_unhealthy",
    severity: "fatal",
    deliveryStatus: "pending",
    incidentStatus: "open",
    startedAt: now,
    occurredAt: now,
    updatedAt: now,
    recoveryAt: null,
    durationMs: 0,
    guildId: "123",
    wsStatus: "1",
    ping: 48,
    message: "Test Gateway unhealthy",
    details: {},
    ...overrides,
  };
}

const testDir = tmpDir();
const logger = makeMockLogger();
console.log(`[alertOutbox.test] 临时目录：${testDir}`);

// ======================
// 写入 + 加载
// ======================
{
  const outbox = createAlertOutbox({ alertsDir: testDir, logger });
  const alert = makeAlert();
  await outbox.writeAlert(alert);
  const alerts = outbox.loadAllAlerts();
  assertEqual(alerts.length, 1, "写入一条告警后可加载");
  assertEqual(alerts[0].id, alert.id, "id 正确");
  assertEqual(alerts[0].event, "failure", "event=failure");
  assertEqual(alerts[0].deliveryStatus, "pending", "deliveryStatus=pending");
  assertEqual(alerts[0].incidentStatus, "open", "incidentStatus=open");
  assertEqual(alerts[0].version, 2, "version=2（outbox 注入，无法覆盖）");
  await outbox.close();
}

// ======================
// version 无法被调用方覆盖
// ======================
{
  const outbox = createAlertOutbox({ alertsDir: testDir, logger });
  const alert = makeAlert({ id: generateAlertId("test_version_guard"), version: 999 });
  await outbox.writeAlert(alert);
  const alerts = outbox.loadAllAlerts();
  const written = alerts.find(a => a.id === alert.id);
  assertEqual(written.version, 2, "调用方传入 version=999 被忽略，实际写入 2");
  await outbox.close();
}

// ======================
// 文件覆盖保护
// ======================
{
  const outbox = createAlertOutbox({ alertsDir: testDir, logger });
  const alert = makeAlert();
  await outbox.writeAlert(alert);
  // 重复写入同一 id 应抛出
  try {
    await outbox.writeAlert(alert);
    failed++; console.error("  FAIL: 重复写入应抛出");
  } catch (err) {
    assert(err instanceof OutboxError, "重复写入抛出 OutboxError");
    assertEqual(err.code, "file_exists", "错误码 file_exists");
    passed++; console.log("  PASS: 重复写入抛出 OutboxError(file_exists)");
  }
  await outbox.close();
}

// ======================
// findOpenIncidents
// ======================
{
  const outbox = createAlertOutbox({ alertsDir: testDir, logger });
  const alerts = outbox.loadAllAlerts();
  const open = outbox.findOpenIncidents(alerts);
  assert(open.length >= 1, "findOpenIncidents 至少找到一条 open");

  // resolved 的不会被找到
  const resolvedAlert = makeAlert({
    id: generateAlertId("resolved_test"),
    incidentStatus: "resolved",
    event: "recovery",
    severity: "info",
  });
  await outbox.writeAlert(resolvedAlert);
  const alerts2 = outbox.loadAllAlerts();
  const open2 = outbox.findOpenIncidents(alerts2);
  // resolved 的不在 open 中
  const openIds = open2.map(a => a.id);
  assert(!openIds.includes(resolvedAlert.id), "incidentStatus=resolved 不在 findOpenIncidents 中");
  await outbox.close();
}

// ======================
// findPendingDelivery
// ======================
{
  const outbox = createAlertOutbox({ alertsDir: testDir, logger });
  const pending = makeAlert({ id: generateAlertId("pd1"), deliveryStatus: "pending" });
  const failed = makeAlert({ id: generateAlertId("pd2"), deliveryStatus: "delivery_failed" });
  const delivered = makeAlert({ id: generateAlertId("pd3"), deliveryStatus: "delivered" });
  await outbox.writeAlert(pending);
  await outbox.writeAlert(failed);
  await outbox.writeAlert(delivered);
  const alerts = outbox.loadAllAlerts();
  const pend = outbox.findPendingDelivery(alerts);
  const pendIds = pend.map(a => a.id);
  assert(pendIds.includes(pending.id), "deliveryStatus=pending 在待投递中");
  assert(pendIds.includes(failed.id), "deliveryStatus=delivery_failed 在待投递中");
  assert(!pendIds.includes(delivered.id), "deliveryStatus=delivered 不在待投递中");
  await outbox.close();
}

// ======================
// updateAlert 区分错误类型
// ======================
{
  const outbox = createAlertOutbox({ alertsDir: testDir, logger });

  // 文件不存在 → file_not_found
  try {
    await outbox.updateAlert("nonexistent_123", { deliveryStatus: "delivered" });
    failed++; console.error("  FAIL: updateAlert 不存在应抛错");
  } catch (err) {
    assert(err instanceof OutboxError, "updateAlert 不存在 → OutboxError");
    assertEqual(err.code, "file_not_found", "错误码 file_not_found");
    passed++; console.log("  PASS: updateAlert 文件不存在抛出 OutboxError(file_not_found)");
  }

  await outbox.close();
}

// ======================
// updateAlert JSON 损坏抛错（不是 file_not_found）
// ======================
{
  const dir2 = tmpDir();
  mkdirSync(dir2, { recursive: true });
  writeFileSync(join(dir2, "corrupt.json"), "{{{bad json", "utf-8");
  const outbox2 = createAlertOutbox({ alertsDir: dir2, logger });

  try {
    await outbox2.updateAlert("corrupt", { deliveryStatus: "delivered" });
    failed++; console.error("  FAIL: JSON 损坏的 updateAlert 应抛错");
  } catch (err) {
    assert(err instanceof OutboxError, "JSON 损坏 → OutboxError");
    assertEqual(err.code, "schema_corrupt", "错误码 schema_corrupt（非 file_not_found）");
    passed++; console.log("  PASS: updateAlert JSON 损坏抛出 OutboxError(schema_corrupt)");
  }

  await outbox2.close();
  rmSync(dir2, { recursive: true, force: true });
}

// ======================
// updateAlert 文件存在+正常 → 成功更新
// ======================
{
  const outbox = createAlertOutbox({ alertsDir: testDir, logger });
  const alert = makeAlert();
  await outbox.writeAlert(alert);

  await outbox.updateAlert(alert.id, { deliveryStatus: "delivered" });
  const alerts = outbox.loadAllAlerts();
  const updated = outbox.findAlert(alert.id, alerts);
  assertEqual(updated.deliveryStatus, "delivered", "updateAlert 更新 deliveryStatus 为 delivered");
  assertEqual(updated.incidentStatus, "open", "delivered 后 incidentStatus 仍为 open");
  await outbox.close();
}

// ======================
// markResolved / markDelivered
// ======================
{
  const outbox = createAlertOutbox({ alertsDir: testDir, logger });
  const alert = makeAlert();
  await outbox.writeAlert(alert);
  await outbox.markResolved(alert.id);
  const alerts = outbox.loadAllAlerts();
  const updated = outbox.findAlert(alert.id, alerts);
  assertEqual(updated.incidentStatus, "resolved", "markResolved 设置 incidentStatus=resolved");
  assert(typeof updated.recoveryAt === "number", "记录 recoveryAt");
  await outbox.close();
}

// ======================
// 空文件 → fail closed
// ======================
{
  const dir2 = tmpDir();
  mkdirSync(dir2, { recursive: true });
  writeFileSync(join(dir2, "empty.json"), "", "utf-8");
  const outbox2 = createAlertOutbox({ alertsDir: dir2, logger });
  assertThrows(() => outbox2.loadAllAlerts(), "空文件 loadAllAlerts 抛错");
  await outbox2.close();
  rmSync(dir2, { recursive: true, force: true });
}

// ======================
// 非法 JSON → fail closed
// ======================
{
  const dir2 = tmpDir();
  mkdirSync(dir2, { recursive: true });
  writeFileSync(join(dir2, "broken.json"), "not json", "utf-8");
  const outbox2 = createAlertOutbox({ alertsDir: dir2, logger });
  assertThrows(() => outbox2.loadAllAlerts(), "非法 JSON loadAllAlerts 抛错");
  await outbox2.close();
  rmSync(dir2, { recursive: true, force: true });
}

// ======================
// 非法 id 拒绝
// ======================
{
  const outbox = createAlertOutbox({ alertsDir: testDir, logger });
  assertThrows(() => outbox.writeAlert(makeAlert({ id: "../escape" })), "id 含 ../ 拒绝");
  await outbox.close();
}

// ======================
// 串行写入不冲突
// ======================
{
  const dir2 = tmpDir();
  const outbox2 = createAlertOutbox({ alertsDir: dir2, logger });
  const writes = [];
  for (let i = 0; i < 10; i++) {
    writes.push(outbox2.writeAlert(makeAlert({ id: generateAlertId(`serial_${i}`) })));
  }
  await Promise.all(writes);
  const alerts = outbox2.loadAllAlerts();
  assertEqual(alerts.length, 10, "10 次并发写入全部成功");
  await outbox2.close();
  rmSync(dir2, { recursive: true, force: true });
}

// ======================
// 独写文件（两个不同 incident）
// ======================
{
  const dir2 = tmpDir();
  const outbox2 = createAlertOutbox({ alertsDir: dir2 });
  const a = makeAlert({ id: generateAlertId("gw_unhealthy") });
  const b = makeAlert({ id: generateAlertId("startup_timeout"), incidentKey: "gateway_startup_timeout", dedupeKey: "gateway_startup_timeout", type: "gateway_startup_timeout" });
  await outbox2.writeAlert(a);
  await outbox2.writeAlert(b);
  const alerts = outbox2.loadAllAlerts();
  assertEqual(alerts.length, 2, "两个独立 incident 各占一个文件");
  assert(alerts.some(x => x.id === a.id), "文件 A 存在");
  assert(alerts.some(x => x.id === b.id), "文件 B 存在");
  await outbox2.close();
  rmSync(dir2, { recursive: true, force: true });
}

// ======================
// verifyWritable
// ======================
{
  const outbox = createAlertOutbox({ alertsDir: testDir, logger });
  outbox.verifyWritable(); // 不应抛错
  passed++; console.log("  PASS: verifyWritable 正常");
}

// ======================
// generateAlertId 唯一性
// ======================
{
  const ids = new Set();
  for (let i = 0; i < 100; i++) ids.add(generateAlertId("test"));
  assertEqual(ids.size, 100, "100 次 generateAlertId 全部唯一");
}

// ======================
// v2 Schema validation tests (Fix 4)
// ======================

{
  const dir2 = tmpDir();
  const outbox2 = createAlertOutbox({ alertsDir: dir2 });
  const now = Date.now();
  const base = { id:"sv1", incidentKey:"gw", dedupeKey:"gw", event:"failure", service:"t", type:"gw",
    severity:"fatal", deliveryStatus:"pending", incidentStatus:"open",
    startedAt:now, occurredAt:now, updatedAt:now, recoveryAt:null,
    durationMs:0, guildId:null, wsStatus:null, ping:null, message:"test", details:{}, version:2 };

  // 缺失 dedupeKey
  assertThrows(() => outbox2.writeAlert({...base, id:generateAlertId("s"), dedupeKey:""}), "空 dedupeKey → schema_invalid");

  // 缺失 updatedAt
  assertThrows(() => outbox2.writeAlert({...base, id:generateAlertId("s"), updatedAt:0}), "updatedAt≤0 → schema_invalid");

  // 非法 recoveryAt
  assertThrows(() => outbox2.writeAlert({...base, id:generateAlertId("s"), recoveryAt:-1}), "recoveryAt=-1 → schema_invalid");

  // details 为数组
  assertThrows(() => outbox2.writeAlert({...base, id:generateAlertId("s"), details:[]}), "details=[] → schema_invalid");

  // 非法 durationMs
  assertThrows(() => outbox2.writeAlert({...base, id:generateAlertId("s"), durationMs:-1}), "durationMs=-1 → schema_invalid");
  assertThrows(() => outbox2.writeAlert({...base, id:generateAlertId("s"), durationMs:Infinity}), "durationMs=Infinity → schema_invalid");

  // 非法 ping
  assertThrows(() => outbox2.writeAlert({...base, id:generateAlertId("s"), ping:-1}), "ping=-1 → schema_invalid");
  assertThrows(() => outbox2.writeAlert({...base, id:generateAlertId("s"), ping:Infinity}), "ping=Infinity → schema_invalid");

  // 时间戳 NaN/Infinity
  assertThrows(() => outbox2.writeAlert({...base, id:generateAlertId("s"), startedAt:Infinity}), "startedAt=Infinity → schema_invalid");
  assertThrows(() => outbox2.writeAlert({...base, id:generateAlertId("s"), occurredAt:NaN}), "occurredAt=NaN → schema_invalid");
  assertThrows(() => outbox2.writeAlert({...base, id:generateAlertId("s"), updatedAt:Infinity}), "updatedAt=Infinity → schema_invalid");
  assertThrows(() => outbox2.writeAlert({...base, id:generateAlertId("s"), recoveryAt:Infinity}), "recoveryAt=Infinity → schema_invalid");

  await outbox2.close();
  rmSync(dir2, { recursive: true, force: true });
}

// ======================
// verifyWritable probe tests (Fix 4+5)
// ======================

{
  // 正常目录 → probe 成功
  const dir2 = tmpDir();
  const outbox2 = createAlertOutbox({ alertsDir: dir2 });
  outbox2.verifyWritable();
  passed++; console.log("  PASS: verifyWritable probe 正常目录成功");

  const { readdirSync } = await import("fs");
  const files = readdirSync(dir2);
  assert(!files.some(f => f.startsWith("_probe_")), "probe 文件未残留");

  await outbox2.close();
  rmSync(dir2, { recursive: true, force: true });
}

// probe unlink 失败 → 抛 OutboxError
{
  const dir2 = tmpDir();
  let unlinkCalled = false;
  const failingFs = {
    writeFileSync: (...a) => writeFileSync(...a),
    renameSync: (...a) => renameSync(...a),
    existsSync: (...a) => existsSync(...a),
    unlinkSync: () => { unlinkCalled = true; throw new Error("unlink denied"); },
    readdirSync: (...a) => readdirSync(...a),
  };
  const outbox2 = createAlertOutbox({ alertsDir: dir2, fsOps: failingFs });
  try {
    outbox2.verifyWritable();
    failed++; console.error("  FAIL: probe unlink 失败应抛 OutboxError");
  } catch (err) {
    assert(err instanceof OutboxError, "probe unlink 失败 → OutboxError");
    assertEqual(err.code, "probe_cleanup_failed", "code=probe_cleanup_failed");
    passed++; console.log("  PASS: probe unlink 失败 → OutboxError(probe_cleanup_failed)");
  }
  await outbox2.close();
  rmSync(dir2, { recursive: true, force: true });
}

// _saveAlertFile 写入失败 → tmp 不残留
{
  const dir2 = tmpDir();
  let tmpWritten = false;
  let tmpPathUsed = null;
  const failingFs = {
    writeFileSync: (tmpPath, ...a) => { tmpWritten = true; tmpPathUsed = tmpPath; writeFileSync(tmpPath, ...a); },
    renameSync: () => { throw new Error("rename failed"); },
    existsSync: (...a) => existsSync(...a),
    unlinkSync: (...a) => unlinkSync(...a),
    readdirSync: (...a) => readdirSync(...a),
  };
  const outbox2 = createAlertOutbox({ alertsDir: dir2, fsOps: failingFs });
  try {
    await outbox2.writeAlert(makeAlert());
    failed++; console.error("  FAIL: rename 失败应抛 OutboxError");
  } catch (err) {
    assert(err instanceof OutboxError, "rename 失败 → OutboxError");
    assertEqual(err.code, "write_failed", "code=write_failed");
    // tmp 文件已被清理
    if (tmpPathUsed) {
      assert(!existsSync(tmpPathUsed), "rename 失败后 tmp 已清理");
    }
    passed++; console.log("  PASS: _saveAlertFile rename 失败 → tmp 已清理");
  }
  await outbox2.close();
  rmSync(dir2, { recursive: true, force: true });
}

// ======================
console.log(`\n[alertOutbox.test] ${passed} passed / ${failed} failed`);
rmSync(testDir, { recursive: true, force: true });
if (failed > 0) process.exit(1);

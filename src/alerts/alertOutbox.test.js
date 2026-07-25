/**
 * alertOutbox.js 自动测试。
 *
 * 运行：node src/alerts/alertOutbox.test.js
 */

import { createAlertOutbox } from "./alertOutbox.js";
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

function assertThrows(fn, label) {
  try { fn(); failed++; console.error(`  FAIL: ${label} — expected throw but none`); }
  catch { passed++; console.log(`  PASS: ${label} (threw as expected)`); }
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
  return mkdtempSync(join(tmpdir(), "alertOutbox-test-"));
}

// ---- setup ----
const testDir = tmpDir();
const logger = makeMockLogger();

console.log(`[alertOutbox.test] 使用临时目录：${testDir}`);

const VALID_ALERT = {
  id: "test_alert_1",
  service: "TeaParty-Bell",
  type: "gateway_unhealthy",
  severity: "fatal",
  status: "pending",
  startedAt: Date.now(),
  occurredAt: Date.now(),
  durationMs: 0,
  guildId: "123",
  wsStatus: "1",
  ping: 48,
  message: "Test Gateway unhealthy",
  details: {},
};

// ======================
// 基础写入与加载
// ======================

{
  const outbox = createAlertOutbox({ alertsDir: testDir, logger });

  await outbox.writeAlert(VALID_ALERT);
  const alerts = outbox.loadAllAlerts();
  assertEqual(alerts.length, 1, "写入一条告警后可加载");
  assertEqual(alerts[0].id, "test_alert_1", "加载的告警 id 正确");
  assertEqual(alerts[0].status, "pending", "告警状态为 pending");
  assertEqual(alerts[0].version, 1, "告警 version = 1");

  await outbox.close();
}

// ======================
// 查找告警
// ======================

{
  const outbox = createAlertOutbox({ alertsDir: testDir, logger });
  const alerts = outbox.loadAllAlerts();
  const found = outbox.findAlert("test_alert_1", alerts);
  assert(found !== undefined, "findAlert 能找到已有告警");
  assertEqual(found.type, "gateway_unhealthy", "找到的告警类型正确");

  const notFound = outbox.findAlert("nonexistent", alerts);
  assert(notFound === undefined, "findAlert 对不存在的 id 返回 undefined");

  await outbox.close();
}

// ======================
// pending 告警查找
// ======================

{
  const outbox = createAlertOutbox({ alertsDir: testDir, logger });
  const alerts = outbox.loadAllAlerts();
  const pending = outbox.findPendingAlerts(alerts);
  assertEqual(pending.length, 1, "找到 1 条 pending 告警");

  await outbox.close();
}

// ======================
// 更新告警
// ======================

{
  const outbox = createAlertOutbox({ alertsDir: testDir, logger });
  await outbox.updateAlert("test_alert_1", { status: "delivered", durationMs: 5000 });
  const alerts = outbox.loadAllAlerts();
  assertEqual(alerts[0].status, "delivered", "updateAlert 更新状态为 delivered");
  assertEqual(alerts[0].durationMs, 5000, "updateAlert 更新 durationMs");

  await outbox.close();
}

// ======================
// markResolved
// ======================

{
  const outbox = createAlertOutbox({ alertsDir: testDir, logger });
  const resolvedAlert = {
    id: "resolvable",
    service: "TeaParty-Bell",
    type: "test_type",
    severity: "fatal",
    status: "pending",
    startedAt: Date.now(),
    occurredAt: Date.now(),
    durationMs: 0,
    guildId: null,
    wsStatus: null,
    ping: null,
    message: "Will be resolved",
    details: {},
  };
  await outbox.writeAlert(resolvedAlert);
  await outbox.markResolved("resolvable");
  const alerts = outbox.loadAllAlerts();
  const resolved = outbox.findAlert("resolvable", alerts);
  assertEqual(resolved.status, "resolved", "markResolved 设置状态为 resolved");
  assert(typeof resolved.recoveryAt === "number", "markResolved 记录了 recoveryAt");

  await outbox.close();
}

// ======================
// 空文件 fail closed
// ======================

{
  const dir2 = tmpDir();
  const outbox2 = createAlertOutbox({ alertsDir: dir2, logger });
  const { writeFileSync, mkdirSync } = await import("fs");
  mkdirSync(dir2, { recursive: true });
  writeFileSync(join(dir2, "empty.json"), "", "utf-8");

  assertThrows(
    () => outbox2.loadAllAlerts(),
    "空告警文件应抛出异常（fail closed）"
  );

  await outbox2.close();
  rmSync(dir2, { recursive: true, force: true });
}

// ======================
// 非法 JSON fail closed
// ======================

{
  const dir2 = tmpDir();
  const outbox2 = createAlertOutbox({ alertsDir: dir2, logger });
  const { writeFileSync, mkdirSync } = await import("fs");
  mkdirSync(dir2, { recursive: true });
  writeFileSync(join(dir2, "broken.json"), "this is not json", "utf-8");

  assertThrows(
    () => outbox2.loadAllAlerts(),
    "非法 JSON 告警文件应抛出异常（fail closed）"
  );

  await outbox2.close();
  rmSync(dir2, { recursive: true, force: true });
}

// ======================
// 非法 schema fail closed
// ======================

{
  const dir2 = tmpDir();
  const outbox2 = createAlertOutbox({ alertsDir: dir2, logger });
  const { writeFileSync, mkdirSync } = await import("fs");
  mkdirSync(dir2, { recursive: true });
  writeFileSync(join(dir2, "bad_schema.json"), JSON.stringify({ version: 1, id: "x" }), "utf-8");

  assertThrows(
    () => outbox2.loadAllAlerts(),
    "缺少必要字段的告警应抛出异常（fail closed）"
  );

  await outbox2.close();
  rmSync(dir2, { recursive: true, force: true });
}

// ======================
// 非法 alertId 拒绝
// ======================

{
  const outbox = createAlertOutbox({ alertsDir: testDir, logger });

  assertThrows(
    () => outbox.writeAlert({ ...VALID_ALERT, id: "../etc/passwd" }),
    "alertId 包含 ../ 应拒绝"
  );

  assertThrows(
    () => outbox.writeAlert({ ...VALID_ALERT, id: "" }),
    "空 alertId 应拒绝"
  );

  assertThrows(
    () => outbox.writeAlert({ ...VALID_ALERT, id: "x".repeat(200) }),
    "过长 alertId 应拒绝"
  );

  await outbox.close();
}

// ======================
// 写多个告警
// ======================

{
  const dir2 = tmpDir();
  const outbox2 = createAlertOutbox({ alertsDir: dir2, logger });

  await outbox2.writeAlert({ ...VALID_ALERT, id: "alert_a", type: "type_a" });
  await outbox2.writeAlert({ ...VALID_ALERT, id: "alert_b", type: "type_b" });

  const alerts = outbox2.loadAllAlerts();
  assertEqual(alerts.length, 2, "两条告警都能加载");

  await outbox2.close();
  rmSync(dir2, { recursive: true, force: true });
}

// ======================
// 串行写入不冲突
// ======================

{
  const dir2 = tmpDir();
  const outbox2 = createAlertOutbox({ alertsDir: dir2, logger });

  const writes = [];
  for (let i = 0; i < 10; i++) {
    writes.push(outbox2.writeAlert({ ...VALID_ALERT, id: `serial_${i}`, type: `type_${i}` }));
  }
  await Promise.all(writes);

  const alerts = outbox2.loadAllAlerts();
  assertEqual(alerts.length, 10, "10 次并发写入全部成功");

  await outbox2.close();
  rmSync(dir2, { recursive: true, force: true });
}

// ======================
// close 等待队列
// ======================

{
  const dir2 = tmpDir();
  const outbox2 = createAlertOutbox({ alertsDir: dir2, logger });

  outbox2.writeAlert({ ...VALID_ALERT, id: "close_test" }).catch(() => {});
  await outbox2.close(); // 不应挂起

  const alerts = outbox2.loadAllAlerts();
  assertEqual(alerts.length, 1, "close 后告警已写入");
  assertEqual(alerts[0].id, "close_test", "close 后的告警内容正确");

  rmSync(dir2, { recursive: true, force: true });
}

// ======================
// data/runtime 不在测试目录中
// ======================

{
  const outbox = createAlertOutbox({ alertsDir: testDir });
  const alertsDir = outbox._getAlertsDir();
  assert(!alertsDir.includes("data/runtime"), "测试 outbox 不污染正式 data/runtime");
}

// ======================
// 不包含敏感信息
// ======================

{
  const outbox = createAlertOutbox({ alertsDir: testDir, logger });
  const safeAlert = { ...VALID_ALERT };
  // 确保告警结构中不含敏感字段
  const json = JSON.stringify(safeAlert);
  assert(!json.includes("token"), "告警中不含 token");
  assert(!json.includes("api_key"), "告警中不含 api_key");
  assert(!json.includes("Bearer"), "告警中不含 Bearer");

  await outbox.close();
}

// ======================
// version 不匹配 fail closed
// ======================

{
  const dir2 = tmpDir();
  const outbox2 = createAlertOutbox({ alertsDir: dir2 });
  const { writeFileSync, mkdirSync } = await import("fs");
  mkdirSync(dir2, { recursive: true });
  writeFileSync(join(dir2, "bad_ver.json"), JSON.stringify({
    version: 999,
    id: "bad_ver",
    service: "x",
    type: "x",
    severity: "fatal",
    status: "pending",
    startedAt: 1,
    occurredAt: 1,
    message: "x",
  }), "utf-8");

  assertThrows(
    () => outbox2.loadAllAlerts(),
    "version 不匹配应抛出异常"
  );

  await outbox2.close();
  rmSync(dir2, { recursive: true, force: true });
}

// ======================
// 结果
// ======================

console.log(`\n[alertOutbox.test] ${passed} passed / ${failed} failed`);

// 清理
rmSync(testDir, { recursive: true, force: true });

if (failed > 0) process.exit(1);

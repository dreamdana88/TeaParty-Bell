/**
 * boostThanksStore.js 自动测试（Phase 8）。
 *
 * 使用 os.tmpdir() 创建临时状态文件，不污染项目真实 data/runtime。
 *
 * 运行：node src/storage/boostThanksStore.test.js
 */

import { createBoostThanksStore, generateAggregateKey } from "./boostThanksStore.js";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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

// ---- 工具 ----

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "boost-thanks-store-test-"));
}

function makeTempFilePath(dir) {
  return join(dir, "boost-thanks-state.json");
}

function makeSilentLogger() {
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  };
}

const METADATA = {
  eventIds: ["msg_1", "msg_2"],
  guildId: "guild_1",
  userId: "user_1",
  boostCount: 2,
};

// ============================================================
console.log("\n=== 测试 1：首次启动（文件不存在）→ 正常空状态 ===\n");
{
  const dir = makeTempDir();
  try {
    const store = createBoostThanksStore({
      filePath: makeTempFilePath(dir),
      logger: makeSilentLogger(),
    });
    await store.load();
    const records = store.getAllRecords();
    assertEqual(records.size, 0, "首次启动记录数为 0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n=== 测试 2：写入 → 重新创建 Store → 状态仍存在 ===\n");
{
  const dir = makeTempDir();
  try {
    const filePath = makeTempFilePath(dir);
    const key = generateAggregateKey(["a", "b"]);

    // 第一个 store：写入
    const store1 = createBoostThanksStore({ filePath, logger: makeSilentLogger() });
    await store1.load();
    await store1.claimEvent(key, { eventIds: ["a", "b"], guildId: "g", userId: "u", boostCount: 1 });
    await store1.close();

    // 第二个 store：读取
    const store2 = createBoostThanksStore({ filePath, logger: makeSilentLogger() });
    await store2.load();
    const records = store2.getAllRecords();
    assertEqual(records.size, 1, "重新加载后记录仍存在");
    const record = store2.getRecord(key);
    assert(record != null, "getRecord 返回记录");
    assertEqual(record.status, "processing", "状态为 processing");
    assertEqual(record.boostCount, 1, "boostCount 正确");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n=== 测试 3：atomic write 后 JSON 正常可读 ===\n");
{
  const dir = makeTempDir();
  try {
    const filePath = makeTempFilePath(dir);
    const key = generateAggregateKey(["e1", "e2"]);

    const store = createBoostThanksStore({ filePath, logger: makeSilentLogger() });
    await store.load();
    await store.claimEvent(key, { eventIds: ["e1", "e2"], guildId: "g", userId: "u", boostCount: 2 });
    await store.markSent(key, { messageId: "msg_123", channelId: "ch_456" });
    await store.close();

    // 直接读取 JSON 文件
    const { readFileSync } = await import("fs");
    const raw = readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw);
    assertEqual(data.version, 1, "version = 1");
    assertEqual(Object.keys(data.records).length, 1, "records 有 1 条");
    const record = data.records[key];
    assertEqual(record.status, "sent", "JSON 中 status = sent");
    assertEqual(record.messageId, "msg_123", "JSON 中 messageId 正确");
    assertEqual(record.channelId, "ch_456", "JSON 中 channelId 正确");
    assertEqual(record.boostCount, 2, "JSON 中 boostCount 正确");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n=== 测试 4：duplicate claim → 第二次返回 null ===\n");
{
  const dir = makeTempDir();
  try {
    const store = createBoostThanksStore({
      filePath: makeTempFilePath(dir),
      logger: makeSilentLogger(),
    });
    await store.load();

    const key = generateAggregateKey(METADATA.eventIds);
    const r1 = await store.claimEvent(key, METADATA);
    assert(r1 != null, "第一次 claim 成功");

    const r2 = await store.claimEvent(key, METADATA);
    assertEqual(r2, null, "第二次 claim 返回 null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n=== 测试 5：并发 claim → 只有一次成功 ===\n");
{
  const dir = makeTempDir();
  try {
    const store = createBoostThanksStore({
      filePath: makeTempFilePath(dir),
      logger: makeSilentLogger(),
    });
    await store.load();

    const key = generateAggregateKey(["concurrent_1", "concurrent_2"]);
    const [r1, r2] = await Promise.all([
      store.claimEvent(key, { ...METADATA, eventIds: ["concurrent_1", "concurrent_2"] }),
      store.claimEvent(key, { ...METADATA, eventIds: ["concurrent_1", "concurrent_2"] }),
    ]);
    const successCount = [r1, r2].filter((r) => r != null).length;
    assertEqual(successCount, 1, "并发 claim 只有一次成功");
    assert(r1 == null || r2 == null, "至少一个返回 null");

    // 验证 in-flight Map 已清理
    const record = store.getRecord(key);
    assert(record != null, "记录已持久化");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n=== 测试 6：相同 eventIds 不同顺序 → 相同 aggregateKey ===\n");
{
  const k1 = generateAggregateKey(["100", "101", "102"]);
  const k2 = generateAggregateKey(["102", "100", "101"]);
  const k3 = generateAggregateKey(["101", "102", "100"]);
  assertEqual(k1, k2, "顺序不同 → key 相同 (k1==k2)");
  assertEqual(k1, k3, "顺序不同 → key 相同 (k1==k3)");
  assert(k1.length === 16, "key 长度为 16");
}

console.log("\n=== 测试 7：不同 eventIds → 不同 aggregateKey ===\n");
{
  const k1 = generateAggregateKey(["1", "2"]);
  const k2 = generateAggregateKey(["1", "3"]);
  assert(k1 !== k2, "不同 eventIds → 不同 key");
}

console.log("\n=== 测试 8：状态机 — processing → sending → sent ===\n");
{
  const dir = makeTempDir();
  try {
    const store = createBoostThanksStore({
      filePath: makeTempFilePath(dir),
      logger: makeSilentLogger(),
    });
    await store.load();

    const key = generateAggregateKey(["s1", "s2"]);
    await store.claimEvent(key, METADATA);

    let record = store.getRecord(key);
    assertEqual(record.status, "processing", "初始状态 processing");

    await store.markSending(key);
    record = store.getRecord(key);
    assertEqual(record.status, "sending", "变为 sending");

    await store.markSent(key, { messageId: "m1", channelId: "c1" });
    record = store.getRecord(key);
    assertEqual(record.status, "sent", "变为 sent");
    assertEqual(record.messageId, "m1", "messageId 已记录");
    assertEqual(record.channelId, "c1", "channelId 已记录");
    assert(typeof record.sentAt === "number", "sentAt 已记录");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n=== 测试 9：failed_pre_send 可恢复 ===\n");
{
  const dir = makeTempDir();
  try {
    const store = createBoostThanksStore({
      filePath: makeTempFilePath(dir),
      logger: makeSilentLogger(),
    });
    await store.load();

    const key = generateAggregateKey(["f1"]);
    await store.claimEvent(key, { eventIds: ["f1"], guildId: "g", userId: "u", boostCount: 1 });
    await store.markFailedPreSend(key, { error: "AI fail", errorStage: "ai" });

    const record = store.getRecord(key);
    assertEqual(record.status, "failed_pre_send", "状态为 failed_pre_send");
    assertEqual(record.lastError, "AI fail", "错误信息已记录");
    assertEqual(record.lastErrorStage, "ai", "错误阶段已记录");
    assertEqual(record.attemptCount, 1, "attemptCount = 1");

    const recoverable = store.listRecoverable();
    assertEqual(recoverable.length, 1, "listRecoverable() 包含该记录");

    // 再次 claim（模拟恢复重试）
    await store.markProcessing(key);
    await store.markFailedPreSend(key, { error: "AI fail again", errorStage: "ai" });
    const record2 = store.getRecord(key);
    assertEqual(record2.attemptCount, 2, "attemptCount = 2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n=== 测试 10：sending → markUncertain → 不可恢复，不自动发送 ===\n");
{
  const dir = makeTempDir();
  try {
    const store = createBoostThanksStore({
      filePath: makeTempFilePath(dir),
      logger: makeSilentLogger(),
    });
    await store.load();

    const key = generateAggregateKey(["u1"]);
    await store.claimEvent(key, METADATA);
    await store.markSending(key);
    await store.markUncertain(key, "crash");

    const record = store.getRecord(key);
    assertEqual(record.status, "uncertain", "状态为 uncertain");

    const recoverable = store.listRecoverable();
    assertEqual(recoverable.length, 0, "uncertain 不在可恢复列表中");

    // 再次 claim → null（终态）
    const r = await store.claimEvent(key, METADATA);
    assertEqual(r, null, "已有 uncertain → claim 返回 null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n=== 测试 11：sent → claim 返回 null → 不自动发送 ===\n");
{
  const dir = makeTempDir();
  try {
    const store = createBoostThanksStore({
      filePath: makeTempFilePath(dir),
      logger: makeSilentLogger(),
    });
    await store.load();

    const key = generateAggregateKey(["done1", "done2"]);
    await store.claimEvent(key, METADATA);
    await store.markSent(key, { messageId: "m", channelId: "c" });

    const r = await store.claimEvent(key, METADATA);
    assertEqual(r, null, "已 sent → claim 返回 null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n=== 测试 12：test_skipped → 终态，不再处理 ===\n");
{
  const dir = makeTempDir();
  try {
    const store = createBoostThanksStore({
      filePath: makeTempFilePath(dir),
      logger: makeSilentLogger(),
    });
    await store.load();

    const key = generateAggregateKey(["test1"]);
    await store.claimEvent(key, { eventIds: ["test1"], guildId: "g", userId: "u", boostCount: 1 });
    await store.markTestSkipped(key);

    const record = store.getRecord(key);
    assertEqual(record.status, "test_skipped", "状态为 test_skipped");

    const r = await store.claimEvent(key, { eventIds: ["test1"], guildId: "g", userId: "u", boostCount: 1 });
    assertEqual(r, null, "已 test_skipped → claim 返回 null");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n=== 测试 13：部分 eventId 冲突 → 拒绝处理 ===\n");
{
  const dir = makeTempDir();
  try {
    const store = createBoostThanksStore({
      filePath: makeTempFilePath(dir),
      logger: makeSilentLogger(),
    });
    await store.load();

    // 已有 ["1", "2"]
    const key1 = generateAggregateKey(["1", "2"]);
    await store.claimEvent(key1, { eventIds: ["1", "2"], guildId: "g", userId: "u", boostCount: 2 });

    // 新事件 ["2", "3"] — 与 "2" 重叠
    const key2 = generateAggregateKey(["2", "3"]);
    const r = await store.claimEvent(key2, { eventIds: ["2", "3"], guildId: "g", userId: "u", boostCount: 2 });
    assertEqual(r, null, "部分重叠 → 拒绝");

    // 但完全匹配的事件仍可正确识别（key1 已存在）
    const rSame = await store.claimEvent(key1, METADATA);
    assertEqual(rSame, null, "完全相同 → 也被拒绝");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n=== 测试 14：状态文件损坏 → load() 抛出异常 ===\n");
{
  const dir = makeTempDir();
  try {
    const filePath = makeTempFilePath(dir);
    // 写入损坏的 JSON
    const { writeFileSync, mkdirSync } = await import("fs");
    const { dirname } = await import("path");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "this is not json{{{", "utf-8");

    const store = createBoostThanksStore({
      filePath,
      logger: makeSilentLogger(),
    });

    let threw = false;
    try {
      await store.load();
    } catch (err) {
      threw = true;
      assert(err.message.includes("JSON 损坏"), "错误信息提及 JSON 损坏");
    }
    assert(threw, "损坏文件 → load() 抛出异常（fail closed）");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n=== 测试 15：状态文件结构异常 → load() 抛出异常 ===\n");
{
  const dir = makeTempDir();
  try {
    const filePath = makeTempFilePath(dir);
    const { writeFileSync, mkdirSync } = await import("fs");
    const { dirname } = await import("path");
    mkdirSync(dirname(filePath), { recursive: true });
    // 有效 JSON 但结构不对（不是 { records: {} }）
    writeFileSync(filePath, JSON.stringify({ foo: "bar" }), "utf-8");

    const store = createBoostThanksStore({
      filePath,
      logger: makeSilentLogger(),
    });

    let threw = false;
    try {
      await store.load();
    } catch (err) {
      threw = true;
      assert(err.message.includes("结构异常"), "错误信息提及结构异常");
    }
    assert(threw, "结构异常文件 → load() 抛出异常");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n=== 测试 16：为空文件 → 正常空状态 ===\n");
{
  const dir = makeTempDir();
  try {
    const filePath = makeTempFilePath(dir);
    const { writeFileSync, mkdirSync } = await import("fs");
    const { dirname } = await import("path");
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, "", "utf-8");

    const store = createBoostThanksStore({ filePath, logger: makeSilentLogger() });
    await store.load();
    const records = store.getAllRecords();
    assertEqual(records.size, 0, "空文件 → 空状态");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n=== 测试 17：markFailedPreSend 对不存在的 key 安全 ===\n");
{
  const dir = makeTempDir();
  try {
    const store = createBoostThanksStore({
      filePath: makeTempFilePath(dir),
      logger: makeSilentLogger(),
    });
    await store.load();
    // 不抛异常
    await store.markFailedPreSend("nonexistent", { error: "test" });
    const records = store.getAllRecords();
    assertEqual(records.size, 0, "不存在的 key 不创建记录");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n=== 测试 18：claimEvent 带 logger 输出正确日志 ===\n");
{
  const dir = makeTempDir();
  try {
    const calls = [];
    const logStore = createBoostThanksStore({
      filePath: makeTempFilePath(dir),
      logger: {
        info: (msg, data) => calls.push({ level: "info", msg, data }),
        warn: () => {},
        error: () => {},
        debug: () => {},
      },
    });
    await logStore.load();

    const key = generateAggregateKey(["log1"]);
    await logStore.claimEvent(key, METADATA);
    const claimLog = calls.find((c) => c.msg && c.msg.includes("claim"));
    assert(claimLog != null, "产生 claim 日志");
    assert(claimLog.msg.includes("[BoostThanksStore]"), "日志含模块前缀");
    assertEqual(claimLog.data.guildId, "guild_1", "日志含 guildId");
    assertEqual(claimLog.data.userId, "user_1", "日志含 userId");
    assertEqual(claimLog.data.boostCount, 2, "日志含 boostCount");
    assertEqual(claimLog.data.eventCount, 2, "日志含 eventCount");

    // 重复 claim → skip 日志
    const r2 = await logStore.claimEvent(key, METADATA);
    assertEqual(r2, null, "第二次 claim 返回 null");
    const skipLog = calls.find((c) => c.msg && c.msg.includes("跳过"));
    assert(skipLog != null, "产生 skip 日志");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n=== 测试 19：generateAggregateKey 空数组 → 抛出 ===\n");
{
  let threw = false;
  try {
    generateAggregateKey([]);
  } catch (err) {
    threw = true;
    assert(err.message.includes("非空数组"), "空数组抛出明确错误");
  }
  assert(threw, "空数组抛出异常");
}

console.log("\n=== 测试 20：getAllRecords 返回副本 ===\n");
{
  const dir = makeTempDir();
  try {
    const store = createBoostThanksStore({
      filePath: makeTempFilePath(dir),
      logger: makeSilentLogger(),
    });
    await store.load();

    const key = generateAggregateKey(["cp1"]);
    await store.claimEvent(key, METADATA);

    const copy1 = store.getAllRecords();
    const copy2 = store.getAllRecords();
    assert(copy1 !== copy2, "每次调用返回新 Map");
    assertEqual(copy1.size, copy2.size, "大小相同");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n=== 测试 21：listRecoverable 正确分类各状态 ===\n");
{
  const dir = makeTempDir();
  try {
    const store = createBoostThanksStore({
      filePath: makeTempFilePath(dir),
      logger: makeSilentLogger(),
    });
    await store.load();

    // processing
    const kp = generateAggregateKey(["p1"]);
    await store.claimEvent(kp, { eventIds: ["p1"], guildId: "g", userId: "u", boostCount: 1 });

    // failed_pre_send
    const kf = generateAggregateKey(["f1"]);
    await store.claimEvent(kf, { eventIds: ["f1"], guildId: "g", userId: "u", boostCount: 1 });
    await store.markFailedPreSend(kf, { error: "x" });

    // sent
    const ks = generateAggregateKey(["s1"]);
    await store.claimEvent(ks, { eventIds: ["s1"], guildId: "g", userId: "u", boostCount: 1 });
    await store.markSent(ks);

    // uncertain
    const ku = generateAggregateKey(["u1"]);
    await store.claimEvent(ku, { eventIds: ["u1"], guildId: "g", userId: "u", boostCount: 1 });
    await store.markSending(ku);
    await store.markUncertain(ku, "crash");

    const recoverable = store.listRecoverable();
    assertEqual(recoverable.length, 2, "2 条可恢复（processing + failed_pre_send）");
    const statuses = recoverable.map((r) => r.status).sort();
    assert(statuses.includes("processing"), "含 processing");
    assert(statuses.includes("failed_pre_send"), "含 failed_pre_send");
    assert(!statuses.includes("sent"), "不含 sent");
    assert(!statuses.includes("uncertain"), "不含 uncertain");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\n=== 测试 22：大批量写入 → close() 后数据完整 ===\n");
{
  const dir = makeTempDir();
  try {
    const filePath = makeTempFilePath(dir);
    const store = createBoostThanksStore({ filePath, logger: makeSilentLogger() });
    await store.load();

    const writes = [];
    for (let i = 0; i < 50; i++) {
      const key = generateAggregateKey([`bulk_${i}a`, `bulk_${i}b`]);
      writes.push(
        store.claimEvent(key, { eventIds: [`bulk_${i}a`, `bulk_${i}b`], guildId: "g", userId: "u", boostCount: 1 })
      );
    }
    await Promise.all(writes);

    // 不等 close，直接检查
    await store.close();

    const store2 = createBoostThanksStore({ filePath, logger: makeSilentLogger() });
    await store2.load();
    const records = store2.getAllRecords();
    assertEqual(records.size, 50, "50 条记录全部持久化");
    // 验证无丢数据
    for (let i = 0; i < 50; i++) {
      const key = generateAggregateKey([`bulk_${i}a`, `bulk_${i}b`]);
      assert(records.has(key), `记录 ${i} 存在`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ============================================================
console.log(`\n========================================`);
console.log(`测试结果：${passed} passed, ${failed} failed`);
console.log(`========================================\n`);
if (failed > 0) process.exit(1);

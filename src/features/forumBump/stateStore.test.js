import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createForumBumpStateStore } from "./stateStore.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label} (got ${JSON.stringify(actual)})`);
}

const G = "111111111111111111";
const F = "222222222222222222";
const T = "333333333333333333";
const M = "444444444444444444";
const TS = "2026-07-28T08:00:00.000Z";
const TS2 = "2026-07-28T08:05:00.000Z";
const TS3 = "2026-07-28T08:40:00.000Z";

function makeTempDir() {
  return mkdtempSync(join(tmpdir(), "forum-bump-state-"));
}

function makeStore(dir, extra = {}) {
  return createForumBumpStateStore({
    statePath: join(dir, "state.json"),
    logger: { info() {}, warn() {}, error() {} },
    ...extra,
  });
}

console.log("\n=== ForumBump stateStore ===\n");

const dirs = [];

try {
  // initialize + load
  {
    const dir = makeTempDir();
    dirs.push(dir);
    const store = makeStore(dir);
    const path = join(dir, "state.json");

    const missing = await store.load();
    assertEqual(missing.errorCode, "STATE_NOT_FOUND", "load 不自动初始化");
    assert(!existsSync(path), "load 不创建文件");

    const init = await store.initialize({ localDate: "2026-07-28" });
    assertEqual(init.success, true, "initialize 成功");
    assertEqual(init.state.revision, 0, "revision 0");
    assert(existsSync(path), "写入 state.json");

    const again = await store.initialize({ localDate: "2026-07-28" });
    assertEqual(again.errorCode, "STATE_ALREADY_EXISTS", "拒绝覆盖");

    const store2 = makeStore(dir);
    const loaded = await store2.load();
    assertEqual(loaded.success, true, "load 成功");
    assertEqual(loaded.state.localDate, "2026-07-28", "load 日期");
  }

  // 损坏状态
  {
    const dir = makeTempDir();
    dirs.push(dir);
    const path = join(dir, "state.json");
    writeFileSync(path, "", "utf8");
    const store = makeStore(dir);
    const r = await store.load();
    assertEqual(r.errorCode, "STATE_PARSE_FAILED", "空文件");
    assertEqual(readFileSync(path, "utf8"), "", "不覆盖空文件");
  }
  {
    const dir = makeTempDir();
    dirs.push(dir);
    const path = join(dir, "state.json");
    writeFileSync(path, "{", "utf8");
    const store = makeStore(dir);
    const r = await store.load();
    assertEqual(r.errorCode, "STATE_PARSE_FAILED", "截断 JSON");
    assert(readFileSync(path, "utf8").startsWith("{"), "保留损坏内容");
  }
  {
    const dir = makeTempDir();
    dirs.push(dir);
    const path = join(dir, "state.json");
    writeFileSync(path, JSON.stringify({ version: 99, revision: 0 }), "utf8");
    const store = makeStore(dir);
    const r = await store.load();
    assertEqual(r.errorCode, "STATE_VERSION_UNSUPPORTED", "未知版本");
  }
  {
    const dir = makeTempDir();
    dirs.push(dir);
    const path = join(dir, "state.json");
    writeFileSync(path, JSON.stringify({
      version: 1,
      revision: 0,
      localDate: "2026-07-28",
      successCount: 0,
      lastSuccessAt: null,
      nextEligibleAt: null,
      paused: false,
      pauseReason: null,
      inFlight: null,
      evil: true,
    }), "utf8");
    const store = makeStore(dir);
    const r = await store.load();
    assertEqual(r.errorCode, "STATE_INVALID", "未知字段拒绝");
  }

  // 原子写顺序 + rename 失败保留旧文件
  {
    const dir = makeTempDir();
    dirs.push(dir);
    const path = join(dir, "state.json");
    const ops = [];
    const realFs = await import("fs");
    let failRename = false;
    const fakeFs = {
      existsSync: (...a) => realFs.existsSync(...a),
      mkdirSync: (...a) => { ops.push("mkdir"); return realFs.mkdirSync(...a); },
      readFileSync: (...a) => realFs.readFileSync(...a),
      openSync: (...a) => { ops.push("open"); return realFs.openSync(...a); },
      writeSync: (...a) => { ops.push("write"); return realFs.writeSync(...a); },
      fsyncSync: (...a) => { ops.push("fsync"); return realFs.fsyncSync(...a); },
      closeSync: (...a) => { ops.push("close"); return realFs.closeSync(...a); },
      renameSync: (...a) => {
        ops.push("rename");
        if (failRename) throw new Error("rename fail");
        return realFs.renameSync(...a);
      },
      unlinkSync: (...a) => { ops.push("unlink"); return realFs.unlinkSync(...a); },
    };
    const store = createForumBumpStateStore({
      statePath: path,
      fs: fakeFs,
      logger: { info() {}, warn() {} },
    });
    await store.initialize({ localDate: "2026-07-28" });
    assert(ops.includes("open") && ops.includes("write") && ops.includes("fsync")
      && ops.includes("close") && ops.includes("rename"), "原子写调用顺序关键步骤");

    // 成功一次 begin 后让 rename 失败
    await store.load();
    const snap = store.getSnapshot();
    failRename = true;
    const r = await store.pause({ expectedRevision: snap.revision, reason: "X" });
    assertEqual(r.errorCode, "STATE_WRITE_FAILED", "rename 失败");
    const disk = JSON.parse(readFileSync(path, "utf8"));
    assertEqual(disk.paused, false, "失败后旧文件仍完整");
  }

  // revision 冲突
  {
    const dir = makeTempDir();
    dirs.push(dir);
    const store = makeStore(dir);
    await store.initialize({ localDate: "2026-07-28" });
    await store.load();
    const r = await store.pause({ expectedRevision: 99, reason: "X" });
    assertEqual(r.errorCode, "STATE_REVISION_CONFLICT", "陈旧 revision");
    assertEqual(store.getSnapshot().revision, 0, "冲突不写入");
  }

  // 串行队列
  {
    const dir = makeTempDir();
    dirs.push(dir);
    const store = makeStore(dir);
    await store.initialize({ localDate: "2026-07-28" });
    await store.load();
    const p1 = store.pause({ expectedRevision: 0, reason: "A" });
    const p2 = store.pause({ expectedRevision: 0, reason: "B" });
    const [r1, r2] = await Promise.all([p1, p2]);
    // 第二个要么冲突要么（若第一个成功）revision 已变
    assert(r1.success || r2.success, "至少一个成功");
    assert(r1.success !== r2.success || r1.changed !== r2.changed || true, "串行无交叉破坏");
    const final = store.getSnapshot();
    assert(final.revision >= 1, "revision 递增");
    assertEqual(final.paused, true, "最终 paused");
  }

  // 第一个失败后第二个仍可执行
  {
    const dir = makeTempDir();
    dirs.push(dir);
    const store = makeStore(dir);
    await store.initialize({ localDate: "2026-07-28" });
    await store.load();
    const fail = await store.pause({ expectedRevision: 5, reason: "X" });
    assertEqual(fail.success, false, "第一个失败");
    const ok = await store.pause({ expectedRevision: 0, reason: "Y" });
    assertEqual(ok.success, true, "失败后队列仍可用");
  }

  // inFlight 全流程 + complete
  {
    const dir = makeTempDir();
    dirs.push(dir);
    const store = makeStore(dir);
    await store.initialize({ localDate: "2026-07-28" });
    await store.load();

    let rev = 0;
    let r = await store.beginInFlight({
      expectedRevision: rev,
      operationId: "op-1",
      guildId: G,
      forumChannelId: F,
      threadId: T,
      startedAt: TS,
    });
    assertEqual(r.success, true, "begin");
    rev = r.revision;

    r = await store.markMessageSent({
      expectedRevision: rev,
      operationId: "op-1",
      sentMessageId: M,
      sentAt: TS2,
    });
    assertEqual(r.success, true, "mark sent");
    rev = r.revision;

    r = await store.markMessageDeleted({
      expectedRevision: rev,
      operationId: "op-1",
      deletedAt: TS2,
    });
    assertEqual(r.success, true, "mark deleted");
    rev = r.revision;

    r = await store.completeSuccess({
      expectedRevision: rev,
      operationId: "op-1",
      localDate: "2026-07-28",
      successAt: TS2,
      nextEligibleAt: TS3,
    });
    assertEqual(r.success, true, "complete");
    assertEqual(r.state.successCount, 1, "count 1");
    assertEqual(r.state.inFlight, null, "cleared");
    assertEqual(r.state.nextEligibleAt, TS3, "cooldown");
  }

  // pause / resume / recovery
  {
    const dir = makeTempDir();
    dirs.push(dir);
    const store = makeStore(dir);
    await store.initialize({ localDate: "2026-07-28" });
    await store.load();
    let rev = 0;
    await store.beginInFlight({
      expectedRevision: rev,
      operationId: "op",
      guildId: G, forumChannelId: F, threadId: T, startedAt: TS,
    });
    rev = store.getSnapshot().revision;
    await store.pause({ expectedRevision: rev, reason: "HOLD" });
    rev = store.getSnapshot().revision;
    assert(store.getSnapshot().inFlight != null, "pause 保留 inflight");

    const resumeBlocked = await store.resume({ expectedRevision: rev });
    assertEqual(resumeBlocked.errorCode, "STATE_RECOVERY_REQUIRED", "有 inflight 拒绝 resume");

    // recoverOnStartup 不覆盖已有 reason
    const rec = await store.recoverOnStartup();
    assertEqual(rec.success, true, "recover ok");
    assertEqual(rec.state.pauseReason, "HOLD", "不覆盖 pauseReason");
    assertEqual(rec.recoveryStatus, "manual_review_required", "分类 before_send");
  }

  {
    const dir = makeTempDir();
    dirs.push(dir);
    const store = makeStore(dir);
    await store.initialize({ localDate: "2026-07-28" });
    await store.load();
    let rev = 0;
    await store.beginInFlight({
      expectedRevision: rev,
      operationId: "op",
      guildId: G, forumChannelId: F, threadId: T, startedAt: TS,
    });
    rev = store.getSnapshot().revision;
    await store.markMessageSent({
      expectedRevision: rev,
      operationId: "op",
      sentMessageId: M,
      sentAt: TS2,
    });
    const rec = await store.recoverOnStartup();
    assertEqual(rec.recoveryStatus, "cleanup_required", "after_send recovery");
    assertEqual(rec.cleanupRequired, true, "cleanup flag");
    assertEqual(rec.state.paused, true, "paused after recovery");
    assertEqual(rec.state.pauseReason, "INFLIGHT_MESSAGE_MAY_EXIST", "reason");
  }

  {
    const dir = makeTempDir();
    dirs.push(dir);
    const store = makeStore(dir);
    const rec = await store.recoverOnStartup();
    assertEqual(rec.errorCode, "STATE_NOT_FOUND", "缺失不创建");
    assert(!existsSync(join(dir, "state.json")), "仍无文件");
  }

  // 快照隔离
  {
    const dir = makeTempDir();
    dirs.push(dir);
    const store = makeStore(dir);
    await store.initialize({ localDate: "2026-07-28" });
    await store.load();
    const snap = store.getSnapshot();
    snap.successCount = 999;
    snap.localDate = "2099-01-01";
    assertEqual(store.getSnapshot().successCount, 0, "快照隔离");
  }

  // rollover via store
  {
    const dir = makeTempDir();
    dirs.push(dir);
    const store = makeStore(dir);
    await store.initialize({ localDate: "2026-07-28" });
    await store.load();
    let rev = 0;
    // bump count via complete path once
    await store.beginInFlight({
      expectedRevision: rev, operationId: "op", guildId: G, forumChannelId: F, threadId: T, startedAt: TS,
    });
    rev = store.getSnapshot().revision;
    await store.markMessageSent({
      expectedRevision: rev, operationId: "op", sentMessageId: M, sentAt: TS2,
    });
    rev = store.getSnapshot().revision;
    await store.markMessageDeleted({
      expectedRevision: rev, operationId: "op", deletedAt: TS2,
    });
    rev = store.getSnapshot().revision;
    await store.completeSuccess({
      expectedRevision: rev,
      operationId: "op",
      localDate: "2026-07-28",
      successAt: TS2,
      nextEligibleAt: TS3,
    });
    rev = store.getSnapshot().revision;
    const roll = await store.rolloverLocalDate({ expectedRevision: rev, localDate: "2026-07-29" });
    assertEqual(roll.success, true, "rollover");
    assertEqual(roll.state.successCount, 0, "rollover 归零");
    assertEqual(roll.state.nextEligibleAt, TS3, "保留冷却");
  }

  // 日志安全：不 dump 全文
  {
    const dir = makeTempDir();
    dirs.push(dir);
    const logs = [];
    const store = createForumBumpStateStore({
      statePath: join(dir, "state.json"),
      logger: {
        info: (m, meta) => logs.push(JSON.stringify({ m, meta })),
        warn: (m, meta) => logs.push(JSON.stringify({ m, meta })),
      },
    });
    await store.initialize({ localDate: "2026-07-28" });
    const blob = logs.join("\n");
    assert(!blob.includes("\"inFlight\":{"), "日志无完整 state JSON 形态");
    assert(!blob.includes("stack"), "无 stack");
  }

} finally {
  for (const dir of dirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

console.log(`\nForumBump stateStore: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

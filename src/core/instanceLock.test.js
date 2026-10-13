/**
 * 单实例锁：对外行为测试（真实子进程）。
 */
import { spawn, spawnSync } from "child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { createInstanceLock, readProcessStartTime, INSTANCE_LOCK_BUSY_EXIT_CODE } from "./instanceLock.js";

let passed = 0;
let failed = 0;
function assert(c, l) {
  if (c) { passed++; console.log(`  PASS: ${l}`); } else { failed++; console.error(`  FAIL: ${l}`); }
}

const lockModuleUrl = pathToFileURL(fileURLToPath(new URL("./instanceLock.js", import.meta.url))).href;
const root = mkdtempSync(join(tmpdir(), "instance-lock-"));
let n = 0;
const freshLockPath = () => join(root, `case-${++n}`, "bell.lock");
const hasProc = readProcessStartTime(process.pid) !== null;

/** 子进程：获取锁 → 写 won 文件 → 等 gate → 释放；失败以 exitCode 退出。 */
const holder = join(root, "holder.mjs");
writeFileSync(holder, `
import { createInstanceLock } from ${JSON.stringify(lockModuleUrl)};
import { existsSync, writeFileSync } from "fs";
const [lockPath, wonPath, gatePath, goPath] = process.argv.slice(2);
while (goPath && !existsSync(goPath)) await new Promise((r) => setTimeout(r, 2));
try {
  const lock = createInstanceLock({ lockPath });
  lock.acquire();
  writeFileSync(wonPath, String(process.pid));
  while (!existsSync(gatePath)) await new Promise((r) => setTimeout(r, 5));
  lock.release();
  process.exit(0);
} catch (e) {
  process.exit(e.exitCode ?? 1);
}
`);

const waitFor = async (cond, ms = 5000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 5));
  }
  return false;
};
const exitOf = (child) => new Promise((res) => {
  if (child.exitCode != null) res(child.exitCode);
  else child.once("exit", (code) => res(code));
});
function deadPid() {
  for (let pid = 4194000; pid > 1000; pid -= 1) {
    try { process.kill(pid, 0); } catch (e) { if (e.code === "ESRCH") return pid; }
  }
  throw new Error("no dead pid");
}
function acquireFresh(lockPath) {
  const lock = createInstanceLock({ lockPath });
  const r = lock.acquire();
  const content = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.release();
  return { r, content };
}

try {
  // 获取 / 内容 / 释放
  {
    const lockPath = freshLockPath();
    const lock = createInstanceLock({ lockPath });
    lock.acquire();
    const content = JSON.parse(readFileSync(lockPath, "utf8"));
    assert(content.pid === process.pid, "锁文件含本进程 pid");
    assert(content.startTime === readProcessStartTime(process.pid), "锁文件含本进程 startTime（无 /proc 时为 null）");
    assert(lock.release().released === true && !existsSync(lockPath), "正常释放删除锁文件");
  }

  // 释放时锁文件已不是本进程的 → 不删除
  {
    const lockPath = freshLockPath();
    const lock = createInstanceLock({ lockPath });
    lock.acquire();
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid + 100000, startTime: null }));
    assert(lock.release().released === false && existsSync(lockPath), "锁文件 pid 不是本进程时不删除");
  }

  // 第二个实例并发启动 → exit 78
  {
    const lockPath = freshLockPath();
    const dir = join(lockPath, "..");
    mkdirSync(dir, { recursive: true });
    const won = join(dir, "won");
    const gate = join(dir, "gate");
    const first = spawn(process.execPath, [holder, lockPath, won, gate], { stdio: "ignore" });
    await waitFor(() => existsSync(won));
    const second = spawnSync(process.execPath, [holder, lockPath, join(dir, "won2"), gate], { timeout: 10000 });
    assert(second.status === INSTANCE_LOCK_BUSY_EXIT_CODE, `第二个实例 exit 78（got ${second.status}）`);
    writeFileSync(gate, "1");
    assert(await exitOf(first) === 0, "第一个实例不受影响并正常退出");
  }

  // 死 pid 的过期锁被接管
  {
    const lockPath = freshLockPath();
    mkdirSync(join(lockPath, ".."), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), startTime: null }));
    const { r, content } = acquireFresh(lockPath);
    assert(r.acquired && r.reclaimed && content.pid === process.pid, "死 pid 的过期锁被接管");
  }

  // startTime 不符（pid 复用）→ 接管
  if (hasProc) {
    const lockPath = freshLockPath();
    mkdirSync(join(lockPath, ".."), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: process.ppid, startTime: "1" }));
    const { r, content } = acquireFresh(lockPath);
    assert(r.acquired && r.reclaimed && content.pid === process.pid, "存活 pid 但 startTime 不符 → 接管");

    const lockPath2 = freshLockPath();
    mkdirSync(join(lockPath2, ".."), { recursive: true });
    writeFileSync(lockPath2, JSON.stringify({ pid: process.ppid, startTime: readProcessStartTime(process.ppid) }));
    let code = null;
    try { createInstanceLock({ lockPath: lockPath2 }).acquire(); } catch (e) { code = e.exitCode; }
    assert(code === 78, "存活 pid 且 startTime 一致 → 占用（78）");
  } else {
    console.log("  (跳过 startTime 用例：无 /proc)");
  }

  // 损坏的锁文件被接管
  {
    const lockPath = freshLockPath();
    mkdirSync(join(lockPath, ".."), { recursive: true });
    writeFileSync(lockPath, "{not json");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath, old, old);
    const { r, content } = acquireFresh(lockPath);
    assert(r.acquired && r.reclaimed && content.pid === process.pid, "损坏的锁文件被接管");
    assert(readdirSync(join(lockPath, "..")).every((f) => !f.includes(".stale.")), "接管后不残留 .stale 文件");
  }

  // 残留 .takeover 守卫：清理后同一进程重试一次 acquire
  const old = () => new Date(Date.now() - 60_000);
  const staleSetup = () => {
    const lockPath = freshLockPath();
    mkdirSync(join(lockPath, ".."), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), startTime: null }));
    writeFileSync(`${lockPath}.takeover`, "");
    utimesSync(`${lockPath}.takeover`, old(), old());
    return lockPath;
  };
  {
    const lockPath = staleSetup();
    let cleaned = 0;
    const lock = createInstanceLock({ lockPath, onStaleGuardCleaned: () => { cleaned += 1; } });
    let r = null;
    try { r = lock.acquire(); } catch { /* */ }
    assert(cleaned === 1 && r?.acquired === true, "残留守卫清理后同一进程获取到锁（不退出 78）");
    assert(!existsSync(`${lockPath}.takeover`), "守卫已删除");
    lock.release();
  }
  {
    const lockPath = staleSetup();
    const lock = createInstanceLock({
      lockPath,
      onStaleGuardCleaned: () => writeFileSync(lockPath, JSON.stringify({
        pid: process.ppid, startTime: readProcessStartTime(process.ppid),
      })),
    });
    let err = null;
    try { lock.acquire(); } catch (e) { err = e; }
    assert(err?.exitCode === 78 && err?.code === "INSTANCE_LOCK_BUSY", "清理守卫后重试遇到存活锁 → 78");
  }
  {
    const lockPath = staleSetup();
    const lock = createInstanceLock({
      lockPath,
      onStaleGuardCleaned: () => writeFileSync(`${lockPath}.takeover`, ""),
    });
    let err = null;
    try { lock.acquire(); } catch (e) { err = e; }
    assert(err?.exitCode === 1 && err?.code === "INSTANCE_LOCK_TAKEOVER_BUSY", "重试又遇到新守卫 → exit 1（可恢复，非 78）");
  }
  {
    // 新鲜守卫（首次即遇到）：他人正在接管 → 78
    const lockPath = freshLockPath();
    mkdirSync(join(lockPath, ".."), { recursive: true });
    writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), startTime: null }));
    writeFileSync(`${lockPath}.takeover`, "");
    let err = null;
    try { createInstanceLock({ lockPath }).acquire(); } catch (e) { err = e; }
    assert(err?.exitCode === 78, "首次遇到新鲜守卫 → 78");
  }

  // 非预期 errno → INSTANCE_LOCK_IO_FAILED / exit 1，不按 78、不接管
  if (typeof process.getuid === "function" && process.getuid() !== 0) {
    {
      // 接管守卫创建 EACCES：锁目录只读（锁文件可读、过期）
      const lockPath = freshLockPath();
      const dir = join(lockPath, "..");
      mkdirSync(dir, { recursive: true });
      const staleBody = JSON.stringify({ pid: deadPid(), startTime: null });
      writeFileSync(lockPath, staleBody);
      chmodSync(dir, 0o555);
      let err = null;
      try { createInstanceLock({ lockPath }).acquire(); } catch (e) { err = e; } finally { chmodSync(dir, 0o755); }
      assert(err?.exitCode === 1 && err?.code === "INSTANCE_LOCK_IO_FAILED" && err.message.includes("接管守卫"),
        `守卫创建 EACCES → IO_FAILED / exit 1（got ${err?.code}/${err?.exitCode}）`);
      assert(readFileSync(lockPath, "utf8") === staleBody && !existsSync(`${lockPath}.takeover`), "锁文件未被改动，无守卫残留");
    }
    {
      // 读锁 EACCES：不得当作损坏接管
      const lockPath = freshLockPath();
      mkdirSync(join(lockPath, ".."), { recursive: true });
      const body = JSON.stringify({ pid: process.ppid, startTime: readProcessStartTime(process.ppid) });
      writeFileSync(lockPath, body);
      const oldTime = old();
      utimesSync(lockPath, oldTime, oldTime);
      chmodSync(lockPath, 0o000);
      let err = null;
      try { createInstanceLock({ lockPath }).acquire(); } catch (e) { err = e; } finally { chmodSync(lockPath, 0o644); }
      assert(err?.exitCode === 1 && err?.code === "INSTANCE_LOCK_IO_FAILED" && err.message.includes("无法读取"),
        `读锁 EACCES → IO_FAILED / exit 1（got ${err?.code}/${err?.exitCode}）`);
      const files = readdirSync(join(lockPath, ".."));
      assert(readFileSync(lockPath, "utf8") === body && files.length === 1, "读失败时锁文件原样保留，未被接管");
    }
  } else {
    console.log("  (跳过 POSIX chmod 用例：平台不支持 getuid，或 root 不受权限限制)");
  }

  // tryCreate 部分写失败留下空锁文件：过了 2s 宽限按损坏接管
  {
    const lockPath = freshLockPath();
    mkdirSync(join(lockPath, ".."), { recursive: true });
    writeFileSync(lockPath, "");
    utimesSync(lockPath, old(), old());
    const { r, content } = acquireFresh(lockPath);
    assert(r.reclaimed && content.pid === process.pid, "空锁文件（宽限已过）被接管");
  }
  {
    const lockPath = freshLockPath();
    mkdirSync(join(lockPath, ".."), { recursive: true });
    writeFileSync(lockPath, "");
    const t0 = Date.now();
    const { r, content } = acquireFresh(lockPath);
    const waited = Date.now() - t0;
    assert(r.reclaimed && content.pid === process.pid && waited >= 1900,
      `新建的空锁文件等宽限期过后才被接管（waited=${waited}ms）`);
  }

  // 并发接管同一过期锁：恰好一个胜者（循环多次）
  {
    const ROUNDS = 50;
    const RACERS = 4;
    let okRounds = 0;
    for (let round = 0; round < ROUNDS; round += 1) {
      const lockPath = freshLockPath();
      const dir = join(lockPath, "..");
      mkdirSync(dir, { recursive: true });
      writeFileSync(lockPath, JSON.stringify({ pid: deadPid(), startTime: null }));
      const go = join(dir, "go");
      const gate = join(dir, "gate");
      const wonPaths = [];
      const children = [];
      for (let i = 0; i < RACERS; i += 1) {
        const won = join(dir, `won-${i}`);
        wonPaths.push(won);
        children.push(spawn(process.execPath, [holder, lockPath, won, gate, go], { stdio: "ignore" }));
      }
      await new Promise((r) => setTimeout(r, 120));
      writeFileSync(go, "1");
      const codes = new Array(RACERS).fill(null);
      children.forEach((c, i) => c.once("exit", (code) => { codes[i] = code; }));
      // 败者都退出、胜者持锁等待 gate
      await waitFor(() => codes.filter((c) => c !== null).length >= RACERS - 1, 10000);
      await new Promise((r) => setTimeout(r, 50));
      const winners = wonPaths.filter((p) => existsSync(p)).length;
      const losers78 = codes.filter((c) => c === INSTANCE_LOCK_BUSY_EXIT_CODE).length;
      writeFileSync(gate, "1");
      const finals = await Promise.all(children.map(exitOf));
      if (winners === 1 && losers78 === RACERS - 1 && finals.filter((c) => c === 0).length === 1) okRounds += 1;
      else console.error(`  round ${round}: winners=${winners} codes=${JSON.stringify(finals)}`);
    }
    assert(okRounds === ROUNDS, `并发接管 ${ROUNDS} 轮 × ${RACERS} 进程：每轮恰好 1 个胜者，其余 exit 78（ok=${okRounds}）`);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n[instanceLock.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

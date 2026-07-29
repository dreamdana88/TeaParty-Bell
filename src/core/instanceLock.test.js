/**
 * 跨进程单实例锁测试（含子进程 exit 78）。
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import { pathToFileURL } from "url";
import { createInstanceLock, INSTANCE_LOCK_BUSY_EXIT_CODE } from "./instanceLock.js";

let passed = 0;
let failed = 0;
function assert(c, l) {
  if (c) { passed++; console.log(`  PASS: ${l}`); }
  else { failed++; console.error(`  FAIL: ${l}`); }
}
function assertEqual(a, e, l) {
  assert(a === e, `${l} (got ${JSON.stringify(a)})`);
}

console.log("\n=== instanceLock ===\n");

const dirs = [];
try {
  {
    const dir = mkdtempSync(join(tmpdir(), "il-"));
    dirs.push(dir);
    const lockPath = join(dir, "t.lock");
    const lock = createInstanceLock({ lockPath, pid: 111 });
    const a = lock.acquire();
    assert(a.acquired, "首次获取成功");
    assert(existsSync(lockPath), "锁文件存在");
    lock.release();
    assert(!existsSync(lockPath), "释放后删除");
    const b = createInstanceLock({ lockPath, pid: 222 });
    assert(b.acquire().acquired, "释放后可再获取");
    b.release();
  }

  {
    const dir = mkdtempSync(join(tmpdir(), "il-"));
    dirs.push(dir);
    const lockPath = join(dir, "t.lock");
    const alive = createInstanceLock({
      lockPath,
      pid: 1,
      isProcessAlive: (p) => p === 1,
    });
    alive.acquire();
    let threw = false;
    try {
      createInstanceLock({
        lockPath,
        pid: 2,
        isProcessAlive: (p) => p === 1,
      }).acquire();
    } catch (e) {
      threw = true;
      assertEqual(e.exitCode, INSTANCE_LOCK_BUSY_EXIT_CODE, "busy exit 78");
      assertEqual(e.code, "INSTANCE_LOCK_BUSY", "INSTANCE_LOCK_BUSY");
    }
    assert(threw, "第二把锁失败");
    alive.release();
  }

  {
    const dir = mkdtempSync(join(tmpdir(), "il-"));
    dirs.push(dir);
    const lockPath = join(dir, "t.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: 999999, acquiredAt: "2020-01-01T00:00:00.000Z" }));
    const lock = createInstanceLock({
      lockPath,
      pid: 42,
      isProcessAlive: () => false,
    });
    assert(lock.acquire().acquired, "陈旧锁可回收");
    lock.release();
  }

  // 子进程：父持锁，子获取失败 exit 78；释放后可获取
  {
    const dir = mkdtempSync(join(tmpdir(), "il-sub2-"));
    dirs.push(dir);
    const lockPath = join(dir, "p.lock");
    const parent = createInstanceLock({
      lockPath,
      pid: process.pid,
      isProcessAlive: (p) => p === process.pid,
    });
    parent.acquire();

    const lockModuleUrl = pathToFileURL(
      join(process.cwd(), "src/core/instanceLock.js"),
    ).href;

    const childScript = join(dir, "child.mjs");
    writeFileSync(childScript, `
import { createInstanceLock } from ${JSON.stringify(lockModuleUrl)};
try {
  createInstanceLock({
    lockPath: process.argv[2],
    pid: 1,
    isProcessAlive: () => true,
  }).acquire();
  process.exit(0);
} catch (e) {
  process.exit(e.exitCode ?? 1);
}
`);
    const r = spawnSync(process.execPath, [childScript, lockPath], {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    assertEqual(r.status, 78, "子进程 exit 78");
    parent.release();

    const child2 = join(dir, "child2.mjs");
    writeFileSync(child2, `
import { createInstanceLock } from ${JSON.stringify(lockModuleUrl)};
try {
  const l = createInstanceLock({
    lockPath: process.argv[2],
    pid: 3,
    isProcessAlive: () => false,
  });
  l.acquire();
  l.release();
  process.exit(0);
} catch (e) {
  process.exit(e.exitCode ?? 1);
}
`);
    const r2 = spawnSync(process.execPath, [child2, lockPath], {
      encoding: "utf8",
      cwd: process.cwd(),
    });
    assertEqual(r2.status, 0, "释放后可获取");
  }
} finally {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  }
}

console.log(`\ninstanceLock: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

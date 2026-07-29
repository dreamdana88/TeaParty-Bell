/**
 * 实例锁 Review Fix2：原子发布 + 非法锁 fail-closed + 真并发互斥。
 */
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
  mkdirSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawn, spawnSync } from "child_process";
import { pathToFileURL } from "url";
import {
  createInstanceLock,
  INSTANCE_LOCK_BUSY_EXIT_CODE,
} from "./instanceLock.js";

let passed = 0;
let failed = 0;
function assert(c, l) {
  if (c) { passed++; console.log(`  PASS: ${l}`); }
  else { failed++; console.error(`  FAIL: ${l}`); }
}
function assertEqual(a, e, l) {
  assert(a === e, `${l} (got ${JSON.stringify(a)})`);
}

console.log("\n=== instanceLock Fix2 ===\n");

const dirs = [];
const lockModuleUrl = pathToFileURL(
  join(process.cwd(), "src/core/instanceLock.js"),
).href;

function parseCanonical(lockPath) {
  const raw = readFileSync(lockPath, "utf8");
  const data = JSON.parse(raw);
  return data;
}

await (async function main() {
try {
  // 基础获取/释放 + payload 完整
  {
    const dir = mkdtempSync(join(tmpdir(), "il2-"));
    dirs.push(dir);
    const lockPath = join(dir, "t.lock");
    const lock = createInstanceLock({ lockPath, pid: 111 });
    const a = lock.acquire();
    assert(a.acquired, "首次获取");
    assert(existsSync(lockPath), "canonical 存在");
    const disk = parseCanonical(lockPath);
    assertEqual(disk.pid, 111, "pid");
    assert(typeof disk.ownerToken === "string" && disk.ownerToken.length >= 8, "ownerToken");
    assert(typeof disk.acquiredAt === "string", "acquiredAt");
    lock.release();
    assert(!existsSync(lockPath), "释放删除");
  }

  // 活 PID busy
  {
    const dir = mkdtempSync(join(tmpdir(), "il2-"));
    dirs.push(dir);
    const lockPath = join(dir, "t.lock");
    const a = createInstanceLock({
      lockPath, pid: 1, isProcessAlive: (p) => p === 1,
    });
    a.acquire();
    let threw = false;
    try {
      createInstanceLock({
        lockPath, pid: 2, isProcessAlive: (p) => p === 1,
      }).acquire();
    } catch (e) {
      threw = true;
      assertEqual(e.exitCode, 78, "busy 78");
      assertEqual(e.code, "INSTANCE_LOCK_BUSY", "INSTANCE_LOCK_BUSY");
    }
    assert(threw, "第二把失败");
    assert(existsSync(lockPath), "锁仍在");
    const disk = parseCanonical(lockPath);
    assertEqual(disk.pid, 1, "owner 仍是 A");
    a.release();
  }

  // 原子发布：temp 写完、link 前 — canonical 不存在；最终仅一方持锁且 payload 完整
  {
    const dir = mkdtempSync(join(tmpdir(), "il2-atom-"));
    dirs.push(dir);
    const lockPath = join(dir, "t.lock");
    let sawCanonicalBeforePublish = false;
    let sawIncomplete = false;
    let aOk = false;
    let bCode = null;
    let holder = null;

    try {
      const a = createInstanceLock({
        lockPath,
        pid: 20,
        isProcessAlive: (p) => p === 20 || p === 21,
        afterTempWriteBeforePublish: () => {
          if (existsSync(lockPath)) {
            sawCanonicalBeforePublish = true;
            try {
              const raw = readFileSync(lockPath, "utf8");
              if (!raw.trim()) sawIncomplete = true;
              else parseCanonical(lockPath);
            } catch {
              sawIncomplete = true;
            }
          }
          try {
            const b = createInstanceLock({
              lockPath,
              pid: 21,
              isProcessAlive: (p) => p === 20 || p === 21,
            });
            b.acquire();
            bCode = "acquired";
            holder = b;
          } catch (e) {
            bCode = e.code;
          }
        },
      });
      a.acquire();
      aOk = true;
      holder = a;
    } catch {
      aOk = false;
    }

    assert(!sawCanonicalBeforePublish, "link 前无 canonical 路径");
    assert(!sawIncomplete, "从未出现不完整 canonical");
    const winners = (aOk ? 1 : 0) + (bCode === "acquired" ? 1 : 0);
    assertEqual(winners, 1, "恰好一个 winner");
    if (aOk) {
      assertEqual(bCode, "INSTANCE_LOCK_BUSY", "A 胜 → B busy");
    } else {
      assertEqual(bCode, "acquired", "B 胜 → A 失败");
    }
    assert(existsSync(lockPath), "canonical 存在");
    const disk = parseCanonical(lockPath);
    assert(typeof disk.ownerToken === "string" && disk.ownerToken.length >= 8, "payload 完整");
    holder?.release?.();
  }

  // 非法 canonical：空/残缺/缺字段 — 无论年龄，不 reclaim
  for (const [label, content] of [
    ["空文件", ""],
    ["部分 JSON", "{not-json"],
    ["缺 ownerToken", JSON.stringify({ pid: 1, acquiredAt: "x" })],
    ["非法 ownerToken", JSON.stringify({ pid: 1, ownerToken: "short", acquiredAt: "x" })],
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "il2-inv-"));
    dirs.push(dir);
    const lockPath = join(dir, "t.lock");
    writeFileSync(lockPath, content);
    const before = readFileSync(lockPath);
    let threw = false;
    try {
      createInstanceLock({
        lockPath,
        pid: 99,
        isProcessAlive: () => false,
      }).acquire();
    } catch (e) {
      threw = true;
      assertEqual(e.code, "INSTANCE_LOCK_INVALID", `${label} → INVALID`);
      assertEqual(e.exitCode, 78, `${label} exit 78`);
    }
    assert(threw, `${label} 抛错`);
    assertEqual(readFileSync(lockPath).toString(), before.toString(), `${label} 文件不变`);
  }

  // 合法死 PID reclaim
  {
    const dir = mkdtempSync(join(tmpdir(), "il2-dead-"));
    dirs.push(dir);
    const lockPath = join(dir, "t.lock");
    writeFileSync(lockPath, `${JSON.stringify({
      pid: 999999,
      ownerToken: "deadtoken12345678",
      acquiredAt: "2020-01-01T00:00:00.000Z",
    })}\n`);
    const lock = createInstanceLock({
      lockPath,
      pid: 42,
      isProcessAlive: () => false,
    });
    const r = lock.acquire();
    assert(r.acquired, "死 PID reclaim");
    const disk = parseCanonical(lockPath);
    assertEqual(disk.pid, 42, "新 owner pid");
    assert(disk.ownerToken !== "deadtoken12345678", "新 ownerToken");
    lock.release();
  }

  // ownerToken 不匹配 release 不删
  {
    const dir = mkdtempSync(join(tmpdir(), "il2-rel-"));
    dirs.push(dir);
    const lockPath = join(dir, "t.lock");
    const a = createInstanceLock({ lockPath, pid: 50, isProcessAlive: (p) => p === 50 });
    a.acquire();
    const zombie = createInstanceLock({ lockPath, pid: 50, isProcessAlive: () => false });
    assertEqual(zombie.release().released, false, "未持锁不删");
    assert(existsSync(lockPath), "锁仍在");
    a.release();
  }

  // 发布前崩溃：只遗留 temp，不阻塞
  {
    const dir = mkdtempSync(join(tmpdir(), "il2-temp-"));
    dirs.push(dir);
    const lockPath = join(dir, "t.lock");
    const temp = join(dir, `.t.lock.tmp.orphanjunk12`);
    writeFileSync(temp, "orphan");
    const lock = createInstanceLock({ lockPath, pid: 70 });
    assert(lock.acquire().acquired, "遗留 temp 不阻塞");
    assert(existsSync(lockPath), "canonical 正常");
    lock.release();
  }

  // 子进程：父持锁，子 78；释放后可获取
  {
    const dir = mkdtempSync(join(tmpdir(), "il2-sub-"));
    dirs.push(dir);
    const lockPath = join(dir, "p.lock");
    const parent = createInstanceLock({
      lockPath,
      pid: process.pid,
      isProcessAlive: (p) => p === process.pid,
    });
    parent.acquire();
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
    const r = spawnSync(process.execPath, [childScript, lockPath], { cwd: process.cwd() });
    assertEqual(r.status, 78, "子进程 exit 78");
    parent.release();
    const child2 = join(dir, "child2.mjs");
    writeFileSync(child2, `
import { createInstanceLock } from ${JSON.stringify(lockModuleUrl)};
try {
  const l = createInstanceLock({ lockPath: process.argv[2], pid: 3, isProcessAlive: () => false });
  l.acquire();
  l.release();
  process.exit(0);
} catch (e) {
  process.exit(e.exitCode ?? 1);
}
`);
    assertEqual(
      spawnSync(process.execPath, [child2, lockPath], { cwd: process.cwd() }).status,
      0,
      "释放后可获取",
    );
  }

  // 真并发互斥：同步屏障，胜者等 gate，败者必须在胜者 release 前 exit 78
  {
    const dir = mkdtempSync(join(tmpdir(), "il2-race-"));
    dirs.push(dir);
    const lockPath = join(dir, "race.lock");
    const gatePath = join(dir, "gate.txt");
    const resultDir = join(dir, "results");
    mkdirSync(resultDir);

    const raceScript = join(dir, "race.mjs");
    writeFileSync(raceScript, `
import { createInstanceLock } from ${JSON.stringify(lockModuleUrl)};
import { writeFileSync, existsSync, readFileSync } from "fs";
import { setTimeout as sleep } from "timers/promises";

const lockPath = process.argv[2];
const gatePath = process.argv[3];
const outPath = process.argv[4];
const readyPath = process.argv[5];
const goPath = process.argv[6];

// 就绪
writeFileSync(readyPath, "1");
// 等 go
while (!existsSync(goPath)) {
  await sleep(5);
}
try {
  const l = createInstanceLock({ lockPath });
  l.acquire();
  writeFileSync(outPath, JSON.stringify({
    role: "winner",
    pid: process.pid,
    at: Date.now(),
  }));
  // 等待父进程 release gate
  while (!existsSync(gatePath)) {
    await sleep(10);
  }
  l.release();
  process.exit(0);
} catch (e) {
  writeFileSync(outPath, JSON.stringify({
    role: "busy",
    code: e.code,
    exitCode: e.exitCode,
    at: Date.now(),
  }));
  process.exit(e.exitCode ?? 1);
}
`);

    const ready1 = join(dir, "ready1");
    const ready2 = join(dir, "ready2");
    const go = join(dir, "go");
    const out1 = join(resultDir, "1.json");
    const out2 = join(resultDir, "2.json");

    const c1 = spawn(process.execPath, [raceScript, lockPath, gatePath, out1, ready1, go], {
      cwd: process.cwd(),
      stdio: "ignore",
    });
    const c2 = spawn(process.execPath, [raceScript, lockPath, gatePath, out2, ready2, go], {
      cwd: process.cwd(),
      stdio: "ignore",
    });

    // 等两子进程就绪
    const waitReady = async (p) => {
      for (let i = 0; i < 200; i += 1) {
        if (existsSync(p)) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error("ready timeout");
    };
    await waitReady(ready1);
    await waitReady(ready2);
    // 同时开闸
    writeFileSync(go, "1");

    // 等两个结果文件之一出现 winner，且另一为 busy（在 release gate 前）
    let r1 = null;
    let r2 = null;
    for (let i = 0; i < 300; i += 1) {
      if (existsSync(out1) && existsSync(out2)) {
        r1 = JSON.parse(readFileSync(out1, "utf8"));
        r2 = JSON.parse(readFileSync(out2, "utf8"));
        break;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    assert(r1 && r2, "两进程均产出结果");
    const roles = [r1.role, r2.role].sort();
    assertEqual(roles.join(","), "busy,winner", "恰好 1 winner + 1 busy");
    const winnerCount = [r1, r2].filter((x) => x.role === "winner").length;
    const busyCount = [r1, r2].filter((x) => x.role === "busy").length;
    assertEqual(winnerCount, 1, "winnerCount=1");
    assertEqual(busyCount, 1, "busyCount=1");
    const busy = r1.role === "busy" ? r1 : r2;
    assertEqual(busy.exitCode, 78, "败者 exitCode 78");
    // 败者必须在 gate 前结束（gate 尚不存在）
    assert(!existsSync(gatePath), "败者结束时 gate 未开（持锁区间不重叠）");

    // 放行胜者
    writeFileSync(gatePath, "1");
    const waitExit = (child, ms) => new Promise((res) => {
      if (child.exitCode != null || child.signalCode != null) {
        res(child.exitCode);
        return;
      }
      const t = setTimeout(() => {
        try { child.kill(); } catch { /* */ }
        res(child.exitCode ?? -1);
      }, ms);
      child.once("exit", (code) => {
        clearTimeout(t);
        res(code);
      });
    });
    const codes = await Promise.all([waitExit(c1, 5000), waitExit(c2, 5000)]);
    const exitWins = codes.filter((c) => c === 0).length;
    const exitBusy = codes.filter((c) => c === 78).length;
    assertEqual(exitWins, 1, "进程 winner exit 0");
    assertEqual(exitBusy, 1, "进程 busy exit 78");
  }
} finally {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  }
}

console.log(`\ninstanceLock Fix2: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;
})();

/**
 * TeaParty-Bell 全量测试运行器（跨平台）。
 *
 * 统计每个文件的 passed/failed 行，输出精确汇总。
 * 进程级失败（非零退出/信号终止）计入文件失败。
 *
 * 用法：node scripts/run-tests.mjs  或  npm test
 */

import { execSync } from "child_process";
import { readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

function findTestFiles(dir) {
  const results = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (entry === "node_modules" || entry === ".git") continue;
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) results.push(...findTestFiles(fullPath));
      else if (entry.endsWith(".test.js")) results.push(fullPath);
    } catch {}
  }
  return results;
}

const testFiles = findTestFiles(join(projectRoot, "src"))
  .concat(findTestFiles(join(projectRoot, "scripts")));

console.log(`\nTeaParty-Bell 全量测试`);
console.log(`测试文件总数: ${testFiles.length}\n`);

let totalPassed = 0;
let totalFailed = 0;
let filesPassed = 0;
let filesFailed = 0;
const processFailedFiles = [];

for (const file of testFiles) {
  const relative = file.replace(projectRoot + "/", "").replace(projectRoot + "\\", "");

  let output = "";
  let processOk = true;
  let signalKill = null;
  try {
    output = execSync(`node "${file}"`, { encoding: "utf-8", cwd: projectRoot, stdio: ["ignore", "pipe", "pipe"] });
  } catch (err) {
    output = (err.stdout ?? "") + (err.stderr ?? "");
    processOk = false;
    if (err.signal) signalKill = err.signal;
  }

  const passMatches = [...output.matchAll(/PASS:/g)];
  const failMatches = [...output.matchAll(/FAIL:/g)];
  const filePassed = passMatches.length;
  const fileFailed = failMatches.length;

  totalPassed += filePassed;
  totalFailed += fileFailed;

  const hasProcessFailure = !processOk || signalKill;

  if (fileFailed === 0 && !hasProcessFailure) {
    filesPassed++;
  } else {
    filesFailed++;
    if (hasProcessFailure) {
      processFailedFiles.push(relative + (signalKill ? ` (signal: ${signalKill})` : " (exit ≠ 0)"));
    }
  }

  const mark = (fileFailed > 0 || hasProcessFailure) ? " <<< FAIL" : "";
  console.log(`  ${relative}: ${filePassed} passed / ${fileFailed} failed${mark}`);
}

if (processFailedFiles.length > 0) {
  console.log(`\n进程级失败文件:`);
  processFailedFiles.forEach(f => console.log(`  ${f}`));
}

console.log(`\n====================================`);
console.log(`文件级: ${filesPassed} passed / ${filesFailed} failed`);
console.log(`用例级: ${totalPassed} passed / ${totalFailed} failed`);
console.log(`进程退出码: ${(filesFailed > 0 || totalFailed > 0) ? 1 : 0}`);
console.log(`====================================`);

if (filesFailed > 0 || totalFailed > 0) {
  process.exit(1);
}

/**
 * TeaParty-Bell 全量测试运行器（跨平台）。
 *
 * 用法：node scripts/run-tests.mjs
 *   或：npm test
 */

import { execSync } from "child_process";
import { readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

/**
 * 递归查找所有 .test.js 文件。
 */
function findTestFiles(dir) {
  const results = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    if (entry === "node_modules" || entry === ".git") continue;
    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        results.push(...findTestFiles(fullPath));
      } else if (entry.endsWith(".test.js")) {
        results.push(fullPath);
      }
    } catch {
      // skip inaccessible
    }
  }
  return results;
}

const testFiles = findTestFiles(join(projectRoot, "src")).concat(
  findTestFiles(join(projectRoot, "scripts"))
);

console.log(`找到 ${testFiles.length} 个测试文件\n`);

let passed = 0;
let failed = 0;
const failedFiles = [];

for (const file of testFiles) {
  const relative = file.replace(projectRoot + "/", "").replace(projectRoot + "\\", "");
  console.log(`--- ${relative} ---`);
  try {
    execSync(`node "${file}"`, { stdio: "inherit", cwd: projectRoot });
    passed++;
  } catch {
    failed++;
    failedFiles.push(relative);
  }
}

console.log("\n====================================");
console.log(`全量测试完成`);
console.log(`文件级: ${passed} passed / ${failed} failed`);
console.log("====================================");

if (failed > 0) {
  console.log(`\n失败文件：`);
  failedFiles.forEach((f) => console.log(`  ${f}`));
  process.exit(1);
}

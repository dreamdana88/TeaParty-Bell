import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { parseForumScanArgs } from "./forum-scan.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, label);
}

console.log("\n=== scripts/forum-scan entry ===\n");

{
  const args = parseForumScanArgs([
    "--forum", "111111111111111111",
    "--silence-days", "30",
    "--confirm-guild", "222222222222222222",
  ]);
  assertEqual(args.forumIds.length, 1, "re-export parse");
}

{
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
  assertEqual(pkg.scripts["forum:scan"], "node scripts/forum-scan.js", "package.json forum:scan");
  assert(!pkg.scripts.prestart, "无 prestart");
  assert(!pkg.scripts.postinstall, "无 postinstall");
}

{
  const source = readFileSync(join(__dirname, "forum-scan.js"), "utf8");
  assert(!source.includes("createGatewayHealthMonitor"), "不启 Health");
  assert(!source.includes("createStartupPreflight"), "不启 Preflight");
  assert(!source.includes("setupBoostObserver"), "不启 Boost");
  assert(!source.includes("createManualInteractionRouter"), "不启 Router");
  assert(!source.includes("createAlertOutbox"), "不启 Outbox");
}

{
  const scanner = readFileSync(
    join(__dirname, "..", "src", "features", "forumBump", "forumScanner.js"),
    "utf8",
  );
  assert(!scanner.includes(".send("), "scanner 无 send 调用");
  assert(!scanner.includes(".delete("), "scanner 无 delete 调用");
  assert(!scanner.includes("setArchived"), "scanner 无 setArchived");
}

console.log(`\nscripts/forum-scan: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

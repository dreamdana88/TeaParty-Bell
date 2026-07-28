import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { parseForumPocArgs } from "./forum-poc.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label}`);
}

console.log("\n=== scripts/forum-poc entry ===\n");

{
  const args = parseForumPocArgs([
    "bump-message",
    "--thread", "1",
    "--confirm-guild", "2",
  ]);
  assertEqual(args.execute, false, "入口 re-export parse：默认 dry-run");
}

{
  const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf8"));
  assertEqual(pkg.scripts["forum:poc"], "node scripts/forum-poc.js", "package.json 含 forum:poc");
  assert(!pkg.scripts.prestart, "无 prestart");
  assert(!pkg.scripts.postinstall, "无 postinstall");
}

{
  const source = readFileSync(join(__dirname, "forum-poc.js"), "utf8");
  assert(!source.includes("createGatewayHealthMonitor"), "入口不启动 Health Monitor");
  assert(!source.includes("createStartupPreflight"), "入口不启动 Preflight");
  assert(!source.includes("setupBoostObserver"), "入口不启动 Boost Observer");
  assert(!source.includes("createManualInteractionRouter"), "入口不启动 Interaction Router");
  assert(!source.includes("createAlertOutbox"), "入口不启动 Alert Outbox");
  assert(!source.includes("start("), "入口不调用生产 start()");
}

console.log(`\nscripts/forum-poc: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

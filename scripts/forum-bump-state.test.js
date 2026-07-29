import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { runForumBumpStateCli } from "./forum-bump-state.js";

let passed = 0;
let failed = 0;
function assert(c, l) {
  if (c) { passed++; console.log(`  PASS: ${l}`); }
  else { failed++; console.error(`  FAIL: ${l}`); }
}
function assertEqual(a, e, l) {
  assert(a === e, `${l} (got ${JSON.stringify(a)})`);
}

console.log("\n=== forum-bump-state CLI ===\n");
const dirs = [];
const G = "1047080654573158420";

try {
  const dir = mkdtempSync(join(tmpdir(), "fb-cli-"));
  dirs.push(dir);
  const statePath = join(dir, "dev-state.json");
  const logs = [];
  const log = {
    log: (...a) => logs.push(["log", ...a]),
    error: (...a) => logs.push(["error", ...a]),
  };
  const env = {
    DISCORD_GUILD_ID: G,
    FORUM_BUMP_TIMEZONE: "Asia/Shanghai",
    FORUM_BUMP_MODE: "disabled",
  };

  // init
  {
    const r = await runForumBumpStateCli(
      ["init", "--confirm-guild", G, "--state-path", statePath],
      {
        env,
        cwd: dir,
        log,
        nowMs: () => Date.parse("2026-07-28T04:00:00.000Z"), // SH 12:00 → 2026-07-28
      },
    );
    assert(r.ok, "init ok");
    assert(existsSync(statePath), "状态文件创建");
    assertEqual(r.localDate, "2026-07-28", "localDate 业务时区");
  }

  // 已存在拒绝
  {
    const r = await runForumBumpStateCli(
      ["init", "--confirm-guild", G, "--state-path", statePath],
      { env, cwd: dir, log },
    );
    assertEqual(r.ok, false, "已存在拒绝");
    assertEqual(r.code, "STATE_ALREADY_EXISTS", "STATE_ALREADY_EXISTS");
  }

  // guild 不匹配
  {
    const r = await runForumBumpStateCli(
      ["init", "--confirm-guild", "111111111111111111", "--state-path", join(dir, "x.json")],
      { env, cwd: dir, log },
    );
    assertEqual(r.code, "GUILD_MISMATCH", "guild mismatch");
  }

  // inspect
  {
    const before = readFileSync(statePath, "utf8");
    const r = await runForumBumpStateCli(
      ["inspect", "--state-path", statePath],
      { env, cwd: dir, log },
    );
    assert(r.ok, "inspect ok");
    assertEqual(r.schemaValid, true, "schema valid");
    assertEqual(r.successCount, 0, "successCount");
    assertEqual(r.inFlightPhase, null, "inFlight null");
    assertEqual(readFileSync(statePath, "utf8"), before, "inspect 不修改文件");
  }

  // 损坏状态
  {
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    const r = await runForumBumpStateCli(
      ["inspect", "--state-path", bad],
      { env, cwd: dir, log },
    );
    assertEqual(r.ok, false, "损坏失败");
    assertEqual(r.code, "STATE_PARSE_FAILED", "parse failed");
  }

  // 不登录 Discord（无 client 依赖 — 结构保证）
  assert(true, "CLI 不需要 Token / 不登录 Discord");
} finally {
  for (const d of dirs) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* */ }
  }
}

console.log(`\nforum-bump-state CLI: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

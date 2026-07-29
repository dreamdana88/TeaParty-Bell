/**
 * 动态配置 Store / schema 测试。
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  validateDynamicConfig,
  createDynamicConfigDocument,
  mergeDynamicConfigPatch,
  baselineDynamicConfigFromEnv,
  FORUM_BUMP_DYNAMIC_CONFIG_VERSION,
} from "./dynamicConfigSchema.js";
import { createForumBumpDynamicConfigStore } from "./dynamicConfigStore.js";

let passed = 0;
let failed = 0;
function assert(c, l) {
  if (c) { passed++; console.log(`  PASS: ${l}`); }
  else { failed++; console.error(`  FAIL: ${l}`); }
}
function assertEqual(a, e, l) {
  assert(a === e, `${l} (got ${JSON.stringify(a)})`);
}

const F = "1420375965963653180";
const F2 = "1420375965963653181";
const dirs = [];

console.log("\n=== forumBump dynamicConfig ===\n");

function validDoc(extra = {}) {
  return createDynamicConfigDocument({
    dailyLimit: 3,
    activeStart: "10:00",
    activeEnd: "22:00",
    forumChannelIds: [F],
    silenceDays: 30,
    updatedAt: null,
    updatedBy: null,
    revision: 0,
    ...extra,
  });
}

// schema 合法
{
  const d = validateDynamicConfig(validDoc());
  assertEqual(d.version, FORUM_BUMP_DYNAMIC_CONFIG_VERSION, "version");
  assertEqual(d.dailyLimit, 3, "dailyLimit");
}

// 未知字段拒绝
{
  try {
    validateDynamicConfig({ ...validDoc(), extraField: 1 });
    failed++; console.error("  FAIL: 未知字段应拒绝");
  } catch (e) {
    assertEqual(e.code, "DYNAMIC_CONFIG_INVALID", "未知字段 INVALID");
  }
}

// 间隔过短
{
  try {
    validateDynamicConfig(validDoc({ activeStart: "10:00", activeEnd: "10:40", dailyLimit: 2 }));
    failed++; console.error("  FAIL: 短间隔应拒绝");
  } catch (e) {
    assertEqual(e.code, "DYNAMIC_CONFIG_INTERVAL_TOO_SHORT", "TOO_SHORT");
  }
}

// silenceDays 范围
{
  try {
    validateDynamicConfig(validDoc({ silenceDays: 0 }));
    failed++; console.error("  FAIL: silenceDays 0");
  } catch (e) {
    assertEqual(e.code, "DYNAMIC_CONFIG_INVALID", "silenceDays 0");
  }
  try {
    validateDynamicConfig(validDoc({ silenceDays: 3651 }));
    failed++; console.error("  FAIL: silenceDays 3651");
  } catch (e) {
    assertEqual(e.code, "DYNAMIC_CONFIG_INVALID", "silenceDays 3651");
  }
}

// merge patch
{
  const cur = validateDynamicConfig(validDoc());
  const m = mergeDynamicConfigPatch(cur, { dailyLimit: 5, silenceDays: 14 });
  assertEqual(m.dailyLimit, 5, "merge dailyLimit");
  assertEqual(m.silenceDays, 14, "merge silenceDays");
  assertEqual(m.activeStart, "10:00", "保留 activeStart");
}

// 文件缺失
{
  const dir = mkdtempSync(join(tmpdir(), "fb-dc-"));
  dirs.push(dir);
  const store = createForumBumpDynamicConfigStore({
    configPath: join(dir, "config.json"),
    logger: { info() {}, warn() {}, error() {} },
  });
  const r = await store.load();
  assertEqual(r.success, false, "缺失 load 失败");
  assertEqual(r.errorCode, "DYNAMIC_CONFIG_NOT_FOUND", "NOT_FOUND");
  assertEqual(store.exists(), false, "exists false");
}

// 首次 save 创建 + 再 load
{
  const dir = mkdtempSync(join(tmpdir(), "fb-dc-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  const store = createForumBumpDynamicConfigStore({
    configPath: path,
    clock: { now: () => Date.parse("2026-07-28T12:00:00.000Z") },
    logger: { info() {}, warn() {}, error() {} },
  });
  const base = validDoc({ revision: 0 });
  const s = await store.save({ config: base, expectedRevision: 0, updatedBy: "admin:1" });
  assert(s.success, "首次 save");
  assertEqual(s.revision, 1, "revision 1");
  assert(existsSync(path), "文件已创建");
  assertEqual(s.config.updatedBy, "admin:1", "updatedBy");

  const store2 = createForumBumpDynamicConfigStore({
    configPath: path,
    logger: { info() {}, warn() {}, error() {} },
  });
  const l = await store2.load();
  assert(l.success, "重启 load");
  assertEqual(l.config.dailyLimit, 3, "持久化 dailyLimit");
  assertEqual(l.config.revision, 1, "持久化 revision");
}

// revision 冲突
{
  const dir = mkdtempSync(join(tmpdir(), "fb-dc-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  const store = createForumBumpDynamicConfigStore({
    configPath: path,
    logger: { info() {}, warn() {}, error() {} },
  });
  await store.save({ config: validDoc(), expectedRevision: 0 });
  const c = await store.save({
    config: validDoc({ dailyLimit: 5 }),
    expectedRevision: 0,
  });
  assertEqual(c.success, false, "旧 revision 冲突");
  assertEqual(c.errorCode, "DYNAMIC_CONFIG_REVISION_CONFLICT", "CONFLICT");
}

// 非法 schema fail closed（不覆盖）
{
  const dir = mkdtempSync(join(tmpdir(), "fb-dc-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, "{not json", "utf8");
  const store = createForumBumpDynamicConfigStore({
    configPath: path,
    logger: { info() {}, warn() {}, error() {} },
  });
  const l = await store.load();
  assertEqual(l.success, false, "损坏 load 失败");
  assertEqual(l.errorCode, "DYNAMIC_CONFIG_PARSE_FAILED", "PARSE");
  assertEqual(readFileSync(path, "utf8"), "{not json", "文件未覆盖");
}

// 未知字段磁盘
{
  const dir = mkdtempSync(join(tmpdir(), "fb-dc-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify({ ...validDoc({ revision: 1 }), evil: true }), "utf8");
  const store = createForumBumpDynamicConfigStore({
    configPath: path,
    logger: { info() {}, warn() {}, error() {} },
  });
  const l = await store.load();
  assertEqual(l.success, false, "未知字段失败");
  assertEqual(l.errorCode, "DYNAMIC_CONFIG_INVALID", "INVALID");
}

// baseline from env
{
  const b = baselineDynamicConfigFromEnv({
    dailyLimit: 5,
    activeStart: "08:00",
    activeEnd: "13:00",
    forumChannelIds: [F, F2],
    silenceDays: 14,
  });
  assertEqual(b.dailyLimit, 5, "baseline dailyLimit");
  assertEqual(b.forumChannelIds.length, 2, "baseline forums");
  assertEqual(b.revision, 0, "baseline revision 0");
}

// 串行写
{
  const dir = mkdtempSync(join(tmpdir(), "fb-dc-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  const store = createForumBumpDynamicConfigStore({
    configPath: path,
    logger: { info() {}, warn() {}, error() {} },
  });
  const p1 = store.save({ config: validDoc({ dailyLimit: 3 }), expectedRevision: 0 });
  const p2 = store.save({ config: validDoc({ dailyLimit: 4 }), expectedRevision: 0 });
  const [r1, r2] = await Promise.all([p1, p2]);
  const wins = [r1, r2].filter((x) => x.success).length;
  const conflicts = [r1, r2].filter((x) => x.errorCode === "DYNAMIC_CONFIG_REVISION_CONFLICT").length;
  assertEqual(wins, 1, "串行仅一成功");
  assertEqual(conflicts, 1, "另一冲突");
}

for (const d of dirs) {
  try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(`\n=== dynamicConfig: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);

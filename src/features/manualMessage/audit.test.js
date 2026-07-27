/** Manual Message 结构化审计测试。 */

import {
  MANUAL_MESSAGE_AUDIT_EVENT,
  buildManualMessageAuditRecord,
  createManualMessageAudit,
} from "./audit.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label} (${JSON.stringify(expected)})`);
}

console.log("\n=== Manual Message audit ===\n");

const now = new Date("2026-07-27T00:00:00.000Z");
const entry = {
  action: "reply",
  source: "discord_context_menu",
  actor: { id: "actor-1", username: "admin", displayName: "管理员" },
  guildId: "guild-1",
  channelId: "channel-1",
  targetMessageId: "target-1",
  sentMessageId: "sent-1",
  contentLength: 12,
  success: true,
  errorCode: null,
  content: "绝不应进入审计",
  allowedMentions: { users: ["secret-user"] },
  token: "secret-token",
};

{
  const record = buildManualMessageAuditRecord(entry, now);
  assertEqual(record.timestamp, "2026-07-27T00:00:00.000Z", "timestamp");
  assertEqual(record.action, "reply", "action");
  assertEqual(record.actorId, "actor-1", "actorId");
  assertEqual(record.actorUsername, "admin", "actorUsername");
  assertEqual(record.actorDisplayName, "管理员", "actorDisplayName");
  assertEqual(record.sentMessageId, "sent-1", "sentMessageId");
  assertEqual(record.success, true, "success");
  assert(!("content" in record), "不记录完整正文");
  assert(!("allowedMentions" in record), "不记录 allowedMentions");
  assert(!("token" in record), "不记录 Token");
}

{
  const calls = [];
  const logger = {
    info: (message, data) => calls.push({ level: "info", message, data }),
    error: () => {},
  };
  const audit = createManualMessageAudit({ logger });
  const result = audit.record({ ...entry, success: false, errorCode: "SEND_FAILED", sentMessageId: null });
  assertEqual(result.written, true, "正常写入成功");
  assertEqual(calls.length, 1, "logger.info 调用一次");
  assertEqual(calls[0].message, MANUAL_MESSAGE_AUDIT_EVENT, "统一审计事件名");
  assertEqual(calls[0].data.errorCode, "SEND_FAILED", "失败记录 errorCode");
  assertEqual(calls[0].data.success, false, "失败记录 success=false");
}

{
  const logger = {
    info: () => { throw new Error("logger unavailable"); },
    error: () => { throw new Error("logger unavailable twice"); },
  };
  const audit = createManualMessageAudit({ logger });
  let result;
  try { result = audit.record(entry); } catch { failed++; console.error("  FAIL: logger 失败不应向上抛出"); }
  assertEqual(result?.written, false, "logger 失败返回 written=false");
}

console.log(`\n[audit.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);

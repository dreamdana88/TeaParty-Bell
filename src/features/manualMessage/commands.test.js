import { ApplicationCommandType, PermissionFlagsBits } from "discord.js";
import {
  buildManualReplyCommand,
  getManualMessageCommands,
  MANUAL_REPLY_COMMAND_NAME,
} from "./commands.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label} (${JSON.stringify(expected)})`);
}

console.log("\n=== Manual Message Commands ===\n");

const command = buildManualReplyCommand().toJSON();
assertEqual(command.name, MANUAL_REPLY_COMMAND_NAME, "命令名称");
assertEqual(command.type, ApplicationCommandType.Message, "命令类型为 Message Context Menu");
assertEqual(command.default_member_permissions, String(PermissionFlagsBits.Administrator), "默认权限为 Administrator");
assertEqual(getManualMessageCommands().length, 1, "只导出一个人工回复命令");
assert(!("description" in command), "不生成 Slash Command description");

console.log(`\n[commands.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);

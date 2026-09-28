import { classifyMemberQuery, memberOptionLabel } from "./memberQuery.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed += 1; console.log(`  PASS: ${label}`); }
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

assert(classifyMemberQuery("  奈 ").kind === "prefix", "名字开头按前缀搜索");
assert(classifyMemberQuery("1047080654573158420").kind === "id", "用户 ID 精确查找");
assert(classifyMemberQuery("").ok === false, "空搜索拒绝");
assert(classifyMemberQuery("a".repeat(33)).ok === false, "超长搜索拒绝");
assert(memberOptionLabel({
  nickname: "奈洛莉",
  username: "damantou618",
  userId: "1",
}).startsWith("奈洛莉"), "选项优先显示服务器昵称");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

import { classifyMemberQuery, memberOptionLabel, obSeatLabel } from "./memberQuery.js";

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
assert(obSeatLabel({
  userId: "1404419757679050814",
  nickname: "森之黑山羊",
  username: "blackgoat",
  globalName: "Goat",
}) === "OB 森之黑山羊 (blackgoat)", "OB 显示服务器昵称和用户名");
assert(obSeatLabel({
  userId: "1",
  username: "ho2",
}) === "OB ho2", "只有用户名时不重复括号");
assert(obSeatLabel({
  userId: "1414886136375148705",
  globalName: "奈洛莉",
  username: "nellie",
}) === "OB 奈洛莉 (nellie)", "没有服务器昵称时用全局名");
{
  const missing = obSeatLabel({ userId: "1362486959028572461" });
  assert(missing.startsWith("OB 未能读取名字") && missing.endsWith("2461"), "读不到名字时只留末四位");
  assert(!missing.includes("1362486959028572461"), "读不到名字时不铺整段用户 ID");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

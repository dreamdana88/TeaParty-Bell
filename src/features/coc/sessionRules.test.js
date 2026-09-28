import { planNicknameRestore } from "./nickname.js";
import { planChannelNames } from "./channelName.js";
import { buildRoomOverwrites } from "./channelAccess.js";
import { PermissionFlagsBits } from "discord.js";
import {
  cancelSignup,
  createRecruitingSession,
  requestStart,
  signupPl,
  signupOb,
} from "./sessionRules.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed += 1; console.log(`  PASS: ${label}`); }
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

const base = createRecruitingSession({
  sessionId: "s1",
  guildId: "g",
  recruitChannelId: "c",
  recruitMessageId: "m",
  kpUserId: "kp",
  title: "常暗之厢",
  now: 1,
});

{
  const joined = signupPl([base], base, "kl1", "奈洛莉");
  assert(joined.ok && joined.session.pl[0].characterName === "奈洛莉", "KL 报名记下角色名");
  const switched = signupOb([joined.session], joined.session, "kl1");
  assert(switched.ok && switched.session.pl.length === 0 && switched.session.ob.length === 1, "KL 可以换成 OB");
  const back = signupPl([switched.session], switched.session, "kl1", "江某");
  assert(back.ok && back.session.ob.length === 0 && back.session.pl[0].characterName === "江某", "OB 可以换成 KL");
}
assert(signupPl([base], base, "kp", "奈洛莉").ok === false, "KP 不能报名 KL");
assert(requestStart(base, "other").ok === false, "普通用户不能开始");
assert(requestStart(base, "kp").message.includes("至少需要一名调查员"), "没有 KL 不能开始");
assert(cancelSignup(base, "kp").ok === false, "KP 不能取消自己的报名身份");

assert(planNicknameRestore({
  originalNickname: "Dream",
  appliedNickname: "奈洛莉",
  currentNickname: "奈洛莉",
}).nickname === "Dream", "昵称仍是角色名时恢复");
assert(planNicknameRestore({
  originalNickname: null,
  appliedNickname: "奈洛莉",
  currentNickname: "奈洛莉",
}).action === "clear", "原来没有昵称时清除");
assert(planNicknameRestore({
  originalNickname: "Dream",
  appliedNickname: "奈洛莉",
  currentNickname: "奈洛莉今天也不想掉SAN",
}).action === "skip", "中途改过的昵称不动");
assert(planNicknameRestore({
  originalNickname: "Dream",
  appliedNickname: null,
  currentNickname: "奈洛莉",
}).action === "skip", "没改成功就不恢复");

{
  const names = planChannelNames("常暗之厢", ["🎲COC・常暗之厢"]);
  assert(names[0] === "🎲COC・常暗之厢-2", "重名加序号");
}
{
  const overwrites = buildRoomOverwrites({ guildId: "g", botUserId: "bot", userIds: ["kp", "kl"] });
  assert(overwrites[0].id === "g" && overwrites[0].deny.includes(PermissionFlagsBits.ViewChannel), "everyone 不能看见");
  assert(overwrites.some((row) => row.id === "kl" && row.allow.includes(PermissionFlagsBits.SendMessages)), "KL 可以发言");
  assert(!overwrites.some((row) => row.id === "stranger"), "未报名的人不在覆盖里");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

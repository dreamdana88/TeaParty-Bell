import { planNicknameRestore } from "./nickname.js";
import { planChannelNames } from "./channelName.js";
import { buildRoomOverwrites } from "./channelAccess.js";
import { PermissionFlagsBits } from "discord.js";
import {
  activeSessionInChannel,
  cancelSignup,
  createRecruitingSession,
  eligibleSecretPl,
  gateSecretAdmin,
  MAX_SECRET_THREADS,
  normalizeThreadName,
  planSecretThreadSync,
  removableSecretPl,
  requestStart,
  revertEnding,
  secretThreadsOf,
  signupPl,
  signupOb,
  SESSION_STATES,
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
  assert(overwrites.some((row) => row.id === "kl" && row.allow.includes(PermissionFlagsBits.SendMessagesInThreads)), "KL 可以在子区发言");
  assert(overwrites.some((row) => row.id === "bot" && row.allow.includes(PermissionFlagsBits.CreatePrivateThreads)), "Bot 可以创建私密子区");
  assert(overwrites.some((row) => row.id === "bot" && row.allow.includes(PermissionFlagsBits.ManageThreads)), "Bot 可以管理子区");
  assert(!overwrites.some((row) => row.id === "kl" && row.allow.includes(PermissionFlagsBits.CreatePrivateThreads)), "PL 不能自己建私密子区");
  assert(!overwrites.some((row) => row.id === "stranger"), "未报名的人不在覆盖里");
}

{
  assert(normalizeThreadName("  密谈  ") === "密谈", "子区名称去掉两端空白");
  assert(normalizeThreadName("") === null, "空名称无效");
  const session = {
    ...base,
    state: SESSION_STATES.active,
    kpUserId: "kp",
    pl: [{ userId: "pl", characterName: "奈洛莉" }, { userId: "pl2", characterName: "江某" }],
    ob: [{ userId: "ob" }],
    runChannelId: "room",
    secretThreads: [
      { threadId: "t2", name: "后建", createdAt: 20, plUserIds: ["pl"] },
      { threadId: "t1", name: "先建", createdAt: 10, plUserIds: ["pl", "pl"] },
    ],
  };
  assertEqual(secretThreadsOf(session).map((thread) => thread.threadId).join(","), "t1,t2", "子区按创建顺序");
  assertEqual(secretThreadsOf(session)[0].plUserIds.join(","), "pl", "参与 PL 去重");
  assert(gateSecretAdmin(session, "pl").ok === false, "非 KP 不能管秘密交流");
  assert(gateSecretAdmin({ ...session, state: "ENDED" }, "kp").ok === false, "已结束不能管秘密交流");
  assert(eligibleSecretPl(session, session.secretThreads[1]).map((member) => member.userId).join(",") === "pl2", "增补只列未加入的本团 PL");
  assertEqual(removableSecretPl(session, { plUserIds: ["pl", "gone"] }).join(","), "pl", "移除只列仍在本团的 PL");
  assert(activeSessionInChannel([session], "t1")?.sessionId === "s1", "秘密子区视为本团跑团频道");
  assert(activeSessionInChannel([session], "other") == null, "无关频道不是本团");
  const toOb = planSecretThreadSync({
    ...session,
    secretThreads: [
      { threadId: "t1", name: "先建", createdAt: 10, plUserIds: ["pl"] },
      { threadId: "t2", name: "后建", createdAt: 20, plUserIds: [] },
    ],
  }, "pl", "ob", "pl");
  assertEqual(toOb.adds.join(","), "t2", "PL 转 OB 时补进未点名的秘密子区");
  assert(toOb.secretThreads.every((thread) => !thread.plUserIds.includes("pl")), "转 OB 后从点名名单里拿掉");
  const leave = planSecretThreadSync(session, "pl", null, "pl");
  assertEqual(leave.removes.join(","), "t1,t2", "移出本局时退出全部秘密子区");
  const fromOb = planSecretThreadSync({
    ...session,
    secretThreads: [
      { threadId: "t1", name: "先建", createdAt: 10, plUserIds: [] },
      { threadId: "t2", name: "后建", createdAt: 20, plUserIds: [] },
    ],
  }, "ob", "pl", "ob");
  assertEqual(fromOb.removes.join(","), "t1,t2", "OB 转 PL 时退出未点名的秘密子区");
  const newPl = planSecretThreadSync(session, "pl2", "pl", null);
  assert(newPl.adds.length === 0 && newPl.removes.length === 0, "新 PL 不自动进入已有秘密子区");
  assertEqual(MAX_SECRET_THREADS, 25, "秘密子区上限是 25");
  const reverted = revertEnding({ state: SESSION_STATES.ending, endedAt: 5, deleteAt: 99 });
  assert(reverted.state === SESSION_STATES.active && reverted.endedAt == null && reverted.deleteAt == null, "收尾失败回到进行中并清掉删除倒计时");
}

function assertEqual(actual, expected, label) {
  if (actual === expected) { passed += 1; console.log(`  PASS: ${label}`); }
  else { failed += 1; console.error(`  FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

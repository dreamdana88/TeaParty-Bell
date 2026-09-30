import { mkdtempSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseBonusPenalty, rollBonusPenalty } from "./dice/bonusPenalty.js";
import { formatRoll, rollDice } from "./dice/roller.js";
import { formatBonusPenalty, formatTextDice } from "./textDice.js";
import { createCocSessionService } from "./sessionService.js";
import { createCocSessionStore } from "./sessionStore.js";
import { DELETE_AFTER_MS, SETTLED_RETENTION_MS } from "./sessionRules.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed += 1; console.log(`  PASS: ${label}`); }
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  if (actual === expected) { passed += 1; console.log(`  PASS: ${label}`); }
  else { failed += 1; console.error(`  FAIL: ${label} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`); }
}

function fakeDiscord(overrides = {}) {
  const calls = [];
  const nicks = new Map(Object.entries(overrides.nicks ?? { kl: "Dream" }));
  return {
    calls,
    async listSiblingNames() { return overrides.names ?? []; },
    async createTextChannel(input) {
      calls.push(["create", input.names[0]]);
      if (overrides.failCreate) throw new Error("create failed");
      return { id: "room-1" };
    },
    async deleteChannel(id) { calls.push(["delete", id]); },
    async addRole(_guildId, userId, roleId) {
      calls.push(["add", userId, roleId]);
      if (overrides.failRole) throw new Error("role failed");
      if (overrides.failAddRole === roleId && calls.filter((call) => call[0] === "add" && call[2] === roleId).length > (overrides.failAddRoleAfter ?? 0)) {
        throw new Error("later add failed");
      }
    },
    async removeRole(_guildId, userId, roleId) {
      calls.push(["remove", userId, roleId]);
      if (overrides.failRemoveRole === roleId) throw new Error("remove failed");
      if (overrides.failFirstRemove && calls.filter((call) => call[0] === "remove").length === 1) {
        throw new Error("first role remove failed");
      }
    },
    async fetchNickname(_guildId, userId) {
      return nicks.has(userId) ? nicks.get(userId) : null;
    },
    async setNickname(_guildId, userId, nickname) {
      calls.push(["nick", userId, nickname]);
      if (overrides.failNick) throw new Error("nick failed");
      if (nickname == null && overrides.replaceClearedNick) {
        nicks.set(userId, overrides.replaceClearedNick);
        return;
      }
      nicks.set(userId, nickname);
    },
    async fetchGuildMember(_guildId, userId) {
      if (overrides.missing?.includes(userId)) throw new Error("missing member");
      return {
        userId,
        bot: Boolean(overrides.bots?.includes(userId)),
        nickname: nicks.has(userId) ? nicks.get(userId) : null,
      };
    },
    async grantChannelAccess(channelId, userId) {
      calls.push(["grant", channelId, userId]);
      if (overrides.failGrant) throw new Error("grant failed");
    },
    async revokeChannelAccess(channelId, userId) { calls.push(["revoke", channelId, userId]); },
    async lockChannel(id) {
      calls.push(["lock", id, overrides.observeState?.() ?? null]);
    },
    async sendMessage(_channelId, payload) {
      calls.push(["send", payload ?? null]);
      if (payload?.files) {
        const sent = calls.filter((call) => call[0] === "send" && call[1]?.files).length;
        if (overrides.failSendFile || sent === overrides.failSendPart) throw new Error("file failed");
      }
      return "control-1";
    },
    async fetchChannelHistory(channelId, options) {
      calls.push(["history", channelId, options ?? null]);
      if (overrides.failHistory) throw new Error("history failed");
      return overrides.history ?? { messages: [], truncated: false };
    },
    async editMessage() { calls.push(["edit"]); },
  };
}

function harness(discordOverrides = {}) {
  const { config: configOverrides = {}, randomInt, ...rest } = discordOverrides;
  const dir = mkdtempSync(join(tmpdir(), "coc-mvp-"));
  const store = createCocSessionStore({ filePath: join(dir, "sessions.json") });
  const discord = fakeDiscord(rest);
  let now = 1_000;
  const service = createCocSessionService({
    store,
    discord,
    config: {
      enabled: true,
      guildId: "guild",
      categoryId: "cat",
      kpRoleId: "role-kp",
      plRoleId: "role-pl",
      obRoleId: "role-ob",
      botUserId: "bot",
      messageContentEnabled: false,
      transcriptEnabled: false,
      ...configOverrides,
    },
    clock: { now: () => now },
    logger: { warn() {}, error() {} },
    createId: () => "session-1",
    randomInt,
  });
  return { service, discord, store, dir, setNow: (value) => { now = value; } };
}

function containsText(value, needle) {
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.some((item) => containsText(item, needle));
  if (value && typeof value === "object") return Object.values(value).some((item) => containsText(item, needle));
  return false;
}

{
  const { service, discord, store } = harness();
  await store.load();
  const opened = await service.openRecruit({
    guildId: "guild",
    channelId: "public",
    kpUserId: "kp",
    title: "常暗之厢",
    messageId: "panel",
  });
  assert(opened.ok, "KP 成功开团");
  const kl = await service.joinPl("session-1", "kl", "奈洛莉");
  assert(kl.ok && kl.session.pl[0].characterName === "奈洛莉", "KL 填写角色名");
  const ob = await service.joinOb("session-1", "ob");
  assert(ob.ok && ob.session.ob.length === 1, "OB 报名");
  const again = await service.openRecruit({
    guildId: "guild", channelId: "public", kpUserId: "kp", title: "另一场", messageId: null,
  });
  assert(again.ok === false, "同一人不能再开一团");
  const started = await service.confirmStart("session-1", "kp");
  assert(started.ok && started.session.state === "ACTIVE", "正式开始");
  assert(discord.calls.some((call) => call[0] === "create"), "创建了频道");
  assert(discord.calls.some((call) => call[0] === "add" && call[2] === "role-pl"), "PL 获得 PL 身份组");
  assert(discord.calls.some((call) => call[0] === "nick" && call[2] === "奈洛莉"), "KL 昵称改成角色名");
  const second = await service.confirmStart("session-1", "kp");
  assert(second.ok === false, "重复开始不会再建频道");
  assertEqual(discord.calls.filter((call) => call[0] === "create").length, 1, "只创建了一次频道");
  const outside = await service.roll({ channelId: "elsewhere", userId: "kl", displayName: "Dream", expression: "1d100" });
  assert(outside.ok === false, "普通频道拒绝骰子");
  const inside = await service.roll({
    channelId: "room-1",
    userId: "kl",
    displayName: "Dream",
    expression: "1d100",
  });
  assert(inside.ok && inside.text.includes("奈洛莉") && inside.text.includes("1d100"), "跑团频道允许骰子并使用角色名");
  const ended = await service.finish("session-1", "kl");
  assert(ended.ok === false, "非 KP 不能结束");
  const done = await service.finish("session-1", "kp");
  assert(done.ok && done.session.deleteAt === 1_000 + DELETE_AFTER_MS, "结束写入 48 小时");
  assert(discord.calls.some((call) => call[0] === "nick" && call[2] === "Dream"), "结束时恢复原昵称");
  assert(discord.calls.some((call) => call[0] === "remove"), "结束时卸下身份组");
  assert(discord.calls.some((call) => call[0] === "lock"), "结束时锁定发言");
  assert(!discord.calls.some((call) => call[0] === "history"), "关闭团录时不读频道历史");
}

{
  const { service, discord, store, setNow } = harness({ nicks: { kl: null } });
  await store.load();
  await service.openRecruit({
    guildId: "guild", channelId: "public", kpUserId: "kp", title: "无昵称", messageId: "panel",
  });
  await service.joinPl("session-1", "kl", "奈洛莉");
  await service.confirmStart("session-1", "kp");
  await service.finish("session-1", "kp");
  assert(discord.calls.some((call) => call[0] === "nick" && call[2] === null), "原来没有昵称时清除");
  setNow(1_000 + DELETE_AFTER_MS);
  const deleted = await service.deleteIfDue("session-1");
  assert(deleted.deleted === true, "到点删除频道");
}

{
  const { service, discord, store } = harness({ failRole: true });
  await store.load();
  await service.openRecruit({
    guildId: "guild", channelId: "public", kpUserId: "kp", title: "半成品", messageId: "panel",
  });
  await service.joinPl("session-1", "kl", "奈洛莉");
  const started = await service.confirmStart("session-1", "kp");
  assert(started.ok === false, "身份组失败则不开团");
  assert(discord.calls.some((call) => call[0] === "delete"), "失败后删掉刚建的频道");
  assert(service.find("session-1").state === "RECRUITING", "回到招募");
}

{
  const { service, store } = harness({ failNick: true });
  await store.load();
  await service.openRecruit({
    guildId: "guild", channelId: "public", kpUserId: "kp", title: "改名失败", messageId: "panel",
  });
  await service.joinPl("session-1", "kl", "奈洛莉");
  const started = await service.confirmStart("session-1", "kp");
  assert(started.ok && started.session.pl[0].appliedNickname === null, "改名失败仍开团且不记恢复义务");
}

{
  const dir = mkdtempSync(join(tmpdir(), "coc-bad-"));
  const store = createCocSessionStore({ filePath: join(dir, "sessions.json") });
  const { writeFileSync } = await import("fs");
  writeFileSync(store.filePath, "{", "utf8");
  const loaded = await store.load();
  assert(loaded.ok === false, "损坏的场次文件 fail closed");
  const update = await store.update((state) => ({ state }));
  assert(update.ok === false, "损坏后不写成空名单");
}

{
  const box = {};
  const { service, discord, store } = harness({
    observeState: () => box.store?.snapshot()?.sessions?.[0]?.state ?? null,
  });
  box.store = store;
  await store.load();
  await service.openRecruit({
    guildId: "guild", channelId: "public", kpUserId: "kp", title: "收尾", messageId: "panel",
  });
  await service.joinPl("session-1", "kl", "奈洛莉");
  await service.confirmStart("session-1", "kp");
  await service.finish("session-1", "kp");
  const lock = discord.calls.find((call) => call[0] === "lock");
  assertEqual(lock?.[2], "ENDING", "清理房间前已经写成 ENDING");
}

{
  const { service, discord, store } = harness({ nicks: { kl: "奈洛莉" } });
  await store.load();
  await store.update((state) => ({
    state: {
      ...state,
      sessions: [{
        sessionId: "stuck",
        state: "STARTING",
        guildId: "guild",
        recruitChannelId: "public",
        recruitMessageId: "panel",
        runChannelId: "orphan-room",
        controlMessageId: null,
        rolesGranted: true,
        kpUserId: "kp",
        title: "中断",
        pl: [{ userId: "kl", characterName: "奈洛莉", originalNickname: "Dream", appliedNickname: "奈洛莉" }],
        ob: [],
        createdAt: 1,
        startedAt: null,
        endedAt: null,
        deleteAt: null,
        channelDeleted: false,
      }],
    },
    result: null,
  }));
  await service.recoverInterrupted();
  assertEqual(service.find("stuck").state, "RECRUITING", "重启后未完成的开团回到招募");
  assert(discord.calls.some((call) => call[0] === "delete" && call[1] === "orphan-room"), "重启后删掉半成品频道");
  assert(discord.calls.some((call) => call[0] === "nick" && call[2] === "Dream"), "重启后恢复已改过的昵称");
  assert(discord.calls.some((call) => call[0] === "remove"), "重启后卸下已发的身份组");
}

{
  const { service, discord, store, setNow } = harness();
  await store.load();
  setNow(SETTLED_RETENTION_MS + 5_000);
  await store.update((state) => ({
    state: {
      ...state,
      sessions: [{
        sessionId: "old",
        state: "CANCELLED",
        guildId: "guild",
        recruitChannelId: "public",
        recruitMessageId: null,
        runChannelId: null,
        controlMessageId: null,
        kpUserId: "kp",
        title: "旧招募",
        pl: [],
        ob: [],
        createdAt: 1,
        startedAt: null,
        endedAt: 1,
        deleteAt: null,
        channelDeleted: false,
      }],
    },
    result: null,
  }));
  await service.recoverInterrupted();
  assert(service.find("old") == null, "过期的取消记录会被清掉");
  assertEqual(discord.calls.length, 0, "清理历史记录不碰 Discord");
}

{
  const { service, discord, store } = harness({ failFirstRemove: true });
  await store.load();
  await service.openRecruit({
    guildId: "guild", channelId: "public", kpUserId: "kp", title: "逐个卸", messageId: "panel",
  });
  await service.joinPl("session-1", "kl", "奈洛莉");
  await service.confirmStart("session-1", "kp");
  await service.finish("session-1", "kp");
  assert(discord.calls.filter((call) => call[0] === "remove").length > 1, "一个身份组卸失败后继续卸其他人");
}

async function activeTable(overrides) {
  const env = harness(overrides);
  await env.store.load();
  await env.service.openRecruit({
    guildId: "guild", channelId: "public", kpUserId: "kp", title: "成员", messageId: "panel",
  });
  await env.service.joinPl("session-1", "pl", "奈洛莉");
  await env.service.joinOb("session-1", "ob");
  await env.service.confirmStart("session-1", "kp");
  await env.service.setControlMessage("session-1", "control");
  return env;
}

{
  const { service, discord } = await activeTable({ bots: ["robot"] });
  assert(service.previewMembers("session-1", "pl").ok === false, "PL 不能管理成员");
  assert(service.previewMembers("session-1", "ob").ok === false, "OB 不能管理成员");
  const added = await service.addOb("session-1", "kp", "guest");
  assert(added.ok && added.session.ob.some((member) => member.userId === "guest"), "KP 添加外部 OB");
  assert(discord.calls.some((call) => call[0] === "grant" && call[2] === "guest"), "外部 OB 获得频道权限");
  const asPl = await service.convertObToPl("session-1", "kp", "guest", "江某");
  assert(asPl.ok && asPl.session.pl.some((member) => member.characterName === "江某"), "OB 转为 PL");
  assert(discord.calls.some((call) => call[0] === "add" && call[1] === "guest" && call[2] === "role-pl"), "转换后获得 PL 身份组");
  const back = await service.convertPlToOb("session-1", "kp", "pl");
  assert(back.ok && back.session.ob.some((member) => member.userId === "pl"), "PL 转为 OB");
  assert(discord.calls.some((call) => call[0] === "nick" && call[1] === "pl" && call[2] === null), "PL 转 OB 后恢复昵称");
  const removed = await service.removeMember("session-1", "kp", "guest");
  assert(removed.ok && !removed.session.pl.some((member) => member.userId === "guest"), "移出 PL");
  assert(discord.calls.some((call) => call[0] === "revoke" && call[2] === "guest"), "移出后失去频道权限");
  assert((await service.removeMember("session-1", "kp", "kp")).ok === false, "不能移出 KP");
  assert((await service.addPl("session-1", "kp", "robot", "机器人")).ok === false, "不能添加机器人");
  assert((await service.addOb("session-1", "kp", "pl")).message.includes("转换身份"), "本局成员要走转换身份");
}

{
  const { service, discord, store } = await activeTable();
  await store.update((state) => ({
    state: {
      ...state,
      sessions: [...state.sessions, {
        sessionId: "session-2",
        state: "ACTIVE",
        guildId: "guild",
        kpUserId: "other-kp",
        title: "另一桌",
        pl: [{ userId: "outsider", characterName: "外人", originalNickname: null, appliedNickname: null }],
        ob: [],
        pendingMemberOp: null,
        runChannelId: "room-2",
        recruitChannelId: "public",
        recruitMessageId: null,
        controlMessageId: null,
        createdAt: 1,
        startedAt: 1,
        endedAt: null,
        deleteAt: null,
        channelDeleted: false,
        rolesGranted: true,
      }],
    },
    result: null,
  }));
  const blocked = await service.addOb("session-1", "kp", "outsider");
  assert(blocked.ok === false && blocked.message.includes("另一场"), "不能添加另一桌成员");
  discord.calls.length = 0;
  const reserved = await store.update((state) => {
    const current = state.sessions.find((item) => item.sessionId === "session-1");
    const next = {
      ...current,
      pendingMemberOp: {
        id: "op",
        type: "add-pl",
        targetUserId: "late",
        beforeRole: null,
        afterRole: "pl",
        beforeChannelAccess: false,
        afterChannelAccess: true,
        nicknameBefore: "Dream",
        nicknameAfter: "奈洛莉",
      },
    };
    return { state: { ...state, sessions: state.sessions.map((item) => item.sessionId === "session-1" ? next : item) }, result: next };
  });
  assert(reserved.ok, "写入未完成的成员操作");
  await service.recoverInterrupted();
  assert(service.find("session-1").pendingMemberOp == null, "重启后清掉未完成的成员操作");
  assert(discord.calls.some((call) => call[0] === "revoke" && call[2] === "late"), "重启后收回未入账的频道权限");
  assert((await service.addOb("session-1", "kp", "late")).ok === true, "回滚后可以重新添加");
}

{
  const { service, discord } = await activeTable({ failAddRole: "role-ob", failAddRoleAfter: 1 });
  const converted = await service.convertPlToOb("session-1", "kp", "pl");
  assert(converted.ok === false, "OB 身份组加不上时不提交转换");
  assert(service.find("session-1").pl.some((member) => member.userId === "pl"), "失败后仍是 PL");
  const nickCalls = discord.calls.filter((call) => call[0] === "nick" && call[1] === "pl");
  assertEqual(nickCalls.at(-1)?.[2], "奈洛莉", "角色操作失败后把昵称改回角色名");
}

{
  const { service, discord } = await activeTable({ failRemoveRole: "role-pl" });
  const removed = await service.removeMember("session-1", "kp", "pl");
  assert(removed.ok === false, "卸不下 PL 身份组时不移出");
  assert(service.find("session-1").pl.some((member) => member.userId === "pl"), "移出失败后仍是 PL");
  assert(!discord.calls.some((call) => call[0] === "revoke" && call[2] === "pl"), "身份组失败时不撤频道权限");
  const nickCalls = discord.calls.filter((call) => call[0] === "nick" && call[1] === "pl");
  assertEqual(nickCalls.at(-1)?.[2], "奈洛莉", "移出失败后把昵称改回角色名");
}

{
  const { service, discord } = await activeTable({ replaceClearedNick: "XXX", failAddRole: "role-ob", failAddRoleAfter: 1 });
  await service.convertPlToOb("session-1", "kp", "pl");
  const nickCalls = discord.calls.filter((call) => call[0] === "nick" && call[1] === "pl");
  assert(!nickCalls.some((call) => call[2] === "奈洛莉" && nickCalls.indexOf(call) > 0), "人工改过的昵称不会被改回去");
  assertEqual(nickCalls.at(-1)?.[2], null, "只执行过小G宝自己的那次恢复");
}

{
  const at1515 = Date.parse("2026-09-28T12:15:00.000Z");
  const at1516 = Date.parse("2026-09-28T12:16:00.000Z");
  const at1517 = Date.parse("2026-09-28T12:17:00.000Z");
  const spoken = "你们推开了地下室的门。";
  const reply = "我先观察门后的情况。";
  const hiddenLine = "这句不要记。";
  const { service, discord, store, dir } = await activeTable({
    randomInt: () => 63,
    config: { messageContentEnabled: true, transcriptEnabled: true },
    history: {
      messages: [
        { id: "m3", authorId: "pl2", content: hiddenLine, createdTimestamp: at1517, type: 0 },
        { id: "m-ob", authorId: "ob", content: "我在旁边看。", createdTimestamp: at1516, type: 0 },
        { id: "m2", authorId: "pl", content: reply, createdTimestamp: at1516, type: 19 },
        { id: "m-bot", authorId: "bot", bot: true, content: "机器人播报。", createdTimestamp: at1515, type: 0 },
        { id: "m1", authorId: "kp", content: spoken, createdTimestamp: at1515, type: 0 },
        { id: "m-sys", authorId: "kp", content: "系统消息不记。", createdTimestamp: at1515, type: 7 },
      ],
    },
  });
  const added = await service.addPl("session-1", "kp", "pl2", "江某");
  assert(added.ok, "再加一名 PL");
  const kpRoll = await service.rollTextDice({
    channelId: "room-1", userId: "kp", displayName: "主持人", content: "1d100",
  });
  assertEqual(kpRoll.text, "<@kp> 🎲 1d100 = 63", "KP 的整句 1d100 会 @ 触发者");
  const plRoll = await service.rollTextDice({
    channelId: "room-1", userId: "pl", displayName: "Dream", content: " 1D100 ",
  });
  assertEqual(plRoll.text, "<@pl> 🎲 1d100 = 63", "PL 的整句 1d100 会 @ 触发者");
  const obRoll = await service.rollTextDice({
    channelId: "room-1", userId: "ob", displayName: "看客", content: "1d100",
  });
  assert(obRoll.ignore === true && obRoll.ok !== true, "OB 发送 1d100 不掷");
  const sentence = await service.rollTextDice({
    channelId: "room-1", userId: "pl", displayName: "Dream", content: "我先观察门后的情况。",
  });
  assert(sentence.ignore === true, "普通句子不掷");
  const lobby = await service.rollTextDice({
    channelId: "lobby", userId: "pl", displayName: "Dream", content: "1d100",
  });
  assert(lobby.ignore === true, "普通频道不掷");
  const slash = await service.roll({
    channelId: "room-1", userId: "pl", displayName: "Dream", expression: "1d100",
  });
  assert(slash.ok && slash.text.includes("掷骰"), "/r 仍用原来的回复");
  assert((await service.setTranscriptOptOut("session-1", "ob", true)).ok === false, "OB 不能设置团录退出");
  assert((await service.previewTranscriptPrivacy("session-1", "stranger")).ok === false, "局外人不能设置团录退出");
  const hidden = await service.setTranscriptOptOut("session-1", "pl2", true);
  assert(hidden.ok && hidden.optedOut === true, "PL 可以退出团录");
  const restored = await service.setTranscriptOptOut("session-1", "pl2", false);
  assert(restored.ok && restored.optedOut === false, "PL 可以恢复记录");
  await service.setTranscriptOptOut("session-1", "pl2", true);
  const beforeEnd = JSON.parse(readFileSync(store.filePath, "utf8"));
  assert(beforeEnd.sessions[0].transcriptOptOutUserIds.includes("pl2"), "当前仍退出的人留在 ID 列表里");
  const openSpan = beforeEnd.sessions[0].transcriptOptOutSpans.find((span) => span.userId === "pl2" && span.until == null);
  assert(typeof openSpan?.from === "number", "退出记下的是用户和时间，不是消息");
  assert(!containsText(beforeEnd, spoken) && !containsText(beforeEnd, hiddenLine), "跑团期间不把正文写进场次文件");
  const done = await service.finish("session-1", "kp");
  assert(done.ok && done.session.state === "ENDED", "有团录时结束仍然完成");
  const historyCall = discord.calls.find((call) => call[0] === "history");
  assertEqual(historyCall?.[2]?.startedAt, 1000, "读历史时带上本局开始时间");
  const historyAt = discord.calls.findIndex((call) => call[0] === "history");
  const lockAt = discord.calls.findIndex((call) => call[0] === "lock");
  assert(historyAt > lockAt && lockAt !== -1, "锁门之后才读频道历史");
  const fileCall = discord.calls.find((call) => call[0] === "send" && call[1]?.files);
  const markdown = fileCall[1].files[0].attachment.toString("utf8");
  assert(fileCall[1].files[0].name.endsWith("团录.md"), "团录作为 Markdown 附件");
  assert(markdown.indexOf(spoken) !== -1 && markdown.indexOf(reply) !== -1, "KP 和 PL 进入团录");
  assert(markdown.indexOf(spoken) < markdown.indexOf(reply), "团录按时间排序");
  assert(markdown.includes("[20:15] KP：") && markdown.includes("[20:16] 奈洛莉："), "时间和称呼正确");
  assert(!markdown.includes("我在旁边看") && !markdown.includes(hiddenLine), "OB 和退出用户不进团录");
  assert(!markdown.includes("机器人播报") && !markdown.includes("系统消息不记"), "Bot 和系统消息不进团录");
  const saved = JSON.parse(readFileSync(store.filePath, "utf8"));
  assert(saved.sessions[0].transcriptDelivered === true, "只记下团录已经发出");
  assert(!containsText(saved, spoken) && !containsText(saved, reply) && !containsText(saved, hiddenLine), "场次文件里没有消息正文");
  assert(!readdirSync(dir).some((name) => name.endsWith(".md")), "成功发送后没有留下团录文件");
}

{
  const { service, discord, store } = await activeTable({
    config: { messageContentEnabled: false, transcriptEnabled: true },
    history: { messages: [{ id: "m", authorId: "kp", content: "不该读到", createdTimestamp: Date.now(), type: 0 }] },
  });
  const ignored = await service.rollTextDice({
    channelId: "room-1", userId: "kp", displayName: "主持人", content: "1d100",
  });
  assert(ignored.ignore === true, "Message Content 关闭时文字骰子不运行");
  assert(service.transcriptControlsEnabled() === false, "只有团录开关时不提供团录隐私");
  assert((await service.previewTranscriptPrivacy("session-1", "pl")).ok === false, "缺少 Message Content 时不能设置团录隐私");
  await service.finish("session-1", "kp");
  assert(!discord.calls.some((call) => call[0] === "history"), "Message Content 关闭时不读频道历史");
  assert(!containsText(JSON.parse(readFileSync(store.filePath, "utf8")), "不该读到"), "关闭时正文也不进场次文件");
}

{
  const { service, discord, store, dir } = await activeTable({
    config: { messageContentEnabled: true, transcriptEnabled: true },
    failHistory: true,
    history: { messages: [{ id: "m", authorId: "kp", content: "读失败也不落盘", createdTimestamp: Date.now(), type: 0 }] },
  });
  const done = await service.finish("session-1", "kp");
  assert(done.ok && done.session.state === "ENDED", "团录读失败也照旧结束");
  assert(discord.calls.some((call) => call[0] === "send" && call[1]?.content === "本局团录没有发出。"), "频道里说明团录没发出");
  assert(!discord.calls.some((call) => call[0] === "send" && call[1]?.files), "读失败不发送附件");
  assert(!containsText(JSON.parse(readFileSync(store.filePath, "utf8")), "读失败也不落盘"), "读失败不把正文写进场次文件");
  assert(!readdirSync(dir).some((name) => name.endsWith(".md")), "读失败不留下团录文件");
}

{
  const line = "发出失败也不能落盘";
  const { service, discord, store, dir } = await activeTable({
    config: { messageContentEnabled: true, transcriptEnabled: true },
    failSendFile: true,
    history: {
      messages: [{ id: "m", authorId: "kp", content: line, createdTimestamp: Date.parse("2026-09-28T12:15:00.000Z"), type: 0 }],
    },
  });
  const done = await service.finish("session-1", "kp");
  assert(done.ok, "团录发送失败也照旧结束");
  assert(discord.calls.some((call) => call[0] === "send" && call[1]?.content === "本局团录没有完整发出。"), "发送失败会说明团录没完整发出");
  assert(done.session.transcriptDelivered !== true, "没发出就不记成已交付");
  assert(!containsText(JSON.parse(readFileSync(store.filePath, "utf8")), line), "发送失败不把正文写进场次文件");
  assert(!readdirSync(dir).some((name) => name.endsWith(".md")), "发送失败不留下团录文件");
}

{
  const { service } = await activeTable({
    config: { messageContentEnabled: true, transcriptEnabled: false },
  });
  assert(service.transcriptControlsEnabled() === false, "只有 Message Content 时不提供团录隐私");
  assert((await service.setTranscriptOptOut("session-1", "pl", true)).ok === false, "团录关闭时不能设置退出");
}

{
  const values = [4, 6, 2, 63, 5, 1, 3, 8, 9, 2, 4, 5, 7];
  let cursor = 0;
  const { service } = await activeTable({
    config: { messageContentEnabled: true },
    randomInt: () => values[cursor++],
  });
  async function expectSameAsSlash(content, label) {
    const start = cursor;
    const actual = await service.rollTextDice({
      channelId: "room-1", userId: "pl", displayName: "Dream", content,
    });
    let index = start;
    const expected = rollDice(content, () => values[index++]);
    assert(actual.ok === true && expected.ok === true, `${label} 会掷`);
    assertEqual(actual.text, formatTextDice("pl", expected), `${label} 展示这次掷出的骰面`);
    if (expected.count > 1) {
      assert(actual.text.includes(`[${expected.rolls.join(", ")}]`), `${label} 保留每一颗骰子`);
    }
    assertEqual(cursor, index, `${label} 用了同样多次随机`);
  }
  await expectSameAsSlash("1d4", "1d4");
  await expectSameAsSlash("1D6", "1d6 大写");
  await expectSameAsSlash("  1d20  ", "1d20 两端空白");
  await expectSameAsSlash("1d100", "1d100");
  await expectSameAsSlash("2d6", "2d6");
  await expectSameAsSlash("2d6+3", "2d6+3");
  await expectSameAsSlash("2d6-1", "2d6-1");
  await expectSameAsSlash("2D6+3", "2D6+3");
  const beforeIgnore = cursor;
  for (const content of ["cc 70", "今天运气大概1d100吧", "请帮我掷 2d6+3", "2d6+3 吧", "21d6", ""]) {
    const ignored = await service.rollTextDice({
      channelId: "room-1", userId: "pl", displayName: "Dream", content,
    });
    assert(ignored.ignore === true && ignored.ok !== true && ignored.message == null, `忽略 ${content || "空"} 且不报错`);
  }
  assertEqual(cursor, beforeIgnore, "非法表达式不消耗随机数");
  const ob = await service.rollTextDice({
    channelId: "room-1", userId: "ob", displayName: "看客", content: "2d6",
  });
  assert(ob.ignore === true && ob.ok !== true && ob.message == null, "OB 的整句骰子不掷也不报错");
  const outsider = await service.rollTextDice({
    channelId: "room-1", userId: "guest", displayName: "路人", content: "1d6",
  });
  assert(outsider.ignore === true, "不是 KP 或 PL 不掷");
  const lobby = await service.rollTextDice({
    channelId: "lobby", userId: "pl", displayName: "Dream", content: "2d6+3",
  });
  assert(lobby.ignore === true, "非进行中频道不掷");
  const slashBad = await service.roll({
    channelId: "room-1", userId: "pl", displayName: "Dream", expression: "你好",
  });
  assert(slashBad.ok === false && slashBad.message?.includes("1d100"), "/r 非法表达式仍然回复错误");
  const slashStart = cursor;
  const slash = await service.roll({
    channelId: "room-1", userId: "pl", displayName: "Dream", expression: "1d4",
  });
  let slashIndex = slashStart;
  const slashRoll = rollDice("1d4", () => values[slashIndex++]);
  assert(slash.ok, "/r 仍然会掷");
  assertEqual(slash.text, formatRoll("奈洛莉", slashRoll), "/r 回复格式不变");
  assert(!slash.text.includes("<@"), "/r 不 @ 用户");
}

{
  const early = "调查员阶段说的话";
  const late = "变成旁观后说的话";
  const watched = "还在旁观时说的话";
  const seated = "入座之后说的话";
  const kept = "退出之前说的话";
  const skipped = "退出期间说的话";
  const resumed = "恢复之后说的话";
  const t = (seconds) => Date.parse("2026-09-29T02:00:00.000Z") + seconds * 1000;
  const { service, discord, store, setNow } = await activeTable({
    config: { messageContentEnabled: true, transcriptEnabled: true },
    history: {
      messages: [
        { id: "pl-early", authorId: "pl", content: early, createdTimestamp: t(10), type: 0 },
        { id: "pl-late", authorId: "pl", content: late, createdTimestamp: t(30), type: 0 },
        { id: "ob-early", authorId: "ob", content: watched, createdTimestamp: t(10), type: 0 },
        { id: "ob-late", authorId: "ob", content: seated, createdTimestamp: t(50), type: 0 },
        { id: "kp-kept", authorId: "kp", content: kept, createdTimestamp: t(5), type: 0 },
        { id: "kp-skip", authorId: "kp", content: skipped, createdTimestamp: t(15), type: 0 },
        { id: "kp-back", authorId: "kp", content: resumed, createdTimestamp: t(25), type: 0 },
      ],
    },
  });
  setNow(t(12));
  assert((await service.setTranscriptOptOut("session-1", "kp", true)).optedOut === true, "KP 从现在起退出团录");
  setNow(t(20));
  assert((await service.setTranscriptOptOut("session-1", "kp", false)).optedOut === false, "KP 从现在起恢复记录");
  const toOb = await service.convertPlToOb("session-1", "kp", "pl");
  assert(toOb.ok, "PL 转成 OB");
  setNow(t(40));
  const toPl = await service.convertObToPl("session-1", "kp", "ob", "后来");
  assert(toPl.ok, "OB 转成 PL");
  const before = JSON.parse(readFileSync(store.filePath, "utf8"));
  const seats = before.sessions[0].transcriptSeats;
  assert(seats.some((seat) => seat.userId === "pl" && seat.until === t(20) && seat.name === "奈洛莉"), "PL 座位在转 OB 时结束");
  assert(seats.some((seat) => seat.userId === "ob" && seat.name === "后来" && seat.from === t(40) && seat.until == null), "新 PL 座位从转换时开始");
  const span = before.sessions[0].transcriptOptOutSpans.find((item) => item.userId === "kp");
  assert(span?.from === t(12) && span?.until === t(20), "退出只覆盖中间一段时间");
  assert(!containsText(before, early) && !containsText(before, skipped) && !containsText(before, seated), "身份和时间段里没有消息正文");
  const done = await service.finish("session-1", "kp");
  assert(done.ok, "按时间段过滤后仍能结束");
  const fileCall = discord.calls.find((call) => call[0] === "send" && call[1]?.files);
  const markdown = fileCall[1].files[0].attachment.toString("utf8");
  assert(markdown.includes(early) && markdown.includes("[10:00] 奈洛莉："), "转 OB 前的发言按当时角色名记入");
  assert(!markdown.includes(late), "转成 OB 之后的发言不进团录");
  assert(!markdown.includes(watched), "还是 OB 时的发言不进团录");
  assert(markdown.includes(seated) && markdown.includes("后来："), "成为 PL 之后的发言按新角色名记入");
  assert(markdown.includes(kept) && markdown.includes(resumed), "退出前后的 KP 发言保留");
  assert(!markdown.includes(skipped), "退出期间的 KP 发言不进团录");
  const saved = JSON.parse(readFileSync(store.filePath, "utf8"));
  assert(!containsText(saved, early) && !containsText(saved, skipped) && !containsText(saved, seated), "结束落盘仍然没有消息正文");
}

{
  const lines = Array.from({ length: 2001 }, (_, index) => ({
    id: `part-${index}`,
    authorId: "kp",
    content: `长团${index}`,
    createdTimestamp: 5_000 + index,
    type: 0,
  }));
  lines.push(
    { id: "old", authorId: "kp", content: "开团前的长团", createdTimestamp: 1, type: 0 },
    { id: "ob-noise", authorId: "ob", content: "旁观长团", createdTimestamp: 5_010, type: 0 },
  );
  const { service, discord, store, dir } = await activeTable({
    config: { messageContentEnabled: true, transcriptEnabled: true },
    history: { messages: lines, truncated: false },
  });
  const done = await service.finish("session-1", "kp");
  assert(done.ok && done.session.state === "ENDED", "分卷团录发完后本局仍然结束");
  const files = discord.calls.filter((call) => call[0] === "send" && call[1]?.files).map((call) => call[1].files[0]);
  assertEqual(files.map((file) => file.name).join("|"), "成员团录-01.md|成员团录-02.md", "超过 2000 条有效发言时发出两卷");
  const first = files[0].attachment.toString("utf8");
  const second = files[1].attachment.toString("utf8");
  assert(first.includes("长团0") && !first.includes("长团2000"), "第一卷只含前 2000 条有效发言");
  assert(second.includes("长团2000") && !second.includes("旁观长团") && !second.includes("开团前的长团"), "第二卷不含已过滤的消息");
  assert(!readdirSync(dir).some((name) => name.endsWith(".md")), "分卷发送后没有留下团录文件");
  assert(!containsText(JSON.parse(readFileSync(store.filePath, "utf8")), "长团0"), "分卷正文不进场次文件");
}

{
  const lines = Array.from({ length: 2001 }, (_, index) => ({
    id: `miss-${index}`,
    authorId: "kp",
    content: `缺卷${index}`,
    createdTimestamp: 5_000 + index,
    type: 0,
  }));
  const { service, discord, store, dir } = await activeTable({
    config: { messageContentEnabled: true, transcriptEnabled: true },
    failSendPart: 2,
    history: { messages: lines },
  });
  const done = await service.finish("session-1", "kp");
  assert(done.ok && done.session.state === "ENDED", "有一卷失败时本局仍然结束");
  assert(discord.calls.some((call) => call[0] === "send" && call[1]?.files?.[0]?.name === "成员团录-01.md"), "失败前的那一卷已经发出");
  assert(discord.calls.some((call) => call[0] === "send" && call[1]?.content === "本局团录没有完整发出。"), "缺卷时说明团录不完整");
  assert(done.session.transcriptDelivered !== true, "没发齐就不记成已交付");
  assert(!containsText(JSON.parse(readFileSync(store.filePath, "utf8")), "缺卷0"), "失败的分卷不落进场次文件");
  assert(!readdirSync(dir).some((name) => name.endsWith(".md")), "失败的分卷不写成本地文件");
}

{
  const values = [7, 5, 2, 4, 7, 3, 9, 3, 4, 8, 4, 2, 6, 9, 0, 0, 5, 0, 0, 5, 63, 8];
  let cursor = 0;
  const { service } = await activeTable({
    config: { messageContentEnabled: true },
    randomInt: () => values[cursor++],
  });
  async function expectBonus(userId, content, label) {
    const start = cursor;
    const actual = await service.rollTextDice({
      channelId: "room-1", userId, content,
    });
    let index = start;
    const expected = rollBonusPenalty(parseBonusPenalty(content), () => values[index++]);
    assert(actual.ok === true && expected.ok === true, `${label} 会掷`);
    assertEqual(actual.text, formatBonusPenalty(userId, expected), label);
    assertEqual(cursor, index, `${label} 不另掷`);
    const chosen = expected.kind === "bonus" ? Math.min(...expected.candidates) : Math.max(...expected.candidates);
    assertEqual(expected.total, chosen, `${label} 用候选里的${expected.kind === "bonus" ? "最小" : "最大"}值`);
  }
  const before = cursor;
  for (const [userId, content] of [
    ["ob", "1D100 奖励1"],
    ["pl", "2D100 奖励1"],
    ["pl", "1D20 奖励1"],
    ["pl", "1D100 奖励3"],
    ["pl", "我投一个1D100 奖励1"],
    ["guest", "1D100 惩罚1"],
  ]) {
    const ignored = await service.rollTextDice({ channelId: "room-1", userId, content });
    assert(ignored.ignore === true && ignored.ok !== true && ignored.message == null, `忽略 ${userId} ${content}`);
  }
  const lobby = await service.rollTextDice({
    channelId: "lobby", userId: "kp", content: "1D100 惩罚2",
  });
  assert(lobby.ignore === true, "普通频道的奖励骰不掷");
  assertEqual(cursor, before, "被忽略的奖励骰不消耗随机数");
  await expectBonus("kp", "1D100 奖励1", "KP 奖励1");
  await expectBonus("pl", "  1d100 奖励2  ", "PL 奖励2");
  await expectBonus("kp", "1D100 惩罚1", "KP 惩罚1");
  await expectBonus("pl", "1d100 惩罚2", "PL 惩罚2");
  await expectBonus("pl", "1D100 奖励1", "奖励骰 100 边界");
  await expectBonus("kp", "1D100 惩罚1", "惩罚骰 100 边界");
  const plain = await service.rollTextDice({
    channelId: "room-1", userId: "pl", content: "1D100",
  });
  assertEqual(plain.text, "<@pl> 🎲 1d100 = 63", "普通 1D100 自然骰不变");
  const slashBad = await service.roll({
    channelId: "room-1", userId: "pl", displayName: "Dream", expression: "1D100 奖励1",
  });
  assert(slashBad.ok === false && slashBad.message?.includes("骰子表达式无效"), "/r 不接受奖励骰");
  const slash = await service.roll({
    channelId: "room-1", userId: "pl", displayName: "Dream", expression: "1d100",
  });
  assertEqual(slash.text, "🎲 奈洛莉掷骰\n\n1d100 → 8", "/r 回复格式不变");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

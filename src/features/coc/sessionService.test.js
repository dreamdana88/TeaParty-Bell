import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
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
    },
    async removeRole(_guildId, userId, roleId) {
      calls.push(["remove", userId, roleId]);
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
    async sendMessage() { return "control-1"; },
    async editMessage() { calls.push(["edit"]); },
  };
}

function harness(discordOverrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), "coc-mvp-"));
  const store = createCocSessionStore({ filePath: join(dir, "sessions.json") });
  const discord = fakeDiscord(discordOverrides);
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
    },
    clock: { now: () => now },
    logger: { warn() {}, error() {} },
    createId: () => "session-1",
  });
  return { service, discord, store, setNow: (value) => { now = value; } };
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
    const next = { ...current, pendingMemberOp: { id: "op", type: "add-pl", targetUserId: "late", accessGranted: true } };
    return { state: { ...state, sessions: state.sessions.map((item) => item.sessionId === "session-1" ? next : item) }, result: next };
  });
  assert(reserved.ok, "写入未完成的成员操作");
  await service.recoverInterrupted();
  assert(service.find("session-1").pendingMemberOp == null, "重启后清掉未完成的成员操作");
  assert(discord.calls.some((call) => call[0] === "revoke" && call[2] === "late"), "重启后收回未入账的频道权限");
  assert((await service.addOb("session-1", "kp", "late")).ok === true, "回滚后可以重新添加");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

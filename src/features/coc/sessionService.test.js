import { mkdtempSync, readFileSync, readdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { parseBonusPenalty, rollBonusPenalty } from "./dice/bonusPenalty.js";
import { rollDice } from "./dice/roller.js";
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
    async grantBotThreadManage(channelId, botUserId) {
      calls.push(["bot-thread", channelId, botUserId]);
    },
    async createPrivateThread({ channelId, name }) {
      calls.push(["thread", channelId, name]);
      if (overrides.failThread) throw new Error("thread failed");
      return { id: overrides.threadId ?? "thread-1", name };
    },
    async addThreadMember(threadId, userId) {
      calls.push(["thread-add", threadId, userId]);
      if (overrides.failThreadAdd === userId) throw new Error("thread add failed");
    },
    async removeThreadMember(threadId, userId) {
      calls.push(["thread-remove", threadId, userId]);
      if (overrides.failThreadRemove) throw new Error("thread remove failed");
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
      if (overrides.failHistoryOf?.[channelId]) throw new Error("history failed");
      if (overrides.missingThreads?.includes(channelId)) {
        const error = new Error("Unknown Channel");
        error.code = 10003;
        throw error;
      }
      if (overrides.histories?.[channelId]) return overrides.histories[channelId];
      return overrides.history ?? { messages: [], truncated: false };
    },
    async editMessage() { calls.push(["edit"]); },
  };
}

async function bindPl(service, sessionId, userId, cardId) {
  const prepared = await service.prepareCharacterSelection(sessionId, userId);
  if (!prepared.ok) return prepared;
  return service.selectCharacter(sessionId, userId, cardId, prepared.invitation.id);
}
async function invitePl(service, kind, sessionId, actorId, targetUserId, cardId) {
  const invited = await service.inviteCharacter(sessionId, actorId, targetUserId, kind);
  if (!invited.ok) return invited;
  return service.selectCharacter(sessionId, targetUserId, cardId, invited.invitation.id);
}
function harness(discordOverrides = {}) {
  const { config: configOverrides = {}, randomInt, characters, ...rest } = discordOverrides;
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
    characters: characters ?? {
      async list() { return { ok: true, characters: [{ id: "fixture-card" }] }; },
      async read(id, ownerDiscordUserId) {
        return { ok: true, snapshot: { characterId: id, ownerDiscordUserId, characterName: id,
          occupation: "测试职业", initialHp: 10, initialSan: 50, initialMp: 10, initialLuck: 50, skills: [] } };
      },
    },
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
  const kl = await bindPl(service, "session-1", "kl", "奈洛莉");
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
  assert(inside.ok && inside.text.includes("<@kl>") && inside.text.includes("1d100"), "跑团频道允许骰子并提及触发者");
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
  await bindPl(service, "session-1", "kl", "奈洛莉");
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
  await bindPl(service, "session-1", "kl", "奈洛莉");
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
  await bindPl(service, "session-1", "kl", "奈洛莉");
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
  await bindPl(service, "session-1", "kl", "奈洛莉");
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
  await bindPl(service, "session-1", "kl", "奈洛莉");
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
  await bindPl(env.service, "session-1", "pl", "奈洛莉");
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
  const asPl = await invitePl(service, "convert", "session-1", "kp", "guest", "江某");
  assert(asPl.ok && asPl.session.pl.some((member) => member.characterName === "江某"), "OB 转为 PL");
  assert(discord.calls.some((call) => call[0] === "add" && call[1] === "guest" && call[2] === "role-pl"), "转换后获得 PL 身份组");
  const back = await service.convertPlToOb("session-1", "kp", "pl");
  assert(back.ok && back.session.ob.some((member) => member.userId === "pl"), "PL 转为 OB");
  assert(discord.calls.some((call) => call[0] === "nick" && call[1] === "pl" && call[2] === null), "PL 转 OB 后恢复昵称");
  const removed = await service.removeMember("session-1", "kp", "guest");
  assert(removed.ok && !removed.session.pl.some((member) => member.userId === "guest"), "移出 PL");
  assert(discord.calls.some((call) => call[0] === "revoke" && call[2] === "guest"), "移出后失去频道权限");
  assert((await service.removeMember("session-1", "kp", "kp")).ok === false, "不能移出 KP");
  assert((await invitePl(service, "add", "session-1", "kp", "robot", "机器人")).ok === false, "不能添加机器人");
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
  const added = await invitePl(service, "add", "session-1", "kp", "pl2", "江某");
  assert(added.ok, "再加一名 PL");
  const kpRoll = await service.rollTextDice({
    channelId: "room-1", userId: "kp", displayName: "主持人", content: "1d100",
  });
  assertEqual(kpRoll.text, "**<@kp> 祝骰运昌隆喵~！**\n🎲 1d100 = 63", "KP 的整句 1d100 会 @ 触发者");
  const plRoll = await service.rollTextDice({
    channelId: "room-1", userId: "pl", displayName: "Dream", content: " 1D100 ",
  });
  assertEqual(plRoll.text, "**<@pl> 祝骰运昌隆喵~！**\n🎲 1d100 = 63", "PL 的整句 1d100 会 @ 触发者");
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
  assert(slash.ok && slash.text.includes("骰运昌隆喵"), "/r 仍用原来的回复");
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
  assert(historyAt < lockAt && historyAt !== -1, "先读取团录历史再完成锁门清理");
  const fileCall = discord.calls.find((call) => call[0] === "send" && call[1]?.files);
  const fileAt = discord.calls.indexOf(fileCall);
  assert(discord.calls.slice(fileAt + 1).some(call => call[0] === "nick")
    && !discord.calls.slice(historyAt, fileAt).some(call => call[0] === "nick" || call[0] === "remove"), "先发团录，再恢复昵称和移除身份组");
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
  assert(done.ok === false && service.find("session-1").state === "ACTIVE", "团录读失败不结束");
  assert(done.message.includes("尚未进入 48 小时删除"), "读失败提示可以重试结束");
  assert(!discord.calls.some((call) => call[0] === "lock"), "读失败不锁频道");
  assert(service.find("session-1").deleteAt == null, "读失败不写入删除倒计时");
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
  assert(done.ok === false && service.find("session-1").state === "ACTIVE", "团录发送失败不结束");
  assert(done.message.includes("尚未进入 48 小时删除"), "发送失败提示可以重试结束");
  assert(!discord.calls.some((call) => call[0] === "lock"), "发送失败不锁频道");
  assert(service.find("session-1").transcriptDelivered !== true, "没发出就不记成已交付");
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
  assertEqual(slash.text, formatTextDice("pl", slashRoll), "/r 回复格式不变");
  assert(slash.text.includes("<@pl>"), "/r 提及触发者");
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
  const toPl = await invitePl(service, "convert", "session-1", "kp", "ob", "后来");
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
  assert(done.ok === false && service.find("session-1").state === "ACTIVE", "有一卷失败时不进入删除");
  assert(discord.calls.some((call) => call[0] === "send" && call[1]?.files?.[0]?.name === "成员团录-01.md"), "失败前的那一卷已经发出");
  assert(!discord.calls.some((call) => call[0] === "lock"), "缺卷时不锁频道");
  assert(service.find("session-1").transcriptDelivered !== true, "没发齐就不记成已交付");
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
  assertEqual(plain.text, "**<@pl> 祝骰运昌隆喵~！**\n🎲 1d100 = 63", "普通 1D100 自然骰不变");
  const slashBad = await service.roll({
    channelId: "room-1", userId: "pl", displayName: "Dream", expression: "1D100 奖励1",
  });
  assert(slashBad.ok === false && slashBad.message?.includes("骰子表达式无效"), "/r 不接受奖励骰");
  const slash = await service.roll({
    channelId: "room-1", userId: "pl", displayName: "Dream", expression: "1d100",
  });
  assertEqual(slash.text, "**<@pl> 祝骰运昌隆喵~！**\n🎲 1d100 = 8", "/r 回复格式不变");
}

{
  const snapshot = { characterId: "card-1", ownerDiscordUserId: "kl", characterName: "档案馆姓名",
    occupation: "演员", initialHp: 11, initialSan: 35, initialMp: 14, initialLuck: 60, skills: [] };
  const { service, discord } = harness({ characters: {
    async list() { return { ok: true, characters: [{ id: "card-1" }] }; },
    async read() { return { ok: true, snapshot }; },
  } });
  await service.openRecruit({ guildId: "guild", channelId: "recruit", kpUserId: "kp", title: "B8 昵称测试" });
  await service.prepareCharacterSelection("session-1", "kl");
  const waiting = await service.confirmStart("session-1", "kp");
  assert(!waiting.ok && !discord.calls.some((call) => call[0] === "create"), "未绑定卡时不能绕过预览开团");
  const selected = await service.selectCharacter("session-1", "kl", "card-1");
  assert(selected.ok, "B8 角色绑定成功");
  assert(!discord.calls.some((call) => call[0] === "nick"), "招募选卡不提前修改全服昵称");
  const started = await service.confirmStart("session-1", "kp");
  assert(started.ok && started.session.pl[0].initialSan === 35, "开团保留选卡快照");
  assert(discord.calls.some((call) => call[0] === "nick" && call[2] === "档案馆姓名"), "复用开团逻辑设置档案馆姓名");
  await service.finish("session-1", "kp");
  assert(discord.calls.some((call) => call[0] === "nick" && call[2] === "Dream"), "复用结束逻辑恢复原昵称");
}

{
  const snapshot = (ownerDiscordUserId) => ({ characterId: "archive-card", ownerDiscordUserId,
    characterName: "档案馆调查员", occupation: "演员", initialHp: 11, initialSan: 35,
    initialMp: 14, initialLuck: 60, skills: [{ name: "演技", base: 5, growth: 0, occupationPoints: 45, interestPoints: 0 }] });
  let wrongOwner = false;
  let noCards = false;
  let failApi = false;
  let releaseRead;
  let holdRead = false;
  const characters = {
    async list() { return failApi ? { ok: false, message: "档案馆不可用" } : { ok: true, characters: noCards ? [] : [{ id: "archive-card" }] }; },
    async read(_id, userId) {
      if (holdRead) return new Promise((resolve) => { releaseRead = resolve; });
      return failApi ? { ok: false, message: "档案馆不可用" }
        : { ok: true, snapshot: snapshot(wrongOwner ? "other" : userId) };
    },
  };
  const { service, discord, store } = harness({ characters });
  await service.openRecruit({ guildId: "guild", channelId: "recruit", kpUserId: "kp", title: "邀请补丁" });
  await bindPl(service, "session-1", "kl", "archive-card");
  await service.confirmStart("session-1", "kp");
  const invited = await service.inviteCharacter("session-1", "kp", "guest", "add");
  assert(invited.ok && !service.find("session-1").pl.some((item) => item.userId === "guest"), "KP 邀请不先创建正式 PL");
  assert(!discord.calls.some((call) => call[0] === "nick" && call[1] === "guest"), "邀请时不修改目标昵称");
  assert((await service.prepareCharacterSelection("session-1", "kp", invited.invitation.id)).ok === false, "KP 不能打开别人的选卡菜单");
  assert((await service.selectCharacter("session-1", "kp", "archive-card", invited.invitation.id)).ok === false, "KP 不能替目标选卡");
  const accepted = await service.selectCharacter("session-1", "guest", "archive-card", invited.invitation.id);
  const added = accepted.session?.pl.find((item) => item.userId === "guest");
  assert(accepted.ok && Object.entries(snapshot("guest")).every(([key, value]) => JSON.stringify(added[key]) === JSON.stringify(value)), "本人选卡成功且所有快照字段完整");
  assert(discord.calls.some((call) => call[0] === "nick" && call[1] === "guest" && call[2] === "档案馆调查员"), "新增 PL 昵称使用档案馆姓名");
  assert(discord.calls.some((call) => call[0] === "grant" && call[2] === "guest"), "选卡成功后才授予频道权限");
  assert(!service.invitationFor("session-1", invited.invitation.id), "成功后消费邀请，不能重复加入");
  await service.addOb("session-1", "kp", "observer");
  const conversion = await service.inviteCharacter("session-1", "kp", "observer", "convert");
  assert(conversion.ok && service.find("session-1").ob.some((item) => item.userId === "observer"), "OB 邀请阶段保留原 OB 身份");
  const converted = await service.selectCharacter("session-1", "observer", "archive-card", conversion.invitation.id);
  assert(converted.ok && converted.session.pl.some((item) => item.userId === "observer" && item.characterId === "archive-card")
    && !converted.session.ob.some((item) => item.userId === "observer"), "OB 本人选卡成功后正式转 PL");
  assert(discord.calls.some((call) => call[0] === "nick" && call[1] === "observer" && call[2] === "档案馆调查员"), "OB 转 PL 使用档案馆昵称");

  const empty = await service.inviteCharacter("session-1", "kp", "empty", "add");
  noCards = true;
  const emptyList = await service.prepareCharacterSelection("session-1", "empty", empty.invitation.id);
  noCards = false;
  assert(emptyList.ok && emptyList.characters.length === 0 && !service.invitationFor("session-1", empty.invitation.id)
    && !service.find("session-1").pl.some((item) => item.userId === "empty"), "无卡取消邀请且没有半成品 PL");
  const denied = await service.inviteCharacter("session-1", "kp", "denied", "add");
  wrongOwner = true;
  assert(!(await service.selectCharacter("session-1", "denied", "archive-card", denied.invitation.id)).ok, "owner 不匹配拒绝");
  wrongOwner = false;
  assert(!service.invitationFor("session-1", denied.invitation.id) && !service.find("session-1").pl.some((item) => item.userId === "denied"), "owner 错误不留下邀请或正式 PL");
  const unavailable = await service.inviteCharacter("session-1", "kp", "unavailable", "add");
  failApi = true;
  assert(!(await service.prepareCharacterSelection("session-1", "unavailable", unavailable.invitation.id)).ok
    && !service.invitationFor("session-1", unavailable.invitation.id), "API 列表失败清理 pending");
  failApi = false;
  const cancelled = await service.inviteCharacter("session-1", "kp", "cancelled", "add");
  assert(!(await service.cancelCharacterInvitation("session-1", "stranger", cancelled.invitation.id)).ok, "其它用户不能取消邀请");
  assert((await service.cancelCharacterInvitation("session-1", "kp", cancelled.invitation.id)).ok, "KP 可以取消邀请");
  assert(!(await service.selectCharacter("session-1", "cancelled", "archive-card", cancelled.invitation.id)).ok, "取消后旧按钮不能再加入");
  const selfCancelled = await service.inviteCharacter("session-1", "kp", "self", "add");
  assert((await service.cancelCharacterInvitation("session-1", "self", selfCancelled.invitation.id)).ok, "目标本人可以取消邀请");
  const disappeared = await service.inviteCharacter("session-1", "kp", "gone", "add");
  holdRead = true;
  const reading = service.selectCharacter("session-1", "gone", "archive-card", disappeared.invitation.id);
  await service.cancelCharacterInvitation("session-1", "kp", disappeared.invitation.id);
  releaseRead({ ok: true, snapshot: snapshot("gone") });
  assert(!(await reading).ok && !service.find("session-1").pl.some((item) => item.userId === "gone"), "读卡期间取消不会回写 PL");
  holdRead = false;
  const ending = await service.inviteCharacter("session-1", "kp", "late", "add");
  holdRead = true;
  const late = service.selectCharacter("session-1", "late", "archive-card", ending.invitation.id);
  await service.finish("session-1", "kp");
  const finished = store.snapshot();
  releaseRead({ ok: true, snapshot: snapshot("late") });
  assert(!(await late).ok && JSON.stringify(store.snapshot()) === JSON.stringify(finished), "读卡期间结束 Session 不回写任何场次数据");
  assert(service.find("session-1").characterInvitations.length === 0, "结束团清除所有选卡邀请");
}

{
  const { service, discord } = harness();
  await service.openRecruit({ guildId: "guild", channelId: "recruit", kpUserId: "kp", title: "邀请权限竞态" });
  await bindPl(service, "session-1", "kl", "奈洛莉");
  await service.confirmStart("session-1", "kp");
  const departed = await service.inviteCharacter("session-1", "kp", "departed", "add");
  const originalFetch = discord.fetchGuildMember;
  discord.fetchGuildMember = async (_guild, userId) => {
    if (userId === "departed") throw new Error("left guild");
    return originalFetch(_guild, userId);
  };
  assert(!(await service.selectCharacter("session-1", "departed", "江某", departed.invitation.id)).ok
    && !service.invitationFor("session-1", departed.invitation.id), "目标离开服务器不加入且清理邀请");
  let release;
  let entered;
  const blocked = new Promise((resolve) => { entered = resolve; });
  discord.grantChannelAccess = async () => { entered(); await new Promise((resolve) => { release = resolve; }); };
  const ending = await service.inviteCharacter("session-1", "kp", "late", "add");
  const selecting = service.selectCharacter("session-1", "late", "江某", ending.invitation.id);
  await blocked;
  await service.finish("session-1", "kp");
  release();
  const result = await selecting;
  assert(!result.ok && !service.find("session-1").pl.some((member) => member.userId === "late"), "权限操作期间结束团也不会提交半成品 PL");
  assert(discord.calls.some((call) => call[0] === "revoke" && call[2] === "late"), "结束后收回晚到的新增频道权限");
  assert(service.find("session-1").pendingMemberOp === null, "晚到变更回滚后清理操作锁");
}

{
  let draws = 0;
  let plainResult = 63;
  const { service, store } = await activeTable({ config: { messageContentEnabled: true }, randomInt: (min, max) => { draws += 1; return max === 9 ? 2 : plainResult; } });
  await store.update(state => ({ state: { ...state, sessions: state.sessions.map(session => ({ ...session,
    pl: session.pl.map(member => ({ ...member, skills: [{ name: "艺术与手艺", specialty: "演技", base: 5, growth: 5, occupationPoints: 30, interestPoints: 10 }] })) })) } }));
  const before = readFileSync(store.filePath, "utf8");
  const actual = await service.rollTextDice({ channelId: "room-1", userId: "pl", content: "1d100 演技" });
  assert(actual.ok && actual.text.includes("演技：63/50 失败") && actual.text.includes("= 63"), "技能骰点展示骰点／技能值与实际结果");
  assert(actual.text.endsWith("\n艺术与手艺：演技：63/50 失败") && !actual.text.includes("奈洛莉"), "技能行不重复角色姓名");
  assert(actual.text.endsWith("失败") && !/大成功|大失败|极难|困难|普通成功/.test(actual.text), "超过技能值只标失败，不细分等级");
  assertEqual(draws, 1, "技能只掷一次");
  plainResult = 50;
  const boundary = await service.rollTextDice({ channelId: "room-1", userId: "pl", content: "1d100 演技" });
  assert(boundary.ok && boundary.text.includes("演技：50/50 成功"), "骰点等于技能值标成功");
  const bonus = await service.rollTextDice({ channelId: "room-1", userId: "pl", content: "1d100 演技 奖励1" });
  assert(bonus.ok && bonus.text.includes("奖励1") && bonus.text.includes("演技：22/50 成功"), "技能奖惩展示最终骰点／技能值");
  assert(bonus.text.endsWith("成功"), "奖惩骰使用最终结果标成功");
  const count = draws;
  const unknown = await service.rollTextDice({ channelId: "room-1", userId: "pl", content: "1d100 不存在" });
  assert(unknown.skillError && draws === count, "未知技能提示且不掷骰");
  const kp = await service.rollTextDice({ channelId: "room-1", userId: "kp", content: "1d100 演技" });
  assert(kp.skillError && draws === count, "KP 不借用 PL 卡");
  assert((await service.rollTextDice({ channelId: "room-1", userId: "ob", content: "1d100 演技" })).ignore, "OB 技能骰点忽略");
  assertEqual(readFileSync(store.filePath, "utf8"), before, "技能骰点不写 Session 或长期卡");
}

{
  const { service, discord, store } = await activeTable({ config: { messageContentEnabled: true } });
  const invited = await invitePl(service, "add", "session-1", "kp", "pl2", "江某");
  assert(invited.ok, "本局再加一名 PL");
  assert((await service.previewSecret("session-1", "pl")).ok === false, "PL 不能打开秘密交流");
  assert((await service.createSecretThread("session-1", "kp", ["pl"])).ok === false, "没有名称不能建子区");
  const named = await service.beginCreateSecretThread("session-1", "kp", "密谈");
  assert(named.ok && named.session.pendingSecretOp?.name === "密谈", "记下待建子区名称");
  const created = await service.createSecretThread("session-1", "kp", ["pl", "pl", "outsider"]);
  assert(created.ok && created.thread.threadId === "thread-1", "KP 建成私密子区");
  assertEqual(created.thread.plUserIds.join(","), "pl", "只记下本团被选中的 PL");
  assert(discord.calls.some((call) => call[0] === "thread" && call[1] === "room-1" && call[2] === "密谈"), "在本团频道下建子区");
  assert(discord.calls.some((call) => call[0] === "thread-add" && call[2] === "kp"), "自动加入 KP");
  assert(discord.calls.some((call) => call[0] === "thread-add" && call[2] === "pl"), "加入所选 PL");
  assert(discord.calls.some((call) => call[0] === "thread-add" && call[2] === "ob"), "自动加入本团 OB");
  assert(!discord.calls.some((call) => call[0] === "thread-add" && call[2] === "pl2"), "未选中的 PL 不加入");
  const saved = JSON.parse(readFileSync(store.filePath, "utf8"));
  assertEqual(saved.sessions[0].secretThreads[0].threadId, "thread-1", "子区 ID 持久保存");
  const threadRoll = await service.roll({ channelId: "thread-1", userId: "pl", displayName: "奈洛莉", expression: "1d4" });
  assert(threadRoll.ok, "秘密子区可以 /r");
  const textRoll = await service.rollTextDice({ channelId: "thread-1", userId: "kp", content: "1d100" });
  assert(textRoll.ok === true, "秘密子区可以文字骰点");
  const outsiderRoll = await service.roll({ channelId: "thread-1", userId: "pl2", displayName: "江某", expression: "1d4" });
  assert(outsiderRoll.ok, "未进子区的本团 PL 若发 /r 仍按本团身份处理");
  const added = await service.addSecretThreadPl("session-1", "kp", "thread-1", ["pl2"]);
  assert(added.ok && added.session.secretThreads[0].plUserIds.includes("pl2"), "增补未加入的本团 PL");
  assert((await service.addSecretThreadPl("session-1", "kp", "thread-1", ["pl2"])).ok === false, "已在子区的 PL 不能再增补");
  const removed = await service.removeSecretThreadPl("session-1", "kp", "thread-1", ["pl"]);
  assert(removed.ok && !removed.session.secretThreads[0].plUserIds.includes("pl"), "移除 PL 只改后续访问名单");
  assert(discord.calls.some((call) => call[0] === "thread-remove" && call[2] === "pl"), "向 Discord 撤销子区成员");
  const reloaded = createCocSessionStore({ filePath: store.filePath });
  await reloaded.load();
  assertEqual(reloaded.snapshot().sessions[0].secretThreads[0].name, "密谈", "重启后仍能读到子区关联");
}

{
  const atMain = Date.parse("2026-09-28T12:15:00.000Z");
  const atSecret = Date.parse("2026-09-28T12:16:00.000Z");
  const atLater = Date.parse("2026-09-28T12:17:00.000Z");
  const { service, discord, store } = await activeTable({
    config: { messageContentEnabled: true, transcriptEnabled: true },
    histories: {
      "room-1": { messages: [
        { id: "m1", authorId: "kp", content: "主频道先说", createdTimestamp: atMain, type: 0 },
        { id: "m3", authorId: "pl", content: "主频道后说", createdTimestamp: atLater, type: 0 },
      ] },
      "thread-1": { messages: [
        { id: "s2", authorId: "pl", content: "第一子区", createdTimestamp: atSecret, type: 0 },
      ] },
      "thread-b": { messages: [
        { id: "s1", authorId: "kp", content: "第二子区更早", createdTimestamp: atMain, type: 0 },
      ] },
    },
  });
  await store.update((state) => {
    const current = state.sessions[0];
    const next = {
      ...current,
      secretThreads: [
        { threadId: "thread-1", name: "耳语", createdAt: 2_000, plUserIds: ["pl"] },
        { threadId: "thread-b", name: "密室", createdAt: 3_000, plUserIds: ["pl"] },
      ],
    };
    return { state: { ...state, sessions: [next] }, result: next };
  });
  const done = await service.finish("session-1", "kp");
  assert(done.ok && done.session.state === "ENDED", "含子区的总团录成功后才结束");
  const historyChannels = discord.calls.filter((call) => call[0] === "history").map((call) => call[1]);
  assertEqual(historyChannels.join(","), "room-1,thread-1,thread-b", "按创建顺序读取主频道和子区");
  const markdown = discord.calls.find((call) => call[0] === "send" && call[1]?.files)?.[1].files[0].attachment.toString("utf8");
  assert(markdown.includes("## 主频道") && markdown.includes("## 耳语") && markdown.includes("## 密室"), "总团录按子区名称分节");
  assert(markdown.indexOf("主频道先说") < markdown.indexOf("主频道后说"), "主频道内部按时间排");
  assert(markdown.indexOf("## 耳语") < markdown.indexOf("## 密室"), "子区分节按创建顺序");
  assert(markdown.includes("第一子区") && markdown.includes("第二子区更早"), "各子区消息都收录");
}

{
  const { service, discord } = await activeTable({
    config: { messageContentEnabled: true, transcriptEnabled: true },
    missingThreads: ["thread-1"],
    history: { messages: [{ id: "m", authorId: "kp", content: "主频道还在", createdTimestamp: Date.parse("2026-09-28T12:15:00.000Z"), type: 0 }] },
  });
  await service.beginCreateSecretThread("session-1", "kp", "已删");
  await service.createSecretThread("session-1", "kp", ["pl"]);
  const done = await service.finish("session-1", "kp");
  assert(done.ok === false && service.find("session-1").state === "ACTIVE", "子区已不存在时不进入删除");
  assert(done.message.includes("没有完整发出"), "缺失子区提示团录不完整");
  assert(!discord.calls.some((call) => call[0] === "send" && call[1]?.files), "缺失子区不发送残缺团录");
  assert(!discord.calls.some((call) => call[0] === "lock"), "缺失子区不锁频道");
  assert(service.find("session-1").deleteAt == null, "缺失子区不写删除倒计时");
}

{
  const { service, discord } = await activeTable({
    config: { messageContentEnabled: true, transcriptEnabled: true },
    failHistoryOf: { "thread-1": true },
    history: { messages: [{ id: "m", authorId: "kp", content: "不该删", createdTimestamp: Date.parse("2026-09-28T12:15:00.000Z"), type: 0 }] },
  });
  await service.beginCreateSecretThread("session-1", "kp", "读失败");
  await service.createSecretThread("session-1", "kp", ["pl"]);
  const done = await service.finish("session-1", "kp");
  assert(done.ok === false && service.find("session-1").state === "ACTIVE", "子区导出失败不进入删除");
  assert(!discord.calls.some((call) => call[0] === "lock"), "子区导出失败不锁频道");
  assert(service.find("session-1").deleteAt == null, "子区导出失败不写删除倒计时");
}

{
  const { service, discord } = await activeTable({
    config: { messageContentEnabled: true, transcriptEnabled: true },
    history: {
      messages: [{ id: "m", authorId: "kp", content: "截断", createdTimestamp: Date.parse("2026-09-28T12:15:00.000Z"), type: 0 }],
      truncated: true,
    },
  });
  const done = await service.finish("session-1", "kp");
  assert(done.ok === false && service.find("session-1").state === "ACTIVE", "截断团录不进入删除");
  assert(done.message.includes("没有完整发出"), "截断提示团录不完整");
  assert(!discord.calls.some((call) => call[0] === "send" && call[1]?.files), "截断团录不发送附件");
  assert(!discord.calls.some((call) => call[0] === "lock"), "截断团录不锁频道");
  assert(service.find("session-1").deleteAt == null, "截断团录不写删除倒计时");
}

{
  const { service, discord, store } = harness({
    config: { messageContentEnabled: true, transcriptEnabled: true },
    failHistory: true,
  });
  await store.load();
  await store.update((state) => ({
    state: {
      ...state,
      sessions: [{
        sessionId: "ending",
        state: "ENDING",
        guildId: "guild",
        recruitChannelId: "public",
        recruitMessageId: "panel",
        runChannelId: "room-1",
        controlMessageId: "control",
        rolesGranted: true,
        kpUserId: "kp",
        title: "收尾失败",
        pl: [{ userId: "pl", characterName: "奈洛莉", originalNickname: null, appliedNickname: null }],
        ob: [],
        createdAt: 1,
        startedAt: 1,
        endedAt: 1_000,
        deleteAt: 1_000 + DELETE_AFTER_MS,
        channelDeleted: false,
        transcriptDelivered: false,
        secretThreads: [],
      }],
    },
    result: null,
  }));
  await service.recoverInterrupted();
  const session = service.find("ending");
  assertEqual(session.state, "ACTIVE", "团录失败的收尾回到进行中");
  assert(session.deleteAt == null && session.endedAt == null, "团录失败的收尾不保留删除倒计时");
  assert(!discord.calls.some((call) => call[0] === "lock"), "团录失败的收尾不锁频道");
  assert(discord.calls.some((call) => (
    call[0] === "send" && String(call[1]?.content ?? "").includes("尚未进入 48 小时删除")
  )), "收尾失败提示可以重试结束");
}

{
  const { service, discord } = await activeTable({ config: { messageContentEnabled: true } });
  await service.beginCreateSecretThread("session-1", "kp", "密谈");
  await service.createSecretThread("session-1", "kp", []);
  discord.calls.length = 0;
  const addedOb = await service.addOb("session-1", "kp", "guest");
  assert(addedOb.ok && discord.calls.some((call) => call[0] === "thread-add" && call[2] === "guest"), "新增 OB 加入已有秘密子区");
  const converted = await service.convertPlToOb("session-1", "kp", "pl");
  assert(converted.ok && discord.calls.some((call) => call[0] === "thread-add" && call[2] === "pl"), "PL 转 OB 后补进未点名的秘密子区");
  assert(!converted.session.secretThreads[0].plUserIds.includes("pl"), "转 OB 后从点名名单里拿掉");
  const asPl = await invitePl(service, "convert", "session-1", "kp", "guest", "江某");
  assert(asPl.ok && discord.calls.some((call) => call[0] === "thread-remove" && call[2] === "guest"), "OB 转 PL 时退出未点名的秘密子区");
  const extra = await invitePl(service, "add", "session-1", "kp", "pl2", "江某");
  assert(extra.ok && !discord.calls.some((call) => call[0] === "thread-add" && call[2] === "pl2"), "新 PL 不自动进入已有秘密子区");
  const removed = await service.removeMember("session-1", "kp", "ob");
  assert(removed.ok && discord.calls.some((call) => call[0] === "thread-remove" && call[2] === "ob"), "移出本局时退出秘密子区");
}

{
  const { service, discord, store } = await activeTable({
    config: { messageContentEnabled: true },
    failThreadAdd: "pl",
  });
  await service.beginCreateSecretThread("session-1", "kp", "密谈");
  const created = await service.createSecretThread("session-1", "kp", ["pl"]);
  assert(created.ok && created.warning.includes("增补"), "PL 加入失败仍保存子区并提示增补");
  assert(!created.thread.plUserIds.includes("pl"), "只记录实际加入成功的 PL");
  const saved = JSON.parse(readFileSync(store.filePath, "utf8"));
  assert(!saved.sessions[0].secretThreads[0].plUserIds.includes("pl"), "失败的 PL 不写入持久名单");
  assert(discord.calls.some((call) => call[0] === "thread-add" && call[2] === "kp"), "KP 仍加入");
  assert(discord.calls.some((call) => call[0] === "thread-add" && call[2] === "ob"), "OB 仍加入");
}

{
  const { service, discord, store } = await activeTable({
    config: { messageContentEnabled: true },
    failThreadAdd: "kp",
  });
  await service.beginCreateSecretThread("session-1", "kp", "密谈");
  const created = await service.createSecretThread("session-1", "kp", ["pl"]);
  assert(created.ok === false, "KP 加入失败则回滚子区");
  assert(discord.calls.some((call) => call[0] === "delete" && call[1] === "thread-1"), "必需成员失败时删掉子区");
  assertEqual(JSON.parse(readFileSync(store.filePath, "utf8")).sessions[0].secretThreads?.length ?? 0, 0, "必需成员失败不留下子区记录");
  assert(service.find("session-1").pendingSecretOp == null, "回滚后清掉待建状态");
}

{
  const { service, discord, store } = await activeTable({
    config: { messageContentEnabled: true },
    failThreadAdd: "ob",
  });
  await service.beginCreateSecretThread("session-1", "kp", "密谈");
  const created = await service.createSecretThread("session-1", "kp", ["pl"]);
  assert(created.ok === false, "OB 加入失败则回滚子区");
  assert(discord.calls.some((call) => call[0] === "delete" && call[1] === "thread-1"), "OB 失败时删掉子区");
  assertEqual(JSON.parse(readFileSync(store.filePath, "utf8")).sessions[0].secretThreads?.length ?? 0, 0, "OB 失败不留下子区记录");
}

{
  const { service, discord, store } = await activeTable({ config: { messageContentEnabled: true } });
  await store.update((state) => {
    const current = state.sessions[0];
    const secretThreads = Array.from({ length: 25 }, (_, index) => ({
      threadId: `thread-${index + 1}`,
      name: `密${index + 1}`,
      createdAt: index,
      plUserIds: [],
    }));
    return {
      state: {
        ...state,
        sessions: [{ ...current, secretThreads, pendingSecretOp: { type: "create", name: "第26" } }],
      },
      result: null,
    };
  });
  assert((await service.beginCreateSecretThread("session-1", "kp", "第26")).ok === false, "满 25 个不能再填名称");
  const created = await service.createSecretThread("session-1", "kp", []);
  assert(created.ok === false && created.message.includes("最多 25"), "满 25 个不能再建子区");
  assert(!discord.calls.some((call) => call[0] === "thread" && call[2] === "第26"), "达到上限不向 Discord 建子区");
  assertEqual(service.find("session-1").secretThreads.length, 25, "达到上限后仍是 25 个子区");
}

{
  // 属性检定：快照来自选卡时的 characteristics，掷骰只读本局快照。
  let face = 43;
  const rand = (min, max) => (max === 9 ? face % 10 : face);
  const longTerm = { str: 50, con: 60, siz: 55, dex: 70, app: 65, int: 75, pow: 40, edu: 80, luck: 33 };
  let archiveReads = 0;
  const characters = {
    async list() { return { ok: true, characters: [{ id: "fixture-card" }] }; },
    async read(id, ownerDiscordUserId) {
      archiveReads += 1;
      return { ok: true, snapshot: { characterId: id, ownerDiscordUserId, characterName: id, occupation: "测试职业",
        initialHp: 10, initialSan: 50, initialMp: 10, initialLuck: 50,
        skills: [{ name: "侦查", base: 25, growth: 0, occupationPoints: 20, interestPoints: 0 }, { name: "敏捷", base: 1, growth: 0, occupationPoints: 0, interestPoints: 0 }],
        characteristics: { ...longTerm }, characterSheet: { character: { characteristics: { dex: 1, luck: 1 } } } } };
    },
  };
  const { service, store } = await activeTable({ config: { messageContentEnabled: true }, randomInt: rand, characters });
  const pl = service.find("session-1").pl.find(member => member.userId === "pl");
  assert(JSON.stringify(pl.characteristics) === JSON.stringify(longTerm), "选卡后 Session 保存九项属性");
  longTerm.dex = 5; longTerm.luck = 1;
  const readsBefore = archiveReads;
  const fileBefore = readFileSync(store.filePath, "utf8");
  const roll = content => service.rollTextDice({ channelId: "room-1", userId: "pl", content });
  const plain = text => `${formatTextDice("pl", rollDice("1d100", rand))}\n${text}`;
  assertEqual((await roll("1d100 敏捷")).text, plain("敏捷 DEX：43/70 成功"), "敏捷读到 DEX（长期卡后来修改不影响本局快照）");
  assertEqual((await roll("1d100 DEX")).text, plain("敏捷 DEX：43/70 成功"), "DEX 读到 DEX");
  assertEqual((await roll("1d100 dex")).text, plain("敏捷 DEX：43/70 成功"), "英文属性名小写兼容");
  assertEqual((await roll("1d100 Pow")).text, plain("意志 POW：43/40 失败"), "英文属性名混合大小写兼容，超过属性值标失败");
  assertEqual((await roll("1d100 幸运")).text, plain("幸运 LUCK：43/33 失败"), "幸运读到快照 Luck，不读 characterSheet");
  assertEqual((await roll("1d100 LUCK")).text, plain("幸运 LUCK：43/33 失败"), "LUCK 读到快照 Luck");
  face = 22;
  const bonus = await roll("1d100 敏捷 奖励1");
  assertEqual(bonus.text, `${formatBonusPenalty("pl", rollBonusPenalty(parseBonusPenalty("1d100 奖励1"), rand))}\n敏捷 DEX：22/70 成功`, "1d100 敏捷 奖励1");
  face = 55;
  const penalty = await roll("1d100 意志 惩罚2");
  assertEqual(penalty.text, `${formatBonusPenalty("pl", rollBonusPenalty(parseBonusPenalty("1d100 惩罚2"), rand))}\n意志 POW：55/40 失败`, "1d100 意志 惩罚2");
  assert(!/大成功|大失败|极难|困难/.test(bonus.text + penalty.text), "属性检定只判成功/失败");
  face = 45;
  assertEqual((await roll("1d100 侦查")).text, plain("侦查：45/45 成功"), "1d100 侦查 行为不变");
  assertEqual((await roll("1d100 侦查 奖励1")).text, `${formatBonusPenalty("pl", rollBonusPenalty(parseBonusPenalty("1d100 奖励1"), rand))}\n侦查：55/45 失败`, "技能奖惩行为不变");
  assertEqual((await roll("1d100 敏捷")).text, plain("敏捷 DEX：45/70 成功"), "属性名优先于同名自定义技能，不串到技能");
  assert((await roll("1d100 不存在")).message === "本局角色卡里没有这个技能，请检查名称。", "非属性名仍走技能查找");
  const kp = await service.rollTextDice({ channelId: "room-1", userId: "kp", content: "1d100 敏捷" });
  assert(kp.skillError && kp.message === "请先绑定本局调查员角色卡。" && !kp.text, "KP 读不到其他 PL 的属性");
  assert((await service.rollTextDice({ channelId: "room-1", userId: "ob", content: "1d100 敏捷" })).ignore, "OB 属性骰点仍被忽略");
  assert((await service.rollTextDice({ channelId: "room-1", userId: "ob", content: "1d100 幸运 奖励1" })).ignore, "OB 属性奖惩骰仍被忽略");
  assertEqual(archiveReads, readsBefore, "属性检定不实时读取档案馆");
  assertEqual(readFileSync(store.filePath, "utf8"), fileBefore, "属性检定不写 Session");

  await store.update(state => ({ state: { ...state, sessions: state.sessions.map(session => ({ ...session,
    pl: session.pl.map(member => { const { characteristics, ...rest } = member; return { ...rest, initialLuck: 50 }; }) })) } }));
  face = 30;
  const legacyDex = await roll("1d100 敏捷");
  assert(legacyDex.skillError && legacyDex.message === "本局角色属性数据异常，请联系 KP。", "老 Session 没有 characteristics 时属性安全失败");
  assertEqual((await roll("1d100 幸运")).text, plain("幸运 LUCK：30/50 成功"), "老 Session 幸运回退到 initialLuck");
  assertEqual((await roll("1d100 luck")).text, plain("幸运 LUCK：30/50 成功"), "老 Session LUCK 回退到 initialLuck");
  await store.update(state => ({ state: { ...state, sessions: state.sessions.map(session => ({ ...session,
    pl: session.pl.map(member => ({ ...member, initialLuck: "50" })) })) } }));
  assert((await roll("1d100 幸运")).message === "本局角色属性数据异常，请联系 KP。", "initialLuck 非法时不回退");
  await store.update(state => ({ state: { ...state, sessions: state.sessions.map(session => ({ ...session,
    pl: session.pl.map(member => ({ ...member, characteristics: { ...longTerm, dex: -3 } })) })) } }));
  assert((await roll("1d100 DEX")).message === "本局角色属性数据异常，请联系 KP。", "属性值非法时报数据异常");
}

{
  // 没卡时安全失败：PL 成员没有绑定角色卡。
  const { service, store } = await activeTable({ config: { messageContentEnabled: true }, randomInt: () => 10 });
  await store.update(state => ({ state: { ...state, sessions: state.sessions.map(session => ({ ...session,
    pl: session.pl.map(member => { const { characterId, characteristics, ...rest } = member; return rest; }) })) } }));
  const result = await service.rollTextDice({ channelId: "room-1", userId: "pl", content: "1d100 敏捷" });
  assert(result.skillError && result.message === "请先绑定本局调查员角色卡。", "没卡时属性检定沿用绑定提示");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);

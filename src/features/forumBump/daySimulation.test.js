/**
 * 特征测试：用真实 State Store + Scheduler + Bump Service（假 Discord / 假时钟 / 假 timer）
 * 连续模拟 3 个自然日，断言对外可观察的顶帖行为：
 * - 每次顶帖都在营业窗口内（Asia/Shanghai 10:00–22:00）
 * - 每个本地日的顶帖次数不超过 dailyLimit，且跨日后额度重置
 * - 每次顶帖都 send 一次并 delete 一次（不漏删），allowedMentions 为空
 * - 精确的顶帖时刻序列（当前实现的调度节奏，重构后必须一致）
 */
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { createForumBumpStateStore } from "./stateStore.js";
import { createForumBumpScheduler } from "./scheduler.js";
import { createForumBumpService } from "./bumpService.js";
import { getLocalTimeParts } from "./businessTime.js";

let passed = 0;
let failed = 0;
function assert(c, l) {
  if (c) { passed++; console.log(`  PASS: ${l}`); } else { failed++; console.error(`  FAIL: ${l}`); }
}

const G = "111111111111111111";
const F = "222222222222222222";
const T = "333333333333333333";
const M = "444444444444444444";
const logLines = [];
const capture = (level) => (msg, meta) => { logLines.push(JSON.stringify({ level, msg, meta })); };
const quiet = { info: capture("info"), warn: capture("warn"), error: capture("error"), debug: capture("debug") };
const TZ = "Asia/Shanghai";

/**
 * 场景与当前实现产生的顶帖时刻（UTC ISO）。重构后必须完全一致。
 * A：额度 3、间隔 4h → 上海 10:00 / 14:00 / 18:00
 * B：额度 5、间隔 3h → 上海 10:00 / 13:00 / 16:00 / 19:00，22:00 已出窗，当日只顶 4 次
 * C：额度 2、间隔 3h → 上海 10:00 / 13:00，窗口内本可再顶 2 次，由每日额度截停（A/B 都被窗口先截住）
 */
const SCENARIOS = [
  {
    name: "A",
    dailyLimit: 3,
    cooldownMs: 4 * 60 * 60 * 1000,
    expected: ["2026-07-28T02:00:00.000Z","2026-07-28T06:00:00.000Z","2026-07-28T10:00:00.000Z","2026-07-29T02:00:00.000Z","2026-07-29T06:00:00.000Z","2026-07-29T10:00:00.000Z","2026-07-30T02:00:00.000Z","2026-07-30T06:00:00.000Z","2026-07-30T10:00:00.000Z"],
  },
  {
    name: "B",
    dailyLimit: 5,
    cooldownMs: 3 * 60 * 60 * 1000,
    expected: ["2026-07-28T02:00:00.000Z","2026-07-28T05:00:00.000Z","2026-07-28T08:00:00.000Z","2026-07-28T11:00:00.000Z","2026-07-29T02:00:00.000Z","2026-07-29T05:00:00.000Z","2026-07-29T08:00:00.000Z","2026-07-29T11:00:00.000Z","2026-07-30T02:00:00.000Z","2026-07-30T05:00:00.000Z","2026-07-30T08:00:00.000Z","2026-07-30T11:00:00.000Z"],
  },
  {
    name: "C",
    dailyLimit: 2,
    cooldownMs: 3 * 60 * 60 * 1000,
    expected: ["2026-07-28T02:00:00.000Z","2026-07-28T05:00:00.000Z","2026-07-29T02:00:00.000Z","2026-07-29T05:00:00.000Z","2026-07-30T02:00:00.000Z","2026-07-30T05:00:00.000Z"],
  },
];

function localParts(ms) {
  return getLocalTimeParts(ms, TZ);
}

for (const { name, dailyLimit: DAILY_LIMIT, cooldownMs, expected: EXPECTED_SEND_TIMES } of SCENARIOS) {
const dir = mkdtempSync(join(tmpdir(), "fb-day-"));
try {
  let now = Date.parse("2026-07-28T00:30:00.000Z"); // 上海 08:30（窗前）
  const clock = { now: () => now };
  const sends = [];
  const deletes = [];
  const payloads = [];
  const message = { id: M, delete: async () => { deletes.push(now); } };
  const thread = {
    id: T,
    type: ChannelType.PublicThread,
    guildId: G,
    parentId: F,
    parent: { id: F, type: ChannelType.GuildForum, defaultSortOrder: 0 },
    name: "t",
    archived: true,
    locked: false,
    pinned: false,
    autoArchiveDuration: 4320,
    archiveTimestamp: 1_700_000_000_000,
    lastMessageId: "1429163615671423037",
    messageCount: 1,
    totalMessageSent: 1,
    appliedTags: [],
    permissionsFor() {
      return { has: (f) => [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessagesInThreads].includes(f) };
    },
    send: async (payload) => { sends.push(now); payloads.push(payload); return message; },
  };
  const client = {
    user: { id: "bot" },
    isReady: () => true,
    channels: { fetch: async (id) => (id === T ? thread : id === F ? thread.parent : null) },
  };
  const timerList = [];
  let tid = 0;
  const timers = {
    setTimeout(fn, ms) { const h = ++tid; timerList.push({ h, fn, due: now + ms, cancelled: false, fired: false }); return h; },
    clearTimeout(h) { const t = timerList.find((x) => x.h === h); if (t) t.cancelled = true; },
  };
  const store = createForumBumpStateStore({ statePath: join(dir, "state.json"), logger: quiet, clock });
  await store.initialize({ localDate: "2026-07-28" });
  const sched = createForumBumpScheduler({
    scanCandidates: async () => ({ candidates: [{ threadId: T, forumChannelId: F, guildId: G }] }),
    bumpService: createForumBumpService({ client, logger: quiet, clock, sleep: async () => {} }),
    stateStore: store,
    config: {
      enabled: true,
      guildId: G,
      forumChannelIds: [F],
      silenceDays: 30,
      excludedTagIds: [],
      skipPinned: true,
      dailyLimit: DAILY_LIMIT,
      cooldownMs,
      cooldownJitterMs: 0,
      idlePollMs: 30 * 60 * 1000,
      failureBackoffMs: 5 * 60 * 1000,
      timezone: TZ,
      activeStart: "10:00",
      activeEnd: "22:00",
    },
    clock,
    timers,
    random: () => 0,
    logger: quiet,
  });
  await sched.start();

  const end = Date.parse("2026-07-31T00:00:00.000Z");
  let fired = 0;
  while (fired < 500) {
    const next = timerList.filter((t) => !t.cancelled && !t.fired).sort((a, b) => a.due - b.due)[0];
    if (!next || next.due >= end) break;
    now = Math.max(now, next.due);
    next.fired = true;
    next.fn();
    fired += 1;
    for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  }
  await sched.stop();

  const perDay = {};
  let allInside = true;
  for (const t of sends) {
    const p = localParts(t);
    const day = `${p.year}-${p.month}-${p.day}`;
    perDay[day] = (perDay[day] ?? 0) + 1;
    const minutes = p.hour * 60 + p.minute;
    if (minutes < 10 * 60 || minutes >= 22 * 60) allInside = false;
  }
  assert(sends.length > 0, `[${name}] 模拟期内有顶帖（${sends.length} 次，timer 触发 ${fired} 次）`);
  assert(allInside, `[${name}] 所有顶帖都在营业窗口 10:00–22:00（上海）内`);
  assert(Object.values(perDay).every((n) => n <= DAILY_LIMIT), `[${name}] 每日不超过额度 ${DAILY_LIMIT}：${JSON.stringify(perDay)}`);
  assert(Object.keys(perDay).length === 3, `[${name}] 三个本地日都有顶帖（跨日额度重置）`);
  assert(deletes.length === sends.length, `[${name}] 每次 send 都 delete（不漏删）`);
  assert(payloads.every((p) => Array.isArray(p.allowedMentions?.parse) && p.allowedMentions.parse.length === 0),
    `[${name}] allowedMentions.parse 为空`);
  const content = payloads[0]?.content;
  assert(typeof content === "string" && content.length > 0 && logLines.length > 0
    && logLines.every((l) => !l.includes(content)), `[${name}] 日志中不出现顶帖正文（${logLines.length} 条日志）`);
  const actualTimes = sends.map((t) => new Date(t).toISOString());
  if (EXPECTED_SEND_TIMES === null) {
    console.log(`  ACTUAL_SEND_TIMES=${JSON.stringify(actualTimes)}`);
    assert(false, `[${name}] EXPECTED_SEND_TIMES 未填写`);
  } else {
    assert(JSON.stringify(actualTimes) === JSON.stringify(EXPECTED_SEND_TIMES), `顶帖时刻序列与当前实现一致 ${JSON.stringify(actualTimes)}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
}

console.log(`\n[daySimulation.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

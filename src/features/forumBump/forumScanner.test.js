import { ChannelType, PermissionFlagsBits } from "discord.js";
import {
  dedupeThreadsById,
  fetchAllPublicArchivedThreads,
  pickOldestArchiveCursor,
  scanForumCandidates,
  validateForumChannel,
} from "./forumScanner.js";
import { isForumBumpError } from "./errors.js";

const GUILD = "111111111111111111";
const FORUM_A = "222222222222222222";
const FORUM_B = "333333333333333333";
const OLD_MSG = "1429163615671423037";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label} (got ${JSON.stringify(actual)})`);
}

function makePerms(flags) {
  const set = new Set(flags);
  return { has: (f) => set.has(f) };
}

function makeThread({
  id,
  parentId = FORUM_A,
  type = ChannelType.PublicThread,
  archived = false,
  locked = false,
  pinned = false,
  lastMessageId = OLD_MSG,
  archiveTimestamp = 1_700_000_000_000,
  name = "t",
  appliedTags = [],
} = {}) {
  return {
    id,
    parentId,
    type,
    guildId: GUILD,
    name,
    archived,
    locked,
    pinned,
    lastMessageId,
    archiveTimestamp,
    appliedTags,
    messageCount: 1,
    totalMessageSent: 1,
    permissionsFor() {
      return makePerms([
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.SendMessagesInThreads,
      ]);
    },
    send: async () => { throw new Error("must not send"); },
    edit: async () => { throw new Error("must not edit"); },
    setArchived: async () => { throw new Error("must not setArchived"); },
  };
}

function makeForum({ id = FORUM_A, name = "forum-a" } = {}) {
  return {
    id,
    name,
    type: ChannelType.GuildForum,
    guildId: GUILD,
    permissionsFor() {
      return makePerms([PermissionFlagsBits.ViewChannel]);
    },
  };
}

function makeClient(forumsById) {
  return {
    user: { id: "bot" },
    channels: {
      fetch: async (id, options) => {
        if (!options?.force) throw new Error("expected force:true");
        const forum = forumsById[id];
        if (!forum) {
          const err = new Error("missing");
          err.code = 10003;
          throw err;
        }
        return forum;
      },
    },
  };
}

const clock = { now: () => 1_800_000_000_000 };

console.log("\n=== ForumBump forumScanner ===\n");

// pickOldestArchiveCursor
{
  const cursor = pickOldestArchiveCursor([
    { archiveTimestamp: 300 },
    { archiveTimestamp: 100 },
    { archiveTimestamp: 200 },
  ]);
  assertEqual(cursor, 100, "最旧 archiveTimestamp 作游标");
}

// dedupe
{
  const t1 = makeThread({ id: "1", lastMessageId: OLD_MSG });
  const t1b = makeThread({ id: "1", lastMessageId: OLD_MSG, messageCount: 5, totalMessageSent: 5 });
  t1b.messageCount = 5;
  t1b.totalMessageSent = 5;
  const { unique, duplicateCount, rawCount } = dedupeThreadsById([t1, t1b, makeThread({ id: "2" })]);
  assertEqual(unique.length, 2, "去重后 2");
  assertEqual(duplicateCount, 1, "duplicateCount 1");
  assertEqual(rawCount, 3, "rawCount 3");
}

// 分页完整扫描
{
  const pages = [
    {
      threads: [
        makeThread({ id: "a1", archiveTimestamp: 300 }),
        makeThread({ id: "a2", archiveTimestamp: 200 }),
      ],
      hasMore: true,
    },
    {
      threads: [
        makeThread({ id: "a3", archiveTimestamp: 100 }),
      ],
      hasMore: false,
    },
  ];
  let pageCalls = 0;
  const befores = [];
  const fetchArchivedPage = async (_forum, options = {}) => {
    pageCalls += 1;
    befores.push(options.before ?? null);
    return pages[pageCalls - 1];
  };
  const result = await fetchAllPublicArchivedThreads(makeForum(), fetchArchivedPage);
  assertEqual(pageCalls, 2, "完整两页");
  assertEqual(result.archivedPageCount, 2, "archivedPageCount 2");
  assertEqual(result.threads.length, 3, "三帖");
  assertEqual(befores[0], null, "首页无 before");
  assertEqual(befores[1], 200, "第二页 before=最旧 ts");
}

// 不因候选数量提前停
{
  let pageCalls = 0;
  const many = Array.from({ length: 15 }, (_, i) =>
    makeThread({ id: `p${i}`, archiveTimestamp: 1000 - i }),
  );
  const fetchArchivedPage = async () => {
    pageCalls += 1;
    if (pageCalls === 1) return { threads: many.slice(0, 10), hasMore: true };
    return { threads: many.slice(10), hasMore: false };
  };
  const result = await fetchAllPublicArchivedThreads(makeForum(), fetchArchivedPage);
  assertEqual(pageCalls, 2, "找到很多帖仍完整分页");
  assertEqual(result.threads.length, 15, "15 帖全取");
}

// 重复游标失败
{
  try {
    await fetchAllPublicArchivedThreads(makeForum(), async () => ({
      threads: [makeThread({ id: "x", archiveTimestamp: 50 })],
      hasMore: true,
    }));
    assert(false, "重复游标应失败");
  } catch (error) {
    assert(isForumBumpError(error) && error.code === "ARCHIVED_PAGINATION_STALLED", "分页卡住");
  }
}

// hasMore 但无游标
{
  try {
    await fetchAllPublicArchivedThreads(makeForum(), async () => ({
      threads: [{ id: "y", archiveTimestamp: null }],
      hasMore: true,
    }));
    assert(false, "无游标应失败");
  } catch (error) {
    assert(error.code === "ARCHIVED_PAGINATION_STALLED", "无 archiveTimestamp 卡住");
  }
}

// Forum 校验
{
  const forum = makeForum();
  const client = makeClient({ [FORUM_A]: forum });
  const got = await validateForumChannel(client, FORUM_A, GUILD, client.user);
  assertEqual(got.id, FORUM_A, "合法 Forum");
}

{
  const client = makeClient({});
  try {
    await validateForumChannel(client, FORUM_A, GUILD, { id: "bot" });
    assert(false, "不存在应失败");
  } catch (error) {
    assert(error.code === "FORUM_NOT_FOUND", "FORUM_NOT_FOUND");
  }
}

{
  const forum = makeForum();
  forum.guildId = "other";
  const client = makeClient({ [FORUM_A]: forum });
  try {
    await validateForumChannel(client, FORUM_A, GUILD, client.user);
    assert(false, "错误 guild 应失败");
  } catch (error) {
    assert(error.code === "WRONG_GUILD", "WRONG_GUILD");
  }
}

{
  const forum = makeForum();
  forum.type = ChannelType.GuildText;
  const client = makeClient({ [FORUM_A]: forum });
  try {
    await validateForumChannel(client, FORUM_A, GUILD, client.user);
    assert(false, "非 forum 应失败");
  } catch (error) {
    assert(error.code === "NOT_FORUM_CHANNEL", "NOT_FORUM_CHANNEL");
  }
}

{
  const forum = makeForum();
  forum.permissionsFor = () => makePerms([]);
  const client = makeClient({ [FORUM_A]: forum });
  try {
    await validateForumChannel(client, FORUM_A, GUILD, client.user);
    assert(false, "缺 view 应失败");
  } catch (error) {
    assert(error.code === "BOT_MISSING_VIEW_CHANNEL", "BOT_MISSING_VIEW_CHANNEL");
  }
}

// 全扫描：过滤其他 Forum / 类型，无写操作
{
  let sendCount = 0;
  let deleteCount = 0;
  let editCount = 0;
  let setArchivedCount = 0;

  const forum = makeForum();
  const tOwn = makeThread({ id: "own1", parentId: FORUM_A });
  tOwn.send = async () => { sendCount += 1; };
  tOwn.edit = async () => { editCount += 1; };
  tOwn.setArchived = async () => { setArchivedCount += 1; };

  const tOtherForum = makeThread({ id: "other", parentId: FORUM_B });
  const tPrivate = makeThread({ id: "priv", type: ChannelType.PrivateThread });
  const tAnnounce = makeThread({ id: "ann", type: ChannelType.AnnouncementThread });
  const tArchived = makeThread({
    id: "arch1",
    archived: true,
    archiveTimestamp: 1_600_000_000_000,
  });
  tArchived.send = async () => { sendCount += 1; };

  const client = makeClient({ [FORUM_A]: forum });

  const report = await scanForumCandidates({
    client,
    guildId: GUILD,
    forumIds: [FORUM_A],
    silenceDays: 30,
    displayLimit: 1,
    clock,
    fetchActiveThreads: async () => [tOwn, tOtherForum, tPrivate, tAnnounce],
    fetchArchivedPage: async () => ({
      threads: [tArchived, tOwn],
      hasMore: false,
    }),
  });

  assertEqual(report.summary.eligibleCount >= 1, true, "有候选");
  assertEqual(report.candidates.length, 1, "displayLimit 只裁剪展示");
  assert(report.summary.eligibleCount >= report.candidates.length, "统计基于完整结果");
  assertEqual(sendCount, 0, "send=0");
  assertEqual(deleteCount, 0, "delete=0");
  assertEqual(editCount, 0, "edit=0");
  assertEqual(setArchivedCount, 0, "setArchived=0");
  assert(
    report.forums[0].activeAcceptedCount === 1,
    "活跃只接受目标 Forum PublicThread",
  );
}

// 任一 Forum 非法整次失败
{
  const good = makeForum({ id: FORUM_A });
  const client = makeClient({ [FORUM_A]: good });
  try {
    await scanForumCandidates({
      client,
      guildId: GUILD,
      forumIds: [FORUM_A, FORUM_B],
      silenceDays: 30,
      clock,
      fetchActiveThreads: async () => [],
      fetchArchivedPage: async () => ({ threads: [], hasMore: false }),
    });
    assert(false, "半套扫描应失败");
  } catch (error) {
    assert(error.code === "FORUM_NOT_FOUND", "整次失败 FORUM_NOT_FOUND");
  }
}

// display-limit 不提前停分页
{
  let pageCalls = 0;
  const forum = makeForum();
  const client = makeClient({ [FORUM_A]: forum });
  await scanForumCandidates({
    client,
    guildId: GUILD,
    forumIds: [FORUM_A],
    silenceDays: 30,
    displayLimit: 1,
    clock,
    fetchActiveThreads: async () => [],
    fetchArchivedPage: async () => {
      pageCalls += 1;
      if (pageCalls === 1) {
        return {
          threads: Array.from({ length: 5 }, (_, i) =>
            makeThread({ id: `x${i}`, archiveTimestamp: 500 - i }),
          ),
          hasMore: true,
        };
      }
      return {
        threads: [makeThread({ id: "last", archiveTimestamp: 10 })],
        hasMore: false,
      };
    },
  });
  assertEqual(pageCalls, 2, "display-limit 不提前停分页");
}

// 多 Forum 汇总
{
  const fa = makeForum({ id: FORUM_A, name: "A" });
  const fb = makeForum({ id: FORUM_B, name: "B" });
  fb.guildId = GUILD;
  const client = makeClient({ [FORUM_A]: fa, [FORUM_B]: fb });
  const report = await scanForumCandidates({
    client,
    guildId: GUILD,
    forumIds: [FORUM_A, FORUM_B],
    silenceDays: 30,
    clock,
    fetchActiveThreads: async (forum) => [
      makeThread({ id: `${forum.id}-t`, parentId: forum.id }),
    ],
    fetchArchivedPage: async () => ({ threads: [], hasMore: false }),
  });
  assertEqual(report.summary.totalForums, 2, "totalForums 2");
  assertEqual(report.forums.length, 2, "两个 forum 摘要");
}

console.log(`\nForumBump forumScanner: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

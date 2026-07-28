import { ChannelType } from "discord.js";
import {
  captureThreadSnapshot,
  forceFetchChannel,
  forceRefreshThreadSnapshot,
} from "./threadSnapshot.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(actual, expected, label) {
  assert(actual === expected, `${label}`);
}

console.log("\n=== ForumBump threadSnapshot ===\n");

{
  const snap = captureThreadSnapshot(
    {
      id: "t1",
      guildId: "g1",
      parentId: "f1",
      type: 11,
      name: "n",
      archived: false,
      locked: false,
      lastMessageId: "m1",
      appliedTags: ["a"],
    },
    { id: "f1", defaultSortOrder: 0 },
    { now: () => 1_700_000_000_000 },
  );
  assertEqual(snap.threadId, "t1", "threadId");
  assertEqual(snap.forumChannelId, "f1", "forumChannelId");
  assertEqual(snap.appliedTagIds.join(","), "a", "tags");
  assertEqual(snap.defaultSortOrder, 0, "sort");
}

{
  const calls = [];
  const client = {
    channels: {
      fetch: async (id, options) => {
        calls.push({ id, force: options?.force === true });
        if (id === "t1") {
          return {
            id: "t1",
            parentId: "f1",
            type: ChannelType.PublicThread,
            guildId: "g",
          };
        }
        return { id: "f1", type: ChannelType.GuildForum, defaultSortOrder: null };
      },
    },
  };
  const result = await forceRefreshThreadSnapshot(client, "t1", { now: () => 1 });
  assert(result.snapshot.threadId === "t1", "force refresh snapshot");
  assert(calls.every((c) => c.force), "全部 force");
}

{
  try {
    await forceFetchChannel({
      channels: {
        fetch: async () => {
          const err = new Error("missing");
          err.code = 10003;
          throw err;
        },
      },
    }, "x");
    assert(false, "应失败");
  } catch (error) {
    assertEqual(error.code, "THREAD_NOT_FOUND", "NOT_FOUND");
  }
}

console.log(`\nForumBump threadSnapshot: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

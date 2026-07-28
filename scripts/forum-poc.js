/**
 * Forum 临时消息顶帖 POC CLI 入口。
 *
 * 独立短生命周期工具：不启动生产 Bot、Health Monitor、Preflight 等。
 *
 * 用法：
 *   npm run forum:poc -- inspect --thread <id> --confirm-guild <guildId>
 *   npm run forum:poc -- bump-message --thread <id> --confirm-guild <guildId>
 *   npm run forum:poc -- bump-message --thread <id> --confirm-guild <guildId> --execute
 */

import { runForumPoc } from "../src/features/forumPoc/cli.js";

const isMain = process.argv[1] && (
  process.argv[1].endsWith("forum-poc.js")
  || process.argv[1].replace(/\\/g, "/").endsWith("scripts/forum-poc.js")
);

export { runForumPoc, parseForumPocArgs } from "../src/features/forumPoc/cli.js";

if (isMain) {
  const result = await runForumPoc({
    argv: process.argv.slice(2),
  });
  process.exitCode = result.exitCode;
}

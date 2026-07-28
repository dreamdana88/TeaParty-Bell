/**
 * Forum 候选扫描 Dry Run CLI 入口。
 *
 * 用法：
 *   npm run forum:scan -- --forum <id> --silence-days 30 --confirm-guild <guildId>
 */

import { runForumScan } from "../src/features/forumBump/scanCli.js";

const isMain = process.argv[1] && (
  process.argv[1].endsWith("forum-scan.js")
  || process.argv[1].replace(/\\/g, "/").endsWith("scripts/forum-scan.js")
);

export { runForumScan, parseForumScanArgs } from "../src/features/forumBump/scanCli.js";

if (isMain) {
  const result = await runForumScan({
    argv: process.argv.slice(2),
  });
  process.exitCode = result.exitCode;
}

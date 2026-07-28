import {
  getLocalDate,
  getNextBusinessDayWindowStart,
  getNextWindowStart,
  isInsideActiveWindow,
} from "./businessTime.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}
function assertEqual(a, e, l) {
  assert(a === e, `${l} (got ${a})`);
}

console.log("\n=== ForumBump businessTime ===\n");

// 2026-07-28T02:00:00Z = 10:00 Asia/Shanghai
const sh10 = Date.parse("2026-07-28T02:00:00.000Z");
assertEqual(getLocalDate(sh10, "Asia/Shanghai"), "2026-07-28", "SH localDate");
assert(isInsideActiveWindow(sh10, "Asia/Shanghai", "10:00", "22:00"), "10:00 在窗口内");

const sh08 = Date.parse("2026-07-28T00:00:00.000Z");
assert(!isInsideActiveWindow(sh08, "Asia/Shanghai", "10:00", "22:00"), "08:00 窗外");
assertEqual(
  new Date(getNextWindowStart(sh08, "Asia/Shanghai", "10:00", "22:00")).toISOString(),
  "2026-07-28T02:00:00.000Z",
  "下一窗口当天 10:00",
);

const sh23 = Date.parse("2026-07-28T15:00:00.000Z");
assert(!isInsideActiveWindow(sh23, "Asia/Shanghai", "10:00", "22:00"), "23:00 窗外");
assertEqual(
  new Date(getNextWindowStart(sh23, "Asia/Shanghai", "10:00", "22:00")).toISOString(),
  "2026-07-29T02:00:00.000Z",
  "下一窗口次日 10:00",
);

assertEqual(getLocalDate(sh10, "UTC"), "2026-07-28", "UTC date");
assert(
  getNextBusinessDayWindowStart(sh10, "Asia/Shanghai", "10:00")
    > sh10,
  "下一业务日 > now",
);

console.log(`\nForumBump businessTime: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exitCode = 1;

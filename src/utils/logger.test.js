/**
 * logger 对外契约：脱敏、不可序列化 meta 不抛出且不泄露、输出流异常不抛出。
 */
import { logger, setLogLevel } from "./logger.js";

let passed = 0;
let failed = 0;
function check(cond, name) {
  if (cond) { passed++; console.log(`  PASS: ${name}`); } else { failed++; console.log(`  FAIL: ${name}`); }
}

const original = { info: console.info, error: console.error };
const lines = [];
console.info = (line) => lines.push(line);
setLogLevel("info");

logger.info("redact", { token: "abc", ok: 1 });
check(lines[0].includes("***REDACTED***") && !lines[0].includes("abc"), "敏感字段脱敏");

const circular = { secret: "s3cr3t" };
circular.self = circular;
let threw = false;
try { logger.info("circular", circular); } catch { threw = true; }
check(!threw && lines[1].includes("logMetaError") && !lines[1].includes("s3cr3t"), "循环引用 meta 不抛出且不输出原始内容");

threw = false;
try { logger.info("bigint", { n: 1n }); } catch { threw = true; }
check(!threw, "BigInt meta 不抛出");

console.error = () => { throw new Error("stream broken"); };
threw = false;
try { logger.error("boom"); } catch { threw = true; }
check(!threw, "输出流异常不抛出");

console.info = original.info;
console.error = original.error;
console.log(`\n[logger.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);

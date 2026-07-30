import { parseCopyTestModels, runCopyTest } from "./copyTestRunner.js";

let passed = 0;
let failed = 0;
function assert(condition, label) {
  if (condition) { passed++; console.log(`  PASS: ${label}`); }
  else { failed++; console.error(`  FAIL: ${label}`); }
}

assert(JSON.stringify(parseCopyTestModels(" alpha, , beta ", "fallback")) === JSON.stringify(["alpha", "beta"]), "多模型按逗号解析并清理空白");
assert(JSON.stringify(parseCopyTestModels("", "fallback")) === JSON.stringify(["fallback"]), "未设置模型时使用 AI_MODEL");

const output = [];
const errors = [];
const createdModels = [];
let clock = 0;
const summaries = await runCopyTest({
  config: { aiModel: "fallback", aiApiKey: "super-secret" },
  models: ["good-model", "bad-model"],
  rounds: 1,
  userId: "u",
  createCopyGeneratorFn(config) {
    createdModels.push(config.aiModel);
    let calls = 0;
    return { async generateCopy() {
      calls++;
      clock += 10;
      if (config.aiModel === "bad-model" && calls === 2) {
        const error = new Error("Bearer super-secret must never print");
        error.code = "network_error";
        throw error;
      }
      return `copy-${config.aiModel}-${calls}`;
    } };
  },
  buildTitleFn: (_userId, count) => `title-${count}`,
  assembleMessageFn: (title, body) => `${title}:${body}`,
  write: (line) => output.push(line),
  writeError: (line) => errors.push(line),
  now: () => clock,
});

assert(JSON.stringify(createdModels) === JSON.stringify(["good-model", "bad-model"]), "按模型分别创建文案生成器");
assert(summaries[0].successCount === 3 && summaries[0].failureCount === 0 && summaries[0].averageSuccessMs === 10, "单模型统计成功数和平均耗时");
assert(summaries[1].successCount === 2 && summaries[1].failureCount === 1 && summaries[1].averageSuccessMs === 10, "失败模型仍完成其余测试并统计");
assert(output.join("\n").includes("Model: good-model") && output.join("\n").includes("Model: bad-model"), "按模型分组输出并汇总");
assert(!`${output.join("\n")}\n${errors.join("\n")}`.includes("super-secret") && !errors.join("\n").includes("Bearer"), "输出不泄露 Key 或鉴权 Header");
assert(!output.join("\n").toLowerCase().includes("discord"), "测试执行器不连接 Discord");

console.log(`\n[copyTestRunner.test] ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);

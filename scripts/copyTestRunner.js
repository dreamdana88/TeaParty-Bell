/**
 * 文案测试的可注入执行器。
 * 不加载 Discord，也不读取环境变量，便于用 fake AI 做离线测试。
 */

export function parseCopyTestModels(value, fallbackModel) {
  const models = String(value ?? "")
    .split(",")
    .map((model) => model.trim())
    .filter(Boolean);
  return models.length > 0 ? models : [fallbackModel];
}

/**
 * @param {object} options
 * @param {object} options.config
 * @param {string[]} options.models
 * @param {number} options.rounds
 * @param {string} options.userId
 * @param {string} [options.interest]
 * @param {string} [options.fixedStyle]
 * @param {Function} options.createCopyGeneratorFn
 * @param {Function} options.buildTitleFn
 * @param {Function} options.assembleMessageFn
 * @param {(line: string) => void} [options.write]
 * @param {(line: string) => void} [options.writeError]
 * @param {() => number} [options.now]
 */
export async function runCopyTest(options) {
  const {
    config,
    models,
    rounds,
    userId,
    interest = "",
    fixedStyle = "",
    createCopyGeneratorFn,
    buildTitleFn,
    assembleMessageFn,
    write = console.log,
    writeError = console.error,
    now = Date.now,
  } = options;
  const summaries = [];

  for (const model of models) {
    const summary = { model, successCount: 0, failureCount: 0, totalSuccessMs: 0 };
    const copyGenerator = createCopyGeneratorFn({ ...config, aiModel: model });
    write(`\n========== Model: ${model} ==========`);

    for (let round = 1; round <= rounds; round++) {
      for (const boostCount of [1, 2, 3]) {
        write(`── ${model} | Round ${round}/${rounds} | boostCount = ${boostCount} ──`);
        const startedAt = now();
        try {
          const title = buildTitleFn(userId, boostCount);
          const body = await copyGenerator.generateCopy({
            interest: interest || undefined,
            styleHint: fixedStyle || undefined,
          });
          summary.successCount++;
          summary.totalSuccessMs += now() - startedAt;
          write(assembleMessageFn(title, body));
        } catch (error) {
          summary.failureCount++;
          // 不输出错误原文：即使某个自定义客户端抛出敏感错误，测试脚本也不扩散它。
          writeError(`❌ 生成失败（${error?.code ?? "unknown_error"}）`);
        }
      }
    }

    summary.averageSuccessMs = summary.successCount === 0
      ? 0
      : Math.round(summary.totalSuccessMs / summary.successCount);
    summaries.push(summary);
  }

  write("\n========================================");
  write("文案测试汇总");
  for (const summary of summaries) {
    write(`Model: ${summary.model} | 成功: ${summary.successCount} | 失败: ${summary.failureCount} | 平均成功耗时: ${summary.averageSuccessMs}ms`);
  }
  write("========================================");
  return summaries;
}

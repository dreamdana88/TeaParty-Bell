/**
 * Boost 感谢发送编排器（Phase 6–7）。
 *
 * 职责：
 * - 接收聚合完成后的 BoostEvent
 * - 调用 AI 生成感谢正文
 * - 调用 messageBuilder 生成标题并拼装消息
 * - 调用公共 Discord sender 发送到感谢频道
 * - 消息发送成功后随机选择 Application Emoji 添加 Reaction（Phase 7）
 *
 * 不负责：
 * - Discord 事件观察（见 observer.js）
 * - Boost 聚合逻辑（见 aggregator.js）
 * - AI 正文生成细节（见 copyGenerator.js）
 * - 标题构造细节（见 messageBuilder.js）
 * - 防重复持久化（Phase 8）
 * - Emoji 获取与管理（见 src/resources/applicationEmojis.js）
 * - Emoji 随机选择（见 emojiSelector.js）
 * - Reaction 添加细节（见 src/discord/reactionSender.js）
 */

import { createCopyGenerator } from "./copyGenerator.js";
import { buildTitle, assembleMessage } from "./messageBuilder.js";
import { sendMessage } from "../../discord/messageSender.js";
import { addReactions } from "../../discord/reactionSender.js";
import { selectEmojis } from "./emojiSelector.js";

/**
 * 创建 Boost 感谢处理 Handler。
 *
 * @param {object} opts
 * @param {object} opts.config           - loadConfig() 输出
 * @param {import("discord.js").Client} opts.client - Discord Client
 * @param {object} opts.logger           - Logger 实例
 * @param {{ generateText: Function }} [opts.aiOverride]  - 测试用 AI
 * @param {{ sendMessage: Function }} [opts.senderOverride] - 测试用 sender
 * @param {{ fetchEmojis: Function }} [opts.emojiProvider] - Phase 7：Emoji Provider（缺失时跳过 Reaction）
 * @param {Function} [opts.reactionSenderOverride] - Phase 7：测试用 Reaction Sender
 * @returns {{ handleBoostEvent: Function }}
 */
export function createBoostThanksHandler(opts) {
  const { config, client, logger } = opts;

  // AI 文案生成器（支持测试注入）
  const copyGenerator = createCopyGenerator(
    config,
    opts.aiOverride ?? undefined
  );

  // Discord 发送（支持测试注入）
  const doSend = opts.senderOverride ?? sendMessage;

  // Phase 7：Application Emoji Provider（测试注入或生产创建）
  const emojiProvider = opts.emojiProvider ?? null;

  // Phase 7：Reaction 发送（支持测试注入）
  const doReactions = opts.reactionSenderOverride ?? addReactions;

  /**
   * 处理聚合完成的 BoostEvent：生成感谢文案并发送到感谢频道。
   *
   * 所有错误内部捕获，不向上抛出导致进程崩溃。
   *
   * @param {object} event - 聚合后的 BoostEvent
   * @param {string} event.userId
   * @param {string} event.guildId
   * @param {number} event.boostCount
   * @param {string[]} event.eventIds
   * @returns {Promise<boolean>} 是否成功发送
   */
  async function handleBoostEvent(event) {
    const ctx = {
      guildId: event.guildId,
      userId: event.userId,
      boostCount: event.boostCount,
      eventIdsCount: event.eventIds?.length ?? 0,
    };

    try {
      // ---- 1. AI 生成正文 ----
      let body;
      try {
        body = await copyGenerator.generateCopy();
      } catch (err) {
        logger.error("[BoostThanks] AI 正文生成失败", {
          ...ctx,
          error: err.message,
          aiCode: err.code ?? undefined,
        });
        return false;
      }

      // ---- 2. 构造标题 ----
      let title;
      try {
        title = buildTitle(event.userId, event.boostCount);
      } catch (err) {
        logger.error("[BoostThanks] 标题构造失败", {
          ...ctx,
          error: err.message,
        });
        return false;
      }

      // ---- 3. 拼装消息 ----
      const content = assembleMessage(title, body);

      // ---- 4. TEST_MODE：跳过真实发送和 Reaction（仅预览并返回成功）----
      if (config.testMode) {
        logger.info("[BoostThanks] TEST_MODE：跳过真实发送", {
          ...ctx,
          targetChannelId: config.discordThanksChannelId,
          content,
        });
        return true;
      }

      // ---- 5. 发送到感谢频道 ----
      const channelId = config.discordThanksChannelId;
      let sentMessage;
      try {
        sentMessage = await doSend(client, channelId, content);
      } catch (err) {
        logger.error("[BoostThanks] Discord 消息发送失败", {
          ...ctx,
          channelId,
          error: err.message,
        });
        return false;
      }

      // ---- 6. 添加 Reactions（Phase 7：best-effort，不影响消息发送结果）----
      if (emojiProvider && sentMessage) {
        try {
          const allEmojis = await emojiProvider.fetchEmojis();
          if (!allEmojis || allEmojis.length === 0) {
            logger.warn("[BoostThanks] Application Emoji 为空，跳过 Reaction", {
              ...ctx,
              emojiCount: allEmojis?.length ?? 0,
            });
          } else {
            // 随机选择 8～min(10, poolSize) 个不重复 Emoji
            const maxCount = Math.min(config.reactionCount ?? 10, allEmojis.length);
            const minCount = Math.min(8, maxCount);
            const count = minCount + Math.floor(Math.random() * (maxCount - minCount + 1));
            const selected = selectEmojis(allEmojis, count);

            if (selected.length > 0) {
              const result = await doReactions(sentMessage, selected, logger);
              logger.info("[BoostThanks] Reactions 添加完成", {
                ...ctx,
                messageId: sentMessage.id ?? null,
                reactionSuccess: result.successCount,
                reactionFail: result.failCount,
              });
            }
          }
        } catch (err) {
          // Reaction 流程任何异常均不影响消息发送结果
          logger.error("[BoostThanks] Reaction 流程异常（消息已正常发送）", {
            ...ctx,
            error: err.message,
          });
        }
      }

      // ---- 7. 成功 ----
      logger.info("[BoostThanks] 感谢消息已发送", {
        ...ctx,
        channelId,
      });
      return true;
    } catch (err) {
      // 未预期错误（如 event 字段缺失导致 buildTitle 抛异常等）
      logger.error("[BoostThanks] 未预期的处理错误", {
        ...ctx,
        error: err.message,
      });
      return false;
    }
  }

  return { handleBoostEvent };
}

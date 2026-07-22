/**
 * Boost 感谢发送编排器（Phase 6–8）。
 *
 * 职责：
 * - 接收聚合完成后的 BoostEvent
 * - 生成 aggregateKey 并进行去重检查（Phase 8）
 * - 维护处理状态机：processing → sending → sent（Phase 8）
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
 * - 防重复持久化细节（见 src/storage/boostThanksStore.js）
 * - Emoji 获取与管理（见 src/resources/applicationEmojis.js）
 * - Emoji 随机选择（见 emojiSelector.js）
 * - Reaction 添加细节（见 src/discord/reactionSender.js）
 */

import { createCopyGenerator } from "./copyGenerator.js";
import { buildTitle, assembleMessage } from "./messageBuilder.js";
import { sendMessage } from "../../discord/messageSender.js";
import { addReactions } from "../../discord/reactionSender.js";
import { selectEmojis } from "./emojiSelector.js";
import { generateAggregateKey } from "../../storage/boostThanksStore.js";

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
 * @param {object} [opts.store]          - Phase 8：BoostThanksStore 实例（缺失时跳过持久化）
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

  // Phase 8：持久化 Store（缺失时跳过持久化，保持向后兼容）
  const store = opts.store ?? null;

  /**
   * 处理聚合完成的 BoostEvent：去重 → 生成文案 → 发送 → Reaction。
   *
   * 所有错误内部捕获，不向上抛出导致进程崩溃。
   *
   * Phase 8 状态机：
   *   claimEvent → markProcessing → [AI/title] → markSending → [send] → markSent → [reactions]
   *   任何前置失败 → markFailedPreSend；TEST_MODE → markTestSkipped
   *
   * @param {object} event - 聚合后的 BoostEvent
   * @param {string} event.userId
   * @param {string[]} event.eventIds
   * @param {string} event.guildId
   * @param {number} event.boostCount
   * @returns {Promise<boolean>} 是否成功发送
   */
  async function handleBoostEvent(event) {
    const ctx = {
      guildId: event.guildId,
      userId: event.userId,
      boostCount: event.boostCount,
      eventIdsCount: event.eventIds?.length ?? 0,
    };

    // ---- 0. 生成 aggregateKey ----
    let aggregateKey;
    try {
      aggregateKey = generateAggregateKey(event.eventIds);
    } catch (err) {
      logger.error("[BoostThanks] 无法生成 aggregateKey", {
        ...ctx,
        error: err.message,
      });
      return false;
    }

    // ---- 0.5 去重检查（Phase 8） ----
    if (store) {
      const claimed = await store.claimEvent(aggregateKey, {
        eventIds: event.eventIds,
        guildId: event.guildId,
        userId: event.userId,
        boostCount: event.boostCount,
      });

      if (claimed == null) {
        // 已被 claim、已达终态、或存在部分 eventIds 冲突
        logger.info("[BoostThanks] 事件已被处理或存在冲突，跳过", {
          ...ctx,
          aggregateKey,
        });
        return true; // 不是失败——只是不需要再处理
      }
    }

    // ---- 0.6 持久化 processing（Phase 8） ----
    if (store) {
      await store.markProcessing(aggregateKey);
    }

    try {
      // ---- 1. AI 生成正文 ----
      let body;
      try {
        body = await copyGenerator.generateCopy();
      } catch (err) {
        logger.error("[BoostThanks] AI 正文生成失败", {
          ...ctx,
          aggregateKey,
          error: err.message,
          aiCode: err.code ?? undefined,
        });
        if (store) {
          await store.markFailedPreSend(aggregateKey, {
            error: err.message,
            errorStage: "ai",
          });
        }
        return false;
      }

      // ---- 2. 构造标题 ----
      let title;
      try {
        title = buildTitle(event.userId, event.boostCount);
      } catch (err) {
        logger.error("[BoostThanks] 标题构造失败", {
          ...ctx,
          aggregateKey,
          error: err.message,
        });
        if (store) {
          await store.markFailedPreSend(aggregateKey, {
            error: err.message,
            errorStage: "title",
          });
        }
        return false;
      }

      // ---- 3. 拼装消息 ----
      const content = assembleMessage(title, body);

      // ---- 4. TEST_MODE：跳过真实发送和 Reaction（仅预览并返回成功）----
      if (config.testMode) {
        logger.info("[BoostThanks] TEST_MODE：跳过真实发送", {
          ...ctx,
          aggregateKey,
          targetChannelId: config.discordThanksChannelId,
          content,
        });
        if (store) {
          await store.markTestSkipped(aggregateKey);
        }
        return true;
      }

      // ---- 5. 标记 sending（Phase 8：必须在真正 send() 之前）----
      if (store) {
        await store.markSending(aggregateKey);
        logger.info("[BoostThanks] 标记为 sending", { ...ctx, aggregateKey });
      }

      // ---- 6. 发送到感谢频道 ----
      const channelId = config.discordThanksChannelId;
      let sentMessage;
      try {
        sentMessage = await doSend(client, channelId, content);
      } catch (err) {
        logger.error("[BoostThanks] Discord 消息发送失败", {
          ...ctx,
          aggregateKey,
          channelId,
          error: err.message,
        });
        if (store) {
          await store.markFailedPreSend(aggregateKey, {
            error: err.message,
            errorStage: "send",
          });
        }
        return false;
      }

      // ---- 7. 立即持久化 sent（Phase 8：不等 Reaction 完成）----
      if (store) {
        await store.markSent(aggregateKey, {
          messageId: sentMessage.id ?? null,
          channelId,
        });
        logger.info("[BoostThanks] 标记为 sent", {
          ...ctx,
          aggregateKey,
          messageId: sentMessage.id ?? null,
          channelId,
        });
      }

      // ---- 8. 添加 Reactions（Phase 7：best-effort，不影响 sent 状态）----
      if (emojiProvider && sentMessage) {
        try {
          const allEmojis = await emojiProvider.fetchEmojis();
          if (!allEmojis || allEmojis.length === 0) {
            logger.warn("[BoostThanks] Application Emoji 为空，跳过 Reaction", {
              ...ctx,
              aggregateKey,
              emojiCount: allEmojis?.length ?? 0,
            });
          } else {
            // 随机选择 8～10 个不重复 Emoji（reactionCount 钳制在 [8, 10]）
            const rawCount = config.reactionCount ?? 10;
            const clampedMax = Math.max(8, Math.min(10,
              Number.isInteger(rawCount) ? rawCount : 10
            ));
            const maxCount = Math.min(clampedMax, allEmojis.length);
            const minCount = Math.min(8, maxCount);
            const count = minCount + Math.floor(Math.random() * (maxCount - minCount + 1));
            const selected = selectEmojis(allEmojis, count);

            if (selected.length > 0) {
              const result = await doReactions(sentMessage, selected, logger);
              logger.info("[BoostThanks] Reactions 添加完成", {
                ...ctx,
                aggregateKey,
                messageId: sentMessage.id ?? null,
                reactionSuccess: result.successCount,
                reactionFail: result.failCount,
              });
            }
          }
        } catch (err) {
          // Reaction 流程任何异常均不影响消息发送结果（sent 状态已持久化）
          logger.error("[BoostThanks] Reaction 流程异常（消息已正常发送）", {
            ...ctx,
            aggregateKey,
            error: err.message,
          });
        }
      }

      // ---- 9. 成功 ----
      logger.info("[BoostThanks] 感谢消息已发送", {
        ...ctx,
        aggregateKey,
        channelId,
      });
      return true;
    } catch (err) {
      // 未预期错误（如 event 字段缺失导致 buildTitle 抛异常等）
      logger.error("[BoostThanks] 未预期的处理错误", {
        ...ctx,
        aggregateKey,
        error: err.message,
      });
      if (store) {
        await store.markFailedPreSend(aggregateKey, {
          error: err.message,
          errorStage: "unexpected",
        });
      }
      return false;
    }
  }

  return { handleBoostEvent };
}

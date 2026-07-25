/**
 * Startup Preflight（启动权限自检）。
 *
 * 职责：
 * - 在 Discord Client 首次 Ready 后执行一次性启动检查
 * - 检查目标 Guild、System Messages Channel、感谢频道、权限
 * - 检查 Application Emoji 可用性（best-effort）
 * - 检查运行时模式（production + TEST_MODE）
 * - 检查 SuppressPremiumSubscriptions（服务器是否禁用了 Boost 通知）
 *
 * 故障分类：
 * - A 类（永久性配置/权限故障）：exitFn(78)
 * - B 类（非致命降级）：warning + 非致命告警，不退出
 *
 * 不依赖：
 * - Boost Feature
 * - AI
 * - Storage
 */

import { ChannelType, GuildSystemChannelFlags } from "discord.js";

// SuppressPremiumSubscriptions flag = 1 << 1 = 2
const SUPPRESS_PREMIUM_SUBSCRIPTIONS = 1 << 1;

/**
 * Preflight 检查结果类型。
 */
export const PreflightResult = {
  PASS: "pass",
  FATAL: "fatal",
  WARNING: "warning",
};

/**
 * 创建 Startup Preflight。
 *
 * @param {object} options
 * @param {import("discord.js").Client} options.client - 已就绪的 Discord Client
 * @param {object} options.config - loadConfig() 输出
 * @param {object} [options.logger] - Logger 实例
 * @param {object} [options.emojiProvider] - ApplicationEmojiProvider 实例
 * @param {Function} [options.notifyFailure] - (type, message, details) => Promise<void>
 * @param {Function} [options.notifyWarning] - (type, message, details) => Promise<void>
 * @param {Function} [options.exitFn] - 退出函数（测试注入），默认 process.exit
 * @returns {{ run: Function }}
 */
export function createStartupPreflight(options) {
  const {
    client,
    config,
    logger,
    emojiProvider,
    notifyFailure,
    notifyWarning,
    exitFn = process.exit,
  } = options;

  // ========================
  // 检查结果收集
  // ========================

  /** @type {{ check: string, result: string, message: string, details?: object }[]} */
  const _results = [];

  function _addResult(check, result, message, details) {
    _results.push({ check, result, message, details: details ?? {} });
    return result;
  }

  // ========================
  // 单个检查项
  // ========================

  /**
   * 检查目标 Guild。
   */
  async function _checkGuild() {
    const guildId = config.discordGuildId;
    if (!guildId) {
      return _addResult(
        "guild",
        PreflightResult.FATAL,
        "discordGuildId 未配置"
      );
    }

    let guild;
    try {
      guild = await client.guilds.fetch(guildId);
    } catch {
      return _addResult(
        "guild",
        PreflightResult.FATAL,
        `无法获取目标 Guild（${guildId}）：Guild 不存在或 Bot 无权访问`,
        { guildId }
      );
    }

    if (!guild) {
      return _addResult(
        "guild",
        PreflightResult.FATAL,
        `目标 Guild（${guildId}）不存在`,
        { guildId }
      );
    }

    if (guild.id !== guildId) {
      return _addResult(
        "guild",
        PreflightResult.FATAL,
        `Guild ID 不匹配（期望 ${guildId}，实际 ${guild.id}）`,
        { expected: guildId, actual: guild.id }
      );
    }

    return _addResult(
      "guild",
      PreflightResult.PASS,
      `目标 Guild 可访问：${guild.name}（${guild.id}）`,
      { guildId: guild.id, guildName: guild.name }
    );
  }

  /**
   * 检查 SuppressPremiumSubscriptions。
   * 必须在 _checkGuild() 之后调用，因为需要已 fetch 的 Guild 对象。
   */
  async function _checkSuppressPremiumSubscriptions() {
    const guildId = config.discordGuildId;
    let guild;
    try {
      guild = await client.guilds.fetch(guildId);
    } catch {
      // Guild 获取失败已由 _checkGuild 报告，这里跳过
      return _addResult(
        "suppress_premium_subscriptions",
        PreflightResult.FATAL,
        "无法获取 Guild，无法检查 systemChannelFlags",
        { guildId }
      );
    }

    if (!guild) {
      return _addResult(
        "suppress_premium_subscriptions",
        PreflightResult.FATAL,
        "Guild 不可用，无法检查 systemChannelFlags",
        { guildId }
      );
    }

    try {
      const flags = guild.systemChannelFlags;
      if (flags && (flags & SUPPRESS_PREMIUM_SUBSCRIPTIONS) !== 0) {
        return _addResult(
          "suppress_premium_subscriptions",
          PreflightResult.FATAL,
          "服务器已关闭 Boost 系统消息通知（SuppressPremiumSubscriptions 已启用）。" +
            "自动感谢功能无法工作。请在服务器设置 → 概览中重新开启" +
            "「Send a message when someone Boosts this server」。",
          { guildId, systemChannelFlags: flags }
        );
      }
    } catch (err) {
      // 如果无法读取 flags，记录 warning 但不 fatal（可能是权限问题）
      if (logger) {
        logger.warn("[StartupPreflight] 无法读取 systemChannelFlags", {
          guildId,
          error: err.message,
        });
      }
    }

    return _addResult(
      "suppress_premium_subscriptions",
      PreflightResult.PASS,
      "Boost 系统消息通知已开启",
      { guildId }
    );
  }

  /**
   * 检查系统消息频道。
   */
  async function _checkSystemChannel() {
    const guildId = config.discordGuildId;
    let guild;
    try {
      guild = await client.guilds.fetch(guildId);
    } catch {
      return _addResult(
        "system_channel",
        PreflightResult.FATAL,
        "无法获取 Guild，跳过系统频道检查",
        { guildId }
      );
    }

    if (!guild) {
      return _addResult(
        "system_channel",
        PreflightResult.FATAL,
        "Guild 不可用，跳过系统频道检查",
        { guildId }
      );
    }

    const systemChannelId = guild.systemChannelId;
    if (!systemChannelId) {
      return _addResult(
        "system_channel",
        PreflightResult.FATAL,
        "目标 Guild 未设置 System Messages Channel。" +
          "请在服务器设置 → 概览中指定系统消息频道。",
        { guildId }
      );
    }

    let channel;
    try {
      channel = await client.channels.fetch(systemChannelId);
    } catch (err) {
      return _addResult(
        "system_channel",
        PreflightResult.FATAL,
        `无法获取系统消息频道（${systemChannelId}）：${err.message}`,
        { guildId, systemChannelId }
      );
    }

    if (!channel) {
      return _addResult(
        "system_channel",
        PreflightResult.FATAL,
        `系统消息频道（${systemChannelId}）不存在`,
        { guildId, systemChannelId }
      );
    }

    if (channel.guildId !== guildId && channel.guild?.id !== guildId) {
      return _addResult(
        "system_channel",
        PreflightResult.FATAL,
        `系统消息频道（${systemChannelId}）不属于目标 Guild（${guildId}）`,
        { guildId, systemChannelId, channelGuildId: channel.guildId ?? channel.guild?.id }
      );
    }

    // 检查权限
    const permissions = channel.permissionsFor(client.user);
    if (!permissions) {
      return _addResult(
        "system_channel",
        PreflightResult.FATAL,
        `无法获取系统消息频道（${systemChannelId}）的权限信息`,
        { guildId, systemChannelId }
      );
    }

    const missing = [];
    if (!permissions.has("ViewChannel")) missing.push("ViewChannel");
    if (!permissions.has("ReadMessageHistory")) missing.push("ReadMessageHistory");

    if (missing.length > 0) {
      return _addResult(
        "system_channel",
        PreflightResult.FATAL,
        `系统消息频道（${systemChannelId}）缺少必要权限：${missing.join("、")}`,
        { guildId, systemChannelId, missing }
      );
    }

    return _addResult(
      "system_channel",
      PreflightResult.PASS,
      `系统消息频道可访问并拥有必要权限：${systemChannelId}`,
      { guildId, systemChannelId }
    );
  }

  /**
   * 检查感谢频道。
   */
  async function _checkThanksChannel() {
    const guildId = config.discordGuildId;
    const channelId = config.discordThanksChannelId;

    if (!channelId) {
      return _addResult(
        "thanks_channel",
        PreflightResult.FATAL,
        "discordThanksChannelId 未配置"
      );
    }

    let channel;
    try {
      channel = await client.channels.fetch(channelId);
    } catch (err) {
      return _addResult(
        "thanks_channel",
        PreflightResult.FATAL,
        `无法获取感谢频道（${channelId}）：${err.message}`,
        { guildId, channelId }
      );
    }

    if (!channel) {
      return _addResult(
        "thanks_channel",
        PreflightResult.FATAL,
        `感谢频道（${channelId}）不存在`,
        { guildId, channelId }
      );
    }

    // 检查频道是否属于目标 Guild
    const channelGuildId = channel.guildId ?? channel.guild?.id;
    if (channelGuildId !== guildId) {
      return _addResult(
        "thanks_channel",
        PreflightResult.FATAL,
        `感谢频道（${channelId}）不属于目标 Guild（${guildId}），实际属于 ${channelGuildId}`,
        { guildId, channelId, channelGuildId }
      );
    }

    // 检查频道类型
    if (
      channel.type !== ChannelType.GuildText &&
      channel.type !== ChannelType.GuildAnnouncement
    ) {
      return _addResult(
        "thanks_channel",
        PreflightResult.FATAL,
        `感谢频道（${channelId}）不是文本频道（type: ${channel.type}）`,
        { guildId, channelId, channelType: channel.type }
      );
    }

    // 检查权限
    const permissions = channel.permissionsFor(client.user);
    if (!permissions) {
      return _addResult(
        "thanks_channel",
        PreflightResult.FATAL,
        `无法获取感谢频道（${channelId}）的权限信息`,
        { guildId, channelId }
      );
    }

    const missing = [];
    if (!permissions.has("ViewChannel")) missing.push("ViewChannel");
    if (!permissions.has("SendMessages")) missing.push("SendMessages");
    if (!permissions.has("ReadMessageHistory")) missing.push("ReadMessageHistory");

    // AddReactions 缺失属于非致命降级
    const addReactionsMissing = !permissions.has("AddReactions");

    if (missing.length > 0) {
      return _addResult(
        "thanks_channel",
        PreflightResult.FATAL,
        `感谢频道（${channelId}）缺少必要权限：${missing.join("、")}`,
        { guildId, channelId, missing }
      );
    }

    if (addReactionsMissing) {
      return _addResult(
        "thanks_channel",
        PreflightResult.WARNING,
        `感谢频道（${channelId}）缺少 AddReactions 权限，Reaction 将不可用，但主消息功能正常`,
        { guildId, channelId, missing: ["AddReactions"] }
      );
    }

    return _addResult(
      "thanks_channel",
      PreflightResult.PASS,
      `感谢频道可访问并拥有完整权限：${channelId}`,
      { guildId, channelId }
    );
  }

  /**
   * 检查 Application Emoji。
   * 失败属于非致命降级。
   */
  async function _checkApplicationEmojis() {
    if (!emojiProvider) {
      return _addResult(
        "application_emojis",
        PreflightResult.WARNING,
        "Emoji Provider 未提供，Reaction 功能不可用",
        {}
      );
    }

    try {
      const emojis = await emojiProvider.fetchEmojis();
      if (emojis === null) {
        return _addResult(
          "application_emojis",
          PreflightResult.WARNING,
          "Application Emoji 获取失败，Reaction 降级，主消息功能不受影响",
          {}
        );
      }
      if (!Array.isArray(emojis) || emojis.length === 0) {
        return _addResult(
          "application_emojis",
          PreflightResult.WARNING,
          "Application Emoji 列表为空，Reaction 降级",
          { emojiCount: 0 }
        );
      }
      return _addResult(
        "application_emojis",
        PreflightResult.PASS,
        `Application Emoji 可用：${emojis.length} 个`,
        { emojiCount: emojis.length }
      );
    } catch (err) {
      return _addResult(
        "application_emojis",
        PreflightResult.WARNING,
        `Application Emoji 获取异常：${err.message}`,
        {}
      );
    }
  }

  /**
   * 检查运行模式。
   * production 中 TEST_MODE=true → fatal
   */
  function _checkRuntimeMode() {
    if (config.isProduction && config.testMode) {
      return _addResult(
        "runtime_mode",
        PreflightResult.FATAL,
        "生产环境中 TEST_MODE=true 属于致命配置错误。请设置 TEST_MODE=false。",
        { nodeEnv: config.nodeEnv, testMode: config.testMode }
      );
    }
    return _addResult(
      "runtime_mode",
      PreflightResult.PASS,
      `运行模式正常：NODE_ENV=${config.nodeEnv}，TEST_MODE=${config.testMode}`,
      { nodeEnv: config.nodeEnv, testMode: config.testMode }
    );
  }

  // ========================
  // 主入口
  // ========================

  /**
   * 执行启动自检。
   *
   * 按顺序检查。遇到 fatal 不立即中断（收集完整诊断信息），
   * 全部检查完成后统一决策。
   *
   * @returns {Promise<{passed: boolean, fatal: object[], warnings: object[], all: object[]}>}
   */
  async function run() {
    _results.length = 0;

    if (logger) {
      logger.info("[StartupPreflight] 开始启动权限自检...", {
        guildId: config.discordGuildId,
        thanksChannelId: config.discordThanksChannelId,
        nodeEnv: config.nodeEnv,
        isProduction: config.isProduction,
      });
    }

    // 1. Guild
    await _checkGuild();

    // 2. SuppressPremiumSubscriptions（在 Guild 检查之后）
    await _checkSuppressPremiumSubscriptions();

    // 3. System Messages Channel
    await _checkSystemChannel();

    // 4. 感谢频道
    await _checkThanksChannel();

    // 5. Application Emoji
    if (emojiProvider) {
      await _checkApplicationEmojis();
    }

    // 6. 运行模式
    _checkRuntimeMode();

    // ---- 汇总 ----
    const fatal = _results.filter((r) => r.result === PreflightResult.FATAL);
    const warnings = _results.filter((r) => r.result === PreflightResult.WARNING);
    const passed = fatal.length === 0;

    if (logger) {
      if (passed) {
        logger.info("[StartupPreflight] 自检通过", {
          checkCount: _results.length,
          warningCount: warnings.length,
        });
      } else {
        logger.error("[StartupPreflight] 自检失败", {
          checkCount: _results.length,
          fatalCount: fatal.length,
          warningCount: warnings.length,
          fatalItems: fatal.map((r) => ({ check: r.check, message: r.message })),
        });
      }
    }

    // ---- 决策 ----
    if (!passed) {
      // 创建一次 composite fatal alert
      if (notifyFailure) {
        const fatalMessages = fatal.map((f) => `[${f.check}] ${f.message}`).join("；");
        try {
          await notifyFailure(
            "startup_preflight_failed",
            `启动自检失败，${fatal.length} 项致命问题：${fatalMessages}`,
            {
              guildId: config.discordGuildId,
              details: { fatalCount: fatal.length, fatalItems: fatal },
            }
          );
        } catch (err) {
          if (logger) {
            logger.error("[StartupPreflight] 无法写入 fatal 告警", { error: err.message });
          }
        }
      }

      // 非致命警告也写入
      if (notifyWarning && warnings.length > 0) {
        for (const w of warnings) {
          try {
            await notifyWarning(w.check, w.message, { details: w.details });
          } catch {
            // 静默
          }
        }
      }

      // 退出
      if (logger) {
        logger.error("[StartupPreflight] 由于致命检查失败，准备退出（exit 78）");
      }
      exitFn(78);
      return { passed: false, fatal, warnings, all: _results };
    }

    // 警告（非致命）
    if (notifyWarning && warnings.length > 0) {
      for (const w of warnings) {
        try {
          await notifyWarning(w.check, w.message, { details: w.details });
        } catch {
          // 静默
        }
      }
    }

    return { passed: true, fatal: [], warnings, all: _results };
  }

  return { run };
}

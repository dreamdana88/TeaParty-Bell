import { Events } from "discord.js";
import { parseBonusPenalty } from "./dice/bonusPenalty.js";
import { parseDiceExpression } from "./dice/parser.js";

/** 整句必须是 /r 已接受的骰子表达式。认不出就当普通聊天。 */
export function isWholeMessageDice(content) {
  return parseDiceExpression(content).ok === true;
}

export function isBonusPenaltyMessage(content) {
  return parseBonusPenalty(content).ok === true;
}

/**
 * 自然消息骰子的回复。骰面和总值直接用这一次 roll 的结果，不另掷。
 * @param {string} userId
 * @param {{ notation: string, count: number, rolls: number[], modifier: number, total: number }} result
 */
export function formatTextDice(userId, result) {
  const mention = `<@${userId}>`;
  if (result.count === 1 && result.modifier === 0) {
    return `${mention} 🎲 ${result.notation} = ${result.total}`;
  }
  const faces = result.rolls.join(", ");
  if (result.modifier === 0) {
    return `${mention} 🎲 ${result.notation} → [${faces}] = ${result.total}`;
  }
  const sign = result.modifier > 0 ? "+" : "-";
  return `${mention} 🎲 ${result.notation} → [${faces}] ${sign} ${Math.abs(result.modifier)} = ${result.total}`;
}

/** 奖励/惩罚的候选和总值直接用这一次 roll 的结果。 */
export function formatBonusPenalty(userId, result) {
  return `<@${userId}> 🎲 ${result.notation} → [${result.candidates.join(", ")}] = ${result.total}`;
}

/**
 * 先看是不是进行中的跑团频道，再看正文。普通频道不读 content。
 */
export function messageNeedsTextDice(message, channelIsActive) {
  if (!channelIsActive || !message || message.system || message.author?.bot || !message.guildId) return false;
  return isWholeMessageDice(message.content) || isBonusPenaltyMessage(message.content);
}

export function attachTextDiceListener({ client, service, logger = console }) {
  async function onMessage(message) {
    try {
      const active = service.hasActiveRunChannel?.(message?.channelId) === true;
      if (!messageNeedsTextDice(message, active)) return;
      const result = await service.rollTextDice({
        channelId: message.channelId,
        userId: message.author?.id,
        displayName: message.member?.displayName
          ?? message.author?.globalName
          ?? message.author?.username
          ?? "",
        content: message.content,
      });
      if (!result?.ok) return;
      const userId = message.author?.id;
      await message.reply({
        content: result.text,
        allowedMentions: { parse: [], users: userId ? [userId] : [], repliedUser: false },
      });
    } catch (error) {
      logger.warn?.("CoC 文字骰子没有发出", { message: error?.message });
    }
  }

  client.on(Events.MessageCreate, onMessage);
  return () => {
    client.off?.(Events.MessageCreate, onMessage);
    client.removeListener?.(Events.MessageCreate, onMessage);
  };
}

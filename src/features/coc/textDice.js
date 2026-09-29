import { Events } from "discord.js";
import { parseDiceExpression } from "./dice/parser.js";

/** 整句必须是 /r 已接受的骰子表达式。认不出就当普通聊天。 */
export function isWholeMessageDice(content) {
  return parseDiceExpression(content).ok === true;
}

/**
 * 先看是不是进行中的跑团频道，再看正文。普通频道不读 content。
 */
export function messageNeedsTextDice(message, channelIsActive) {
  if (!channelIsActive || !message || message.system || message.author?.bot || !message.guildId) return false;
  return isWholeMessageDice(message.content);
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
      await message.reply({ content: result.text, allowedMentions: { parse: [] } });
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

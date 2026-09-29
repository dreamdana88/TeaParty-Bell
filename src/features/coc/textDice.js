import { Events } from "discord.js";

const WHOLE_D100 = /^1d100$/i;

export function isWholeMessageD100(content) {
  return typeof content === "string" && WHOLE_D100.test(content.trim());
}

/**
 * 先看是不是进行中的跑团频道，再看正文。普通频道不读 content。
 */
export function messageNeedsTextDice(message, channelIsActive) {
  if (!channelIsActive || !message || message.system || message.author?.bot || !message.guildId) return false;
  return isWholeMessageD100(message.content);
}

export function formatTextD100(speaker, total) {
  const name = String(speaker ?? "").trim() || "调查员";
  return `${name} 🎲 1d100 = ${total}`;
}

export function attachTextDiceListener({ client, service, logger = console }) {
  async function onMessage(message) {
    try {
      const active = service.hasActiveRunChannel?.(message?.channelId) === true;
      if (!messageNeedsTextDice(message, active)) return;
      const result = await service.rollPlainD100({
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

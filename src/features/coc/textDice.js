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

export function parseSkillDice(content) {
  if (typeof content !== "string" || content.length > 160) return { ok: false };
  const match = /^1d100\s+(.+?)(?:\s+(奖励|惩罚)([12]))?$/i.exec(content.trim());
  if (!match || /^(奖励|惩罚)\d*$/.test(match[1])) return { ok: false };
  return { ok: true, name: match[1].trim(), bonus: match[2] ? parseBonusPenalty(`1d100 ${match[2]}${match[3]}`) : null };
}

export function findSnapshotSkill(member, query) {
  if (!member?.characterId || !Array.isArray(member.skills)) return { ok: false, message: "请先绑定本局调查员角色卡。" };
  const normalize = value => String(value ?? "").trim().replace(/\s+/g, "").replace(/:/g, "：");
  const fullName = skill => skill.specialty ? `${skill.name}：${skill.specialty}` : skill.name;
  const exact = member.skills.filter(skill => normalize(fullName(skill)) === normalize(query));
  const matches = exact.length ? exact : member.skills.filter(skill => normalize(skill.name) === normalize(query) || (skill.specialty && normalize(skill.specialty) === normalize(query)));
  if (!matches.length) return { ok: false, message: "本局角色卡里没有这个技能，请检查名称。" };
  if (matches.length !== 1) return { ok: false, message: `技能名称不唯一，请使用完整名称：${matches.map(fullName).join("、")}` };
  const skill = matches[0];
  const values = [skill.base, skill.growth, skill.occupationPoints, skill.interestPoints];
  if (!values.every(value => Number.isSafeInteger(value) && value >= 0)) return { ok: false, message: "本局技能数据异常，请联系 KP。" };
  const value = values.reduce((sum, n) => sum + n, 0);
  if (!Number.isSafeInteger(value)) return { ok: false, message: "本局技能数据异常，请联系 KP。" };
  return { ok: true, name: fullName(skill), value };
}

/**
 * 自然消息骰子的回复。骰面和总值直接用这一次 roll 的结果，不另掷。
 * @param {string} userId
 * @param {{ notation: string, count: number, rolls: number[], modifier: number, total: number }} result
 */
export function formatTextDice(userId, result) {
  const mention = `**<@${userId}> 祝骰运昌隆喵~！**\n`;
  if (result.count === 1 && result.modifier === 0) {
    return `${mention}🎲 ${result.notation} = ${result.total}`;
  }
  const faces = result.rolls.join(", ");
  if (result.modifier === 0) {
    return `${mention}🎲 ${result.notation} → [${faces}] = ${result.total}`;
  }
  const sign = result.modifier > 0 ? "+" : "-";
  return `${mention}🎲 ${result.notation} → [${faces}] ${sign} ${Math.abs(result.modifier)} = ${result.total}`;
}

/** 奖励/惩罚的候选和总值直接用这一次 roll 的结果。 */
export function formatBonusPenalty(userId, result) {
  return `**<@${userId}> 祝骰运昌隆喵~！**\n🎲 ${result.notation} → [${result.candidates.join(", ")}] = ${result.total}`;
}

/**
 * 先看是不是进行中的跑团频道，再看正文。普通频道不读 content。
 */
export function messageNeedsTextDice(message, channelIsActive) {
  if (!channelIsActive || !message || message.system || message.author?.bot || !message.guildId) return false;
  return isWholeMessageDice(message.content) || isBonusPenaltyMessage(message.content) || parseSkillDice(message.content).ok;
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
      if (!result?.ok && !result?.skillError) return;
      const userId = message.author?.id;
      await message.reply({
        content: result.ok ? result.text : result.message,
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

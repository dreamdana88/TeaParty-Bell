import { PermissionFlagsBits } from "discord.js";

export const ROOM_ALLOW = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
];

/**
 * @param {{ guildId: string, botUserId: string, userIds: string[] }} input
 */
export function buildRoomOverwrites({ guildId, botUserId, userIds }) {
  const members = [];
  const seen = new Set();
  for (const userId of [botUserId, ...userIds]) {
    if (!userId || seen.has(userId)) continue;
    seen.add(userId);
    members.push({
      id: userId,
      type: 1,
      allow: ROOM_ALLOW,
    });
  }
  return [
    {
      id: guildId,
      type: 0,
      deny: [PermissionFlagsBits.ViewChannel],
    },
    ...members,
  ];
}

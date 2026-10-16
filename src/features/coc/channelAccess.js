import { PermissionFlagsBits } from "discord.js";

export const ROOM_ALLOW = [
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.SendMessagesInThreads,
];

export const BOT_ROOM_ALLOW = [
  ...ROOM_ALLOW,
  PermissionFlagsBits.CreatePrivateThreads,
  PermissionFlagsBits.ManageThreads,
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
      allow: userId === botUserId ? BOT_ROOM_ALLOW : ROOM_ALLOW,
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

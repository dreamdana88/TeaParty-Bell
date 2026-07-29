/**
 * Forum Bump 管理员 Slash 命令：/顶帖 面板
 */

import {
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

export const FORUM_BUMP_ROOT_COMMAND_NAME = "顶帖";
export const FORUM_BUMP_PANEL_SUBCOMMAND_NAME = "面板";

/**
 * @returns {SlashCommandBuilder}
 */
export function buildForumBumpPanelCommand() {
  return new SlashCommandBuilder()
    .setName(FORUM_BUMP_ROOT_COMMAND_NAME)
    .setDescription("Forum 自动顶帖管理")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((sub) => sub
      .setName(FORUM_BUMP_PANEL_SUBCOMMAND_NAME)
      .setDescription("打开顶帖控制面板（状态与配置）"));
}

export const forumBumpPanelCommand = buildForumBumpPanelCommand();

export const forumBumpAdminCommandDefinitions = Object.freeze([
  forumBumpPanelCommand.toJSON(),
]);

export function getForumBumpAdminCommands() {
  return forumBumpAdminCommandDefinitions.map((d) => ({ ...d }));
}

import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from "discord.js";

export const MANUAL_REPLY_COMMAND_NAME = "小G宝回复";
export const MESSAGE_REPLY_COMMAND_NAME = MANUAL_REPLY_COMMAND_NAME;
export const SLASH_SEND_COMMAND_NAME = "小g宝发言";

/**
 * 构造人工回复 Message Context Menu。
 *
 * 这里只提供可复用的定义，不执行命令注册。
 */
export function buildManualReplyCommand() {
  return new ContextMenuCommandBuilder()
    .setName(MANUAL_REPLY_COMMAND_NAME)
    .setType(ApplicationCommandType.Message)
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
}

export function buildSlashSendCommand() {
  return new SlashCommandBuilder()
    .setName(SLASH_SEND_COMMAND_NAME)
    .setDescription("让小G宝在当前频道发言")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);
}

export const messageReplyCommand = buildManualReplyCommand();
export const slashSendCommand = buildSlashSendCommand();

export const adminCommandDefinitions = Object.freeze([
  messageReplyCommand.toJSON(),
  slashSendCommand.toJSON(),
]);

export function getManualReplyCommandJson() {
  return messageReplyCommand.toJSON();
}

export function getManualMessageCommands() {
  return adminCommandDefinitions.map((definition) => ({ ...definition }));
}

export function getAdminCommandDefinitions() {
  return adminCommandDefinitions.map((definition) => ({ ...definition }));
}

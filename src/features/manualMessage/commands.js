import {
  ApplicationCommandType,
  ContextMenuCommandBuilder,
  PermissionFlagsBits,
} from "discord.js";

export const MANUAL_REPLY_COMMAND_NAME = "小G宝回复";

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

export function getManualReplyCommandJson() {
  return buildManualReplyCommand().toJSON();
}

export function getManualMessageCommands() {
  return [getManualReplyCommandJson()];
}

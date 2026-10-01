import { SlashCommandBuilder } from "discord.js";

export const COC_COMMAND_NAME = "coc";
export const COC_OPEN_SUBCOMMAND = "开团";
export const COC_PANEL_SUBCOMMAND = "面板";
export const COC_ARCHIVE_SUBCOMMAND = "建卡";
export const ROLL_COMMAND_NAME = "r";

export function buildCocCommands() {
  const coc = new SlashCommandBuilder()
    .setName(COC_COMMAND_NAME)
    .setDescription("茶话会 CoC 跑团")
    .setDMPermission(false)
    .addSubcommand((sub) => sub
      .setName(COC_OPEN_SUBCOMMAND)
      .setDescription("在当前频道发起一场招募"))
    .addSubcommand((sub) => sub
      .setName(COC_PANEL_SUBCOMMAND)
      .setDescription("在跑团频道重新发送控制面板"))
    .addSubcommand((sub) => sub
      .setName(COC_ARCHIVE_SUBCOMMAND)
      .setDescription("打开调查员档案馆创建或管理角色卡"));
  const roll = new SlashCommandBuilder()
    .setName(ROLL_COMMAND_NAME)
    .setDescription("在 CoC 跑团房间里掷骰")
    .setDMPermission(false)
    .addStringOption((option) => option
      .setName("dice")
      .setDescription("例如 1d100 或 2d6+3")
      .setRequired(true)
      .setMaxLength(32));
  return [coc, roll];
}

export const cocCommandDefinitions = Object.freeze(
  buildCocCommands().map((command) => command.toJSON()),
);

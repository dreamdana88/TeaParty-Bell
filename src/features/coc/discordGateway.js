import { ChannelType } from "discord.js";

function ignoreMissing(error) {
  const code = error?.code ?? error?.discordCode;
  return code === 10003 || code === 10007 || code === 10011 || code === 10013;
}

/**
 * 把 Discord 调用收成场次服务用的窄接口。
 */
export function createCocDiscordGateway(client) {
  async function guildOf(guildId) {
    return client.guilds.fetch(guildId);
  }

  async function memberOf(guildId, userId) {
    const guild = await guildOf(guildId);
    return guild.members.fetch(userId);
  }

  return {
    async listSiblingNames(parentId) {
      const parent = await client.channels.fetch(parentId);
      const channels = await parent.guild.channels.fetch();
      const names = [];
      for (const channel of channels.values()) {
        if (channel?.parentId === parentId && typeof channel.name === "string") names.push(channel.name);
      }
      return names;
    },

    async createTextChannel({ names, parentId, permissionOverwrites }) {
      const parent = await client.channels.fetch(parentId);
      let lastError = null;
      for (const name of names) {
        try {
          return await parent.guild.channels.create({
            name,
            type: ChannelType.GuildText,
            parent: parentId,
            permissionOverwrites,
          });
        } catch (error) {
          lastError = error;
        }
      }
      throw lastError ?? new Error("CHANNEL_CREATE_FAILED");
    },

    async deleteChannel(channelId) {
      const channel = await client.channels.fetch(channelId);
      await channel.delete("CoC MVP 房间结束");
    },

    async addRole(guildId, userId, roleId) {
      const member = await memberOf(guildId, userId);
      await member.roles.add(roleId);
    },

    async removeRole(guildId, userId, roleId) {
      try {
        const member = await memberOf(guildId, userId);
        if (!member.roles.cache.has(roleId)) return;
        await member.roles.remove(roleId);
      } catch (error) {
        if (!ignoreMissing(error)) throw error;
      }
    },

    async fetchNickname(guildId, userId) {
      const member = await memberOf(guildId, userId);
      return member.nickname ?? null;
    },

    async setNickname(guildId, userId, nickname) {
      const member = await memberOf(guildId, userId);
      await member.setNickname(nickname);
    },

    async lockChannel(channelId, userIds) {
      const channel = await client.channels.fetch(channelId);
      for (const userId of userIds) {
        await channel.permissionOverwrites.edit(userId, {
          ViewChannel: true,
          SendMessages: false,
          ReadMessageHistory: true,
        });
      }
      await channel.permissionOverwrites.edit(channel.guild.id, {
        ViewChannel: false,
        SendMessages: false,
      });
    },

    async sendMessage(channelId, payload) {
      const channel = await client.channels.fetch(channelId);
      const message = await channel.send(payload);
      return message.id;
    },

    async editMessage(channelId, messageId, payload) {
      const channel = await client.channels.fetch(channelId);
      const message = await channel.messages.fetch(messageId);
      await message.edit(payload);
    },
  };
}


import { ChannelType } from "discord.js";
import { TRANSCRIPT_HISTORY_LIMIT } from "./transcript.js";

function summarizeMember(member) {
  return {
    userId: member.id,
    bot: Boolean(member.user?.bot),
    nickname: member.nickname ?? null,
    username: member.user?.username ?? "",
    globalName: member.user?.globalName ?? null,
  };
}

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
        const guild = await guildOf(guildId);
        await guild.members.removeRole({
          user: userId,
          role: roleId,
          reason: "CoC 跑团结束，卸下展示身份",
        });
      } catch (error) {
        if (!ignoreMissing(error)) throw error;
      }
    },

    async searchMembers(guildId, query) {
      const guild = await guildOf(guildId);
      if (/^\d{17,20}$/.test(query)) {
        const member = await guild.members.fetch({ user: query, force: true });
        return [summarizeMember(member)];
      }
      const found = await guild.members.search({ query, limit: 25, cache: false });
      return [...found.values()].map(summarizeMember);
    },

    async fetchGuildMember(guildId, userId) {
      const guild = await guildOf(guildId);
      const member = await guild.members.fetch({ user: userId, force: true });
      return {
        userId: member.id,
        bot: Boolean(member.user?.bot),
        nickname: member.nickname ?? null,
      };
    },

    async grantChannelAccess(channelId, userId) {
      const channel = await client.channels.fetch(channelId);
      await channel.permissionOverwrites.edit(userId, {
        ViewChannel: true,
        SendMessages: true,
        ReadMessageHistory: true,
      });
    },

    async revokeChannelAccess(channelId, userId) {
      const channel = await client.channels.fetch(channelId);
      await channel.permissionOverwrites.delete(userId);
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

    async fetchChannelHistory(channelId) {
      const channel = await client.channels.fetch(channelId);
      const messages = [];
      let before;
      let truncated = false;
      while (messages.length < TRANSCRIPT_HISTORY_LIMIT) {
        const limit = Math.min(100, TRANSCRIPT_HISTORY_LIMIT - messages.length);
        const batch = await channel.messages.fetch({ limit, ...(before ? { before } : {}) });
        if (batch.size === 0) break;
        const rows = [...batch.values()].sort((left, right) => left.createdTimestamp - right.createdTimestamp);
        for (const message of rows) {
          messages.push({
            id: message.id,
            authorId: message.author?.id ?? "",
            bot: Boolean(message.author?.bot) || message.system === true,
            content: typeof message.content === "string" ? message.content : "",
            createdTimestamp: message.createdTimestamp,
            type: message.type,
          });
        }
        const oldest = rows[0]?.id;
        if (!oldest || oldest === before) break;
        before = oldest;
        if (batch.size < limit) break;
        if (messages.length >= TRANSCRIPT_HISTORY_LIMIT) truncated = true;
      }
      messages.sort((left, right) => left.createdTimestamp - right.createdTimestamp || String(left.id).localeCompare(String(right.id)));
      return { messages, truncated };
    },

    async editMessage(channelId, messageId, payload) {
      const channel = await client.channels.fetch(channelId);
      const message = await channel.messages.fetch(messageId);
      await message.edit(payload);
    },
  };
}


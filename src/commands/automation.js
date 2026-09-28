const {
  SlashCommandBuilder, EmbedBuilder, ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits,
  AutoModerationActionType, AutoModerationRuleEventType, AutoModerationRuleTriggerType,
} = require('discord.js');
const { db, getSettings, getFeature, setFeature } = require('../db');
const automation = require('../automation');
const journal = require('../journal');
const { formatDuration } = require('../monitor');
const { BRAND, ephemeral, parseDuration } = require('../util');

const RULES = {
  words: 'rejs · Blocked words',
  invites: 'rejs · Invite links',
  mentions: 'rejs · Mention spam',
  spam: 'rejs · Spam',
};
const INVITE_REGEX = '(?i)discord(?:\\.gg|(?:app)?\\.com/invite)/[a-z0-9-]+';
const MIN_INTERVAL_MS = 10 * 60_000;
const unix = (ms) => Math.floor(ms / 1000);

// Creates or updates one of our Discord AutoMod rules. Discord enforces it, even while the bot is offline.
async function upsertRule(guild, name, triggerType, triggerMetadata) {
  const { modlog_channel_id } = getSettings(guild.id);
  const actions = [{ type: AutoModerationActionType.BlockMessage, metadata: { customMessage: 'This message was blocked by the server filter.' } }];
  if (modlog_channel_id) actions.push({ type: AutoModerationActionType.SendAlertMessage, metadata: { channel: modlog_channel_id } });

  const existing = (await guild.autoModerationRules.fetch()).find((r) => r.name === name);
  if (existing) {
    journal.automod(existing, { triggerMetadata: existing.triggerMetadata, actions: actionsOf(existing), enabled: existing.enabled });
    return existing.edit({ triggerMetadata, actions, enabled: true });
  }
  const rule = await guild.autoModerationRules.create({
    name, triggerType, triggerMetadata, actions, enabled: true, eventType: AutoModerationRuleEventType.MessageSend,
  });
  journal.automod(rule);
  return rule;
}

// A rule's actions in the shape create() and edit() accept, so /undo can put them back.
const actionsOf = (rule) => rule.actions.map((a) => ({
  type: a.type,
  metadata: { channel: a.metadata.channelId ?? undefined, durationSeconds: a.metadata.durationSeconds ?? undefined, customMessage: a.metadata.customMessage ?? undefined },
}));

async function removeRule(guild, name) {
  const existing = (await guild.autoModerationRules.fetch()).find((r) => r.name === name);
  if (existing) {
    journal.deletedAutomod({
      name: existing.name, eventType: existing.eventType, triggerType: existing.triggerType, triggerMetadata: existing.triggerMetadata,
      actions: actionsOf(existing), enabled: existing.enabled, exemptRoles: [...existing.exemptRoles.keys()], exemptChannels: [...existing.exemptChannels.keys()],
    });
  }
  await existing?.delete();
  return Boolean(existing);
}

async function automod(i) {
  const sub = i.options.getSubcommand();
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const T = AutoModerationRuleTriggerType;

  try {
    if (sub === 'words') {
      const input = i.options.getString('words', true);
      const words = input.trim().toLowerCase() === 'off' ? [] : input.split(',').map((w) => w.trim()).filter(Boolean);
      if (!words.length) return i.editReply(`✅ ${await removeRule(i.guild, RULES.words) ? 'Removed' : 'There was no'} blocked word list.`);
      await upsertRule(i.guild, RULES.words, T.Keyword, { keywordFilter: words.map((w) => w.slice(0, 60)) });
      return i.editReply(`✅ Blocking ${words.length} word${words.length === 1 ? '' : 's'}. Tip: \`word*\` also blocks words that start with it.`);
    }
    if (sub === 'invites' || sub === 'spam') {
      const on = i.options.getBoolean('enabled', true);
      if (!on) return i.editReply(`✅ ${await removeRule(i.guild, RULES[sub]) ? 'Turned off' : 'It was already off'}.`);
      if (sub === 'invites') await upsertRule(i.guild, RULES.invites, T.Keyword, { regexPatterns: [INVITE_REGEX] });
      else await upsertRule(i.guild, RULES.spam, T.Spam, {});
      return i.editReply(sub === 'invites' ? '✅ Invite links to other servers are blocked.' : '✅ Discord will block messages it detects as spam.');
    }
    if (sub === 'mentions') {
      const limit = i.options.getInteger('limit', true);
      if (!limit) return i.editReply(`✅ ${await removeRule(i.guild, RULES.mentions) ? 'Turned off' : 'It was already off'}.`);
      await upsertRule(i.guild, RULES.mentions, T.MentionSpam, { mentionTotalLimit: limit, mentionRaidProtectionEnabled: true });
      return i.editReply(`✅ Messages with more than ${limit} mentions are blocked, and mention raids are detected.`);
    }
  } catch (e) {
    return i.editReply(`❌ Discord refused that: ${e.message}. I need the Manage Server permission.`);
  }

  const rules = await i.guild.autoModerationRules.fetch();
  const lines = rules.map((r) => `${r.enabled ? '🟢' : '⚪'} **${r.name}**${Object.values(RULES).includes(r.name) ? '' : ' (not managed by me)'}`);
  const { modlog_channel_id } = getSettings(i.guildId);
  return i.editReply({
    embeds: [new EmbedBuilder()
      .setColor(BRAND)
      .setTitle('🛡️ AutoMod rules')
      .setDescription(lines.join('\n') || 'No rules yet.')
      .setFooter({ text: modlog_channel_id ? 'Blocked messages are reported in the mod log.' : 'Set /config modlog to get alerts for blocked messages.' })],
  });
}

async function schedule(i) {
  const sub = i.options.getSubcommand();

  if (sub === 'add') {
    const channel = i.options.getChannel('channel', true);
    const every = parseDuration(i.options.getString('every', true));
    if (!every || every < MIN_INTERVAL_MS) return i.reply(ephemeral('Use an interval like `30m`, `6h` or `1d`. The minimum is 10 minutes.'));
    const firstIn = i.options.getString('first_in');
    const delay = firstIn ? parseDuration(firstIn) : every;
    if (!delay) return i.reply(ephemeral('`first_in` needs a duration like `5m` or `2h`.'));
    if (!channel.permissionsFor(i.guild.members.me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
      return i.reply(ephemeral(`I can't post in ${channel}.`));
    }
    const nextRun = Date.now() + delay;
    const { lastInsertRowid } = db.prepare('INSERT INTO schedules (guild_id, channel_id, message, interval_ms, next_run_at) VALUES (?, ?, ?, ?, ?)')
      .run(i.guildId, channel.id, i.options.getString('message', true).replaceAll('\\n', '\n'), every, nextRun);
    return i.reply(ephemeral(`✅ Schedule #${lastInsertRowid} posts in ${channel} every ${formatDuration(every)}. First post <t:${unix(nextRun)}:R>.`));
  }

  if (sub === 'remove') {
    const id = i.options.getInteger('id', true);
    const { changes } = db.prepare('DELETE FROM schedules WHERE guild_id = ? AND id = ?').run(i.guildId, id);
    return i.reply(ephemeral(changes ? `✅ Removed schedule #${id}.` : `There is no schedule #${id} here.`));
  }

  const rows = db.prepare('SELECT * FROM schedules WHERE guild_id = ? ORDER BY next_run_at').all(i.guildId);
  const lines = rows.map((s) => {
    const preview = s.message.length > 80 ? `${s.message.slice(0, 80)}…` : s.message;
    return `\`#${s.id}\` <#${s.channel_id}> · every ${formatDuration(s.interval_ms)} · next <t:${unix(s.next_run_at)}:R>\n> ${preview.replaceAll('\n', ' ')}`;
  });
  return i.reply({
    flags: MessageFlags.Ephemeral,
    embeds: [new EmbedBuilder().setColor(BRAND).setTitle('🗓️ Scheduled messages').setDescription(lines.join('\n\n') || 'None yet. Add one with `/schedule add`.')],
  });
}

const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

module.exports = [
  {
    data: new SlashCommandBuilder()
      .setName('automod')
      .setDescription("Turn on Discord's built-in message filters")
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) => s.setName('words').setDescription('Block a list of words (replaces the current list)')
        .addStringOption((o) => o.setName('words').setDescription('Comma separated, or "off" to clear the list').setRequired(true).setMaxLength(4000)))
      .addSubcommand((s) => s.setName('invites').setDescription('Block invite links to other Discord servers')
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)))
      .addSubcommand((s) => s.setName('mentions').setDescription('Block messages that mention too many people')
        .addIntegerOption((o) => o.setName('limit').setDescription('Most mentions allowed in one message. 0 turns it off').setMinValue(0).setMaxValue(50).setRequired(true)))
      .addSubcommand((s) => s.setName('spam').setDescription("Block messages Discord detects as spam")
        .addBooleanOption((o) => o.setName('enabled').setDescription('On or off').setRequired(true)))
      .addSubcommand((s) => s.setName('show').setDescription('List the AutoMod rules in this server')),
    execute: automod,
  },

  {
    data: new SlashCommandBuilder()
      .setName('schedule')
      .setDescription('Post messages on a repeating schedule')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) => s.setName('add').setDescription('Add a repeating message')
        .addChannelOption((o) => o.setName('channel').setDescription('Where to post').addChannelTypes(...TEXT_CHANNELS).setRequired(true))
        .addStringOption((o) => o.setName('message').setDescription('What to post. Write \\n for a new line').setMaxLength(2000).setRequired(true))
        .addStringOption((o) => o.setName('every').setDescription('How often, e.g. 30m, 6h, 1d').setRequired(true))
        .addStringOption((o) => o.setName('first_in').setDescription('Delay before the first post (default: one interval)')))
      .addSubcommand((s) => s.setName('list').setDescription('Show scheduled messages'))
      .addSubcommand((s) => s.setName('remove').setDescription('Delete a scheduled message')
        .addIntegerOption((o) => o.setName('id').setDescription('Number from /schedule list').setRequired(true))),
    execute: schedule,
  },

  {
    data: new SlashCommandBuilder()
      .setName('autoresponder')
      .setDescription('Reply automatically when a message contains a phrase')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) => s.setName('add').setDescription('Add a reply')
        .addStringOption((o) => o.setName('trigger').setDescription('Phrase to look for, e.g. how do i join').setMaxLength(100).setRequired(true))
        .addStringOption((o) => o.setName('response').setDescription('What to reply. Write \\n for a new line').setMaxLength(2000).setRequired(true))
        .addChannelOption((o) => o.setName('channel').setDescription('Only in this channel (default: everywhere)').addChannelTypes(...TEXT_CHANNELS)))
      .addSubcommand((s) => s.setName('remove').setDescription('Delete a reply')
        .addIntegerOption((o) => o.setName('id').setDescription('Number from /autoresponder list').setRequired(true)))
      .addSubcommand((s) => s.setName('list').setDescription('Show all replies')),
    async execute(i) {
      const sub = i.options.getSubcommand();
      if (sub === 'add') {
        if (db.prepare('SELECT COUNT(*) AS n FROM responders WHERE guild_id = ?').get(i.guildId).n >= 50) return i.reply(ephemeral('You can have up to 50 auto-replies.'));
        const channel = i.options.getChannel('channel');
        const { lastInsertRowid: id } = db.prepare('INSERT INTO responders (guild_id, trigger, response, channels) VALUES (?, ?, ?, ?)')
          .run(i.guildId, i.options.getString('trigger', true).trim(), i.options.getString('response', true).replaceAll('\\n', '\n'), JSON.stringify(channel ? [channel.id] : []));
        const note = i.client.hasMessageContent ? '' : '\n⚠️ The Message Content intent is off, so auto-replies stay inactive until the bot owner turns it on.';
        return i.reply(ephemeral(`✅ Auto-reply #${id} added${channel ? ` for ${channel}` : ''}.${note}`));
      }
      if (sub === 'remove') {
        const id = i.options.getInteger('id', true);
        const { changes } = db.prepare('DELETE FROM responders WHERE guild_id = ? AND id = ?').run(i.guildId, id);
        return i.reply(ephemeral(changes ? `✅ Deleted auto-reply #${id}.` : `There is no auto-reply #${id}.`));
      }
      const rows = db.prepare('SELECT * FROM responders WHERE guild_id = ? ORDER BY id').all(i.guildId);
      const where = (r) => JSON.parse(r.channels).map((c) => `<#${c}>`).join(' ') || 'everywhere';
      return i.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [new EmbedBuilder().setColor(BRAND).setTitle('💬 Auto-replies')
          .setDescription(rows.map((r) => `\`#${r.id}\` "${r.trigger}" · ${where(r)}\n> ${r.response.slice(0, 80).replaceAll('\n', ' ')}`).join('\n').slice(0, 4000) || 'None yet.')],
      });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('sticky')
      .setDescription('Keep a message at the bottom of a channel')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addSubcommand((s) => s.setName('set').setDescription('Set or replace the sticky message')
        .addStringOption((o) => o.setName('message').setDescription('Text. Write \\n for a new line').setMaxLength(1900).setRequired(true))
        .addChannelOption((o) => o.setName('channel').setDescription('Default: this channel').addChannelTypes(...TEXT_CHANNELS)))
      .addSubcommand((s) => s.setName('remove').setDescription('Remove the sticky message')
        .addChannelOption((o) => o.setName('channel').setDescription('Default: this channel').addChannelTypes(...TEXT_CHANNELS))),
    async execute(i) {
      const channel = i.options.getChannel('channel') ?? i.channel;
      const old = db.prepare('SELECT message_id FROM stickies WHERE channel_id = ?').get(channel.id);
      if (old?.message_id) await channel.messages.delete(old.message_id).catch(() => {});
      if (i.options.getSubcommand() === 'remove') {
        db.prepare('DELETE FROM stickies WHERE channel_id = ?').run(channel.id);
        return i.reply(ephemeral(old ? `✅ Removed the sticky message in ${channel}.` : `${channel} has no sticky message.`));
      }
      db.prepare(`INSERT INTO stickies (channel_id, guild_id, content) VALUES (?, ?, ?)
        ON CONFLICT (channel_id) DO UPDATE SET content = excluded.content, message_id = NULL`)
        .run(channel.id, i.guildId, i.options.getString('message', true).replaceAll('\\n', '\n'));
      await automation.repostSticky(channel);
      return i.reply(ephemeral(`📌 Sticky message set in ${channel}. It moves back to the bottom a few seconds after people post.`));
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('autopublish')
      .setDescription('Publish posts in announcement channels automatically')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
      .addSubcommand((s) => s.setName('add').setDescription('Auto-publish a channel')
        .addChannelOption((o) => o.setName('channel').setDescription('Announcement channel').addChannelTypes(ChannelType.GuildAnnouncement).setRequired(true)))
      .addSubcommand((s) => s.setName('remove').setDescription('Stop auto-publishing a channel')
        .addChannelOption((o) => o.setName('channel').setDescription('Announcement channel').addChannelTypes(ChannelType.GuildAnnouncement).setRequired(true)))
      .addSubcommand((s) => s.setName('list').setDescription('Show auto-published channels')),
    async execute(i) {
      const cfg = getFeature(i.guildId, 'autopublish', { channels: [] });
      const channel = i.options.getChannel('channel');
      const sub = i.options.getSubcommand();
      if (sub === 'add') {
        if (!channel.permissionsFor(i.guild.members.me)?.has([PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageMessages])) {
          return i.reply(ephemeral(`I need Send Messages and Manage Messages in ${channel} to publish other people's posts.`));
        }
        cfg.channels = [...new Set([...cfg.channels, channel.id])];
      } else if (sub === 'remove') {
        cfg.channels = cfg.channels.filter((id) => id !== channel.id);
      }
      setFeature(i.guildId, 'autopublish', cfg);
      return i.reply(ephemeral(`📣 Auto-published: ${cfg.channels.map((id) => `<#${id}>`).join(', ') || 'none'}. Discord allows about 10 publishes per hour per channel.`));
    },
  },
];

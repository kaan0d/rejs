const { SlashCommandBuilder, EmbedBuilder, InteractionContextType, MessageFlags, PermissionFlagsBits, escapeMarkdown } = require('discord.js');
const { db } = require('../db');
const { BRAND, ephemeral, parseDuration } = require('../util');

const MAX_REMINDERS = 25;
const MAX_REMINDER_MS = 365 * 86_400_000;
const unix = (ms) => Math.floor(ms / 1000);
const cleanName = (name) => name.trim().toLowerCase().replace(/\s+/g, '-').slice(0, 32);

const tagChoices = (i) => db.prepare('SELECT name FROM tags WHERE guild_id = ? AND name LIKE ? ORDER BY uses DESC, name LIMIT 25')
  .all(i.guildId, `%${i.options.getFocused()}%`).map(({ name }) => ({ name, value: name }));

async function tags(i) {
  const sub = i.options.getSubcommand();
  if (sub === 'list') {
    const rows = db.prepare('SELECT name, uses FROM tags WHERE guild_id = ? ORDER BY name').all(i.guildId);
    return i.reply({
      flags: MessageFlags.Ephemeral,
      embeds: [new EmbedBuilder().setColor(BRAND).setTitle(`Tags (${rows.length})`)
        .setDescription(rows.map((t) => `\`${t.name}\` · used ${t.uses}×`).join('\n').slice(0, 4000) || 'No tags yet. Add one with `/tags add`.')],
    });
  }
  const name = cleanName(i.options.getString('name', true));
  if (sub === 'remove') {
    const { changes } = db.prepare('DELETE FROM tags WHERE guild_id = ? AND name = ?').run(i.guildId, name);
    return i.reply(ephemeral(changes ? `✅ Deleted \`${name}\`.` : `There is no tag \`${name}\`.`));
  }
  const content = i.options.getString('content', true).replaceAll('\\n', '\n');
  if (sub === 'add') {
    if (db.prepare('SELECT COUNT(*) AS n FROM tags WHERE guild_id = ?').get(i.guildId).n >= 200) return i.reply(ephemeral('You can have up to 200 tags.'));
    const { changes } = db.prepare('INSERT OR IGNORE INTO tags (guild_id, name, content) VALUES (?, ?, ?)').run(i.guildId, name, content);
    return i.reply(ephemeral(changes ? `✅ Saved \`${name}\`. Post it with \`/tag ${name}\`.` : `\`${name}\` already exists. Use \`/tags edit\`.`));
  }
  const { changes } = db.prepare('UPDATE tags SET content = ? WHERE guild_id = ? AND name = ?').run(content, i.guildId, name);
  return i.reply(ephemeral(changes ? `✅ Updated \`${name}\`.` : `There is no tag \`${name}\`.`));
}

async function reminders(i) {
  if (i.options.getSubcommand() === 'delete') {
    const id = i.options.getInteger('id', true);
    const { changes } = db.prepare('DELETE FROM reminders WHERE id = ? AND user_id = ?').run(id, i.user.id);
    return i.reply(ephemeral(changes ? `✅ Deleted reminder #${id}.` : `You have no reminder #${id}.`));
  }
  const rows = db.prepare('SELECT * FROM reminders WHERE user_id = ? ORDER BY due_at').all(i.user.id);
  return i.reply({
    flags: MessageFlags.Ephemeral,
    embeds: [new EmbedBuilder().setColor(BRAND).setTitle('Your reminders')
      .setDescription(rows.map((r) => `\`#${r.id}\` <t:${unix(r.due_at)}:R> · ${escapeMarkdown(r.text.slice(0, 100))}`).join('\n') || 'None.')],
  });
}

module.exports = [
  {
    data: new SlashCommandBuilder()
      .setName('tag')
      .setDescription('Post a saved answer, like the rules or an FAQ')
      .setContexts(InteractionContextType.Guild)
      .addStringOption((o) => o.setName('name').setDescription('Tag name').setAutocomplete(true).setRequired(true))
      .addUserOption((o) => o.setName('for').setDescription('Mention someone with it')),
    autocomplete: (i) => i.respond(tagChoices(i)),
    async execute(i) {
      const name = cleanName(i.options.getString('name', true));
      const tag = db.prepare('SELECT * FROM tags WHERE guild_id = ? AND name = ?').get(i.guildId, name);
      if (!tag) return i.reply(ephemeral(`There is no tag \`${name}\`. See \`/tags list\`.`));
      db.prepare('UPDATE tags SET uses = uses + 1 WHERE guild_id = ? AND name = ?').run(i.guildId, name);
      const target = i.options.getUser('for');
      await i.reply({ content: `${target ? `${target} ` : ''}${tag.content}`, allowedMentions: { users: target ? [target.id] : [] } });
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('tags')
      .setDescription('Manage saved answers')
      .setContexts(InteractionContextType.Guild)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addSubcommand((s) => s.setName('add').setDescription('Save a new tag')
        .addStringOption((o) => o.setName('name').setDescription('Short name, e.g. rules').setMaxLength(32).setRequired(true))
        .addStringOption((o) => o.setName('content').setDescription('Text to post. Write \\n for a new line').setMaxLength(2000).setRequired(true)))
      .addSubcommand((s) => s.setName('edit').setDescription('Change a tag')
        .addStringOption((o) => o.setName('name').setDescription('Tag name').setAutocomplete(true).setRequired(true))
        .addStringOption((o) => o.setName('content').setDescription('New text').setMaxLength(2000).setRequired(true)))
      .addSubcommand((s) => s.setName('remove').setDescription('Delete a tag')
        .addStringOption((o) => o.setName('name').setDescription('Tag name').setAutocomplete(true).setRequired(true)))
      .addSubcommand((s) => s.setName('list').setDescription('Show all tags')),
    autocomplete: (i) => i.respond(tagChoices(i)),
    execute: tags,
  },

  {
    data: new SlashCommandBuilder()
      .setName('remind')
      .setDescription('Get reminded about something later')
      .addStringOption((o) => o.setName('in').setDescription('e.g. 30m, 2h, 1d').setRequired(true))
      .addStringOption((o) => o.setName('about').setDescription('What to remind you about').setMaxLength(1000).setRequired(true))
      .addBooleanOption((o) => o.setName('dm').setDescription('Remind me by DM instead of here')),
    async execute(i) {
      const ms = parseDuration(i.options.getString('in', true));
      if (!ms || ms > MAX_REMINDER_MS) return i.reply(ephemeral('Use a time like `30m`, `2h` or `3d`, up to a year.'));
      if (db.prepare('SELECT COUNT(*) AS n FROM reminders WHERE user_id = ?').get(i.user.id).n >= MAX_REMINDERS) {
        return i.reply(ephemeral(`You can have up to ${MAX_REMINDERS} reminders. Delete some with \`/reminders delete\`.`));
      }
      const dm = i.options.getBoolean('dm') || !i.inGuild();
      const due = Date.now() + ms;
      const { lastInsertRowid: id } = db.prepare('INSERT INTO reminders (user_id, guild_id, channel_id, text, due_at, dm) VALUES (?, ?, ?, ?, ?, ?)')
        .run(i.user.id, i.guildId, i.channelId, i.options.getString('about', true), due, dm ? 1 : 0);
      await i.reply(ephemeral(`Reminder #${id} set for <t:${unix(due)}:f> (<t:${unix(due)}:R>)${dm ? ' by DM' : ''}.`));
    },
  },

  {
    data: new SlashCommandBuilder()
      .setName('reminders')
      .setDescription('Your reminders')
      .addSubcommand((s) => s.setName('list').setDescription('Show your reminders'))
      .addSubcommand((s) => s.setName('delete').setDescription('Delete a reminder')
        .addIntegerOption((o) => o.setName('id').setDescription('Number from /reminders list').setRequired(true))),
    execute: reminders,
  },
];

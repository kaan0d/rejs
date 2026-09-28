const {
  EmbedBuilder, Colors, ActionRowBuilder, ButtonBuilder, ButtonStyle, StringSelectMenuBuilder, Events, MessageFlags, escapeMarkdown,
} = require('discord.js');
const { db, getFeature } = require('./db');
const { BRAND, ephemeral, toEmoji } = require('./util');
const mod = require('./moderation');

// ---- Role menus -----------------------------------------------------------------------------

const getMenu = (messageId) => {
  const row = db.prepare('SELECT * FROM role_menus WHERE message_id = ?').get(messageId);
  return row && { ...row, roles: JSON.parse(row.roles) };
};

function menuMessage(guild, menu) {
  const roles = menu.roles.filter((r) => guild.roles.cache.has(r.roleId));
  const list = roles.map((r) => `${r.emoji ? `${r.emoji} ` : ''}<@&${r.roleId}>${r.description ? ` · ${r.description}` : ''}`).join('\n');
  const embed = new EmbedBuilder()
    .setColor(BRAND)
    .setTitle(menu.title)
    .setDescription([menu.description, list || '*No roles yet.*'].filter(Boolean).join('\n\n'))
    .setFooter({ text: menu.max_choices === 1 ? 'Pick one. Picking again removes it.' : 'Pick roles to add them. Pick one you have to remove it.' });
  if (!roles.length) return { embeds: [embed], components: [] };
  const select = new StringSelectMenuBuilder()
    .setCustomId(`rolemenu:${menu.message_id}`)
    .setPlaceholder('Choose roles')
    .setMinValues(1)
    .setMaxValues(menu.max_choices === 1 ? 1 : roles.length)
    .addOptions(roles.map((r) => ({
      label: guild.roles.cache.get(r.roleId).name.slice(0, 100),
      value: r.roleId,
      ...(toEmoji(r.emoji) && { emoji: toEmoji(r.emoji) }),
      ...(r.description && { description: r.description.slice(0, 100) }),
    })));
  return { embeds: [embed], components: [new ActionRowBuilder().addComponents(select)], allowedMentions: { parse: [] } };
}

const saveMenu = (menu) => db.prepare('UPDATE role_menus SET roles = ? WHERE message_id = ?').run(JSON.stringify(menu.roles), menu.message_id);

async function refreshMenu(guild, menu) {
  const channel = guild.channels.cache.get(menu.channel_id);
  const message = await channel?.messages.fetch(menu.message_id).catch(() => null);
  if (!message) return false;
  await message.edit(menuMessage(guild, menu));
  return true;
}

// Picking a role toggles it. In pick-one menus, picking a role also removes the others.
function roleChanges(menuRoleIds, held, picked, pickOne) {
  const add = [];
  const remove = [];
  for (const id of picked) (held.has(id) ? remove : add).push(id);
  if (pickOne && add.length) remove.push(...menuRoleIds.filter((id) => held.has(id) && !picked.includes(id)));
  return { add, remove };
}

// ---- Welcome and goodbye --------------------------------------------------------------------

const WELCOME_DEFAULTS = {
  enabled: false,
  channelId: null,
  message: 'Welcome {user} to **{server}**! You are member #{count}.',
  embed: true,
  dm: null,
  goodbyeChannelId: null,
  goodbye: '**{username}** left the server.',
};

const fill = (template, member) => template
  .replaceAll('{user}', `${member}`)
  .replaceAll('{username}', escapeMarkdown(member.user.username))
  .replaceAll('{server}', escapeMarkdown(member.guild.name))
  .replaceAll('{count}', `${member.guild.memberCount}`);

async function sendWelcome(member) {
  const cfg = getFeature(member.guild.id, 'welcome', WELCOME_DEFAULTS);
  if (!cfg.enabled) return;
  const channel = member.guild.channels.cache.get(cfg.channelId);
  const text = fill(cfg.message, member);
  const payload = cfg.embed
    ? {
      content: `${member}`,
      embeds: [new EmbedBuilder().setColor(BRAND).setAuthor({ name: `Welcome, ${member.user.username}!`, iconURL: member.displayAvatarURL() })
        .setThumbnail(member.displayAvatarURL({ size: 256 })).setDescription(text).setFooter({ text: `Member #${member.guild.memberCount}` })],
    }
    : { content: text };
  await channel?.send({ ...payload, allowedMentions: { users: [member.id] } }).catch(() => {});
  if (cfg.dm) await mod.notify(member.user, fill(cfg.dm, member));
}

async function sendGoodbye(member) {
  const cfg = getFeature(member.guild.id, 'welcome', WELCOME_DEFAULTS);
  const channel = member.guild.channels.cache.get(cfg.goodbyeChannelId);
  if (!channel || !cfg.goodbye) return;
  await channel.send({ content: fill(cfg.goodbye, member), allowedMentions: { parse: [] } }).catch(() => {});
}

// ---- Suggestions ----------------------------------------------------------------------------

const STATUS = {
  open: { label: 'Open', color: BRAND },
  considering: { label: '🤔 Considering', color: Colors.Yellow },
  accepted: { label: '✅ Accepted', color: Colors.Green },
  denied: { label: '❌ Denied', color: Colors.Red },
};
const getSuggestion = (id) => db.prepare('SELECT * FROM suggestions WHERE id = ?').get(Number(id));
const votesOf = (id) => db.prepare('SELECT COALESCE(SUM(vote = 1), 0) AS up, COALESCE(SUM(vote = -1), 0) AS down FROM suggestion_votes WHERE suggestion_id = ?').get(id);

async function suggestionMessage(client, s) {
  const { up, down } = votesOf(s.id);
  const author = s.anonymous ? null : await client.users.fetch(s.user_id).catch(() => null);
  const status = STATUS[s.status];
  const embed = new EmbedBuilder()
    .setColor(status.color)
    .setAuthor(author ? { name: author.tag, iconURL: author.displayAvatarURL() } : { name: 'Anonymous suggestion' })
    .setTitle(`Suggestion #${s.id}`)
    .setDescription(s.text)
    .setTimestamp(s.created_at);
  if (s.status !== 'open') {
    embed.addFields({ name: status.label, value: `${s.status_reason || 'No reason given'}\n— <@${s.handled_by}>` });
  }
  const closed = s.status === 'accepted' || s.status === 'denied';
  return {
    embeds: [embed],
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sugg-up:${s.id}`).setEmoji('👍').setLabel(`${up}`).setStyle(ButtonStyle.Success).setDisabled(closed),
      new ButtonBuilder().setCustomId(`sugg-down:${s.id}`).setEmoji('👎').setLabel(`${down}`).setStyle(ButtonStyle.Danger).setDisabled(closed),
    )],
    allowedMentions: { parse: [] },
  };
}

async function postSuggestion(i, text, anonymous) {
  const channel = i.guild.channels.cache.get(getFeature(i.guildId, 'suggestions', {}).channelId);
  if (!channel) return null;
  const { lastInsertRowid: id } = db.prepare('INSERT INTO suggestions (guild_id, channel_id, user_id, anonymous, text, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(i.guildId, channel.id, i.user.id, anonymous ? 1 : 0, text, Date.now());
  const message = await channel.send(await suggestionMessage(i.client, getSuggestion(id)));
  db.prepare('UPDATE suggestions SET message_id = ? WHERE id = ?').run(message.id, id);
  await message.startThread({ name: `Suggestion #${id}`, autoArchiveDuration: 10080 }).catch(() => {});
  return message;
}

async function setSuggestionStatus(i, id, status, reason) {
  const s = getSuggestion(id);
  if (!s || s.guild_id !== i.guildId) return null;
  db.prepare('UPDATE suggestions SET status = ?, status_reason = ?, handled_by = ? WHERE id = ?').run(status, reason, i.user.id, s.id);
  const updated = getSuggestion(s.id);
  const message = await i.guild.channels.cache.get(s.channel_id)?.messages.fetch(s.message_id).catch(() => null);
  await message?.edit(await suggestionMessage(i.client, updated));
  const author = await i.client.users.fetch(s.user_id).catch(() => null);
  await mod.notify(author, `Your suggestion #${s.id} in **${i.guild.name}** is now **${STATUS[status].label}**${reason ? `: ${reason}` : '.'}`);
  return updated;
}

async function vote(i, id, value) {
  const s = getSuggestion(id);
  if (!s || s.status === 'accepted' || s.status === 'denied') return i.reply(ephemeral('Voting on this suggestion is closed.'));
  const current = db.prepare('SELECT vote FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?').get(s.id, i.user.id);
  if (current?.vote === value) {
    db.prepare('DELETE FROM suggestion_votes WHERE suggestion_id = ? AND user_id = ?').run(s.id, i.user.id);
  } else {
    db.prepare(`INSERT INTO suggestion_votes (suggestion_id, user_id, vote) VALUES (?, ?, ?)
      ON CONFLICT (suggestion_id, user_id) DO UPDATE SET vote = excluded.vote`).run(s.id, i.user.id, value);
  }
  await i.update(await suggestionMessage(i.client, s));
}

// ---- Wiring ---------------------------------------------------------------------------------

const handlers = {
  async rolemenu(i, messageId) {
    const menu = getMenu(messageId);
    if (!menu) return i.reply(ephemeral('This role menu no longer exists.'));
    const menuIds = menu.roles.map((r) => r.roleId);
    const { add, remove } = roleChanges(menuIds, i.member.roles.cache, i.values, menu.max_choices === 1);
    const usable = (ids) => ids.filter((id) => i.guild.roles.cache.get(id)?.editable);
    const [added, removed] = [usable(add), usable(remove)];
    // Re-rendering the menu clears the member's pick, so picking the same role again (to remove it) works.
    await i.update(menuMessage(i.guild, menu));
    if (added.length) await i.member.roles.add(added, 'Role menu');
    if (removed.length) await i.member.roles.remove(removed, 'Role menu');
    const list = (ids) => ids.map((id) => `<@&${id}>`).join(', ');
    const text = [added.length && `Added ${list(added)}`, removed.length && `Removed ${list(removed)}`].filter(Boolean).join('\n');
    await i.followUp(ephemeral(text || "Nothing changed. I can't manage those roles; ask the staff."));
  },
  'sugg-up': (i, id) => vote(i, id, 1),
  'sugg-down': (i, id) => vote(i, id, -1),
};

function register(client) {
  client.on(Events.GuildMemberAdd, (member) => {
    // No welcome spam during a raid, and no welcomes for bots.
    if (member.user.bot || getFeature(member.guild.id, 'raid_state', {}).active) return;
    sendWelcome(member).catch((e) => console.error('Welcome:', e));
  });
  client.on(Events.GuildMemberRemove, (member) => {
    if (!member.user.bot) sendGoodbye(member).catch((e) => console.error('Goodbye:', e));
  });
}

module.exports = {
  getMenu, menuMessage, saveMenu, refreshMenu, roleChanges,
  WELCOME_DEFAULTS, fill, sendWelcome,
  getSuggestion, postSuggestion, setSuggestionStatus, suggestionMessage, STATUS,
  handlers, register,
};

const { SlashCommandBuilder, ChannelType, InteractionContextType, PermissionFlagsBits, EmbedBuilder, MessageFlags } = require('discord.js');
const { db, getFeature, setFeature } = require('../db');
const { BRAND, ephemeral, toEmoji } = require('../util');
const community = require('../community');
const journal = require('../journal');

const P = PermissionFlagsBits;
const TEXT_CHANNELS = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
const POST = [P.ViewChannel, P.SendMessages, P.EmbedLinks];
const canPost = (i, channel) => channel.permissionsFor(i.guild.members.me)?.has(POST);

const command = (name, description, permission) => {
  const builder = new SlashCommandBuilder().setName(name).setDescription(description).setContexts(InteractionContextType.Guild);
  return permission ? builder.setDefaultMemberPermissions(permission) : builder;
};

async function rolemenu(i) {
  const sub = i.options.getSubcommand();
  if (sub === 'create') {
    const channel = i.options.getChannel('channel', true);
    if (!canPost(i, channel)) return i.reply(ephemeral(`I can't post in ${channel}.`));
    const message = await channel.send({ embeds: [new EmbedBuilder().setColor(BRAND).setDescription('Setting up…')] });
    journal.created('message', message);
    db.prepare('INSERT INTO role_menus (message_id, guild_id, channel_id, title, description, max_choices) VALUES (?, ?, ?, ?, ?, ?)')
      .run(message.id, i.guildId, channel.id, i.options.getString('title', true), i.options.getString('description'), i.options.getBoolean('pick_one') ? 1 : 25);
    await message.edit(community.menuMessage(i.guild, community.getMenu(message.id)));
    return i.reply(ephemeral(`✅ Menu created in ${channel}. Add roles with \`/rolemenu add message_id:${message.id}\`.`));
  }

  const menu = community.getMenu(i.options.getString('message_id', true).trim());
  if (!menu || menu.guild_id !== i.guildId) return i.reply(ephemeral('No role menu with that message ID here. Copy it with right-click → Copy Message ID.'));
  const role = i.options.getRole('role', true);

  if (sub === 'add') {
    if (role.managed || role.id === i.guildId || !role.editable) return i.reply(ephemeral(`I can't give ${role}. Pick a normal role below mine.`));
    if (i.user.id !== i.guild.ownerId && role.position >= i.member.roles.highest.position) return i.reply(ephemeral(`${role} is equal to or above your highest role.`));
    if (menu.roles.length >= 25) return i.reply(ephemeral('A menu holds up to 25 roles.'));
    const emoji = i.options.getString('emoji');
    if (emoji && !toEmoji(emoji)) return i.reply(ephemeral('That emoji won\'t work in a menu. Use a normal emoji like , or a server emoji picked from the emoji menu.'));
    menu.roles = menu.roles.filter((r) => r.roleId !== role.id);
    menu.roles.push({ roleId: role.id, emoji: i.options.getString('emoji'), description: i.options.getString('description') });
  } else {
    menu.roles = menu.roles.filter((r) => r.roleId !== role.id);
  }
  journal.refresh('rolemenu', menu.message_id);
  community.saveMenu(menu);
  const ok = await community.refreshMenu(i.guild, menu);
  return i.reply(ephemeral(ok ? `✅ Menu updated.` : '⚠️ Saved, but I could not find the menu message. Was it deleted?'));
}

async function welcome(i) {
  const sub = i.options.getSubcommand();
  const cfg = getFeature(i.guildId, 'welcome', community.WELCOME_DEFAULTS);

  if (sub === 'set') {
    const channel = i.options.getChannel('channel', true);
    if (!canPost(i, channel)) return i.reply(ephemeral(`I can't post in ${channel}.`));
    Object.assign(cfg, { enabled: true, channelId: channel.id });
    const message = i.options.getString('message');
    if (message) cfg.message = message.replaceAll('\\n', '\n');
    const embed = i.options.getBoolean('embed');
    if (embed !== null) cfg.embed = embed;
  } else if (sub === 'dm') {
    const message = i.options.getString('message');
    cfg.dm = message ? message.replaceAll('\\n', '\n') : null;
  } else if (sub === 'goodbye') {
    const channel = i.options.getChannel('channel');
    if (channel && !canPost(i, channel)) return i.reply(ephemeral(`I can't post in ${channel}.`));
    cfg.goodbyeChannelId = channel?.id ?? null;
    const message = i.options.getString('message');
    if (message) cfg.goodbye = message.replaceAll('\\n', '\n');
  } else if (sub === 'off') {
    cfg.enabled = false;
  } else if (sub === 'test') {
    if (!cfg.enabled) return i.reply(ephemeral('Welcome messages are off. Turn them on with `/welcome set`.'));
    await community.sendWelcome(i.member);
    return i.reply(ephemeral(`✅ Sent a test welcome to <#${cfg.channelId}>${cfg.dm ? ' and a DM to you' : ''}.`));
  }
  setFeature(i.guildId, 'welcome', cfg);

  const preview = (t) => community.fill(t, i.member);
  return i.reply({
    flags: MessageFlags.Ephemeral,
    embeds: [new EmbedBuilder()
      .setColor(BRAND)
      .setTitle('Welcome settings')
      .setDescription('Variables: `{user}` `{username}` `{server}` `{count}`. Write `\\n` for a new line.')
      .addFields(
        { name: `Welcome ${cfg.enabled ? `in <#${cfg.channelId}>` : '(off)'}${cfg.embed ? ' · embed' : ''}`, value: preview(cfg.message) },
        { name: 'Welcome DM', value: cfg.dm ? preview(cfg.dm) : 'Off' },
        { name: `Goodbye ${cfg.goodbyeChannelId ? `in <#${cfg.goodbyeChannelId}>` : '(off)'}`, value: preview(cfg.goodbye) },
      )],
    allowedMentions: { parse: [] },
  });
}

async function suggestion(i) {
  const sub = i.options.getSubcommand();
  const id = i.options.getInteger('id', true);
  const s = community.getSuggestion(id);
  if (!s || s.guild_id !== i.guildId) return i.reply(ephemeral(`There is no suggestion #${id}.`));
  if (sub === 'author') return i.reply(ephemeral(`Suggestion #${id} was posted by <@${s.user_id}>${s.anonymous ? ' (anonymously)' : ''}.`));
  journal.refresh('suggestion', id);
  await community.setSuggestionStatus(i, id, sub, i.options.getString('reason'));
  return i.reply(ephemeral(`✅ Suggestion #${id} is now ${community.STATUS[sub].label}. The author got a DM.`));
}

const statusSub = (name, description) => (s) => s.setName(name).setDescription(description)
  .addIntegerOption((o) => o.setName('id').setDescription('Suggestion number').setMinValue(1).setRequired(true))
  .addStringOption((o) => o.setName('reason').setDescription('Shown on the suggestion').setMaxLength(1000));

module.exports = [
  {
    data: command('rolemenu', 'Dropdown menus where members pick their own roles', P.ManageRoles)
      .addSubcommand((s) => s.setName('create').setDescription('Post a new role menu')
        .addChannelOption((o) => o.setName('channel').setDescription('Where to post it').addChannelTypes(...TEXT_CHANNELS).setRequired(true))
        .addStringOption((o) => o.setName('title').setDescription('e.g. Pick your region').setMaxLength(256).setRequired(true))
        .addStringOption((o) => o.setName('description').setDescription('Text above the roles').setMaxLength(1000))
        .addBooleanOption((o) => o.setName('pick_one').setDescription('Members can only have one role from this menu')))
      .addSubcommand((s) => s.setName('add').setDescription('Add a role to a menu')
        .addStringOption((o) => o.setName('message_id').setDescription('ID of the menu message').setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true))
        .addStringOption((o) => o.setName('emoji').setDescription('Emoji shown next to it').setMaxLength(40))
        .addStringOption((o) => o.setName('description').setDescription('Short hint shown in the menu').setMaxLength(100)))
      .addSubcommand((s) => s.setName('remove').setDescription('Remove a role from a menu')
        .addStringOption((o) => o.setName('message_id').setDescription('ID of the menu message').setRequired(true))
        .addRoleOption((o) => o.setName('role').setDescription('Role').setRequired(true))),
    execute: rolemenu,
  },

  {
    data: command('welcome', 'Welcome and goodbye messages', P.ManageGuild)
      .addSubcommand((s) => s.setName('set').setDescription('Turn on welcome messages')
        .addChannelOption((o) => o.setName('channel').setDescription('Where to welcome people').addChannelTypes(...TEXT_CHANNELS).setRequired(true))
        .addStringOption((o) => o.setName('message').setDescription('e.g. Welcome {user} to {server}!').setMaxLength(2000))
        .addBooleanOption((o) => o.setName('embed').setDescription('Show as a card with their avatar (default on)')))
      .addSubcommand((s) => s.setName('dm').setDescription('Also send new members a DM')
        .addStringOption((o) => o.setName('message').setDescription('Leave empty to turn the DM off').setMaxLength(2000)))
      .addSubcommand((s) => s.setName('goodbye').setDescription('Post when someone leaves')
        .addChannelOption((o) => o.setName('channel').setDescription('Leave empty to turn goodbyes off').addChannelTypes(...TEXT_CHANNELS))
        .addStringOption((o) => o.setName('message').setDescription('e.g. {username} left.').setMaxLength(2000)))
      .addSubcommand((s) => s.setName('test').setDescription('Send yourself a test welcome'))
      .addSubcommand((s) => s.setName('off').setDescription('Turn welcome messages off')),
    execute: welcome,
  },

  {
    data: command('suggest', 'Suggest something for the server')
      .addStringOption((o) => o.setName('idea').setDescription('Your suggestion').setMaxLength(2000).setRequired(true))
      .addBooleanOption((o) => o.setName('anonymous').setDescription("Hide your name (staff can still see it)")),
    async execute(i) {
      const message = await community.postSuggestion(i, i.options.getString('idea', true), i.options.getBoolean('anonymous') ?? false);
      await i.reply(ephemeral(message ? `✅ Posted: ${message.url}` : 'Suggestions are not set up here. Ask the staff to run `/config suggestions`.'));
    },
  },

  {
    data: command('suggestion', 'Answer a suggestion', P.ManageMessages)
      .addSubcommand(statusSub('accepted', 'Accept a suggestion'))
      .addSubcommand(statusSub('denied', 'Deny a suggestion'))
      .addSubcommand(statusSub('considering', 'Mark a suggestion as under consideration'))
      .addSubcommand((s) => s.setName('author').setDescription('See who posted a suggestion, even an anonymous one')
        .addIntegerOption((o) => o.setName('id').setDescription('Suggestion number').setMinValue(1).setRequired(true))),
    execute: suggestion,
  },
];

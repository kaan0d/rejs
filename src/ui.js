// Every message the bot sends becomes a Components V2 card: a container with an accent color,
// headings, separators, thumbnails, galleries and the buttons inside the card.
//
// Commands keep building ordinary payloads (text, embeds, action rows). install() converts them
// right before they reach Discord, so one place decides how the whole bot looks.
const {
  ContainerBuilder, TextDisplayBuilder, SectionBuilder, ThumbnailBuilder, SeparatorBuilder, SeparatorSpacingSize,
  MediaGalleryBuilder, MediaGalleryItemBuilder, FileBuilder, MessageFlags, MessageFlagsBitField, ComponentType, Colors,
  CommandInteraction, MessageComponentInteraction, ModalSubmitInteraction, BaseGuildTextChannel, ThreadChannel,
  BaseGuildVoiceChannel, DMChannel, Message, EmbedBuilder,
} = require('discord.js');
const { BRAND } = require('./util');

const V2 = MessageFlags.IsComponentsV2;
// Discord allows 4000 characters of text per card message; stay a little under.
const TEXT_BUDGET = 3900;

// Plain replies start with a status marker (✅ ❌ ⛔ ⚠️) in the code. The marker picks the card's
// color and is removed from the text, so members see a clean message on a green, red or orange card.
const MARKERS = [['✅', Colors.Green], ['❌', Colors.Red], ['⛔', Colors.Red], ['⚠️', Colors.Orange]];
function tone(text) {
  const found = MARKERS.find(([marker]) => text.startsWith(marker));
  return found ? { color: found[1], text: text.slice(found[0].length).trimStart() } : { color: BRAND, text };
}

const json = (e) => (e instanceof EmbedBuilder ? e.toJSON() : e?.data ?? e);

// Fields become compact lines. Short values sit next to their name, longer ones below it.
function fieldsText(fields) {
  return fields.map((f) => {
    const name = f.name.replace(/\*\*/g, '');
    return f.value.includes('\n') || f.value.length > 60 ? `**${name}**\n${f.value}` : `**${name}** · ${f.value}`;
  }).join('\n');
}

// One embed becomes one container.
function embedToContainer(embed) {
  const e = json(embed);
  const container = new ContainerBuilder().setAccentColor(e.color ?? BRAND);
  const head = [
    e.author?.name && `-# ${e.author.name}`,
    e.title && `### ${e.url ? `[${e.title}](${e.url})` : e.title}`,
    e.description,
  ].filter(Boolean).join('\n');

  // Cards without a title show the author's avatar on the side instead.
  const thumbnail = e.thumbnail?.url ?? (e.title ? null : e.author?.icon_url) ?? null;
  if (head && thumbnail) {
    container.addSectionComponents(new SectionBuilder()
      .addTextDisplayComponents(new TextDisplayBuilder().setContent(head))
      .setThumbnailAccessory(new ThumbnailBuilder().setURL(thumbnail)));
  } else if (head) {
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(head));
  }

  if (e.fields?.length) {
    if (head) container.addSeparatorComponents(new SeparatorBuilder().setDivider(false).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(fieldsText(e.fields)));
  }
  if (e.image?.url) {
    container.addMediaGalleryComponents(new MediaGalleryBuilder().addItems(new MediaGalleryItemBuilder().setURL(e.image.url)));
  }
  const stamp = e.timestamp ? `<t:${Math.floor(new Date(e.timestamp).getTime() / 1000)}:f>` : null;
  const footer = [e.footer?.text, stamp].filter(Boolean).join(' · ');
  if (footer) {
    container.addSeparatorComponents(new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small));
    container.addTextDisplayComponents(new TextDisplayBuilder().setContent(`-# ${footer}`));
  }
  return container;
}

// Keeps the whole message under Discord's text limit by shortening the longest texts first.
function fitText(components) {
  const texts = [];
  const walk = (c) => {
    if (c.type === ComponentType.TextDisplay) texts.push(c);
    for (const child of c.components ?? []) walk(child);
  };
  components.forEach(walk);
  let total = texts.reduce((sum, t) => sum + t.content.length, 0);
  for (const t of [...texts].sort((a, b) => b.content.length - a.content.length)) {
    if (total <= TEXT_BUDGET) break;
    const cut = Math.min(total - TEXT_BUDGET + 1, t.content.length - 1);
    t.content = `${t.content.slice(0, t.content.length - cut)}…`;
    total -= cut;
  }
  return components;
}

const isRow = (c) => (c.type ?? json(c)?.type) === ComponentType.ActionRow;
const toJSON = (c) => (typeof c.toJSON === 'function' ? c.toJSON() : c);

// Resolves any flags value to a bit field, dropping flags edits don't accept.
function flagsFor(flags, { edit = false } = {}) {
  const bits = new MessageFlagsBitField(flags ?? 0).add(V2);
  if (edit) bits.remove(MessageFlags.Ephemeral);
  return bits.bitfield;
}

// Converts an ordinary payload into a card payload. Returns it unchanged when it already is one,
// or null when it only changes buttons (see restyle for that case).
function modernize(input, { edit = false } = {}) {
  if (input == null) return input;
  const payload = typeof input === 'string' ? { content: input } : { ...input };
  if (new MessageFlagsBitField(payload.flags ?? 0).has(V2)) return payload;

  const { content, embeds = [], components = [], files = [], ...rest } = payload;
  if (!content && !embeds.length) return null;

  const out = [];
  const rows = components.filter(isRow);
  if (content && embeds.length) {
    // Text next to embeds is usually a ping; it stays above the card so it still notifies.
    out.push(new TextDisplayBuilder().setContent(content));
  }
  const plain = !embeds.length && tone(content);
  const containers = plain
    ? [new ContainerBuilder().setAccentColor(plain.color).addTextDisplayComponents(new TextDisplayBuilder().setContent(plain.text || content))]
    : embeds.map(embedToContainer);
  const last = containers.at(-1);

  // Attached files must be shown by a component, or Discord hides them.
  for (const file of files) {
    const name = file.name ?? file.attachment?.name;
    if (name) last.addFileComponents(new FileBuilder().setURL(`attachment://${name}`));
  }
  if (rows.length) last.addActionRowComponents(...rows.map((r) => toJSON(r)));
  out.push(...containers);

  return { ...rest, files, components: fitText(out.map(toJSON)), flags: flagsFor(payload.flags, { edit }) };
}

// For "remove the buttons" edits: keeps the card and swaps its buttons for the new ones.
function restyle(message, { rows = [], status = null, color = null } = {}) {
  const components = message.components.map((c) => c.toJSON());
  const container = components.findLast((c) => c.type === ComponentType.Container);
  if (!container) return { components: rows.map(toJSON), flags: V2 };
  container.components = container.components.filter((c) => c.type !== ComponentType.ActionRow);
  if (status) {
    container.components.push(
      new SeparatorBuilder().setDivider(true).setSpacing(SeparatorSpacingSize.Small).toJSON(),
      new TextDisplayBuilder().setContent(`-# ${status}`).toJSON(),
    );
  }
  if (color !== null) container.accent_color = color;
  container.components.push(...rows.map(toJSON));
  return { components, flags: V2 };
}

// A message made before the switch keeps its old embed look when edited: Discord can't turn it
// into a card while it still has text or embeds.
const isLegacy = (message) => message && !message.flags?.has(V2) && (message.content || message.embeds?.length);

// Marks a staff card as done (e.g. "Accepted by X"): recolors it, adds the status line and
// removes its buttons. Older embed messages get the same treatment in embed form.
function finishCard(message, { status, color }) {
  if (isLegacy(message) && message.embeds.length) {
    return { embeds: [EmbedBuilder.from(message.embeds[0]).setColor(color).setFooter({ text: status })], components: [] };
  }
  return restyle(message, { status, color });
}

async function convertEdit(payload, target) {
  const body = modernize(payload, { edit: true });
  if (body) {
    const message = await target();
    return isLegacy(message) ? payload : body;
  }
  // Only the buttons change.
  const message = await target();
  if (!message || isLegacy(message) || !message.flags?.has(V2)) return payload;
  return restyle(message, { rows: (payload.components ?? []).filter(isRow) });
}

// Wraps the methods that send or edit messages so everything goes out as a card.
function install() {
  const wrap = (proto, name, convert) => {
    const original = proto[name];
    proto[name] = async function wrapped(payload, ...args) {
      return original.call(this, await convert.call(this, payload), ...args);
    };
  };
  const send = (payload) => modernize(payload) ?? payload;

  for (const proto of [CommandInteraction.prototype, MessageComponentInteraction.prototype, ModalSubmitInteraction.prototype]) {
    wrap(proto, 'reply', send);
    wrap(proto, 'followUp', send);
    // Command replies are always new cards; button and form replies may edit an older message.
    wrap(proto, 'editReply', function convert(payload) {
      const needsLookup = !(this instanceof CommandInteraction) || !modernize(payload, { edit: true });
      return needsLookup ? convertEdit(payload, () => this.fetchReply().catch(() => null)) : modernize(payload, { edit: true });
    });
  }
  for (const proto of [MessageComponentInteraction.prototype, ModalSubmitInteraction.prototype]) {
    wrap(proto, 'update', function convert(payload) {
      return convertEdit(payload, async () => this.message);
    });
  }
  for (const proto of [BaseGuildTextChannel.prototype, ThreadChannel.prototype, BaseGuildVoiceChannel.prototype, DMChannel.prototype]) {
    wrap(proto, 'send', send);
  }
  wrap(Message.prototype, 'edit', function convert(payload) {
    return convertEdit(payload, async () => this);
  });
}

// Pulls the visible text out of a card, for transcripts and logs.
function textOf(message) {
  const parts = [];
  const walk = (c) => {
    if (c.type === ComponentType.TextDisplay) parts.push(c.content);
    for (const child of c.components ?? []) walk(child);
  };
  (message.components ?? []).forEach((c) => walk(c.toJSON ? c.toJSON() : c));
  return parts.join('\n');
}

module.exports = { install, modernize, restyle, finishCard, textOf, V2 };

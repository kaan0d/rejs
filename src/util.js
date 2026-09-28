const { ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags, parseEmoji } = require('discord.js');

// Info embeds use the brand color; success, warning and error keep green, orange and red.
const BRAND = 0x2B2D31;

const ephemeral = (content) => ({ content, flags: MessageFlags.Ephemeral });

const UNITS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 };

// "90s", "10m", "1h30m", "2d" -> milliseconds. Returns null when it can't read it.
function parseDuration(text) {
  const clean = String(text).toLowerCase().replace(/\s+/g, '');
  if (!/^(\d+[smhdw])+$/.test(clean)) return null;
  let ms = 0;
  for (const [, n, unit] of clean.matchAll(/(\d+)([smhdw])/g)) ms += Number(n) * UNITS[unit];
  return ms || null;
}

// Asks the invoker to confirm with buttons. Resolves to the button interaction, or null on cancel/timeout.
async function confirm(i, content, label) {
  const components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('confirm').setLabel(label).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('cancel').setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  )];
  const send = i.deferred || i.replied ? i.editReply({ content, components }) : i.reply({ content, components, flags: MessageFlags.Ephemeral });
  const response = await send;
  try {
    const button = await response.awaitMessageComponent({ time: 30_000, filter: (b) => b.user.id === i.user.id });
    if (button.customId === 'confirm') return button;
    await button.update({ content: 'Cancelled. Nothing changed.', components: [] });
  } catch {
    await i.editReply({ content: 'Timed out. Nothing changed.', components: [] });
  }
  return null;
}

// Turns what someone typed into an emoji for buttons and menus, or null when it isn't one.
// Accepts a server emoji (<:name:id>) or a normal emoji; shortcodes like :smile: don't work here.
function toEmoji(text) {
  const value = text?.trim();
  if (!value) return null;
  const custom = parseEmoji(value);
  if (custom?.id) return { id: custom.id, name: custom.name, animated: custom.animated };
  return /^(\p{Extended_Pictographic}|\p{Regional_Indicator}|[0-9#*]️?⃣)/u.test(value) ? { name: value } : null;
}

module.exports = { BRAND, ephemeral, parseDuration, confirm, toEmoji };

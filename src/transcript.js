// Builds a standalone HTML page of a ticket conversation.
const { textOf } = require('./ui');

const escape = (text) => String(text ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

// Bold, italics, inline code and links: enough to keep messages readable.
const format = (text) => escape(text)
  .replace(/```([\s\S]*?)```/g, '<pre>$1</pre>')
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  .replace(/\*([^*]+)\*/g, '<i>$1</i>')
  .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')
  .replaceAll('\n', '<br>');

function messageHtml(m) {
  const parts = [];
  const text = m.content || textOf(m);
  if (text) parts.push(`<div class="text">${format(text)}</div>`);
  for (const e of m.embeds) {
    const body = [e.title && `<b>${escape(e.title)}</b>`, e.description && format(e.description)].filter(Boolean).join('<br>');
    if (body) parts.push(`<div class="embed">${body}</div>`);
  }
  for (const a of m.attachments.values()) parts.push(`<div class="file"><a href="${escape(a.url)}">${escape(a.name)}</a></div>`);
  return `<div class="msg">
  <img class="avatar" src="${escape(m.author.displayAvatarURL({ size: 64 }))}" alt="">
  <div><div class="head"><span class="name${m.author.bot ? ' bot' : ''}">${escape(m.author.displayName ?? m.author.username)}</span>
  <span class="time">${new Date(m.createdTimestamp).toISOString().replace('T', ' ').slice(0, 16)} UTC</span></div>
  ${parts.join('\n  ') || '<div class="text muted">(no text)</div>'}</div>
</div>`;
}

function transcriptHtml({ title, subtitle, messages }) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  body { margin: 0; background: #313338; color: #dbdee1; font: 15px/1.4 system-ui, sans-serif; }
  header { padding: 16px 20px; background: #2b2d31; border-bottom: 1px solid #1e1f22; }
  header h1 { margin: 0; font-size: 18px; color: #f2f3f5; } header p { margin: 4px 0 0; color: #949ba4; }
  .msg { display: flex; gap: 12px; padding: 8px 20px; } .msg:hover { background: #2e3035; }
  .avatar { width: 40px; height: 40px; border-radius: 50%; flex: none; }
  .name { font-weight: 600; color: #f2f3f5; } .name.bot::after { content: "BOT"; margin-left: 6px; padding: 0 4px; font-size: 10px; background: #5865f2; color: #fff; border-radius: 3px; }
  .time { margin-left: 8px; font-size: 12px; color: #949ba4; }
  .embed { margin-top: 4px; padding: 8px 12px; border-left: 4px solid #1e1f22; background: #2b2d31; border-radius: 4px; }
  code, pre { background: #1e1f22; border-radius: 4px; padding: 2px 4px; } pre { padding: 8px; white-space: pre-wrap; }
  a { color: #00a8fc; } .muted { color: #949ba4; font-style: italic; }
</style></head>
<body><header><h1>${escape(title)}</h1><p>${escape(subtitle)}</p></header>
${messages.map(messageHtml).join('\n')}
</body></html>`;
}

// Reads a whole thread, oldest first, 100 messages per request.
async function fetchAll(channel) {
  const all = [];
  let before;
  for (;;) {
    const batch = await channel.messages.fetch({ limit: 100, before });
    all.push(...batch.values());
    if (batch.size < 100) break;
    before = batch.last().id;
  }
  return all.reverse();
}

module.exports = { transcriptHtml, fetchAll, escape };

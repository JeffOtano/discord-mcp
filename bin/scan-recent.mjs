#!/usr/bin/env node
// Zero-dependency CLI: dump recent Discord messages as JSON for downstream triage.
// Reads DISCORD_TOKEN from the environment. Requires Node 18+ (global fetch).
//
// Usage:
//   node bin/scan-recent.mjs [--hours 24] [--guild <name|id>] [--include-bots]
//
// Output (stdout): JSON { generatedAt, hours, guild, messageCount, skippedChannels, messages[] }
// Each message: { channelId, channel, threadOf, messageId, author, authorId, content,
//                 timestamp, url, attachments[] }

const API = "https://discord.com/api/v10";
const DISCORD_EPOCH = 1420070400000n;
const TEXT_TYPES = new Set([0, 5]); // GUILD_TEXT, GUILD_ANNOUNCEMENT

function parseArgs(argv) {
  const args = { hours: 24, guild: undefined, includeBots: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--hours") args.hours = Number(argv[++i]);
    else if (a === "--guild") args.guild = argv[++i];
    else if (a === "--include-bots") args.includeBots = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!Number.isFinite(args.hours) || args.hours <= 0) {
    throw new Error("--hours must be a positive number");
  }
  return args;
}

function snowflakeForMsAgo(hours) {
  const cutoffMs = BigInt(Date.now()) - BigInt(Math.round(hours * 3600_000));
  return String((cutoffMs - DISCORD_EPOCH) << 22n);
}

async function discord(token, path) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${API}${path}`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (res.status === 429) {
      const body = await res.json().catch(() => ({}));
      const waitMs = Math.ceil((body.retry_after ?? 1) * 1000) + 250;
      await new Promise((r) => setTimeout(r, waitMs));
      continue;
    }
    return res;
  }
  throw new Error(`Rate limited repeatedly on ${path}`);
}

async function resolveGuild(token, wanted) {
  const res = await discord(token, "/users/@me/guilds");
  if (!res.ok) throw new Error(`Failed to list guilds: ${res.status}`);
  const guilds = await res.json();
  if (guilds.length === 0) throw new Error("Bot is not in any guild");
  if (!wanted) {
    if (guilds.length === 1) return guilds[0];
    const names = guilds.map((g) => `"${g.name}"`).join(", ");
    throw new Error(`Bot is in multiple guilds; pass --guild. Available: ${names}`);
  }
  const w = wanted.toLowerCase();
  const match = guilds.find((g) => g.id === wanted || g.name.toLowerCase() === w);
  if (!match) {
    const names = guilds.map((g) => `"${g.name}"`).join(", ");
    throw new Error(`Guild "${wanted}" not found. Available: ${names}`);
  }
  return match;
}

async function listScannableChannels(token, guildId) {
  const chRes = await discord(token, `/guilds/${guildId}/channels`);
  if (!chRes.ok) throw new Error(`Failed to list channels: ${chRes.status}`);
  const channels = (await chRes.json())
    .filter((c) => TEXT_TYPES.has(c.type))
    .map((c) => ({ id: c.id, name: c.name, threadOf: undefined }));

  // Active threads (covers forum posts and in-channel threads) in one call.
  const thRes = await discord(token, `/guilds/${guildId}/threads/active`);
  if (thRes.ok) {
    const { threads = [] } = await thRes.json();
    const parentName = new Map(channels.map((c) => [c.id, c.name]));
    for (const t of threads) {
      channels.push({
        id: t.id,
        name: t.name,
        threadOf: parentName.get(t.parent_id) ?? t.parent_id,
      });
    }
  }
  return channels;
}

async function fetchSince(token, channel, sinceSnowflake, guildId, includeBots) {
  const collected = [];
  const sinceId = BigInt(sinceSnowflake);
  let before;
  // Walk newest-first with `before`, stopping once we cross the cutoff. This
  // guarantees recent messages are never starved by an old high-volume burst
  // (e.g. a runaway notification loop) that would otherwise eat a forward cap.
  for (let page = 0; page < 200; page++) {
    const res = await discord(
      token,
      `/channels/${channel.id}/messages?limit=100${before ? `&before=${before}` : ""}`,
    );
    if (res.status === 403) return { messages: [], skipped: true };
    if (!res.ok) return { messages: collected, skipped: false };
    const batch = await res.json();
    if (!Array.isArray(batch) || batch.length === 0) break;

    let reachedCutoff = false;
    for (const m of batch) {
      if (BigInt(m.id) <= sinceId) {
        reachedCutoff = true;
        continue;
      }
      if (!includeBots && m.author?.bot) continue;
      collected.push({
        channelId: channel.id,
        channel: channel.threadOf ? `${channel.threadOf} › ${channel.name}` : channel.name,
        threadOf: channel.threadOf,
        messageId: m.id,
        author: m.author?.username ?? "unknown",
        authorId: m.author?.id,
        isBot: Boolean(m.author?.bot),
        content: m.content,
        timestamp: m.timestamp,
        url: `https://discord.com/channels/${guildId}/${channel.id}/${m.id}`,
        attachments: (m.attachments ?? []).map((a) => ({ name: a.filename, url: a.url })),
        embeds: (m.embeds ?? []).map((e) => ({
          title: e.title ?? undefined,
          description: e.description ?? undefined,
          url: e.url ?? undefined,
          fields: (e.fields ?? []).map((f) => ({ name: f.name, value: f.value })),
        })),
      });
    }
    before = batch[batch.length - 1].id; // oldest id in this batch
    if (reachedCutoff || batch.length < 100) break;
  }
  return { messages: collected, skipped: false };
}

async function main() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error("Error: DISCORD_TOKEN environment variable is not set");
    process.exit(1);
  }
  const { hours, guild: wantedGuild, includeBots } = parseArgs(process.argv.slice(2));
  const guild = await resolveGuild(token, wantedGuild);
  const after = snowflakeForMsAgo(hours);
  const channels = await listScannableChannels(token, guild.id);

  const messages = [];
  const skippedChannels = [];
  for (const channel of channels) {
    const { messages: msgs, skipped } = await fetchSince(
      token,
      channel,
      after,
      guild.id,
      includeBots,
    );
    if (skipped) skippedChannels.push(channel.name);
    messages.push(...msgs);
  }
  messages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  process.stdout.write(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        hours,
        guild: { id: guild.id, name: guild.name },
        messageCount: messages.length,
        skippedChannels,
        messages,
      },
      null,
      2,
    ) + "\n",
  );
}

main().catch((err) => {
  console.error(`scan-recent failed: ${err.message}`);
  process.exit(1);
});

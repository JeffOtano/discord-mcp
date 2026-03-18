#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  Client,
  GatewayIntentBits,
  TextChannel,
  ThreadChannel,
  ChannelType,
  type Guild,
  type Message,
} from "discord.js";
import { z } from "zod";

// --- Discord client ---

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// --- Helpers ---

function formatMessage(msg: Message) {
  return {
    id: msg.id,
    author: msg.author.tag,
    content: msg.content,
    timestamp: msg.createdAt.toISOString(),
    attachments: msg.attachments.size > 0
      ? Array.from(msg.attachments.values()).map((a) => ({
          name: a.name,
          url: a.url,
          type: a.contentType,
        }))
      : undefined,
    embeds: msg.embeds.length > 0
      ? msg.embeds.map((e) => ({
          title: e.title,
          description: e.description,
          url: e.url,
        }))
      : undefined,
    threadId: msg.thread?.id,
    replyTo: msg.reference?.messageId,
  };
}

async function resolveGuild(identifier?: string): Promise<Guild> {
  if (!identifier) {
    if (client.guilds.cache.size === 1) {
      return client.guilds.cache.first()!;
    }
    const names = client.guilds.cache.map((g) => `"${g.name}"`).join(", ");
    throw new Error(
      `Bot is in multiple servers. Specify a server. Available: ${names}`
    );
  }

  // Try ID first, then name
  try {
    return await client.guilds.fetch(identifier);
  } catch {
    const match = client.guilds.cache.find(
      (g) => g.name.toLowerCase() === identifier.toLowerCase()
    );
    if (match) return match;

    const names = client.guilds.cache.map((g) => `"${g.name}"`).join(", ");
    throw new Error(
      `Server "${identifier}" not found. Available: ${names}`
    );
  }
}

async function resolveChannel(
  channelId: string,
  serverId?: string
): Promise<TextChannel> {
  const guild = await resolveGuild(serverId);

  // Try ID
  try {
    const ch = await client.channels.fetch(channelId);
    if (ch instanceof TextChannel && ch.guild.id === guild.id) return ch;
  } catch {
    // Fall through to name search
  }

  // Search by name
  const name = channelId.toLowerCase().replace(/^#/, "");
  const matches = guild.channels.cache.filter(
    (c): c is TextChannel =>
      c instanceof TextChannel && c.name.toLowerCase() === name
  );

  if (matches.size === 0) {
    const available = guild.channels.cache
      .filter((c): c is TextChannel => c instanceof TextChannel)
      .map((c) => `#${c.name}`)
      .join(", ");
    throw new Error(
      `Channel "${channelId}" not found in "${guild.name}". Available: ${available}`
    );
  }

  return matches.first()!;
}

// --- Schemas ---

const ListChannelsSchema = z.object({
  server: z
    .string()
    .optional()
    .describe("Server name or ID (optional if bot is only in one server)"),
});

const ReadMessagesSchema = z.object({
  server: z
    .string()
    .optional()
    .describe("Server name or ID (optional if bot is only in one server)"),
  channel: z.string().describe('Channel name (e.g., "general") or ID'),
  limit: z
    .number()
    .min(1)
    .max(100)
    .default(50)
    .describe("Number of messages to fetch (1-100, default 50)"),
  before: z
    .string()
    .optional()
    .describe("Fetch messages before this message ID (for pagination)"),
  after: z
    .string()
    .optional()
    .describe("Fetch messages after this message ID (for pagination)"),
});

const SearchMessagesSchema = z.object({
  server: z
    .string()
    .optional()
    .describe("Server name or ID (optional if bot is only in one server)"),
  channel: z.string().describe('Channel name (e.g., "general") or ID'),
  query: z.string().describe("Text to search for (case-insensitive)"),
  limit: z
    .number()
    .min(1)
    .max(100)
    .default(50)
    .describe("Max messages to scan (1-100, default 50)"),
});

const ReadThreadSchema = z.object({
  server: z
    .string()
    .optional()
    .describe("Server name or ID (optional if bot is only in one server)"),
  channel: z.string().describe("Parent channel name or ID"),
  threadId: z.string().describe("Thread ID or name"),
  limit: z
    .number()
    .min(1)
    .max(100)
    .default(50)
    .describe("Number of messages to fetch (1-100, default 50)"),
});

const SendMessageSchema = z.object({
  server: z
    .string()
    .optional()
    .describe("Server name or ID (optional if bot is only in one server)"),
  channel: z.string().describe('Channel name (e.g., "general") or ID'),
  message: z.string().describe("Message content to send"),
  replyTo: z
    .string()
    .optional()
    .describe("Message ID to reply to (creates a threaded reply)"),
});

// --- MCP Server ---

const server = new Server(
  { name: "discord-mcp", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "list-channels",
      description:
        "List all text channels in a Discord server. Use this first to discover available channels.",
      inputSchema: {
        type: "object" as const,
        properties: {
          server: {
            type: "string",
            description:
              "Server name or ID (optional if bot is only in one server)",
          },
        },
      },
    },
    {
      name: "read-messages",
      description:
        "Read recent messages from a Discord channel. Supports pagination with before/after message IDs.",
      inputSchema: {
        type: "object" as const,
        properties: {
          server: {
            type: "string",
            description:
              "Server name or ID (optional if bot is only in one server)",
          },
          channel: {
            type: "string",
            description: 'Channel name (e.g., "general") or ID',
          },
          limit: {
            type: "number",
            description: "Number of messages to fetch (1-100, default 50)",
          },
          before: {
            type: "string",
            description: "Fetch messages before this message ID (pagination)",
          },
          after: {
            type: "string",
            description: "Fetch messages after this message ID (pagination)",
          },
        },
        required: ["channel"],
      },
    },
    {
      name: "search-messages",
      description:
        "Search for messages containing specific text in a Discord channel. Useful for finding error reports, feedback, or specific topics.",
      inputSchema: {
        type: "object" as const,
        properties: {
          server: {
            type: "string",
            description:
              "Server name or ID (optional if bot is only in one server)",
          },
          channel: {
            type: "string",
            description: 'Channel name (e.g., "general") or ID',
          },
          query: {
            type: "string",
            description: "Text to search for (case-insensitive)",
          },
          limit: {
            type: "number",
            description: "Max messages to scan (1-100, default 50)",
          },
        },
        required: ["channel", "query"],
      },
    },
    {
      name: "read-thread",
      description:
        "Read messages from a thread in a Discord channel. Useful for following conversations.",
      inputSchema: {
        type: "object" as const,
        properties: {
          server: {
            type: "string",
            description:
              "Server name or ID (optional if bot is only in one server)",
          },
          channel: {
            type: "string",
            description: "Parent channel name or ID",
          },
          threadId: {
            type: "string",
            description: "Thread ID or name",
          },
          limit: {
            type: "number",
            description: "Number of messages to fetch (1-100, default 50)",
          },
        },
        required: ["channel", "threadId"],
      },
    },
    {
      name: "send-message",
      description:
        "Send a message to a Discord channel. Can reply to a specific message.",
      inputSchema: {
        type: "object" as const,
        properties: {
          server: {
            type: "string",
            description:
              "Server name or ID (optional if bot is only in one server)",
          },
          channel: {
            type: "string",
            description: 'Channel name (e.g., "general") or ID',
          },
          message: {
            type: "string",
            description: "Message content to send",
          },
          replyTo: {
            type: "string",
            description: "Message ID to reply to",
          },
        },
        required: ["channel", "message"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "list-channels": {
        const { server: serverId } = ListChannelsSchema.parse(args);
        const guild = await resolveGuild(serverId);

        const channels = guild.channels.cache
          .filter(
            (c) =>
              c.type === ChannelType.GuildText ||
              c.type === ChannelType.GuildAnnouncement
          )
          .sort((a, b) => a.position - b.position)
          .map((c) => ({
            name: `#${c.name}`,
            id: c.id,
            type: c.type === ChannelType.GuildAnnouncement ? "announcement" : "text",
            topic: "topic" in c ? (c.topic ?? undefined) : undefined,
          }));

        return {
          content: [
            {
              type: "text",
              text: `Channels in "${guild.name}":\n${JSON.stringify(channels, null, 2)}`,
            },
          ],
        };
      }

      case "read-messages": {
        const {
          server: serverId,
          channel: channelId,
          limit,
          before,
          after,
        } = ReadMessagesSchema.parse(args);
        const channel = await resolveChannel(channelId, serverId);

        const fetchOptions: { limit: number; before?: string; after?: string } =
          { limit };
        if (before) fetchOptions.before = before;
        if (after) fetchOptions.after = after;

        const messages = await channel.messages.fetch(fetchOptions);
        const formatted = Array.from(messages.values())
          .reverse() // chronological order
          .map(formatMessage);

        return {
          content: [
            {
              type: "text",
              text: `${formatted.length} messages from #${channel.name} in "${channel.guild.name}":\n${JSON.stringify(formatted, null, 2)}`,
            },
          ],
        };
      }

      case "search-messages": {
        const {
          server: serverId,
          channel: channelId,
          query,
          limit,
        } = SearchMessagesSchema.parse(args);
        const channel = await resolveChannel(channelId, serverId);

        const messages = await channel.messages.fetch({ limit });
        const q = query.toLowerCase();
        const matches = Array.from(messages.values())
          .filter((m) => m.content.toLowerCase().includes(q))
          .reverse()
          .map(formatMessage);

        return {
          content: [
            {
              type: "text",
              text: `Found ${matches.length} messages matching "${query}" in #${channel.name}:\n${JSON.stringify(matches, null, 2)}`,
            },
          ],
        };
      }

      case "read-thread": {
        const {
          server: serverId,
          channel: channelId,
          threadId,
          limit,
        } = ReadThreadSchema.parse(args);
        const channel = await resolveChannel(channelId, serverId);

        // Try ID first, then name
        let thread: ThreadChannel | undefined;
        try {
          const fetched = await channel.threads.fetch(threadId);
          if (fetched instanceof ThreadChannel) {
            thread = fetched;
          }
        } catch {
          // Search by name in active threads
          const active = await channel.threads.fetchActive();
          thread = active.threads.find(
            (t) => t.name.toLowerCase() === threadId.toLowerCase()
          );

          if (!thread) {
            // Check archived threads
            const archived = await channel.threads.fetchArchived();
            thread = archived.threads.find(
              (t) => t.name.toLowerCase() === threadId.toLowerCase()
            );
          }
        }

        if (!thread) {
          throw new Error(
            `Thread "${threadId}" not found in #${channel.name}`
          );
        }

        const messages = await thread.messages.fetch({ limit });
        const formatted = Array.from(messages.values())
          .reverse()
          .map(formatMessage);

        return {
          content: [
            {
              type: "text",
              text: `${formatted.length} messages from thread "${thread.name}" in #${channel.name}:\n${JSON.stringify(formatted, null, 2)}`,
            },
          ],
        };
      }

      case "send-message": {
        const {
          server: serverId,
          channel: channelId,
          message,
          replyTo,
        } = SendMessageSchema.parse(args);
        const channel = await resolveChannel(channelId, serverId);

        const options = replyTo
          ? { content: message, reply: { messageReference: replyTo } }
          : { content: message };

        const sent = await channel.send(options);
        return {
          content: [
            {
              type: "text",
              text: `Message sent to #${channel.name} in "${channel.guild.name}". ID: ${sent.id}`,
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(
        `Invalid arguments: ${error.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ")}`
      );
    }
    throw error;
  }
});

// --- Startup ---

async function main() {
  const token = process.env.DISCORD_TOKEN;
  if (!token) {
    console.error("Error: DISCORD_TOKEN environment variable is not set");
    console.error("Set it in your MCP config or export it in your shell.");
    process.exit(1);
  }

  await client.login(token);
  console.error("Discord bot connected");

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Discord MCP server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});

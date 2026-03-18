# discord-mcp

A Discord MCP (Model Context Protocol) server that lets Claude read and interact with Discord channels. Built for monitoring feedback, errors, and conversations.

## Tools

| Tool | Description |
|------|-------------|
| `list-channels` | List all text channels in a server |
| `read-messages` | Read recent messages with pagination (before/after) |
| `search-messages` | Search for messages by keyword |
| `read-thread` | Read messages from a thread |
| `send-message` | Send a message (with optional reply-to) |

## Setup

### 1. Create a Discord Bot

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Create a new application
3. Go to **Bot** tab, click **Reset Token**, copy it
4. Enable **Message Content Intent** under Privileged Gateway Intents
5. Go to **OAuth2 > URL Generator**, select `bot` scope with `Read Message History` and `Send Messages` permissions
6. Use the generated URL to invite the bot to your server

### 2. Install

```bash
git clone https://github.com/JeffOtano/discord-mcp.git
cd discord-mcp
npm install
npm run build
```

### 3. Configure Claude Code

Add to your Claude Code MCP settings (`~/.claude/settings.json` or project `.mcp.json`):

```json
{
  "mcpServers": {
    "discord": {
      "command": "node",
      "args": ["/path/to/discord-mcp/build/index.js"],
      "env": {
        "DISCORD_TOKEN": "your_bot_token_here"
      }
    }
  }
}
```

## Usage Examples

```
"List the channels in my Discord server"
"Read the last 20 messages from #feedback"
"Search for 'error' in #bug-reports"
"Read the thread about authentication issues in #support"
```

## License

MIT

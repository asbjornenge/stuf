# stuf-mcp

MCP server for [stuf](https://stufapp.net) — manage your tasks with AI.

## Setup

Add to your Claude Code config (`.claude/settings.local.json` or via CLI):

```bash
claude mcp add stuf -s project -- npx stuf-mcp
```

Or manually in settings:

```json
{
  "mcpServers": {
    "stuf": {
      "command": "npx",
      "args": ["stuf-mcp"]
    }
  }
}
```

## Pairing

On first use, call the `pair` tool. It opens a QR scanner in your browser:

1. Open stuf on your phone → Settings → Add Device
2. Scan the QR code in the browser
3. Call `pair_complete` to finish

Credentials are saved locally — you only need to pair once.

### Manual configuration

You can also configure via environment variables (skips pairing):

```json
{
  "mcpServers": {
    "stuf": {
      "command": "npx",
      "args": ["stuf-mcp"],
      "env": {
        "STUF_SERVER_URL": "https://your-sync-server",
        "STUF_DEVICE_TOKEN": "your-device-token",
        "STUF_ENCRYPTION_KEY": "your-base64-encryption-key"
      }
    }
  }
}
```

## Tools

| Tool | Description |
|---|---|
| `pair` | Start QR pairing flow |
| `pair_complete` | Complete pairing after scanning |
| `list_tasks` | List tasks (filter by status, tag, project) |
| `add_task` | Add a task with notes, checklist, tags |
| `update_task` | Update task name, notes, checklist, tags |
| `complete_task` | Mark a task as done |
| `delete_task` | Delete a task |
| `check_item` | Toggle a checklist item |
| `snooze_task` | Snooze a task until a date |
| `unsnooze_task` | Remove snooze |
| `set_reminder` | Set a push notification reminder |
| `clear_reminder` | Remove a reminder |
| `reorder_tasks` | Move a task to a new position |
| `move_to_project` | Move task to/from a project |
| `add_project` / `delete_project` | Manage projects |
| `add_tag` / `delete_tag` | Manage tags |
| `list_projects` / `list_tags` | List projects and tags |
| `upcoming` | Show snoozed tasks |

## License

MIT

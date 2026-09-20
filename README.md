# stꝋf

Open-source, offline-first to-do app with encrypted sync.

🔗 [stufapp.net](https://stufapp.net)

## Monorepo structure

| Package | Description |
|---|---|
| [`app/`](./app) | React + Vite frontend |
| [`sync/`](./sync) | Node.js sync backend |
| [`landing/`](./landing) | Marketing/landing page |
| [`mcp/`](./mcp) | MCP server for AI integration |

---

## Development

All services are configured via a single `.env` file at the root:

```bash
cp .env.example .env
# edit .env with your values
docker compose up
```

| Service | URL |
|---|---|
| app | http://localhost:5173 |
| sync | http://localhost:3000 |
| landing | http://localhost:5174 |

---

## app

React + Vite frontend.

| Script | Description |
|---|---|
| `npm run dev` | Start dev server |
| `npm run build` | Production build |
| `npm run preview` | Preview production build |

---

## sync

Node.js/Express backend with PostgreSQL.

| Script | Description |
|---|---|
| `npm start` | Start server |

**Modes** (set via `MODE` in `.env`):

| Mode | Description |
|---|---|
| `standalone` | Single space, single user — default for self-hosting |
| `multi` | Multiple spaces — set `PAYMENTS_ENABLED=true` to require Stripe payment per space |

**Change log housekeeping**

Clients push encrypted Automerge changes together with the change hash, and the server ignores duplicates. Pulls are paged (`?since=&limit=`), and a device that does not know the server state bootstraps from the space snapshot instead of the full log.

| Env | Default | Description |
|---|---|---|
| `COMPACT_AFTER_DAYS` | `0` (off) | Daily job deleting changes already contained in a space's snapshot once they are older than this many days |
| `PULL_PAGE_MAX` | `2000` | Upper bound for `limit` on paged pulls |

Manual one-off compaction of a single space (dry run without `--yes`):

```bash
DATABASE_URL=postgresql://... node scripts/compact-space.js <spaceId> [--grace-days N] [--yes]
```

It refuses unless the latest snapshot was pushed by an up-to-date client (which reports the exact change cursor the snapshot contains). Clients whose cursor predates compacted history get `410 history_compacted` and re-bootstrap from the snapshot, so update all devices before compacting.

---

## landing

Static marketing site built with Vite.

| Script | Description |
|---|---|
| `npm run dev` | Start dev server |
| `npm run build` | Production build |

---

## AI / MCP

stuf is AI-ready via [MCP](https://modelcontextprotocol.io). Let your AI assistant manage tasks, set reminders, and organize projects — synced to all your devices.

### Quick setup

```bash
claude mcp add stuf -- npx stuf-mcp
```

Then call the `pair` tool to connect via QR code from the stuf app.

### What it can do

- Add, update, complete, and delete tasks
- Manage checklists, notes, tags, and projects
- Snooze tasks and set push notification reminders
- Reorder and organize your task list

See [`mcp/README.md`](./mcp/README.md) for full documentation.

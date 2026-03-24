# stꝋf

Open-source, offline-first to-do app with encrypted sync.

🔗 [stufapp.net](https://stufapp.net)

## Monorepo structure

| Package | Description |
|---|---|
| [`app/`](./app) | React + Vite frontend |
| [`sync-server/`](./sync-server) | Node.js sync backend |
| [`landing/`](./landing) | Marketing/landing page |

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
| sync-server | http://localhost:3000 |
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

## sync-server

Node.js/Express backend with PostgreSQL.

| Script | Description |
|---|---|
| `npm start` | Start server |

---

## landing

Static marketing site built with Vite.

| Script | Description |
|---|---|
| `npm run dev` | Start dev server |
| `npm run build` | Production build |

# Study-AI-Agent

Telegram bot + website that turns a syllabus into a study plan.

- **Frontend** (`public/`) -> Vercel (static site)
- **Backend** (`src/`, Telegram bot + API) -> Railway (`npm start`)
- **Database** -> Neon Postgres

## Environment variables (Railway, or a local `.env`)

```
DATABASE_URL=postgresql://...      # Neon connection string
TELEGRAM_BOT_TOKEN=...
GEMINI_API_KEY=...
CLASS_LEVEL=10                     # optional
```

Tables are created automatically on first start.

## Run locally

```
npm install
npm start      # website + API on http://localhost:3001, bot polling
```

## Deploy

1. Railway: new project from this GitHub repo, add the variables above. Start command: `npm start`.
   Then Settings -> Networking -> Generate Domain.
2. Put that domain in `vercel.json` (replace `YOUR-APP.up.railway.app`).
3. Vercel: import the same repo. No build command needed.

Only run the bot in ONE place at a time (Railway or your PC), or Telegram will report a polling conflict.
The NotebookLM browser login only works when run on your own computer.

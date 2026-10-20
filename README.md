# Study-AI-Agent
Making An AI agent to automate studying stuff for me

## Run (JavaScript port)

Requires Node 20+.

```
npm install
npm start
```

Create a `.env` file in the project root:

```
TELEGRAM_BOT_TOKEN=...
GEMINI_API_KEY=...
CLASS_LEVEL=10        # optional
DATABASE_URL=postgresql://USER:PASSWORD@ep-xxxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require
```

The database is [Neon](https://neon.tech) Postgres. Tables are created automatically on first start.
To copy old data from `data/study_agent.db`, run `npm install --no-save better-sqlite3 && node scripts/migrate-sqlite-to-neon.js` once.

### Setup page

Pressing **Save Configuration** stores the Telegram id, Gemini keys and the `notebooklm-py` session
(`~/.notebooklm/storage_state.json`, from `notebooklm login`) in the `users` table.

### Public sign-in for NotebookLM (Browserbase)

Visitors sign in to Google inside a cloud Chrome shown on the setup page, so nothing runs on their computer.
Create a [Browserbase](https://www.browserbase.com) account and add to `.env`:

```
BROWSERBASE_API_KEY=...
BROWSERBASE_PROJECT_ID=...
BROWSERBASE_PROXIES=true        # residential proxies help Google accept the sign-in (paid plan); false to skip
BROWSERBASE_MAX_SESSIONS=3      # cloud browsers open at the same time (each one costs money)
```

Without these keys, sign-in opens Chrome on the computer running the server (localhost only) and public
visitors are asked to upload `storage_state.json` instead. The server must be a normal always-on Node
process (`npm start`), not Vercel serverless functions, because sign-ins are tracked in memory.

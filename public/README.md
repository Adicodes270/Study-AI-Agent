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
BROWSERBASE_API_KEY_BACKUP=...   # optional second account, used automatically if the first can't start a session
BROWSERBASE_PROJECT_ID_BACKUP=...
BROWSERBASE_PROXIES=true        # residential proxies help Google accept the sign-in (paid plan); false to skip
BROWSERBASE_MAX_SESSIONS=3      # cloud browsers open at the same time (each one costs money)
```

Without these keys, sign-in opens Chrome on the computer running the server (localhost only) and public
visitors are asked to upload `storage_state.json` instead. The server must be a normal always-on Node
process (`npm start`), not Vercel serverless functions, because sign-ins are tracked in memory.

### Chapter generation queue (`src/generationQueue.js`)

`POST /api/syllabus/upload` (sent by `quizzes.html`) parses the syllabus into an ordered chapter list, stores every
chapter as `Generating` in `chapter_generation`, and starts a per-user queue that handles **one chapter at a time**
with that user's saved Google session (`exportStorageStateFile`). `GET /api/generation/status?telegramUserId=…` lists statuses.

The NotebookLM integration plugs in with:

```js
import { registerChapterGenerator, completeChapter, failChapter } from "./generationQueue.js";
registerChapterGenerator(async ({ jobId, userId, chapter, sessionFile }) => {
  // ...do the NotebookLM work; return/resolve = Ready, throw/reject = Failed.
  // Or report explicitly: completeChapter({ jobId }, result) / failChapter({ jobId }, err, { retryAfter: "15 minutes" })
});
```

Events: `generationEvents.emit("report:completed" | "report:failed", { jobId, ... })`; listen to `chapter:started|completed|failed`, `queue:idle`.
Until a generator is registered, chapters simply stay `Generating`. Needs the long-running server (`npm start`), not serverless.

### NotebookLM service + NCERT fallback (`src/notebooklmService.js`)

`registerNotebookLmGenerator()` (called in `src/main.js`) plugs `createChapterNotebook()` into the queue. Per chapter it
creates a NotebookLM notebook with the user's saved Google session, tries to add the chapter's source URL, and if that
throws / is rejected / ends in an error status it downloads the matching NCERT PDF (via `findNcertChapter` in
`ncertCatalog.js`) to a temp file, uploads it to the same notebook and deletes the temp file. It then triggers the study
resources (audio overview, study guide, briefing doc, FAQ, timeline, flashcards, mind map, slide deck; infographics and
reports are never requested). Success stores `Ready` + `notebook_url` in `chapter_generation`; any unrecoverable error stores `Failed`.
Requires `pip install notebooklm-py` (override the interpreter with `NOTEBOOKLM_PYTHON`).

### `GET /api/resources`

Returns `{ "chapters": [{ "chapterName", "subject", "status", "description", "notebookUrl" }] }` for the user
(`?telegramUserId=…` or the `sa_telegram_id` cookie). `status` is `Ready`, `Generating`, `Failed` or `Pending`;
`notebookUrl` is only set when `Ready`. No syllabus yet → `200` with `chapters: []` and a `message`.

### If notebooks don't generate
The server (Railway) must have **Python 3 + `pip install notebooklm-py`**; a startup warning is logged if it's missing.
Chapters saved before the queue existed show `Pending`: press **Generate** / **Generate all missing** on the Resources page
(`POST /api/resources/start`). Failed cards show the reason and a **Retry** button.

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
```

### Setup page

Pressing **Save Configuration** stores the Telegram id, Gemini keys and the `notebooklm-py` session
(`~/.notebooklm/storage_state.json`, from `notebooklm login`) in the `users` table.

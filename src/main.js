// src/main.js
import "./tz.js"; // must be first: sets the process timezone to IST
import { runBot } from "./intake/telegramBot.js";
import { startWebServer } from "./webServer.js";
import { registerNotebookLmGenerator } from "./notebooklmService.js";

// 0. Chapter generation queue -> NotebookLM (+ NCERT fallback)
registerNotebookLmGenerator();

// 1. Start the website on http://localhost:3000
startWebServer(3000);

// 2. Start the Telegram bot polling
runBot();
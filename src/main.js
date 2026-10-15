// src/main.js
import { runBot } from "./intake/telegramBot.js";
import { startWebServer } from "./webServer.js";

// 1. Start the website on http://localhost:3000
startWebServer(3000);

// 2. Start the Telegram bot polling
runBot();
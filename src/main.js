// src/main.js  (this is what `npm start` runs, locally and on Railway)
import { runBot } from "./intake/telegramBot.js";
import { startWebServer } from "./webServer.js";

// Railway provides PORT; locally we use 3001
const port = Number(process.env.PORT) || 3001;

await startWebServer(port);
await runBot(); // Telegram bot (polling)

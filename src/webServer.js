// src/webServer.js
// Runs on Railway (or locally). Serves the JSON API; also serves /public so it works standalone in dev.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";
import { confirmLogin, getLoginStatus, startLogin, takeLoginEmail, takeLoginSession } from "./notebooklmLogin.js";
import { initDb } from "./db.js";
import { getKeys, getPairing, getSyllabus, removeKeys, saveKeys, sendWelcome, telegramBotInfo } from "./api.js";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const LOCAL_IPS = ["127.0.0.1", "::1", "::ffff:127.0.0.1"];

function readJson(req, limit = 5_000_000) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > limit) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

export async function startWebServer(port = 3000) {
  await initDb();
  const publicDir = path.join(ROOT, "public");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const send = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const reply = (r) => send(r.status, r.body);
    const parts = url.pathname.split("/").filter(Boolean); // ["api", "user-keys", "123"]

    try {
      // Health check (Railway uses this to know the app is up)
      if (url.pathname === "/api/health") return send(200, { ok: true });

      // NotebookLM login opens a browser window on the machine running this server, so it
      // only works when Study Agent runs on your own computer, never on Railway.
      if (url.pathname.startsWith("/api/notebooklm/login")) {
        const ip = req.socket.remoteAddress || "";
        if (!LOCAL_IPS.includes(ip)) {
          return send(403, { error: "NotebookLM login only works from the computer running Study Agent" });
        }
        if (req.method === "POST" && url.pathname === "/api/notebooklm/login") {
          return startLogin()
            .then((loginId) => send(200, { login_id: loginId }))
            .catch((e) => send(500, { error: e.message }));
        }
        if (req.method === "POST" && parts[4] === "confirm") return send(200, { ok: confirmLogin(parts[3] || "") });
        return send(200, getLoginStatus(parts[3] || ""));
      }

      // Gemini keys per Telegram user id
      if (parts[0] === "api" && parts[1] === "user-keys") {
        if (req.method === "POST" && parts.length === 2) {
          let body;
          try {
            body = await readJson(req);
          } catch (e) {
            return send(400, { error: e.message });
          }
          return reply(await saveKeys(body, { takeLoginSession, takeLoginEmail }));
        }
        if (req.method === "DELETE") return reply(await removeKeys(parts[2]));
        if (req.method === "GET") return reply(await getKeys(parts[2]));
        return send(405, { error: "Method not allowed" });
      }

      // GET /api/syllabus/:chatId
      if (parts[0] === "api" && parts[1] === "syllabus" && req.method === "GET") return reply(await getSyllabus(parts[2]));

      // Telegram helpers for the setup page (the bot token never leaves the server)
      if (parts[0] === "api" && parts[1] === "telegram") {
        if (req.method === "GET" && parts[2] === "bot") return reply(await telegramBotInfo());
        if (req.method === "GET" && parts[2] === "pairing") return reply(await getPairing(parts[3]));
        if (req.method === "POST" && parts[2] === "welcome") {
          let body;
          try {
            body = await readJson(req, 10_000);
          } catch (e) {
            return send(400, { error: e.message });
          }
          return reply(await sendWelcome(body));
        }
      }

      if (parts[0] === "api") return send(404, { error: "Not found" });

      // Static files from /public (defaults "/" to "/index.html")
      const safePath = path.normalize(url.pathname === "/" ? "/index.html" : url.pathname);
      const filePath = path.join(publicDir, safePath);
      if (!filePath.startsWith(publicDir)) {
        res.writeHead(403);
        return res.end("Forbidden");
      }
      fs.readFile(filePath, (err, content) => {
        if (err) {
          res.writeHead(err.code === "ENOENT" ? 404 : 500, { "Content-Type": "text/plain" });
          return res.end(err.code === "ENOENT" ? "404 Not Found" : "Server Error");
        }
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
        res.end(content);
      });
    } catch (e) {
      console.log(`Request error: ${e.message}`);
      if (!res.headersSent) send(500, { error: e.message });
    }
  });

  // 0.0.0.0 so Railway can reach it from outside the container
  server.listen(port, "0.0.0.0", () => {
    console.log(`🌐 API + website listening on port ${port}`);
  });
}

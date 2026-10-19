// src/webServer.js
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";
import { getLoginStatus, startLogin, takeLoginSession } from "./notebooklmLogin.js";
import { initDb, withDb } from "./db.js";
import { deleteUserKey, getUserKeys, getUserProfile, saveUserConfig } from "./intake/userKeys.js";

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

export function startWebServer(port = 3000) {
  initDb();
  const publicDir = path.join(ROOT, "public");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    // NotebookLM login: opens a browser window on this computer, captures the session, closes it
    if (url.pathname.startsWith("/api/notebooklm/login")) {
      const json = (code, body) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const ip = req.socket.remoteAddress || "";
      if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip)) {
        return json(403, { error: "NotebookLM login only works from the computer running Study Agent" });
      }
      if (req.method === "POST" && url.pathname === "/api/notebooklm/login") {
        return startLogin()
          .then((loginId) => json(200, { login_id: loginId }))
          .catch((e) => json(500, { error: e.message }));
      }
      return json(200, getLoginStatus(url.pathname.split("/")[4] || ""));
    }

    // Gemini keys per Telegram user id, written from public/setup.html
    if (url.pathname.startsWith("/api/user-keys")) {
      const json = (code, body) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const parseId = (v) => (/^\d+$/.test(String(v ?? "")) ? Number(v) : NaN);
      try {
        if (req.method === "POST") {
          let raw = "";
          req.on("data", (c) => {
            raw += c;
            if (raw.length > 5_000_000) req.destroy();
          });
          req.on("end", () => {
            try {
              const body = JSON.parse(raw || "{}");
              const id = parseId(body.telegram_user_id);
              if (Number.isNaN(id)) return json(400, { error: "Invalid Telegram user id" });
              const keys = Array.isArray(body.gemini_api_keys) ? body.gemini_api_keys : [];
              // NotebookLM session captured by the login window (held server-side until now)
              let notebooklmState = null;
              if (body.notebooklm_login_id) {
                notebooklmState = takeLoginSession(String(body.notebooklm_login_id));
                if (!notebooklmState) throw new Error("NotebookLM login not finished yet. Sign in first");
              }
              const rawEmail = typeof body.google_email === "string" ? body.google_email.trim().toLowerCase() : "";
              if (rawEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) throw new Error("That email address doesn't look valid");
              const saved = saveUserConfig(id, { keys, notebooklmState, email: rawEmail || null });
              if (!saved.keys && !saved.session && !saved.email) return json(400, { error: `Nothing valid to save: received ${keys.length} Gemini key(s), none accepted (20+ characters, no spaces), and no NotebookLM session` });
              json(200, { ok: true, telegram_user_id: id, keys_saved: saved.keys, session_saved: saved.session });
            } catch (e) {
              json(400, { error: e.message });
            }
          });
          return;
        }
        const id = parseId(url.pathname.split("/")[3]);
        if (Number.isNaN(id)) return json(400, { error: "Invalid Telegram user id" });
        if (req.method === "DELETE") return json(200, { ok: true, deleted: deleteUserKey(id) });
        // GET: never return the keys themselves, only a masked summary
        const keys = getUserKeys(id);
        const profile = getUserProfile(id);
        return json(200, { telegram_user_id: id, google_email: profile?.google_email || null, notebooklm_session_saved: Boolean(profile?.has_session), count: keys.length, masked: keys.map((k) => `AIza…${k.slice(-4)}`) });
      } catch (err) {
        return json(500, { error: err.message });
      }
    }

    // 1. API Route: GET /api/syllabus/:chatId
    if (url.pathname.startsWith("/api/syllabus/")) {
      const chatId = parseInt(url.pathname.split("/")[3], 10);
      if (Number.isNaN(chatId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Invalid chat ID" }));
      }

      try {
        const chapters = withDb((db) =>
          db
            .prepare(
              `SELECT subject, exam, number, title, match_status, pdf_url
               FROM syllabus_chapters
               WHERE chat_id = ?
               ORDER BY subject, number`
            )
            .all(chatId)
        );
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ chatId, chapters }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // 2. Serve Static Files from /public (defaults "/" to "/index.html")
    const safePath = path.normalize(url.pathname === "/" ? "/index.html" : url.pathname);
    const filePath = path.join(publicDir, safePath);

    // Prevent directory traversal outside /public
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
  });

  server.listen(port, () => {
    console.log(`🌐 Website live at: http://localhost:${port}`);
  });
}
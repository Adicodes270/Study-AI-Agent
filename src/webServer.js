// src/webServer.js
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";
import { cancelLogin, confirmLogin, getLoginStatus, remoteLoginEnabled, startLogin, startRemoteLogin, takeLoginEmail, takeLoginSession } from "./notebooklmLogin.js";
import { initDb, withDb } from "./db.js";
import {
  getPairing,
  quizChapters,
  quizGenerate,
  quizGenerateCustom,
  quizSaveProgress,
  quizSubmit,
  quizTranscribe,
  resourceGet,
  resourcesChapters,
  resourcesGenerate,
  sendWelcome,
  syllabusUpload,
  telegramBotInfo,
} from "./api.js";
import { deleteUserKey, getUserKeys, getUserProfile, inspectStorageState, saveUserConfig } from "./intake/userKeys.js";
import { classifyGranularSubject } from "./intake/syllabusParser.js";

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

const loginStartedAt = new Map(); // client ip -> last time a cloud sign-in was started

// Pairing codes are only 4 digits, so cap how fast one address can try them (per minute)
const tgHits = new Map();
function tgRateLimited(ip, max) {
  const minute = Math.floor(Date.now() / 60_000);
  const rec = tgHits.get(ip);
  if (!rec || rec.minute !== minute) { tgHits.set(ip, { minute, n: 1 }); return false; }
  if (tgHits.size > 5000) tgHits.clear();
  return ++rec.n > max;
}

function parseCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 1) continue;
    try {
      cookies[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {}
  }
  return cookies;
}

export function startWebServer(port = 3000) {
  initDb().catch((e) => console.log(`Database init failed: ${e.message}`));
  const publicDir = path.join(ROOT, "public");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    const ip = req.socket.remoteAddress || "";
    const isLocal = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip);
    // Behind a proxy (Render, Railway, ...) the real visitor is in x-forwarded-for
    const clientIp = String(req.headers["x-forwarded-for"] || ip).split(",")[0].trim();

    // Which NotebookLM sign-in this server offers: cloud browser (Browserbase), Chrome on this computer, or neither
    if (url.pathname === "/api/notebooklm/mode") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ mode: remoteLoginEnabled() ? "remote" : isLocal ? "local" : "upload" }));
    }

    // NotebookLM login: a cloud browser shown in the page, or (localhost only) a Chrome window on this computer
    if (url.pathname.startsWith("/api/notebooklm/login")) {
      const json = (code, body) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      const remote = remoteLoginEnabled();
      if (!remote && !isLocal) {
        return json(403, { error: "Browser sign-in is only available on the computer running Study Agent. Upload your NotebookLM storage_state.json instead." });
      }
      if (req.method === "POST" && url.pathname === "/api/notebooklm/login") {
        if (remote) {
          const last = loginStartedAt.get(clientIp) || 0;
          if (Date.now() - last < 15_000) return json(429, { error: "Please wait a few seconds before trying again" });
          loginStartedAt.set(clientIp, Date.now());
          return startRemoteLogin()
            .then(({ loginId, liveViewUrl }) => json(200, { login_id: loginId, live_view_url: liveViewUrl }))
            .catch((e) => json(500, { error: e.message }));
        }
        return startLogin()
          .then((loginId) => json(200, { login_id: loginId }))
          .catch((e) => json(500, { error: e.message }));
      }
      const parts = url.pathname.split("/");
      if (req.method === "POST" && parts[5] === "confirm") return json(200, { ok: confirmLogin(parts[4] || "") });
      if (req.method === "POST" && parts[5] === "cancel") return json(200, { ok: cancelLogin(parts[4] || "") });
      return json(200, getLoginStatus(parts[4] || ""));
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
          req.on("end", async () => {
            try {
              const body = JSON.parse(raw || "{}");
              const id = parseId(body.telegram_user_id);
              if (Number.isNaN(id)) return json(400, { error: "Invalid Telegram user id" });
              const keys = Array.isArray(body.gemini_api_keys) ? body.gemini_api_keys : [];
              let notebooklmState = null;
              let loginEmail = null;
              if (!body.notebooklm_login_id && body.notebooklm_storage_state) {
                let st = body.notebooklm_storage_state;
                if (typeof st === "string") { try { st = JSON.parse(st); } catch { throw new Error("That storage_state.json is not valid JSON"); } }
                inspectStorageState(st);
                notebooklmState = st;
              }
              if (body.notebooklm_login_id) {
                notebooklmState = takeLoginSession(String(body.notebooklm_login_id));
                if (!notebooklmState) throw new Error("NotebookLM login not finished yet. Sign in first");
                loginEmail = takeLoginEmail(String(body.notebooklm_login_id));
              }
              const rawEmail = loginEmail || (typeof body.google_email === "string" ? body.google_email.trim().toLowerCase() : "");
              if (rawEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) throw new Error("That email address doesn't look valid");
              const saved = await saveUserConfig(id, { keys, notebooklmState, email: rawEmail || null });
              if (!saved.keys && !saved.session && !saved.email) return json(400, { error: `Nothing valid to save: received ${keys.length} Gemini key(s), none accepted (20+ characters, no spaces), and no NotebookLM session` });
              json(200, { ok: true, telegram_user_id: id, keys_saved: saved.keys, session_saved: saved.session, email_saved: saved.email, google_email: rawEmail || null });
            } catch (e) {
              json(400, { error: e.message });
            }
          });
          return;
        }
        const id = parseId(url.pathname.split("/")[3]);
        if (Number.isNaN(id)) return json(400, { error: "Invalid Telegram user id" });
        if (req.method === "DELETE") return json(200, { ok: true, deleted: await deleteUserKey(id) });
        const keys = await getUserKeys(id);
        const profile = await getUserProfile(id);
        return json(200, { telegram_user_id: id, google_email: profile?.google_email || null, notebooklm_session_saved: Boolean(profile?.has_session), count: keys.length, masked: keys.map((k) => `AIza…${k.slice(-4)}`) });
      } catch (err) {
        return json(500, { error: err.message });
      }
    }

    // Telegram helpers for the setup page
    if (url.pathname.startsWith("/api/telegram/")) {
      const send = ({ status, body }) => {
        res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(body));
      };
      const parts = url.pathname.replace(/\/+$/, "").split("/");
      if (req.method === "GET" && parts[3] === "bot" && parts.length === 4) return telegramBotInfo().then(send);
      if (req.method === "GET" && parts[3] === "pairing" && parts.length === 5) {
        if (tgRateLimited(clientIp, 90)) return send({ status: 429, body: { error: "Too many requests. Wait a minute." } });
        return getPairing(parts[4]).then(send);
      }
      if (req.method === "POST" && parts[3] === "welcome" && parts.length === 4) {
        if (tgRateLimited(clientIp + "|w", 6)) return send({ status: 429, body: { error: "Too many requests. Wait a minute." } });
        let raw = "";
        req.on("data", (c) => { raw += c; if (raw.length > 10_000) req.destroy(); });
        req.on("end", () => {
          let body;
          try { body = JSON.parse(raw || "{}"); } catch { return send({ status: 400, body: { error: "Invalid JSON" } }); }
          sendWelcome(body).then(send);
        });
        return;
      }
      return send({ status: 404, body: { error: "Not found" } });
    }

    // Quizzes: GET /api/quizzes/chapters, POST /api/quizzes/generate, POST /api/quizzes/progress, POST /api/quizzes/generate-custom, POST /api/quizzes/submit, POST /api/quizzes/transcribe
    if (url.pathname.startsWith("/api/quizzes/")) {
      const send = ({ status, body }) => {
        res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(body));
      };
      const ctx = { cookies: parseCookies(req) };
      const route = url.pathname.replace(/\/+$/, "");
      if (req.method === "GET" && route === "/api/quizzes/chapters") {
        return quizChapters(Object.fromEntries(url.searchParams), ctx).then(send);
      }
      if (req.method === "POST" && (route === "/api/quizzes/generate-custom" || route === "/api/quizzes/transcribe")) {
        const LIMIT = 28 * 1024 * 1024;
        const chunks = [];
        let size = 0;
        req.on("data", (c) => {
          size += c.length;
          if (size <= LIMIT) chunks.push(c);
        });
        req.on("end", () => {
          if (size > LIMIT) return send({ status: 413, body: { error: "That payload is too big (20 MB max)." } });
          let body;
          try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return send({ status: 400, body: { error: "Invalid JSON" } }); }
          const handler = route.endsWith("transcribe") ? quizTranscribe : quizGenerateCustom;
          handler(body, ctx).then(send);
        });
        return;
      }
      if (
        req.method === "POST" &&
        (route === "/api/quizzes/generate" ||
          route === "/api/quizzes/submit" ||
          route === "/api/quizzes/progress")
      ) {
        let raw = "";
        let tooBig = false;
        req.on("data", (c) => {
          raw += c;
          if (raw.length > 500_000) { tooBig = true; req.destroy(); }
        });
        req.on("end", () => {
          if (tooBig) return;
          let body;
          try { body = JSON.parse(raw || "{}"); } catch { return send({ status: 400, body: { error: "Invalid JSON" } }); }
          const handler = route.endsWith("generate")
            ? quizGenerate
            : route.endsWith("progress")
              ? quizSaveProgress
              : quizSubmit;
          handler(body, ctx).then(send);
        });
        return;
      }
      return send({ status: 404, body: { error: "Not found" } });
    }

    // NotebookLM Resources: GET /api/resources/chapters, GET /api/resources/item, POST /api/resources/generate
    if (url.pathname.startsWith("/api/resources/")) {
      const send = ({ status, body }) => {
        res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(body));
      };
      const ctx = { cookies: parseCookies(req) };
      const route = url.pathname.replace(/\/+$/, "");
      if (req.method === "GET" && route === "/api/resources/chapters") {
        return resourcesChapters(Object.fromEntries(url.searchParams), ctx).then(send);
      }
      if (req.method === "GET" && route === "/api/resources/item") {
        return resourceGet(Object.fromEntries(url.searchParams), ctx).then(send);
      }
      if (req.method === "POST" && route === "/api/resources/generate") {
        let raw = "";
        let tooBig = false;
        req.on("data", (c) => {
          raw += c;
          if (raw.length > 500_000) { tooBig = true; req.destroy(); }
        });
        req.on("end", () => {
          if (tooBig) return send({ status: 413, body: { error: "Request payload too large" } });
          let body;
          try {
            body = JSON.parse(raw || "{}");
          } catch {
            return send({ status: 400, body: { error: "Invalid JSON" } });
          }
          resourcesGenerate(body, ctx).then(send);
        });
        return;
      }
      return send({ status: 404, body: { error: "Not found" } });
    }

    // POST /api/syllabus/upload
    if (req.method === "POST" && url.pathname.replace(/\/+$/, "") === "/api/syllabus/upload") {
      const send = ({ status, body }) => {
        res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify(body));
      };
      if (tgRateLimited(clientIp + "|su", 6)) return send({ status: 429, body: { error: "Too many uploads. Wait a minute." } });
      const cookies = parseCookies(req);
      const LIMIT = 28 * 1024 * 1024;
      const chunks = [];
      let size = 0;
      req.on("data", (c) => {
        size += c.length;
        if (size <= LIMIT) chunks.push(c);
      });
      req.on("end", () => {
        if (size > LIMIT) return send({ status: 413, body: { error: "That file is too big (20 MB max)." } });
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return send({ status: 400, body: { error: "Invalid JSON" } }); }
        syllabusUpload(body, { cookies }).then(send);
      });
      return;
    }

    // 1. API Route: GET /api/syllabus/:chatId
    if (url.pathname.startsWith("/api/syllabus/")) {
      const chatId = parseInt(url.pathname.split("/")[3], 10);
      if (Number.isNaN(chatId)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: "Invalid chat ID" }));
      }

      try {
        const chapters = await withDb(async (db) => {
          const { rows } = await db.query(
            `SELECT id, subject, exam, number, title, match_status, pdf_url, recommended_questions
             FROM syllabus_chapters
             WHERE chat_id = $1
             ORDER BY subject, number`,
            [chatId]
          );
          for (const r of rows) {
            const granular = classifyGranularSubject(r.subject, r.title, r.pdf_url, "", r.number);
            if (granular && granular !== r.subject) {
              r.subject = granular;
              await db.query("UPDATE syllabus_chapters SET subject = $1 WHERE id = $2", [granular, r.id]).catch(() => {});
            }
          }
          return rows;
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ chatId, chapters }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json" });
        return res.end(JSON.stringify({ error: err.message }));
      }
    }

    // 2. Serve Static Files from /public
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
  });

  server.listen(port, () => {
    console.log(`🌐 Website live at: http://localhost:${port}`);
  });
}
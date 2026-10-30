// src/webServer.js
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";
import {
  cancelLogin,
  confirmLogin,
  typeIntoLogin,
  getLoginStatus,
  remoteLoginEnabled,
  startLogin,
  startRemoteLogin,
  takeLoginEmail,
  takeLoginSession,
} from "./notebooklmLogin.js";
import { initDb } from "./db.js";
import {
  doubtAsk,
  generationStatus,
  getKeys,
  getPairing,
  getSyllabus,
  plannerGenerate,
  plannerState,
  plannerSyllabusSave,
  plannerSyncTodoist,
  plannerToggleTask,
  quizChapters,
  quizGenerate,
  quizGenerateCustom,
  quizSaveProgress,
  quizSubmit,
  quizTranscribe,
  removeKeys,
  resourceGet,
  resourcesChapters,
  resourcesGenerate,
  resourcesList,
  resourcesStart,
  reviewsCreate,
  reviewsList,
  saveKeys,
  sendWelcome,
  syllabusUpload,
  telegramBotInfo,
  todoistVerify,
} from "./api.js";
import { inspectStorageState } from "./intake/userKeys.js";
import { resumePendingGenerations, startAutoStartScheduler } from "./generationQueue.js";

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
  if (!rec || rec.minute !== minute) {
    tgHits.set(ip, { minute, n: 1 });
    return false;
  }
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

function readJsonBody(req, res, maxBytes = 1_000_000) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    let tooBig = false;
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        tooBig = true;
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on("end", () => {
      if (tooBig) {
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Request payload too large" }));
        return resolve(null);
      }
      try {
        const raw = Buffer.concat(chunks).toString("utf8") || "{}";
        resolve(JSON.parse(raw));
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        resolve(null);
      }
    });
  });
}

export function startWebServer(port = 3000) {
  initDb()
    .then(() => {
      startAutoStartScheduler(); // starts generation for users whose choose-what-to-generate window ran out
      return resumePendingGenerations();
    })
    .catch((e) => console.log(`Database init failed: ${e.message}`));
  const publicDir = path.join(ROOT, "public");

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const send = ({ status, body }) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };

    const ip = req.socket.remoteAddress || "";
    const isLocal = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(ip);
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
      if (req.method === "POST" && parts[5] === "type") {
        const body = await readJsonBody(req, res, 5_000);
        if (!body) return;
        return typeIntoLogin(parts[4] || "", body).then((ok) => json(200, { ok }));
      }
      if (req.method === "POST" && parts[5] === "cancel") return json(200, { ok: cancelLogin(parts[4] || "") });
      return json(200, getLoginStatus(parts[4] || ""));
    }

    // User keys (Gemini + Todoist + NotebookLM session), unified with src/api.js
    if (url.pathname.startsWith("/api/user-keys")) {
      if (req.method === "POST") {
        const body = await readJsonBody(req, res, 5_000_000);
        if (!body) return;
        const out = await saveKeys(body, {
          takeLoginSession,
          takeLoginEmail,
          inspectStorageState,
        });
        return send(out);
      }
      const idPart = url.pathname.split("/")[3];
      if (req.method === "DELETE") {
        return removeKeys(idPart).then(send);
      }
      return getKeys(idPart).then(send);
    }

    // Todoist key live/format verification endpoint: POST /api/todoist/verify
    if (url.pathname.replace(/\/+$/, "") === "/api/todoist/verify" && req.method === "POST") {
      const body = await readJsonBody(req, res, 100_000);
      if (!body) return;
      return todoistVerify(body, { cookies: parseCookies(req) }).then(send);
    }

    // AI Study Planner & Todoist integration endpoints: /api/planner/*
    if (url.pathname.startsWith("/api/planner/")) {
      const ctx = { cookies: parseCookies(req) };
      const route = url.pathname.replace(/\/+$/, "");

      if (req.method === "GET" && route === "/api/planner/state") {
        return plannerState(Object.fromEntries(url.searchParams), ctx).then(send);
      }
      if (req.method === "POST" && route === "/api/planner/syllabus") {
        const body = await readJsonBody(req, res, 28 * 1024 * 1024);
        if (!body) return;
        return plannerSyllabusSave(body, ctx).then(send);
      }
      if (req.method === "POST" && route === "/api/planner/generate") {
        const body = await readJsonBody(req, res, 2_000_000);
        if (!body) return;
        return plannerGenerate(body, ctx).then(send);
      }
      if (req.method === "POST" && route === "/api/planner/sync-todoist") {
        const body = await readJsonBody(req, res, 2_000_000);
        if (!body) return;
        return plannerSyncTodoist(body, ctx).then(send);
      }
      if (req.method === "POST" && route === "/api/planner/task-toggle") {
        const body = await readJsonBody(req, res, 200_000);
        if (!body) return;
        return plannerToggleTask(body, ctx).then(send);
      }
      return send({ status: 404, body: { error: "Planner endpoint not found" } });
    }

    // Telegram helpers for the setup page
    if (url.pathname.startsWith("/api/telegram/")) {
      const parts = url.pathname.replace(/\/+$/, "").split("/");
      if (req.method === "GET" && parts[3] === "bot" && parts.length === 4) return telegramBotInfo().then(send);
      if (req.method === "GET" && parts[3] === "pairing" && parts.length === 5) {
        if (tgRateLimited(clientIp, 90)) return send({ status: 429, body: { error: "Too many requests. Wait a minute." } });
        return getPairing(parts[4]).then(send);
      }
      if (req.method === "POST" && parts[3] === "welcome" && parts.length === 4) {
        if (tgRateLimited(clientIp + "|w", 6)) return send({ status: 429, body: { error: "Too many requests. Wait a minute." } });
        const body = await readJsonBody(req, res, 10_000);
        if (!body) return;
        return sendWelcome(body).then(send);
      }
      return send({ status: 404, body: { error: "Not found" } });
    }

    // Feedback & Reviews: GET /api/reviews, POST /api/reviews
    if (url.pathname.replace(/\/+$/, "") === "/api/reviews") {
      if (req.method === "GET") {
        return reviewsList().then(send);
      }
      if (req.method === "POST") {
        if (tgRateLimited(clientIp + "|rv", 10)) {
          return send({ status: 429, body: { error: "Too many reviews submitted. Wait a minute." } });
        }
        const body = await readJsonBody(req, res, 20_000);
        if (!body) return;
        return reviewsCreate(body).then(send);
      }
      return send({ status: 405, body: { error: "Method not allowed" } });
    }

    // Ask a doubt (AI chat popup on the Quizzes and Resources pages): POST /api/doubt/ask
    if (req.method === "POST" && url.pathname.replace(/\/+$/, "") === "/api/doubt/ask") {
      if (tgRateLimited(clientIp + "|d", 20)) return send({ status: 429, body: { error: "Too many questions. Wait a minute." } });
      const body = await readJsonBody(req, res, 60_000);
      if (!body) return;
      return doubtAsk(body, { cookies: parseCookies(req) }).then(send);
    }

    // Quizzes: GET /api/quizzes/chapters, POST /api/quizzes/generate, POST /api/quizzes/progress, POST /api/quizzes/generate-custom, POST /api/quizzes/submit, POST /api/quizzes/transcribe
    if (url.pathname.startsWith("/api/quizzes/")) {
      const ctx = { cookies: parseCookies(req) };
      const route = url.pathname.replace(/\/+$/, "");
      if (req.method === "GET" && route === "/api/quizzes/chapters") {
        return quizChapters(Object.fromEntries(url.searchParams), ctx).then(send);
      }
      if (req.method === "POST" && (route === "/api/quizzes/generate-custom" || route === "/api/quizzes/transcribe")) {
        const body = await readJsonBody(req, res, 28 * 1024 * 1024);
        if (!body) return;
        const handler = route.endsWith("transcribe") ? quizTranscribe : quizGenerateCustom;
        return handler(body, ctx).then(send);
      }
      if (
        req.method === "POST" &&
        (route === "/api/quizzes/generate" ||
          route === "/api/quizzes/submit" ||
          route === "/api/quizzes/progress")
      ) {
        const body = await readJsonBody(req, res, 500_000);
        if (!body) return;
        const handler = route.endsWith("generate")
          ? quizGenerate
          : route.endsWith("progress")
            ? quizSaveProgress
            : quizSubmit;
        return handler(body, ctx).then(send);
      }
      return send({ status: 404, body: { error: "Not found" } });
    }

    // NotebookLM Resources: GET /api/resources/chapters, GET /api/resources/item, POST /api/resources/generate
    if (url.pathname.startsWith("/api/resources/")) {
      const ctx = { cookies: parseCookies(req) };
      const route = url.pathname.replace(/\/+$/, "");
      if (req.method === "GET" && route === "/api/resources/chapters") {
        return resourcesChapters(Object.fromEntries(url.searchParams), ctx).then(send);
      }
      if (req.method === "GET" && route === "/api/resources/item") {
        return resourceGet(Object.fromEntries(url.searchParams), ctx).then(send);
      }
      if (req.method === "POST" && route === "/api/resources/start") {
        const body = await readJsonBody(req, res, 100_000);
        if (!body) return;
        return resourcesStart(body, ctx).then(send);
      }
      if (req.method === "POST" && route === "/api/resources/generate") {
        const body = await readJsonBody(req, res, 500_000);
        if (!body) return;
        return resourcesGenerate(body, ctx).then(send);
      }
      return send({ status: 404, body: { error: "Not found" } });
    }

    // GET /api/resources?telegramUserId=...
    if (req.method === "GET" && url.pathname.replace(/\/+$/, "") === "/api/resources") {
      return resourcesList(Object.fromEntries(url.searchParams), { cookies: parseCookies(req) }).then(send);
    }

    // GET /api/generation/status?telegramUserId=...
    if (req.method === "GET" && url.pathname.replace(/\/+$/, "") === "/api/generation/status") {
      return generationStatus(Object.fromEntries(url.searchParams), { cookies: parseCookies(req) }).then(send);
    }

    // POST /api/syllabus/upload
    if (req.method === "POST" && url.pathname.replace(/\/+$/, "") === "/api/syllabus/upload") {
      if (tgRateLimited(clientIp + "|su", 6)) return send({ status: 429, body: { error: "Too many uploads. Wait a minute." } });
      const cookies = parseCookies(req);
      const body = await readJsonBody(req, res, 28 * 1024 * 1024);
      if (!body) return;
      return syllabusUpload(body, { cookies }).then(send);
    }

    // GET /api/syllabus/:chatId
    if (url.pathname.startsWith("/api/syllabus/")) {
      const chatId = url.pathname.split("/")[3];
      return getSyllabus(chatId).then(send);
    }

    // Serve Static Files from /public (supporting clean URLs like /planner as well as /planner.html)
    let reqPath = url.pathname === "/" ? "/index.html" : url.pathname;
    if (!path.extname(reqPath) && !reqPath.endsWith("/")) {
      const htmlCandidate = path.join(publicDir, `${reqPath}.html`);
      if (fs.existsSync(htmlCandidate)) {
        reqPath = `${reqPath}.html`;
      }
    }
    const safePath = path.normalize(reqPath);
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
  return server;
}
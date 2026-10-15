// src/webServer.js
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { ROOT } from "./config.js";
import { withDb } from "./db.js";

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
  const publicDir = path.join(ROOT, "public");

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

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
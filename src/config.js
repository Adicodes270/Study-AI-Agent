import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// src/config.js -> project root is one level up
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env") });

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";

export const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
export const GEMINI_MODEL = (process.env.GEMINI_MODEL ?? "").trim() || "gemini-3.5-flash-lite";

const _class = (process.env.CLASS_LEVEL ?? "").trim();
export const DEFAULT_CLASS_LEVEL = /^\d+$/.test(_class) ? parseInt(_class, 10) : null;

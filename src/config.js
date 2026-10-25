import "./tz.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

// src/config.js -> project root is one level up
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env") });

export const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN ?? "";

// Neon connection string, e.g. postgresql://user:pass@ep-xxx-pooler.region.aws.neon.tech/neondb?sslmode=require
export const DATABASE_URL = (process.env.DATABASE_URL ?? "").trim();

export const GEMINI_API_KEY = process.env.GEMINI_API_KEY ?? "";
export const GEMINI_MODEL = (process.env.GEMINI_MODEL ?? "").trim() || "gemini-3.5-flash-lite";

// Optional fallback Todoist API key from .env
export const TODOIST_API_KEY = (process.env.TODOIST_API_KEY ?? "").trim();

// The student's class is NOT read from .env: each user picks it on the setup page (users.class_level).

// Browserbase: a cloud Chrome the user signs in to through the setup page (works on a public site).
// Leave the key empty to keep the old "open Chrome on this computer" sign-in for localhost.
export const BROWSERBASE_API_KEY = (process.env.BROWSERBASE_API_KEY ?? "").trim();
export const BROWSERBASE_PROJECT_ID = (process.env.BROWSERBASE_PROJECT_ID ?? "").trim();
// Optional second Browserbase account, used automatically when the first one can't start a session
// (out of free minutes, rate limited, key revoked, ...). Both values must be set for it to count.
export const BROWSERBASE_API_KEY_BACKUP = (process.env.BROWSERBASE_API_KEY_BACKUP ?? "").trim();
export const BROWSERBASE_PROJECT_ID_BACKUP = (process.env.BROWSERBASE_PROJECT_ID_BACKUP ?? "").trim();
// Residential proxies make Google far less likely to block the sign-in. They need a paid Browserbase plan;
// if the plan refuses them we automatically retry without. Set BROWSERBASE_PROXIES=false to skip them.
export const BROWSERBASE_PROXIES = (process.env.BROWSERBASE_PROXIES ?? "true").trim().toLowerCase() !== "false";
export const BROWSERBASE_REGION = (process.env.BROWSERBASE_REGION ?? "").trim(); // e.g. ap-southeast-1 (optional)
export const BROWSERBASE_MAX_SESSIONS = parseInt(process.env.BROWSERBASE_MAX_SESSIONS ?? "", 10) || 3;

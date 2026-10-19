// src/notebooklmLogin.js
// Opens a real browser window on THIS computer, lets the user sign in to Google / NotebookLM,
// captures the logged-in session automatically, and closes the window. The session is what
// notebooklm-py needs to act as that Google account. It is held here under a one-time id and
// written to the database when the user presses Save Configuration.
import crypto from "node:crypto";
import { inspectStorageState } from "./intake/userKeys.js";

const NOTEBOOKLM_URL = "https://notebooklm.google.com/";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const sessions = new Map(); // loginId -> { status, state, error, at }

export function getLoginStatus(loginId) {
  const s = sessions.get(loginId);
  return s ? { status: s.status, error: s.error || null } : { status: "none" };
}

/** The captured session for a loginId (only when finished), else null. */
export function takeLoginSession(loginId) {
  const s = sessions.get(loginId);
  return s && s.status === "done" ? s.state : null;
}

async function launchBrowser(chromium, headless) {
  const opts = {
    headless,
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  };
  // Prefer the user's installed Chrome/Edge (Google is much happier with those), then bundled Chromium
  for (const channel of ["chrome", "msedge", undefined]) {
    try {
      return await chromium.launch(channel ? { ...opts, channel } : opts);
    } catch (e) {
      if (!channel) throw e;
    }
  }
}

/**
 * Start a login. Returns the loginId immediately; poll getLoginStatus(loginId).
 * Options are for tests only.
 */
export async function startLogin({
  url = NOTEBOOKLM_URL,
  hostIs = "notebooklm.google.com",
  cookieDomain = "google",
  cookieNames = ["SID", "__Secure-1PSID"],
  headless = false,
} = {}) {
  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("Playwright is not installed. Run: npm install && npx playwright install chromium");
  }

  const loginId = crypto.randomBytes(18).toString("base64url");
  const entry = { status: "waiting", at: Date.now() };
  sessions.set(loginId, entry);

  let browser;
  try {
    browser = await launchBrowser(chromium, headless);
  } catch (e) {
    sessions.delete(loginId);
    throw new Error(
      `Could not open a browser: ${e.message.split("\n")[0]}. Install Chrome, or run: npx playwright install chromium`
    );
  }

  (async () => {
    let closedByUs = false;
    try {
      const context = await browser.newContext({ viewport: null });
      const page = await context.newPage();
      browser.on("disconnected", () => {
        if (!closedByUs && entry.status === "waiting") {
          Object.assign(entry, { status: "error", error: "The login window was closed before sign-in finished" });
        }
      });
      await page.goto(url);

      const deadline = Date.now() + LOGIN_TIMEOUT_MS;
      while (entry.status === "waiting" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        let onApp = false;
        try {
          onApp = context.pages().some((p) => {
            try { return new URL(p.url()).hostname === hostIs; } catch { return false; }
          });
        } catch { break; }
        if (!onApp) continue;
        const cookies = await context.cookies().catch(() => []);
        if (!cookies.some((c) => cookieNames.includes(c.name))) continue;
        await new Promise((r) => setTimeout(r, 2500)); // let Google finish setting cookies
        const state = await context.storageState();
        inspectStorageState(state, cookieDomain);
        Object.assign(entry, { status: "done", state, at: Date.now() });
      }
      if (entry.status === "waiting") Object.assign(entry, { status: "error", error: "Login timed out" });
    } catch (e) {
      if (entry.status === "waiting") Object.assign(entry, { status: "error", error: e.message });
    } finally {
      closedByUs = true;
      await browser.close().catch(() => {}); // closes the Google login window
      setTimeout(() => sessions.delete(loginId), 60 * 60 * 1000).unref();
    }
  })();

  return loginId;
}

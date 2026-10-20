// src/notebooklmLogin.js
// Opens a real browser window on THIS computer, lets the user sign in to Google / NotebookLM,
// captures the logged-in session automatically, and closes the window. The session is what
// notebooklm-py needs to act as that Google account. It is held here under a one-time id and
// written to the database when the user presses Save Configuration.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { inspectStorageState } from "./intake/userKeys.js";

const NOTEBOOKLM_URL = "https://notebooklm.google.com/";
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
const sessions = new Map(); // loginId -> { status, state, error, at }

export function getLoginStatus(loginId) {
  const s = sessions.get(loginId);
  return s ? { status: s.status, error: s.error || null, email: s.status === "done" ? s.email || null : null } : { status: "none" };
}

/** User pressed "I've signed in - Confirm": capture as soon as a Google sign-in cookie exists. */
export function confirmLogin(loginId) {
  const s = sessions.get(loginId);
  if (s && s.status === "waiting") { s.confirm = true; return true; }
  return false;
}

/** The captured session for a loginId (only when finished), else null. */
export function takeLoginSession(loginId) {
  const s = sessions.get(loginId);
  return s && s.status === "done" ? s.state : null;
}

/** The Google account email read from the signed-in session (only when finished), else null. */
export function takeLoginEmail(loginId) {
  const s = sessions.get(loginId);
  return s && s.status === "done" ? s.email || null : null;
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;

/** First email address found in a piece of text (e.g. "Google Account: Aditya (a@gmail.com)"), lower-cased. */
export function findEmail(text) {
  const m = String(text ?? "").match(EMAIL_RE);
  return m ? m[0].toLowerCase() : null;
}

/**
 * Read the signed-in account's email from NotebookLM itself, the same place NotebookLM shows it:
 * the page's own account data, or the label of the profile button in the top-right corner.
 */
async function detectAccountEmail(context, hostIs, url) {
  const hostOf = (p) => { try { return new URL(p.url()).hostname; } catch { return ""; } };
  let page = context.pages().find((p) => hostOf(p) === hostIs);
  let openedByUs = false;
  if (!page) {
    page = await context.newPage();
    openedByUs = true;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});
  }
  try {
    for (let i = 0; i < 10; i++) {
      const candidates = await page
        .evaluate(() => {
          const out = [];
          try { const v = window.WIZ_global_data && window.WIZ_global_data.oPEP7c; if (typeof v === "string") out.push(v); } catch {}
          for (const el of document.querySelectorAll('[aria-label*="@"], [aria-label^="Google Account"]')) out.push(el.getAttribute("aria-label"));
          const m = document.documentElement.innerHTML.match(/"oPEP7c"\s*:\s*"([^"]+)"/);
          if (m) out.push(m[1]);
          return out;
        })
        .catch(() => []);
      for (const c of candidates) { const e = findEmail(c); if (e) return e; }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return null;
  } finally {
    if (openedByUs) await page.close().catch(() => {});
  }
}

// Google blocks sign-in inside browsers that Playwright launches itself ("This browser or app may
// not be secure"). So we start the user's REAL Chrome/Edge as a normal process with a private
// profile folder, and only attach to it over the debugging port to read the cookies afterwards.
function findBrowserExecutable(chromium) {
  const env = process.env;
  const candidates = process.platform === "win32"
    ? [
        `${env["PROGRAMFILES"]}\\Google\\Chrome\\Application\\chrome.exe`,
        `${env["PROGRAMFILES(X86)"]}\\Google\\Chrome\\Application\\chrome.exe`,
        `${env["LOCALAPPDATA"]}\\Google\\Chrome\\Application\\chrome.exe`,
        `${env["PROGRAMFILES"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${env["PROGRAMFILES(X86)"]}\\Microsoft\\Edge\\Application\\msedge.exe`,
        `${env["PROGRAMFILES"]}\\BraveSoftware\\Brave-Browser\\Application\\brave.exe`,
      ]
    : process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
      ]
    : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge", "/usr/bin/brave-browser"];
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  try { const p = chromium.executablePath(); if (p && fs.existsSync(p)) return p; } catch {}
  return null;
}

async function waitForDebugPort(port, proc, timeoutMs = 20000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (proc.exitCode !== null) throw new Error("the browser exited immediately");
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error("the browser did not start in time");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on("error", reject);
  });
}

async function launchBrowser(chromium, headless, startUrl = NOTEBOOKLM_URL) {
  const exe = findBrowserExecutable(chromium);
  if (!exe) throw new Error("No Chrome/Edge found");
  const port = await freePort();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), "study-agent-login-"));
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []), // Chrome refuses to run as root otherwise
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    ...(headless ? ["--headless=new"] : []),
    startUrl,
  ];
  const proc = spawn(exe, args, { stdio: "ignore", detached: false });
  const cleanup = () => {
    try { proc.kill(); } catch {}
    setTimeout(() => fs.rm(profileDir, { recursive: true, force: true }, () => {}), 3000).unref();
  };
  try {
    await waitForDebugPort(port, proc);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    return { browser, proc, close: async () => {
      try { await browser.close(); } catch {}      // detaches / asks Chrome to quit
      cleanup();                                   // and make sure the window is really gone
    } };
  } catch (e) {
    cleanup();
    throw e;
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

  let launched, browser;
  try {
    launched = await launchBrowser(chromium, headless, url);
    browser = launched.browser;
  } catch (e) {
    sessions.delete(loginId);
    throw new Error(
      `Could not open a browser: ${e.message.split("\n")[0]}. Install Chrome, or run: npx playwright install chromium`
    );
  }

  (async () => {
    let closedByUs = false;
    try {
      const context = browser.contexts()[0] || (await browser.newContext({ viewport: null }));
      launched.proc.on("exit", () => {
        if (!closedByUs && entry.status === "waiting") {
          Object.assign(entry, { status: "error", error: "The login window was closed before sign-in finished" });
        }
      });
      browser.on("disconnected", () => {
        if (!closedByUs && entry.status === "waiting") {
          Object.assign(entry, { status: "error", error: "The login window was closed before sign-in finished" });
        }
      });

      const AUTH_COOKIES = [...cookieNames, "__Secure-3PSID", "SAPISID", "__Secure-1PAPISID", "__Secure-3PAPISID"];
      const hostsOf = () => {
        try { return context.pages().map((p) => { try { return new URL(p.url()).hostname; } catch { return ""; } }); }
        catch { return null; }
      };
      const deadline = Date.now() + LOGIN_TIMEOUT_MS;
      let tick = 0;
      while (entry.status === "waiting" && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        const hosts = hostsOf();
        if (!hosts) break;
        const cookies = await context.cookies().catch(() => []);
        const hasAuth = cookies.some((c) => AUTH_COOKIES.includes(c.name) && String(c.domain).includes(cookieDomain));
        if (++tick % 5 === 0) {
          console.log(`[notebooklm login] pages: ${hosts.join(", ") || "(none)"} | signed-in cookies: ${hasAuth ? "yes" : "no"}${entry.confirm ? " | user pressed Confirm" : ""}`);
        }
        const onApp = hosts.includes(hostIs);
        const stillSigningIn = hosts.includes("accounts.google.com");
        // Done when signed in AND (we reached the app, OR the sign-in pages are gone, OR the user pressed Confirm)
        if (!hasAuth) {
          if (entry.confirm) {
            Object.assign(entry, { status: "error", error: "No Google sign-in found in that window yet. Finish signing in, then press Confirm again" });
          }
          continue;
        }
        if (!(onApp || !stillSigningIn || entry.confirm)) continue;
        await new Promise((r) => setTimeout(r, 2500)); // let Google finish setting cookies
        let email = null;
        try { email = await detectAccountEmail(context, hostIs, url); } catch {}
        console.log(`[notebooklm login] account email: ${email ? "detected" : "not found"}`);
        const state = await context.storageState();
        inspectStorageState(state, cookieDomain);
        Object.assign(entry, { status: "done", state, email, at: Date.now() });
      }
      if (entry.status === "waiting") Object.assign(entry, { status: "error", error: "Login timed out" });
    } catch (e) {
      if (entry.status === "waiting") Object.assign(entry, { status: "error", error: e.message });
    } finally {
      closedByUs = true;
      await launched.close(); // closes the Google login window for good
      setTimeout(() => sessions.delete(loginId), 60 * 60 * 1000).unref();
    }
  })();

  return loginId;
}

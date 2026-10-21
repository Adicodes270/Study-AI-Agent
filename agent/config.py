# agent/config.py - NotebookLM worker configuration
import os
from dotenv import load_dotenv

# Load .env from project root (one level up from agent/)
load_dotenv(os.path.join(os.path.dirname(__file__), "..", ".env"))

# ─── Required ──────────────────────────────────────────────────────────────
DATABASE_URL = os.getenv("DATABASE_URL", "").strip()
if not DATABASE_URL:
    raise RuntimeError("DATABASE_URL not set in .env")

TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()

SESSION_ENC_KEY = os.getenv("SESSION_ENC_KEY", "").strip()
# Must match the 32-byte key used by the Node app (src/intake/userKeys.js)
# Generate once: python -c "import secrets; print(secrets.token_hex(32))"
# Put in .env as SESSION_ENC_KEY=<64 hex chars>

# ─── Worker tuning ─────────────────────────────────────────────────────────
POLL_SECONDS = int(os.getenv("WORKER_POLL_SECONDS", "60"))      # cycle interval
MAX_SOURCES_PER_CYCLE = int(os.getenv("WORKER_MAX_SOURCES", "3"))
MAX_STARTS_PER_CYCLE = int(os.getenv("WORKER_MAX_STARTS", "5"))
MAX_NOTEBOOKS_PER_USER = int(os.getenv("WORKER_MAX_NOTEBOOKS", "50"))
MAX_ATTEMPTS = int(os.getenv("WORKER_MAX_ATTEMPTS", "5"))        # asset retries
RUNNING_TIMEOUT_MIN = int(os.getenv("WORKER_RUNNING_TIMEOUT", "45"))  # stuck asset timeout

# ─── Asset selection ───────────────────────────────────────────────────────
# These are the asset types the worker can generate. User can override via
# nlm_user_state.enabled_assets_json in the DB (set from setup page later).
DEFAULT_ASSETS = [
    "report",       # study guide (markdown)
    "flashcards",   # markdown flashcards
    "quiz",         # practice quiz (markdown)
    "mind_map",     # instant JSON mind map
    "audio",        # audio overview (MP3)
    # "video",       # video overview (slow, quota-heavy) - enable later
    # "slide_deck",  # PDF slides
    # "infographic",
    # "data_table",
]

# ─── NotebookLM limits ─────────────────────────────────────────────────────
# NotebookLM free tier has a hard cap on total notebooks per Google account.
# We enforce a per-user soft cap to avoid hitting it.
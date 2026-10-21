# agent/session.py - turns the stored (encrypted) NotebookLM session into a signed-in client
import base64
import json
import os
import re
import tempfile
from contextlib import asynccontextmanager

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

import config

ENC_PREFIX = "enc:v1:"  # written by encryptState() in src/intake/userKeys.js


class SessionExpired(Exception):
    """The saved Google session is missing, empty or no longer accepted by NotebookLM."""


def _key() -> bytes | None:
    raw = config.SESSION_ENC_KEY
    if not raw:
        return None
    key = bytes.fromhex(raw) if re.fullmatch(r"[0-9a-fA-F]{64}", raw) else base64.b64decode(raw)
    if len(key) != 32:
        raise RuntimeError("SESSION_ENC_KEY must be 32 bytes (64 hex chars or base64)")
    return key


def decrypt_state(stored: str) -> str:
    """Mirror of decryptState() in userKeys.js: enc:v1:<iv hex>:<tag hex>:<ciphertext hex>."""
    if not stored.startswith(ENC_PREFIX):
        return stored  # legacy plaintext row
    key = _key()
    if key is None:
        raise RuntimeError("Session is encrypted but SESSION_ENC_KEY is not set for the worker")
    iv_hex, tag_hex, ct_hex = stored[len(ENC_PREFIX):].split(":")
    try:
        # Node keeps the GCM tag separate; AESGCM wants it appended to the ciphertext
        plain = AESGCM(key).decrypt(bytes.fromhex(iv_hex), bytes.fromhex(ct_hex) + bytes.fromhex(tag_hex), None)
    except InvalidTag as e:
        raise RuntimeError("Could not decrypt the session: SESSION_ENC_KEY differs from the one the web app uses") from e
    return plain.decode("utf-8")


def is_auth_error(exc: BaseException) -> bool:
    """Best-effort: did this fail because Google no longer accepts the saved sign-in?"""
    text = f"{type(exc).__name__} {exc}".lower()
    return any(s in text for s in (
        "autherror", "authentication", "not authenticated", "re-authenticate", "reauth",
        "login", "log in", "sign in", "accounts.google.com", "csrf", "session expired", "cookies",
    ))


@asynccontextmanager
async def open_client(state_json: str):
    """Yield a NotebookLMClient signed in with this storage_state JSON."""
    from notebooklm import NotebookLMClient  # imported here so the rest of the worker loads without it

    try:
        state = json.loads(state_json)
    except json.JSONDecodeError as e:
        raise SessionExpired("saved session is not valid JSON") from e
    if not any("google" in str(c.get("domain", "")) for c in state.get("cookies", [])):
        raise SessionExpired("saved session has no Google cookies")

    fd, path = tempfile.mkstemp(suffix=".json", prefix="nlm-")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(state_json)
        os.chmod(path, 0o600)
        try:
            client_cm = await NotebookLMClient.from_storage(path)
            client = await client_cm.__aenter__()
        except Exception as e:
            if is_auth_error(e):
                raise SessionExpired(str(e)) from e
            raise
        try:
            yield client
        finally:
            await client_cm.__aexit__(None, None, None)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
# agent/quota.py - NotebookLM daily limits. We don't hard-code the limits (Google changes them); when a
# generation is refused for rate/quota reasons we block that asset type for the user with a growing back-off.
import db

BACKOFF_HOURS = [1, 3, 6, 12, 24]
_QUOTA_WORDS = ("quota", "rate limit", "rate_limit", "ratelimit", "limit reached", "daily limit",
                "too many", "resource_exhausted", "resource exhausted", "429", "try again later")


def looks_like_quota(text: str) -> bool:
    t = (text or "").lower()
    return any(w in t for w in _QUOTA_WORDS)


def block(user_id: int, asset_type: str) -> int:
    """Block this asset type for the user; returns the number of hours it is blocked for."""
    strikes = db.get_strikes(user_id, asset_type) + 1
    hours = BACKOFF_HOURS[min(strikes - 1, len(BACKOFF_HOURS) - 1)]
    db.set_quota_block(user_id, asset_type, hours, strikes)
    return hours


def clear(user_id: int, asset_type: str) -> None:
    db.clear_quota_block(user_id, asset_type)
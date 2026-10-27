// Force Indian Standard Time (UTC+05:30) for all date/time logic on the server,
// so "today", weekdays and day boundaries never follow the host's (usually UTC) clock.
// Override with APP_TIMEZONE in .env if ever needed.
process.env.TZ = process.env.APP_TIMEZONE || "Asia/Kolkata";

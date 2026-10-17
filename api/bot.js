import { bot } from "../src/index.js"; // adjust this import to wherever your bot instance is defined
import { webhookCallback } from "grammy";

export default webhookCallback(bot, "std/http");
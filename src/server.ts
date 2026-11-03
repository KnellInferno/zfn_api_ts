/*
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * Based on openschoolcn/zfn_api: https://github.com/openschoolcn/zfn_api
 */
import "dotenv/config";
import { createApp } from "./app.js";

const port = Number.parseInt(process.env.PORT ?? "3000", 10);
const baseUrl = process.env.ZF_BASE_URL;
const timeoutMs = Number.parseInt(process.env.ZF_TIMEOUT_MS ?? "8000", 10);
const sessionTtlMinutes = Number.parseInt(process.env.API_SESSION_TTL_MINUTES ?? "240", 10);

// Fail at startup so a misconfigured server cannot accept requests with invalid timing or network settings.
if (!baseUrl) throw new Error("ZF_BASE_URL is required. Copy .env.example and configure your academic system URL.");
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535.");
if (!Number.isInteger(timeoutMs) || timeoutMs < 1000) throw new Error("ZF_TIMEOUT_MS must be at least 1000.");
if (!Number.isInteger(sessionTtlMinutes) || sessionTtlMinutes < 1) throw new Error("API_SESSION_TTL_MINUTES must be a positive integer.");

const { app } = createApp({ baseUrl, timeoutMs, sessionTtlMs: sessionTtlMinutes * 60_000 });
app.listen(port, () => console.log("Zhengfang REST API listening on port " + port));

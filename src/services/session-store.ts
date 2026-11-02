/*
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0.
 * Based on openschoolcn/zfn_api: https://github.com/openschoolcn/zfn_api
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { LoginChallenge, ZhengfangClient } from "./zhengfang-client.js";

export interface ApiSession { token: string; client: ZhengfangClient; expiresAt: number; }
export interface CaptchaSession { id: string; client: ZhengfangClient; challenge: LoginChallenge; expiresAt: number; }

export class SessionStore {
  private readonly sessions = new Map<string, ApiSession>();
  private readonly challenges = new Map<string, CaptchaSession>();
  constructor(private readonly ttlMs: number) {}

  create(client: ZhengfangClient): ApiSession {
    const token = randomBytes(32).toString("base64url");
    const session = { token, client, expiresAt: Date.now() + this.ttlMs };
    this.sessions.set(token, session);
    return session;
  }

  createChallenge(client: ZhengfangClient, challenge: LoginChallenge): CaptchaSession {
    const entry = { id: randomUUID(), client, challenge, expiresAt: Date.now() + 5 * 60_000 };
    this.challenges.set(entry.id, entry);
    return entry;
  }

  getChallenge(id: string): CaptchaSession | undefined {
    const challenge = this.challenges.get(id);
    if (!challenge) return undefined;
    if (challenge.expiresAt <= Date.now()) { this.challenges.delete(id); return undefined; }
    return challenge;
  }

  removeChallenge(id: string): void { this.challenges.delete(id); }

  get(token: string): ApiSession | undefined {
    const session = this.sessions.get(token);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) { this.sessions.delete(token); return undefined; }
    return session;
  }

  revoke(token: string): void { this.sessions.delete(token); }
}

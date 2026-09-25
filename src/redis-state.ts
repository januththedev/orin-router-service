import { createHmac } from "node:crypto";
import { Redis } from "@upstash/redis";
import { RouterError } from "./errors.js";
import type { DistributedState } from "./types.js";
type Candidate = { provider: string; model: string };
export class MemoryState implements DistributedState {
  private failures = new Map<string, number>();
  private requests = new Map<string, { start: number; count: number }>();
  private readonly now: () => number;
  constructor(now: () => number = () => Date.now()) { this.now = now; }
  async isEligible(candidate: Candidate): Promise<boolean> { return (this.failures.get(`${candidate.provider}:${candidate.model}`) ?? 0) < 3; }
  async recordSuccess(_candidate: Candidate, _latencyMs: number): Promise<void> { this.failures.delete(`${_candidate.provider}:${_candidate.model}`); }
  async recordFailure(candidate: Candidate, _status: number): Promise<void> { const key = `${candidate.provider}:${candidate.model}`; this.failures.set(key, (this.failures.get(key) ?? 0) + 1); }
  async consumeRequest(key: string, limit: number, windowMs: number): Promise<boolean> { const now = this.now(); const current = this.requests.get(key); if (!current || now - current.start >= windowMs) { this.requests.set(key, { start: now, count: 1 }); return true; } current.count += 1; return current.count <= limit; }
}
export class UpstashState implements DistributedState {
  private readonly redis: Redis;
  private readonly hashKey: string;
  constructor(url: string, token: string, hashKey: string) { this.redis = new Redis({ url, token }); this.hashKey = hashKey; }
  private key(value: string): string { return `orin-router:${createHmac("sha256", this.hashKey).update(value).digest("hex")}`; }
  async isEligible(candidate: Candidate): Promise<boolean> { try { const failures = await this.redis.get<number>(this.key(`fail:${candidate.provider}:${candidate.model}`)); return (failures ?? 0) < 3; } catch { throw new RouterError("ORIN_RATE_LIMIT_STATE_UNAVAILABLE", "Router state is unavailable.", true); } }
  async recordSuccess(candidate: Candidate, _latencyMs: number): Promise<void> { try { await this.redis.del(this.key(`fail:${candidate.provider}:${candidate.model}`)); } catch { throw new RouterError("ORIN_RATE_LIMIT_STATE_UNAVAILABLE", "Router state is unavailable.", true); } }
  async recordFailure(candidate: Candidate, _status: number): Promise<void> { try { await this.redis.incr(this.key(`fail:${candidate.provider}:${candidate.model}`)); } catch { throw new RouterError("ORIN_RATE_LIMIT_STATE_UNAVAILABLE", "Router state is unavailable.", true); } }
  async consumeRequest(key: string, limit: number, windowMs: number): Promise<boolean> { try { const bucket = Math.floor(Date.now() / windowMs); const redisKey = `${this.key(`req:${key}`)}:${bucket}`; const count = await this.redis.incr(redisKey); if (count === 1) await this.redis.pexpire(redisKey, windowMs * 2); return count <= limit; } catch { throw new RouterError("ORIN_RATE_LIMIT_STATE_UNAVAILABLE", "Router state is unavailable.", true); } }
}
export function createDistributedState(mode: "fake" | "live", url: string, token: string, hashKey: string): DistributedState { return mode === "fake" ? new MemoryState() : new UpstashState(url, token, hashKey); }

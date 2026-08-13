import type { SessionId } from "../shared/ids.js";

export const TASK_QUOTA_POOLS = ["a2a", "async-tool"] as const;

export type TaskQuotaPool = (typeof TASK_QUOTA_POOLS)[number];

export type SessionTaskQuotaLimits = Readonly<Record<TaskQuotaPool, number>>;

export interface SessionTaskQuotaLease {
  readonly sessionId: SessionId;
  readonly quotaPool: TaskQuotaPool;
  release(): void;
  /** Moves ownership to a new handle and permanently invalidates this handle. */
  transfer(): SessionTaskQuotaLease;
}

export type SessionTaskQuotaAcquireResult =
  | {
      readonly status: "acquired";
      readonly lease: SessionTaskQuotaLease;
    }
  | {
      readonly status: "limit-reached";
      readonly quotaPool: TaskQuotaPool;
      readonly maxActiveTasksPerSession: number;
    };

export type SessionTaskQuotaServiceOptions = {
  readonly limits: SessionTaskQuotaLimits;
};

type QuotaSlot = {
  readonly sessionId: SessionId;
  readonly quotaPool: TaskQuotaPool;
  ownerVersion: number;
  released: boolean;
};

/** Owns protocol-independent per-Session admission slots for top-level Tasks. */
export class SessionTaskQuotaService {
  private readonly limits: SessionTaskQuotaLimits;
  private readonly activeBySessionAndPool = new Map<string, number>();

  constructor(options: SessionTaskQuotaServiceOptions) {
    for (const quotaPool of TASK_QUOTA_POOLS) {
      requirePositiveSafeInteger(options.limits[quotaPool], quotaPool);
    }
    this.limits = { ...options.limits };
  }

  acquire(
    sessionId: SessionId,
    quotaPool: TaskQuotaPool,
  ): SessionTaskQuotaAcquireResult {
    requireNonBlank(sessionId, "sessionId");
    if (!(TASK_QUOTA_POOLS as readonly unknown[]).includes(quotaPool)) {
      throw new Error("Session Task quota pool is unsupported");
    }
    const limit = this.limits[quotaPool];
    const key = quotaKey(sessionId, quotaPool);
    if ((this.activeBySessionAndPool.get(key) ?? 0) >= limit) {
      return {
        status: "limit-reached",
        quotaPool,
        maxActiveTasksPerSession: limit,
      };
    }
    this.activeBySessionAndPool.set(
      key,
      (this.activeBySessionAndPool.get(key) ?? 0) + 1,
    );
    return {
      status: "acquired",
      lease: this.createLease({
        sessionId,
        quotaPool,
        ownerVersion: 0,
        released: false,
      }),
    };
  }

  private createLease(slot: QuotaSlot): SessionTaskQuotaLease {
    const ownerVersion = slot.ownerVersion;
    return {
      sessionId: slot.sessionId,
      quotaPool: slot.quotaPool,
      release: () => {
        if (slot.released || slot.ownerVersion !== ownerVersion) {
          return;
        }
        slot.released = true;
        this.adjust(slot.sessionId, slot.quotaPool, -1);
      },
      transfer: () => {
        if (slot.released || slot.ownerVersion !== ownerVersion) {
          throw new Error("Session Task quota lease is no longer owned");
        }
        slot.ownerVersion += 1;
        return this.createLease(slot);
      },
    };
  }

  private adjust(
    sessionId: SessionId,
    quotaPool: TaskQuotaPool,
    delta: -1,
  ): void {
    const key = quotaKey(sessionId, quotaPool);
    const next = (this.activeBySessionAndPool.get(key) ?? 0) + delta;
    if (next < 0) {
      throw new Error("Session Task quota count is inconsistent");
    }
    if (next === 0) {
      this.activeBySessionAndPool.delete(key);
      return;
    }
    this.activeBySessionAndPool.set(key, next);
  }
}

function quotaKey(sessionId: SessionId, quotaPool: TaskQuotaPool): string {
  return JSON.stringify([sessionId, quotaPool]);
}

function requireNonBlank(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be blank`);
  }
}

function requirePositiveSafeInteger(value: number, quotaPool: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${quotaPool} Task quota must be a positive safe integer`);
  }
}

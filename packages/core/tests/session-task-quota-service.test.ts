import { describe, expect, test } from "vitest";

import { SessionTaskQuotaService } from "../src/index.js";

describe("SessionTaskQuotaService", () => {
  test("rejects an unknown quota pool at the runtime boundary", () => {
    const quotas = new SessionTaskQuotaService({
      limits: { a2a: 2, "async-tool": 3 },
    });

    expect(() => quotas.acquire("session-a", "unknown-pool" as never)).toThrow(
      /quota pool/,
    );
  });

  test("applies independent A2A and ordinary async Tool limits per Session", () => {
    const service = new SessionTaskQuotaService({
      limits: { a2a: 2, "async-tool": 3 },
    });

    expect(service.acquire("session-a", "a2a").status).toBe("acquired");
    expect(service.acquire("session-a", "a2a").status).toBe("acquired");
    expect(service.acquire("session-a", "a2a")).toEqual({
      status: "limit-reached",
      quotaPool: "a2a",
      maxActiveTasksPerSession: 2,
    });

    expect(service.acquire("session-a", "async-tool").status).toBe("acquired");
    expect(service.acquire("session-a", "async-tool").status).toBe("acquired");
    expect(service.acquire("session-a", "async-tool").status).toBe("acquired");
    expect(service.acquire("session-a", "async-tool")).toEqual({
      status: "limit-reached",
      quotaPool: "async-tool",
      maxActiveTasksPerSession: 3,
    });

    expect(service.acquire("session-b", "a2a").status).toBe("acquired");
    expect(service.acquire("session-b", "async-tool").status).toBe("acquired");
  });

  test("transfers ownership without allowing the previous owner to release the slot", () => {
    const service = new SessionTaskQuotaService({
      limits: { a2a: 1, "async-tool": 1 },
    });
    const acquired = service.acquire("session-a", "a2a");
    if (acquired.status !== "acquired") {
      throw new Error("test setup must acquire a quota slot");
    }

    const adopted = acquired.lease.transfer();
    acquired.lease.release();

    expect(service.acquire("session-a", "a2a")).toEqual({
      status: "limit-reached",
      quotaPool: "a2a",
      maxActiveTasksPerSession: 1,
    });

    adopted.release();
    adopted.release();
    expect(service.acquire("session-a", "a2a").status).toBe("acquired");
  });
});

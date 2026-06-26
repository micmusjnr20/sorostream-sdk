import { describe, it, expect, vi, beforeEach } from "vitest";
import { SoroStreamClient } from "../src/SoroStreamClient.js";
import type { Stream, WalletAdapter } from "../src/types.js";
import {
  toStroops,
  formatUSDC,
  calculateFlowRate,
  claimableNow,
  timeUntilStreamEnd,
  filterStreams,
} from "../src/utils.js";

// ── Utility tests ────────────────────────────────────────────────────────────

describe("toStroops", () => {
  it("converts whole USDC to stroops", () => {
    expect(toStroops("100")).toBe(1_000_000_000n);
  });

  it("converts decimal USDC to stroops", () => {
    expect(toStroops("1.5")).toBe(15_000_000n);
  });

  it("handles 7 decimal places", () => {
    expect(toStroops("0.0000001")).toBe(1n);
  });
});

describe("formatUSDC", () => {
  it("formats stroops to USDC string", () => {
    expect(formatUSDC(1_000_000_000n)).toBe("100.0000000");
  });

  it("formats fractional amounts", () => {
    expect(formatUSDC(1n)).toBe("0.0000001");
  });
});

describe("calculateFlowRate", () => {
  it("calculates flow rate correctly", () => {
    // 100 USDC over 1000 seconds = 1_000_000n stroops/s
    expect(calculateFlowRate(1_000_000_000n, 1000)).toBe(1_000_000n);
  });

  it("throws on zero duration", () => {
    expect(() => calculateFlowRate(100n, 0)).toThrow("Duration must be > 0");
  });
});

describe("claimableNow", () => {
  it("returns 0 for non-active streams", () => {
    const stream: Stream = makeStream({ status: "Cancelled" });
    expect(claimableNow(stream)).toBe(0n);
  });

  it("calculates claimable for active stream", () => {
    const now = Math.floor(Date.now() / 1000);
    const stream: Stream = makeStream({
      status: "Active",
      flowRate: 100n,
      lastWithdrawTime: now - 500,
      endTime: now + 500,
    });
    const claimable = claimableNow(stream);
    // Should be around 500 * 100 = 50_000
    expect(claimable).toBeGreaterThanOrEqual(49_900n);
    expect(claimable).toBeLessThanOrEqual(50_100n);
  });

  it("caps at end time", () => {
    const now = Math.floor(Date.now() / 1000);
    const stream: Stream = makeStream({
      status: "Active",
      flowRate: 100n,
      lastWithdrawTime: now - 2000,
      endTime: now - 1000, // already ended
    });
    // elapsed capped at endTime - lastWithdrawTime = 1000
    expect(claimableNow(stream)).toBe(100_000n);
  });
});

describe("timeUntilStreamEnd", () => {
  it("returns 0 for ended streams", () => {
    const now = Math.floor(Date.now() / 1000);
    const stream = makeStream({ endTime: now - 100 });
    expect(timeUntilStreamEnd(stream)).toBe(0);
  });

  it("returns positive seconds for active streams", () => {
    const now = Math.floor(Date.now() / 1000);
    const stream = makeStream({ endTime: now + 3600 });
    expect(timeUntilStreamEnd(stream)).toBeGreaterThan(0);
  });
});

describe("filterStreams", () => {
  const streams: Stream[] = [
    makeStream({
      id: "1",
      status: "Active",
      token: "GUSDC",
      startTime: 1_000,
      endTime: 2_000,
    }),
    makeStream({
      id: "2",
      status: "Completed",
      token: "GUSDC",
      startTime: 3_000,
      endTime: 4_000,
    }),
    makeStream({
      id: "3",
      status: "Active",
      token: "GXLM",
      startTime: 5_000,
      endTime: 6_000,
    }),
    makeStream({
      id: "4",
      status: "Cancelled",
      token: "GXLM",
      startTime: 7_000,
      endTime: 8_000,
    }),
  ];

  it("returns all streams when no criteria are provided", () => {
    expect(filterStreams(streams)).toHaveLength(4);
  });

  it("filters by status", () => {
    expect(filterStreams(streams, { status: "Active" }).map((s) => s.id)).toEqual([
      "1",
      "3",
    ]);
  });

  it("filters by multiple statuses", () => {
    expect(
      filterStreams(streams, { status: ["Active", "Cancelled"] }).map((s) => s.id)
    ).toEqual(["1", "3", "4"]);
  });

  it("filters by token", () => {
    expect(filterStreams(streams, { token: "GUSDC" }).map((s) => s.id)).toEqual([
      "1",
      "2",
    ]);
  });

  it("filters by startsAfter", () => {
    expect(filterStreams(streams, { startsAfter: 4_000 }).map((s) => s.id)).toEqual([
      "3",
      "4",
    ]);
  });

  it("filters by endsBefore", () => {
    expect(filterStreams(streams, { endsBefore: 5_000 }).map((s) => s.id)).toEqual([
      "1",
      "2",
    ]);
  });

  it("combines criteria with logical AND", () => {
    expect(
      filterStreams(streams, {
        status: "Active",
        token: "GUSDC",
        startsAfter: 500,
        endsBefore: 3_000,
      }).map((s) => s.id)
    ).toEqual(["1"]);
  });
});

// ── SoroStreamClient validation tests ────────────────────────────────────────

describe("SoroStreamClient input validation", () => {
  let client: SoroStreamClient;
  let mockAdapter: WalletAdapter;

  beforeEach(() => {
    mockAdapter = {
      getPublicKey: vi.fn().mockResolvedValue("GABC123"),
      signTransaction: vi.fn().mockResolvedValue("signed_xdr"),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    client = new SoroStreamClient({
      network: "testnet",
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      walletAdapter: mockAdapter,
    });
  });

  it("rejects createStream with zero amount", async () => {
    await expect(
      client.createStream({
        recipient: "GABC",
        token: "GUSDC",
        amount: 0n,
        durationSeconds: 1000,
        autoRenew: false,
      })
    ).rejects.toThrow("Amount must be > 0");
  });

  it("rejects createStream with zero duration", async () => {
    await expect(
      client.createStream({
        recipient: "GABC",
        token: "GUSDC",
        amount: 100n,
        durationSeconds: 0,
        autoRenew: false,
      })
    ).rejects.toThrow("Duration must be > 0");
  });

  it("rejects topUp with zero amount", async () => {
    await expect(
      client.topUp({ streamId: "1", amount: 0n })
    ).rejects.toThrow("Amount must be > 0");
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeStream(overrides: Partial<Stream> = {}): Stream {
  const now = Math.floor(Date.now() / 1000);
  return {
    id: "0",
    sender: "GSENDER",
    recipient: "GRECIPIENT",
    token: "GTOKEN",
    deposit: 100_000n,
    flowRate: 100n,
    startTime: now,
    endTime: now + 1000,
    lastWithdrawTime: now,
    status: "Active",
    autoRenew: false,
    ...overrides,
  };
}

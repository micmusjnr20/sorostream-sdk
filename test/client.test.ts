import { describe, it, expect, vi, beforeEach, afterEach, useFakeTimers } from "vitest";
import { SoroStreamClient } from "../src/SoroStreamClient.js";
import { createKeypairAdapter } from "../src/wallet.js";
import type { Stream, WalletAdapter, BulkStreamRow } from "../src/types.js";
import {
  toStroops,
  formatUSDC,
  calculateFlowRate,
  claimableNow,
  timeUntilStreamEnd,
  calculateVestingSchedule,
  watchClaimable,
  aggregateStreamsByToken,
  parseCsvStreamRows,
} from "../src/utils.js";
import {
  InsufficientAmountError,
  SoroStreamError,
} from "../src/errors.js";
import { NoopLogger } from "../src/logger.js";
import type { Logger } from "../src/logger.js";

// ── Utility tests ────────────────────────────────────────────────────────────

describe("toStroops", () => {
  it("converts whole USDC to stroops (default 7 decimals)", () => {
    expect(toStroops("100")).toBe(1_000_000_000n);
  });

  it("converts decimal USDC to stroops", () => {
    expect(toStroops("1.5")).toBe(15_000_000n);
  });

  it("handles 7 decimal places", () => {
    expect(toStroops("0.0000001")).toBe(1n);
  });

  it("respects custom decimals parameter", () => {
    expect(toStroops("100", 6)).toBe(100_000_000n);
    expect(toStroops("1.5", 6)).toBe(1_500_000n);
    expect(toStroops("0.5", 18)).toBe(500_000_000_000_000_000n);
  });
});

describe("formatUSDC", () => {
  it("formats stroops to USDC string (default 7 decimals)", () => {
    expect(formatUSDC(1_000_000_000n)).toBe("100.0000000");
  });

  it("formats fractional amounts", () => {
    expect(formatUSDC(1n)).toBe("0.0000001");
  });

  it("formats with no decimal remainder", () => {
    expect(formatUSDC(100_000_000n, 6)).toBe("100.000000");
  });

  it("respects custom decimals parameter", () => {
    expect(formatUSDC(1_500_000n, 6)).toBe("1.500000");
    expect(formatUSDC(1n, 18)).toBe("0.000000000000000001");
  });
});

describe("calculateFlowRate", () => {
  it("calculates flow rate correctly", () => {
    // 100 USDC over 1000 seconds = 1_000_000n stroops/s
    expect(calculateFlowRate(1_000_000_000n, 1000)).toBe(1_000_000n);
  });

  it("throws SoroStreamError on zero duration", () => {
    expect(() => calculateFlowRate(100n, 0)).toThrow(SoroStreamError);
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

// ── Vesting schedule calculator ───────────────────────────────────────────────

describe("calculateVestingSchedule", () => {
  const startTime = 1_000_000;
  const endTime = startTime + 4 * 365 * 24 * 3600; // 4 years
  const flowRate = 10n; // 10 stroops/s
  const deposit = flowRate * BigInt(endTime - startTime);

  function makeVestingStream(overrides: Partial<Stream> = {}): Stream {
    return {
      id: "0",
      sender: "GSENDER",
      recipient: "GRECIPIENT",
      token: "GTOKEN",
      deposit,
      flowRate,
      startTime,
      endTime,
      lastWithdrawTime: startTime,
      status: "Active",
      autoRenew: false,
      ...overrides,
    };
  }

  it("returns 0 effective claimable while in cliff period", () => {
    const now = startTime + 100; // 100s in, cliff = 1 year
    const result = calculateVestingSchedule(
      makeVestingStream(),
      365 * 24 * 3600,
      now
    );
    expect(result.inCliff).toBe(true);
    expect(result.effectiveClaimable).toBe(0n);
    expect(result.cliffEndTime).toBe(startTime + 365 * 24 * 3600);
  });

  it("returns positive effective claimable after cliff", () => {
    const cliff = 365 * 24 * 3600;
    const now = startTime + cliff + 500; // 500s after cliff
    const result = calculateVestingSchedule(
      makeVestingStream(),
      cliff,
      now
    );
    expect(result.inCliff).toBe(false);
    expect(result.effectiveClaimable).toBe(flowRate * 500n);
  });

  it("caps effective claimable at total amount", () => {
    const cliff = 365 * 24 * 3600;
    const now = endTime + 10_000; // well past end
    const result = calculateVestingSchedule(
      makeVestingStream(),
      cliff,
      now
    );
    expect(result.effectiveClaimable).toBe(deposit);
  });

  it("includes cliff milestone when cliff < total duration", () => {
    const cliff = 365 * 24 * 3600;
    const result = calculateVestingSchedule(
      makeVestingStream(),
      cliff,
      startTime
    );
    expect(result.milestones.length).toBeGreaterThanOrEqual(1);
    expect(result.milestones[0]).toBeDefined();
    expect(result.milestones[0].time).toBe(startTime + cliff);
  });

  it("returns milestones sorted by time", () => {
    const cliff = 365 * 24 * 3600;
    const result = calculateVestingSchedule(
      makeVestingStream(),
      cliff,
      startTime
    );
    for (let i = 1; i < result.milestones.length; i++) {
      expect(result.milestones[i].time).toBeGreaterThan(
        result.milestones[i - 1].time
      );
    }
  });

  it("total amount matches deposit * duration", () => {
    const result = calculateVestingSchedule(
      makeVestingStream(),
      0,
      startTime
    );
    expect(result.totalAmount).toBe(deposit);
  });
});

// ── watchClaimable ────────────────────────────────────────────────────────────

describe("watchClaimable", () => {
  beforeEach(() => {
    useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits initial claimable value immediately", () => {
    const now = Math.floor(Date.now() / 1000);
    const stream: Stream = {
      id: "0",
      sender: "GSENDER",
      recipient: "GRECIPIENT",
      token: "GTOKEN",
      deposit: 100_000n,
      flowRate: 100n,
      startTime: now - 100,
      endTime: now + 900,
      lastWithdrawTime: now - 50,
      status: "Active",
      autoRenew: false,
    };

    const onTick = vi.fn();
    const reconcile = vi.fn().mockResolvedValue(5000n);
    const unsubscribe = watchClaimable(stream, reconcile, onTick);

    expect(onTick).toHaveBeenCalledTimes(1);
    expect(onTick).toHaveBeenCalledWith(5000n); // 50 * 100
    unsubscribe();
  });

  it("emits interpolated values on tick interval", () => {
    const now = Math.floor(Date.now() / 1000);
    const stream: Stream = {
      id: "0",
      sender: "GSENDER",
      recipient: "GRECIPIENT",
      token: "GTOKEN",
      deposit: 100_000n,
      flowRate: 100n,
      startTime: now - 100,
      endTime: now + 900,
      lastWithdrawTime: now - 50,
      status: "Active",
      autoRenew: false,
    };

    const onTick = vi.fn();
    const reconcile = vi.fn().mockResolvedValue(5000n);
    const unsubscribe = watchClaimable(stream, reconcile, onTick);

    // Clear initial call
    onTick.mockClear();

    // Advance 1 second
    vi.advanceTimersByTime(1000);

    // Should have emitted ~5 times at 200ms intervals
    expect(onTick).toHaveBeenCalled();

    // The latest interpolated value after 1s should be near 5100
    const calls = onTick.mock.calls;
    const lastCall = calls[calls.length - 1] as [bigint];
    // flowRate 100/s, 1 second elapsed => +100
    expect(lastCall[0]).toBeGreaterThanOrEqual(5000n);
    expect(lastCall[0]).toBeLessThanOrEqual(5200n);

    unsubscribe();
  });

  it("unsubscribe stops the ticker", () => {
    const now = Math.floor(Date.now() / 1000);
    const stream: Stream = {
      id: "0",
      sender: "GSENDER",
      recipient: "GRECIPIENT",
      token: "GTOKEN",
      deposit: 100_000n,
      flowRate: 100n,
      startTime: now - 100,
      endTime: now + 900,
      lastWithdrawTime: now,
      status: "Active",
      autoRenew: false,
    };

    const onTick = vi.fn();
    const reconcile = vi.fn().mockResolvedValue(0n);
    const unsubscribe = watchClaimable(stream, reconcile, onTick);

    onTick.mockClear();
    unsubscribe();
    vi.advanceTimersByTime(5000);
    expect(onTick).not.toHaveBeenCalled();
  });
});

// ── Fee estimation input validation ───────────────────────────────────────────

describe("estimate*Fee input validation", () => {
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

  it("rejects estimateCreateStreamFee with zero amount", async () => {
    await expect(
      client.estimateCreateStreamFee({
        recipient: "GABC",
        token: "GUSDC",
        amount: 0n,
        durationSeconds: 1000,
        autoRenew: false,
      })
    ).rejects.toThrow("Amount must be > 0");
  });

  it("rejects estimateCreateStreamFee with zero duration", async () => {
    await expect(
      client.estimateCreateStreamFee({
        recipient: "GABC",
        token: "GUSDC",
        amount: 100n,
        durationSeconds: 0,
        autoRenew: false,
      })
    ).rejects.toThrow("Duration must be > 0");
  });

  it("rejects estimateTopUpFee with zero amount", async () => {
    await expect(
      client.estimateTopUpFee({ streamId: "1", amount: 0n })
    ).rejects.toThrow("Amount must be > 0");
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

  it("rejects createStream with zero amount (InsufficientAmountError)", async () => {
    await expect(
      client.createStream({
        recipient: "GABC",
        token: "GUSDC",
        amount: 0n,
        durationSeconds: 1000,
        autoRenew: false,
      })
    ).rejects.toThrow(InsufficientAmountError);
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

  it("rejects topUp with zero amount (InsufficientAmountError)", async () => {
    await expect(
      client.topUp({ streamId: "1", amount: 0n })
    ).rejects.toThrow(InsufficientAmountError);
  });
});

// ── Typed error tests ────────────────────────────────────────────────────────

describe("typed errors", () => {
  it("InsufficientAmountError extends SoroStreamError", () => {
    const err = new InsufficientAmountError();
    expect(err).toBeInstanceOf(SoroStreamError);
    expect(err.message).toBe("Amount must be > 0");
  });

  it("InsufficientAmountError accepts custom message", () => {
    const err = new InsufficientAmountError("Custom");
    expect(err.message).toBe("Custom");
  });

  it("SoroStreamError is a base Error", () => {
    const err = new SoroStreamError("base");
    expect(err).toBeInstanceOf(Error);
  });
});

// ── createKeypairAdapter tests ────────────────────────────────────────────────

describe("createKeypairAdapter", () => {
  it("returns a connected WalletAdapter", async () => {
    const adapter = createKeypairAdapter(
      "SA3HUUPJ3WN3Z2T6JQ54Z6BQ2OQ2B6Q2OQ2B6Q2OQ2B6Q2OQ2B6Q2AAAA"
    );
    expect(await adapter.isConnected()).toBe(true);
    expect(await adapter.getPublicKey()).toBeTruthy();
  });

  it("throws on invalid secret key", () => {
    expect(() => createKeypairAdapter("INVALID")).toThrow();
  });
});

// ── aggregateStreamsByToken tests ─────────────────────────────────────────────

describe("aggregateStreamsByToken", () => {
  it("returns empty array for no streams", () => {
    expect(aggregateStreamsByToken([])).toEqual([]);
  });

  it("groups streams by token and sums correctly", () => {
    const now = Math.floor(Date.now() / 1000);
    const streams: Stream[] = [
      makeStream({
        id: "1",
        token: "GUSDC",
        deposit: 1000n,
        flowRate: 10n,
        startTime: now - 200,
        lastWithdrawTime: now - 100,
        endTime: now + 100,
      }),
      makeStream({
        id: "2",
        token: "GUSDC",
        deposit: 2000n,
        flowRate: 20n,
        startTime: now - 200,
        lastWithdrawTime: now - 50,
        endTime: now + 100,
      }),
      makeStream({
        id: "3",
        token: "GEURC",
        deposit: 5000n,
        flowRate: 50n,
        status: "Completed",
      }),
    ];

    const result = aggregateStreamsByToken(streams);

    expect(result).toHaveLength(2);

    const eurc = result.find((t) => t.token === "GEURC")!;
    expect(eurc.streamCount).toBe(1);
    expect(eurc.deposited).toBe(5000n);
    expect(eurc.claimable).toBe(0n);

    const usdc = result.find((t) => t.token === "GUSDC")!;
    expect(usdc.streamCount).toBe(2);
    expect(usdc.deposited).toBe(3000n);
    expect(usdc.claimable).toBeGreaterThan(0n);
  });
});

// ── parseCsvStreamRows tests ──────────────────────────────────────────────────

describe("parseCsvStreamRows", () => {
  it("parses valid CSV with header", () => {
    const csv = `recipient,amount,durationSeconds
GABCD,10000000,86400
GEFGH,5000000,604800`;

    const rows = parseCsvStreamRows(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      recipient: "GABCD",
      amount: 10000000n,
      durationSeconds: 86400,
    });
    expect(rows[1]).toEqual({
      recipient: "GEFGH",
      amount: 5000000n,
      durationSeconds: 604800,
    });
  });

  it("throws on empty CSV", () => {
    expect(() => parseCsvStreamRows("")).toThrow();
  });

  it("throws on missing recipient column", () => {
    expect(() =>
      parseCsvStreamRows(`amount,durationSeconds\n100,10`)
    ).toThrow("CSV missing 'recipient' column");
  });

  it("throws on invalid durationSeconds", () => {
    expect(() =>
      parseCsvStreamRows(
        `recipient,amount,durationSeconds\nGABCD,100,0`
      )
    ).toThrow("invalid durationSeconds");
  });

  it("skips empty lines", () => {
    const csv = `recipient,amount,durationSeconds
GABCD,100,10

GEFGH,200,20
`;
    const rows = parseCsvStreamRows(csv);
    expect(rows).toHaveLength(2);
  });
});

// ── batchWithdraw validation tests ────────────────────────────────────────────

describe("SoroStreamClient batchWithdraw", () => {
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

    vi.spyOn(client as any, "buildAndSubmitBatch").mockResolvedValue("txhash_batch");
    vi.spyOn(client, "getClaimable").mockResolvedValue(500n);
  });

  it("calls buildAndSubmitBatch with correct number of operations", async () => {
    const results = await client.batchWithdraw(["1", "2", "3"], 8);

    expect(client as any).toHaveLength;
    expect(results).toHaveLength(1);
    expect(results[0].txHash).toBe("txhash_batch");
    expect(results[0].streamIds).toEqual(["1", "2", "3"]);
  });

  it("splits into multiple batches when count exceeds batchSize", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => String(i + 1));
    const results = await client.batchWithdraw(ids, 3);

    expect(results).toHaveLength(4);
    expect(results[0].streamIds).toHaveLength(3);
    expect(results[3].streamIds).toHaveLength(1);
  });
});

// ── bulkCreateStreams validation tests ────────────────────────────────────────

describe("SoroStreamClient bulkCreateStreams", () => {
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

    vi.spyOn(client as any, "buildAndSubmitBatch").mockResolvedValue("txhash_bulk");
  });

  it("processes rows and returns batch results", async () => {
    vi.spyOn(client, "getStreamsBySender").mockResolvedValue([
      makeStream({ id: "10" }),
      makeStream({ id: "11" }),
    ]);

    const rows: BulkStreamRow[] = [
      { recipient: "GA", amount: 100n, durationSeconds: 3600 },
      { recipient: "GB", amount: 200n, durationSeconds: 7200 },
    ];

    const result = await client.bulkCreateStreams(rows, {
      token: "GUSDC",
      autoRenew: false,
      batchSize: 8,
    });

    expect(result.batches).toHaveLength(1);
    expect(result.batches[0].txHash).toBe("txhash_bulk");
    expect(result.batches[0].streamIds).toEqual(["10", "11"]);
  });

  it("defaults autoRenew to false", async () => {
    vi.spyOn(client, "getStreamsBySender").mockResolvedValue([]);

    const rows: BulkStreamRow[] = [
      { recipient: "GA", amount: 100n, durationSeconds: 3600 },
    ];

    const result = await client.bulkCreateStreams(rows, {
      token: "GUSDC",
    });

    expect(result.batches).toHaveLength(1);
    expect(result.batches[0].streamIds).toEqual([]);
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

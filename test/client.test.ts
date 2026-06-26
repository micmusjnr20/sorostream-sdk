import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SoroStreamClient } from "../src/SoroStreamClient.js";
import { createKeypairAdapter } from "../src/wallet.js";
import { Keypair } from "@stellar/stellar-sdk";
import type { Stream, WalletAdapter, BulkStreamRow, PriceFeedAdapter, FeeBumpOptions } from "../src/types.js";
import {
  toStroops,
  formatUSDC,
  formatToken,
  toFiatDisplay,
  isValidStellarAddress,
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
  InvalidAddressError,
  AccountNotFoundError,
} from "../src/errors.js";
import { createContractEncoder } from "../src/contractEncoders.js";
import { Contract } from "@stellar/stellar-sdk";

const VALID_ACCOUNT = "GDDZFLD7ZQTSSDLWEMSD6UML2MTU4KKNCH765GZOVHAYKZNRJMWV4GMF";
const VALID_CONTRACT = "CAVTXNC2WCHINDNP4VBLSOQA2667VE3RPQZNGD5TFI4U2QSHTVAC667T";

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

describe("formatToken", () => {
  it("behaves identically to formatUSDC", () => {
    expect(formatToken(1_000_000_000n)).toBe(formatUSDC(1_000_000_000n));
    expect(formatToken(1n, 6)).toBe(formatUSDC(1n, 6));
  });
});

describe("isValidStellarAddress", () => {
  it("accepts valid account address", () => {
    expect(isValidStellarAddress(VALID_ACCOUNT)).toBe(true);
  });

  it("accepts valid contract address", () => {
    expect(isValidStellarAddress(VALID_CONTRACT)).toBe(true);
  });

  it("rejects short address", () => {
    expect(isValidStellarAddress("GABC")).toBe(false);
  });

  it("rejects invalid prefix", () => {
    expect(isValidStellarAddress("X" + "A".repeat(55))).toBe(false);
  });

  it("rejects lowercase", () => {
    expect(isValidStellarAddress("g" + "a".repeat(55))).toBe(false);
  });
});

describe("toFiatDisplay", () => {
  it("returns token and fiat amounts", async () => {
    const mockFeed: PriceFeedAdapter = {
      getPrice: vi.fn().mockResolvedValue(1.0),
    };
    const result = await toFiatDisplay(
      1_000_000_000n,
      7,
      mockFeed,
      VALID_CONTRACT,
      "usd"
    );
    expect(result.tokenAmount).toBe("100.0000000");
    expect(result.fiatAmount).toBe("100.00");
    expect(mockFeed.getPrice).toHaveBeenCalledWith(VALID_CONTRACT, "usd");
  });

  it("handles different price", async () => {
    const mockFeed: PriceFeedAdapter = {
      getPrice: vi.fn().mockResolvedValue(2.5),
    };
    const result = await toFiatDisplay(
      1_000_000_000n,
      7,
      mockFeed,
      VALID_CONTRACT,
      "eur"
    );
    expect(result.fiatAmount).toBe("250.00");
  });
});

describe("calculateFlowRate", () => {
  it("calculates flow rate correctly", () => {
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
    expect(claimable).toBeGreaterThanOrEqual(49_900n);
    expect(claimable).toBeLessThanOrEqual(50_100n);
  });

  it("caps at end time", () => {
    const now = Math.floor(Date.now() / 1000);
    const stream: Stream = makeStream({
      status: "Active",
      flowRate: 100n,
      lastWithdrawTime: now - 2000,
      endTime: now - 1000,
    });
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
  const endTime = startTime + 4 * 365 * 24 * 3600;
  const flowRate = 10n;
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
    const now = startTime + 100;
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
    const now = startTime + cliff + 500;
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
    const now = endTime + 10_000;
    const result = calculateVestingSchedule(
      makeVestingStream(),
      cliff,
      now
    );
    const vestedAfterCliff = flowRate * BigInt(endTime - startTime - cliff);
    expect(result.effectiveClaimable).toBe(vestedAfterCliff);
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
    expect(result.milestones[0]!.time).toBe(startTime + cliff);
  });

  it("returns milestones sorted by time", () => {
    const cliff = 365 * 24 * 3600;
    const result = calculateVestingSchedule(
      makeVestingStream(),
      cliff,
      startTime
    );
    for (let i = 1; i < result.milestones.length; i++) {
      expect(result.milestones[i]!.time).toBeGreaterThan(
        result.milestones[i - 1]!.time
      );
    }
  });

  it("total amount matches deposit", () => {
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
    vi.useFakeTimers();
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
    expect(onTick).toHaveBeenCalledWith(5000n);
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

    onTick.mockClear();

    vi.advanceTimersByTime(1000);

    expect(onTick).toHaveBeenCalled();

    const calls = onTick.mock.calls;
    const lastCall = calls[calls.length - 1] as [bigint];
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
      getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
      signTransaction: vi.fn().mockResolvedValue("signed_xdr"),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    client = new SoroStreamClient({
      network: "testnet",
      contractId: VALID_CONTRACT,
      walletAdapter: mockAdapter,
    });
  });

  it("rejects estimateCreateStreamFee with zero amount", async () => {
    await expect(
      client.estimateCreateStreamFee({
        recipient: VALID_ACCOUNT,
        token: VALID_CONTRACT,
        amount: 0n,
        durationSeconds: 1000,
        autoRenew: false,
      })
    ).rejects.toThrow("Amount must be > 0");
  });

  it("rejects estimateCreateStreamFee with zero duration", async () => {
    await expect(
      client.estimateCreateStreamFee({
        recipient: VALID_ACCOUNT,
        token: VALID_CONTRACT,
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
      getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
      signTransaction: vi.fn().mockResolvedValue("signed_xdr"),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    client = new SoroStreamClient({
      network: "testnet",
      contractId: VALID_CONTRACT,
      walletAdapter: mockAdapter,
    });
  });

  it("rejects createStream with zero amount (InsufficientAmountError)", async () => {
    await expect(
      client.createStream({
        recipient: VALID_ACCOUNT,
        token: VALID_CONTRACT,
        amount: 0n,
        durationSeconds: 1000,
        autoRenew: false,
      })
    ).rejects.toThrow(InsufficientAmountError);
  });

  it("rejects createStream with zero duration", async () => {
    await expect(
      client.createStream({
        recipient: VALID_ACCOUNT,
        token: VALID_CONTRACT,
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

  it("InvalidAddressError extends SoroStreamError", () => {
    const err = new InvalidAddressError("INVALID");
    expect(err).toBeInstanceOf(SoroStreamError);
    expect(err.message).toContain("Invalid Stellar address");
  });

  it("AccountNotFoundError extends SoroStreamError", () => {
    const err = new AccountNotFoundError("GNOPE");
    expect(err).toBeInstanceOf(SoroStreamError);
    expect(err.message).toContain("Account not found");
  });
});

// ── createKeypairAdapter tests ────────────────────────────────────────────────

describe("createKeypairAdapter", () => {
  it("returns a connected WalletAdapter", async () => {
    const adapter = createKeypairAdapter(
      "SDNOE4D4CJ4BWNE5DCYCFSZCRAIWVV3UGMZZZURFJPUK7LI7EXWWLE2M"
    );
    expect(await adapter.isConnected()).toBe(true);
    expect(await adapter.getPublicKey()).toBe(kp.publicKey());
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
      getPublicKey: vi.fn().mockResolvedValue("GD6YQXH4ESCIYGLKLMHZRLNOOMS475NAHGHOJK2MFSY3QERPINRQCXAN"),
      signTransaction: vi.fn().mockResolvedValue("signed_xdr"),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    client = new SoroStreamClient({
      network: "testnet",
      contractId: VALID_CONTRACT,
      walletAdapter: mockAdapter,
    });

    vi.spyOn(client as any, "buildAndSubmitBatch").mockResolvedValue("txhash_batch");
    vi.spyOn(client, "getClaimable").mockResolvedValue(500n);
  });

  it("calls buildAndSubmitBatch with correct number of operations", async () => {
    const results = await client.batchWithdraw(["1", "2", "3"], 8);

    expect(results).toHaveLength(1);
    expect(results[0]!.txHash).toBe("txhash_batch");
    expect(results[0]!.streamIds).toEqual(["1", "2", "3"]);
  });

  it("splits into multiple batches when count exceeds batchSize", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => String(i + 1));
    const results = await client.batchWithdraw(ids, 3);

    expect(results).toHaveLength(4);
    expect(results[0]!.streamIds).toHaveLength(3);
    expect(results[3]!.streamIds).toHaveLength(1);
  });
});

// ── bulkCreateStreams validation tests ────────────────────────────────────────

describe("SoroStreamClient bulkCreateStreams", () => {
  let client: SoroStreamClient;
  let mockAdapter: WalletAdapter;

  beforeEach(() => {
    mockAdapter = {
      getPublicKey: vi.fn().mockResolvedValue("GD6YQXH4ESCIYGLKLMHZRLNOOMS475NAHGHOJK2MFSY3QERPINRQCXAN"),
      signTransaction: vi.fn().mockResolvedValue("signed_xdr"),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    client = new SoroStreamClient({
      network: "testnet",
      contractId: VALID_CONTRACT,
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
      { recipient: "GC67CTZFJUVIZ3FL2QRAJ7YRPPYIHF53QXHQMOSWINB5EHJHFQFRKT7K", amount: 100n, durationSeconds: 3600 },
      { recipient: "GCIA5SUX53DFPONYDFKTTOTVGONY25VBMZRHM2QH4ME7DGEGQOVM2XZD", amount: 200n, durationSeconds: 7200 },
    ];

    const result = await client.bulkCreateStreams(rows, {
      token: "GBXESJQLSNQE7ABHMZDZWV434OMMVRFEJ7OJ6VI2C32XJRSLTOYPNUW7",
      autoRenew: false,
      batchSize: 8,
    });

    expect(result.batches).toHaveLength(1);
    expect(result.batches[0]!.txHash).toBe("txhash_bulk");
    expect(result.batches[0]!.streamIds).toEqual(["10", "11"]);
  });

  it("defaults autoRenew to false", async () => {
    vi.spyOn(client, "getStreamsBySender").mockResolvedValue([]);

    const rows: BulkStreamRow[] = [
      { recipient: "GC67CTZFJUVIZ3FL2QRAJ7YRPPYIHF53QXHQMOSWINB5EHJHFQFRKT7K", amount: 100n, durationSeconds: 3600 },
    ];

    const result = await client.bulkCreateStreams(rows, {
      token: "GBXESJQLSNQE7ABHMZDZWV434OMMVRFEJ7OJ6VI2C32XJRSLTOYPNUW7",
    });

    expect(result.batches).toHaveLength(1);
    expect(result.batches[0]!.streamIds).toEqual([]);
  });
});

// ── Pre-flight validation tests (Issue 2) ────────────────────────────────────

describe("createStream pre-flight validation", () => {
  let client: SoroStreamClient;
  let mockAdapter: WalletAdapter;

  beforeEach(() => {
    mockAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
      signTransaction: vi.fn().mockResolvedValue("signed_xdr"),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    client = new SoroStreamClient({
      network: "testnet",
      contractId: VALID_CONTRACT,
      walletAdapter: mockAdapter,
    });
  });

  it("rejects invalid recipient address format", async () => {
    await expect(
      client.createStream({
        recipient: "INVALID",
        token: VALID_CONTRACT,
        amount: 100n,
        durationSeconds: 1000,
        autoRenew: false,
      })
    ).rejects.toThrow(InvalidAddressError);
  });

  it("rejects invalid token address format", async () => {
    await expect(
      client.createStream({
        recipient: VALID_ACCOUNT,
        token: "SHORT",
        amount: 100n,
        durationSeconds: 1000,
        autoRenew: false,
      })
    ).rejects.toThrow(InvalidAddressError);
  });

  it("rejects non-existent recipient account", async () => {
    const mockServer = {
      getAccount: vi.fn().mockRejectedValue(new Error("not found")),
      simulateTransaction: vi.fn(),
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      getTransaction: vi.fn(),
    };
    (client as any).server = mockServer;

    await expect(
      client.createStream({
        recipient: VALID_ACCOUNT,
        token: VALID_CONTRACT,
        amount: 100n,
        durationSeconds: 1000,
        autoRenew: false,
      })
    ).rejects.toThrow(AccountNotFoundError);
  });

  it("rejects non-existent sender account", async () => {
    let callCount = 0;
    const mockServer = {
      getAccount: vi.fn().mockImplementation(async (addr: string) => {
        callCount++;
        if (callCount === 1) {
          return { accountId: () => addr };
        }
        throw new Error("not found");
      }),
      simulateTransaction: vi.fn(),
      prepareTransaction: vi.fn(),
      sendTransaction: vi.fn(),
      getTransaction: vi.fn(),
    };
    (client as any).server = mockServer;

    await expect(
      client.createStream({
        recipient: VALID_ACCOUNT,
        token: VALID_CONTRACT,
        amount: 100n,
        durationSeconds: 1000,
        autoRenew: false,
      })
    ).rejects.toThrow(AccountNotFoundError);
  });
});

// ── Contract versioning tests (Issue 4) ──────────────────────────────────────

describe("contract versioning", () => {
  const testContract = new Contract(VALID_CONTRACT);

  it("v1 encoder creates correct create_stream operation", () => {
    const encoder = createContractEncoder(testContract, "v1");
    const op = encoder.createStream(VALID_ACCOUNT, {
      recipient: VALID_ACCOUNT,
      token: VALID_CONTRACT,
      amount: 1000n,
      durationSeconds: 3600,
      autoRenew: false,
    });
    expect(op).toBeDefined();
    expect(op.toXDR()).toBeTruthy();
  });

  it("v2 encoder creates correct create_stream operation", () => {
    const encoder = createContractEncoder(testContract, "v2");
    const op = encoder.createStream(VALID_ACCOUNT, {
      recipient: VALID_ACCOUNT,
      token: VALID_CONTRACT,
      amount: 1000n,
      durationSeconds: 3600,
      autoRenew: true,
    });
    expect(op).toBeDefined();
    expect(op.toXDR()).toBeTruthy();
  });

  it("v1 encoder creates correct withdraw operation", () => {
    const encoder = createContractEncoder(testContract, "v1");
    const op = encoder.withdraw("1", VALID_ACCOUNT);
    expect(op).toBeDefined();
    expect(op.toXDR()).toBeTruthy();
  });

  it("v1 encoder creates correct cancel_stream operation", () => {
    const encoder = createContractEncoder(testContract, "v1");
    const op = encoder.cancelStream("1", VALID_ACCOUNT);
    expect(op).toBeDefined();
    expect(op.toXDR()).toBeTruthy();
  });

  it("v1 encoder creates correct top_up operation", () => {
    const encoder = createContractEncoder(testContract, "v1");
    const op = encoder.topUp("1", VALID_ACCOUNT, 500n);
    expect(op).toBeDefined();
    expect(op.toXDR()).toBeTruthy();
  });

  it("client uses versioned encoder based on contractVersion option", () => {
    const adapter: WalletAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
      signTransaction: vi.fn().mockResolvedValue("signed_xdr"),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    const client = new SoroStreamClient({
      network: "testnet",
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      contractVersion: "v2",
    });

    const encoder = (client as any).encoder;
    expect(encoder).toBeDefined();
  });
});

// ── Price feed adapter tests (Issue 1) ───────────────────────────────────────

describe("price feed adapter integration", () => {
  it("client exposes price feed via getPriceFeed()", () => {
    const mockFeed: PriceFeedAdapter = {
      getPrice: vi.fn().mockResolvedValue(1.0),
    };

    const adapter: WalletAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
      signTransaction: vi.fn().mockResolvedValue("signed_xdr"),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    const client = new SoroStreamClient({
      network: "testnet",
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
      priceFeed: mockFeed,
    });

    expect(client.getPriceFeed()).toBe(mockFeed);
  });

  it("client returns null price feed when not configured", () => {
    const adapter: WalletAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
      signTransaction: vi.fn().mockResolvedValue("signed_xdr"),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    const client = new SoroStreamClient({
      network: "testnet",
      contractId: VALID_CONTRACT,
      walletAdapter: adapter,
    });

    expect(client.getPriceFeed()).toBeNull();
  });
});

// ── Fee bump option tests (Issue 3) ──────────────────────────────────────────

describe("fee bump options", () => {
  it("client accepts default fee bump options", () => {
    const sponsorAdapter: WalletAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
      signTransaction: vi.fn().mockResolvedValue("signed_fee_bump"),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    const userAdapter: WalletAdapter = {
      getPublicKey: vi.fn().mockResolvedValue(VALID_ACCOUNT),
      signTransaction: vi.fn().mockResolvedValue("signed_inner"),
      isConnected: vi.fn().mockResolvedValue(true),
    };

    const feeBump: FeeBumpOptions = {
      sponsorAddress: VALID_ACCOUNT,
      sponsorAdapter,
      maxFee: 10_000,
    };

    const client = new SoroStreamClient({
      network: "testnet",
      contractId: VALID_CONTRACT,
      walletAdapter: userAdapter,
      feeBump,
    });

    const defaultBump = (client as any).defaultFeeBump;
    expect(defaultBump).toBe(feeBump);
    expect(defaultBump.sponsorAddress).toBe(VALID_ACCOUNT);
    expect(defaultBump.maxFee).toBe(10_000);
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

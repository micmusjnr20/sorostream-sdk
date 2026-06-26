import type {
  Stream,
  VestingScheduleResult,
  WatchClaimableOptions,
} from "./types.js";
import type { Stream, BulkStreamRow, TokenAggregate } from "./types.js";

const STROOP_FACTOR = 10_000_000n;

/**
 * Converts a token amount (as a decimal string like "100.50") to stroops/smallest unit.
 * @param amount - Amount as a decimal string.
 * @param decimals - Number of decimal places the token uses (default 7 for SAC).
 */
export function toStroops(amount: string, decimals: number = 7): bigint {
  const [whole = "0", decimal = ""] = amount.split(".");
  const factor = 10n ** BigInt(decimals);
  const paddedDecimal = decimal.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(whole) * factor + BigInt(paddedDecimal);
}

/**
 * Formats a stroop amount to a human-readable token string (e.g. "100.5000000").
 * @param stroops - Amount in the smallest token unit.
 * @param decimals - Number of decimal places the token uses (default 7 for SAC).
 */
export function formatUSDC(stroops: bigint, decimals: number = 7): string {
  const factor = 10n ** BigInt(decimals);
  const whole = stroops / factor;
  const remainder = stroops % factor;
  return `${whole}.${remainder.toString().padStart(decimals, "0")}`;
}

/**
 * Calculates the per-second flow rate in stroops.
 * @param amount - Total amount in stroops.
 * @param durationSeconds - Duration in seconds.
 */
export function calculateFlowRate(amount: bigint, durationSeconds: number): bigint {
  if (durationSeconds <= 0) throw new SoroStreamError("Duration must be > 0");
  return amount / BigInt(durationSeconds);
}

/**
 * Returns the number of seconds remaining until the stream ends.
 * Returns 0 if the stream has already ended.
 * @param stream - The stream object.
 */
export function timeUntilStreamEnd(stream: Stream): number {
  const now = Math.floor(Date.now() / 1000);
  return Math.max(0, stream.endTime - now);
}

/**
 * Calculates the currently claimable amount in stroops based on local time.
 * This is an estimate — the contract is the source of truth.
 * @param stream - The stream object.
 */
export function claimableNow(stream: Stream): bigint {
  if (stream.status !== "Active") return 0n;
  const now = Math.floor(Date.now() / 1000);
  const effectiveNow = Math.min(now, stream.endTime);
  const elapsed = Math.max(0, effectiveNow - stream.lastWithdrawTime);
  return stream.flowRate * BigInt(elapsed);
}

/**
 * Computes a display-only vesting schedule that approximates a cliff.
 *
 * The contract streams linearly from `startTime` with no cliff concept.
 * A "4-year vesting with 1-year cliff" can only be approximated by adjusting
 * the displayed schedule — **this is NOT enforced on-chain**.
 *
 * @param stream - The stream object.
 * @param cliffSeconds - Duration of the cliff period in seconds.
 * @param now - Optional override for "current" time (Unix seconds). Defaults to Date.now().
 */
export function calculateVestingSchedule(
  stream: Stream,
  cliffSeconds: number,
  now?: number
): VestingScheduleResult {
  const currentTime = now ?? Math.floor(Date.now() / 1000);
  const cliffEndTime = stream.startTime + cliffSeconds;
  const inCliff = currentTime < cliffEndTime;
  const totalSeconds = stream.endTime - stream.startTime;
  const totalAmount = stream.flowRate * BigInt(totalSeconds);

  let effectiveClaimable: bigint;
  if (inCliff) {
    effectiveClaimable = 0n;
  } else {
    const elapsed = Math.min(currentTime, stream.endTime) - Math.max(cliffEndTime, stream.startTime);
    effectiveClaimable = stream.flowRate * BigInt(Math.max(0, elapsed));
    if (effectiveClaimable > totalAmount) effectiveClaimable = totalAmount;
  }

  const milestones: Array<{ time: number; vested: bigint }> = [];

  if (cliffSeconds < totalSeconds) {
    milestones.push({
      time: cliffEndTime,
      vested: stream.flowRate * BigInt(cliffSeconds),
    });
  }

  for (const pct of [0.25, 0.5, 0.75, 1]) {
    const t = stream.startTime + Math.floor(totalSeconds * pct);
    if (t > cliffEndTime) {
      milestones.push({
        time: t,
        vested: stream.flowRate * BigInt(Math.floor(totalSeconds * pct)),
      });
    }
  }

  milestones.sort((a, b) => a.time - b.time);

  return {
    effectiveClaimable,
    totalAmount,
    cliffEndTime,
    inCliff,
    milestones,
  };
}

/**
 * Creates a live "counting up" ticker for the claimable balance of a stream.
 *
 * Emits smoothly interpolated claimable values on an interval, reconciled
 * periodically against the on-chain `getClaimable` value. Returns an unsubscribe
 * function to stop the ticker.
 *
 * @param stream - The stream object.
 * @param reconcile - Async function that fetches the current on-chain claimable (typically `client.getClaimable(id)`).
 * @param onTick - Callback invoked with the current interpolated claimable value in stroops.
 * @param options - Optional configuration.
 * @returns A function that stops the ticker when called.
 *
 * @example
 * ```ts
 * const unsubscribe = watchClaimable(
 *   stream,
 *   () => client.getClaimable(stream.id),
 *   (claimable) => { displayElement.textContent = formatUSDC(claimable); }
 * );
 * // later: unsubscribe();
 * ```
 */
export function watchClaimable(
  stream: Stream,
  reconcile: () => Promise<bigint>,
  onTick: (claimable: bigint) => void,
  options?: WatchClaimableOptions
): () => void {
  const tickMs = options?.tickMs ?? 200;
  const reconcileMs = options?.reconcileMs ?? 5_000;
  let baseValue = claimableNow(stream);
  let baseTime = Date.now();
  let stopped = false;

  onTick(baseValue);

  function emit() {
    if (stopped) return;
    const elapsedMs = Date.now() - baseTime;
    const perMs = Number(stream.flowRate) / 1000;
    const interpolated = baseValue + BigInt(Math.floor(perMs * elapsedMs));
    onTick(interpolated);
  }

  const tickTimer = setInterval(emit, tickMs);

  const reconcileTimer = setInterval(async () => {
    if (stopped) return;
    try {
      const actual = await reconcile();
      baseValue = actual;
      baseTime = Date.now();
      emit();
    } catch {
      // swallow — keep interpolating from last known value
    }
  }, reconcileMs);

  return () => {
    stopped = true;
    clearInterval(tickTimer);
    clearInterval(reconcileTimer);
  };
 * Groups streams by token address and returns per-token aggregates.
 * Uses the client-side `claimableNow` for claimable estimates.
 *
 * @param streams - Stream list (e.g. from getStreamsByRecipient).
 * @returns Per-token aggregates sorted by deposited amount descending.
 *
 * @example
 * ```ts
 * const streams = await client.getStreamsByRecipient(recipient);
 * const agg = aggregateStreamsByToken(streams);
 * for (const t of agg) console.log(t.token, t.claimable);
 * ```
 */
export function aggregateStreamsByToken(streams: Stream[]): TokenAggregate[] {
  const map = new Map<string, TokenAggregate>();

  for (const s of streams) {
    const existing = map.get(s.token) ?? {
      token: s.token,
      streamCount: 0,
      deposited: 0n,
      claimable: 0n,
      claimedSoFar: 0n,
    };
    existing.streamCount += 1;
    existing.deposited += s.deposit;
    existing.claimable += claimableNow(s);
    existing.claimedSoFar += s.deposit - s.flowRate * BigInt(s.endTime - s.lastWithdrawTime);
    map.set(s.token, existing);
  }

  return [...map.values()].sort((a, b) => {
    if (b.deposited > a.deposited) return 1;
    if (b.deposited < a.deposited) return -1;
    return 0;
  });
}

/**
 * Parses a CSV string into BulkStreamRow objects.
 *
 * Expected CSV format (header required):
 * ```
 * recipient,amount,durationSeconds
 * GABCD...1,10000000,2592000
 * GABCD...2,5000000,604800
 * ```
 *
 * `amount` is in stroops (bigint-compatible string).
 *
 * @param csv - The CSV content with header row.
 * @returns Parsed rows.
 */
export function parseCsvStreamRows(csv: string): BulkStreamRow[] {
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("CSV must have a header row and at least one data row");

  const header = lines[0].toLowerCase().trim();
  const cols = header.split(",").map((c) => c.trim());

  const recipientIdx = cols.indexOf("recipient");
  const amountIdx = cols.indexOf("amount");
  const durationIdx = cols.indexOf("durationseconds");

  if (recipientIdx === -1) throw new Error("CSV missing 'recipient' column");
  if (amountIdx === -1) throw new Error("CSV missing 'amount' column");
  if (durationIdx === -1) throw new Error("CSV missing 'durationSeconds' column");

  const rows: BulkStreamRow[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const fields = line.split(",").map((f) => f.trim());

    const recipient = fields[recipientIdx];
    if (!recipient) throw new Error(`Row ${i + 1}: missing recipient`);

    const amount = BigInt(fields[amountIdx]);
    const durationSeconds = Number(fields[durationIdx]);

    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
      throw new Error(`Row ${i + 1}: invalid durationSeconds`);
    }

    rows.push({ recipient, amount, durationSeconds });
  }

  return rows;
}

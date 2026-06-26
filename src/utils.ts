import type { Stream, StreamFilterCriteria, StreamStatus } from "./types.js";

const STROOP_FACTOR = 10_000_000n;

/**
 * Converts a USDC amount (as a decimal string like "100.50") to stroops.
 * @param usdc - USDC amount as a decimal string.
 */
export function toStroops(usdc: string): bigint {
  const [whole = "0", decimal = ""] = usdc.split(".");
  const paddedDecimal = decimal.padEnd(7, "0").slice(0, 7);
  return BigInt(whole) * STROOP_FACTOR + BigInt(paddedDecimal);
}

/**
 * Formats a stroop amount to a human-readable USDC string (e.g. "100.5000000").
 * @param stroops - Amount in stroops.
 */
export function formatUSDC(stroops: bigint): string {
  const whole = stroops / STROOP_FACTOR;
  const remainder = stroops % STROOP_FACTOR;
  return `${whole}.${remainder.toString().padStart(7, "0")}`;
}

/**
 * Calculates the per-second flow rate in stroops.
 * @param amount - Total amount in stroops.
 * @param durationSeconds - Duration in seconds.
 */
export function calculateFlowRate(amount: bigint, durationSeconds: number): bigint {
  if (durationSeconds <= 0) throw new Error("Duration must be > 0");
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

function matchesStatus(stream: Stream, status: StreamStatus | StreamStatus[]): boolean {
  const allowed = Array.isArray(status) ? status : [status];
  return allowed.includes(stream.status);
}

/**
 * Filters a list of streams by common dashboard criteria.
 * All criteria are optional and combined with logical AND.
 *
 * @param streams - Streams returned by getStreamsBySender or getStreamsByRecipient.
 * @param criteria - Optional filters for status, token, and time bounds.
 */
export function filterStreams(
  streams: Stream[],
  criteria: StreamFilterCriteria = {}
): Stream[] {
  return streams.filter((stream) => {
    if (criteria.status !== undefined && !matchesStatus(stream, criteria.status)) {
      return false;
    }
    if (criteria.token !== undefined && stream.token !== criteria.token) {
      return false;
    }
    if (criteria.startsAfter !== undefined && stream.startTime <= criteria.startsAfter) {
      return false;
    }
    if (criteria.endsBefore !== undefined && stream.endTime >= criteria.endsBefore) {
      return false;
    }
    return true;
  });
}

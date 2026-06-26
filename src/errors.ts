export class SoroStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SoroStreamError";
  }
}

export class InsufficientAmountError extends SoroStreamError {
  constructor(message?: string) {
    super(message ?? "Amount must be > 0");
    this.name = "InsufficientAmountError";
  }
}

export class StreamNotFoundError extends SoroStreamError {
  constructor(streamId: string) {
    super(`Stream not found: ${streamId}`);
    this.name = "StreamNotFoundError";
  }
}

export class StreamNotActiveError extends SoroStreamError {
  constructor(streamId: string) {
    super(`Stream is not active: ${streamId}`);
    this.name = "StreamNotActiveError";
  }
}

export class TransactionFailedError extends SoroStreamError {
  constructor(details: string) {
    super(`Transaction failed: ${details}`);
    this.name = "TransactionFailedError";
  }
}

export class InvalidAddressError extends SoroStreamError {
  constructor(address: string) {
    super(`Invalid Stellar address: ${address}`);
    this.name = "InvalidAddressError";
  }
}

export class AccountNotFoundError extends SoroStreamError {
  constructor(address: string) {
    super(`Account not found on-chain: ${address}`);
    this.name = "AccountNotFoundError";
  }
}

export class InsufficientBalanceError extends SoroStreamError {
  constructor(message?: string) {
    super(message ?? "Insufficient token balance or missing trustline");
    this.name = "InsufficientBalanceError";
  }
}

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

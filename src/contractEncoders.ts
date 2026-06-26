import { Contract, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { ContractVersion, CreateStreamParams } from "./types.js";

export interface ContractCallEncoder {
  createStream(sender: string, params: CreateStreamParams): xdr.Operation;
  withdraw(streamId: string, recipient: string): xdr.Operation;
  cancelStream(streamId: string, sender: string): xdr.Operation;
  topUp(streamId: string, sender: string, amount: bigint): xdr.Operation;
}

class V1Encoder implements ContractCallEncoder {
  constructor(private contract: Contract) {}

  createStream(sender: string, params: CreateStreamParams): xdr.Operation {
    return this.contract.call(
      "create_stream",
      nativeToScVal(sender, { type: "address" }),
      nativeToScVal(params.recipient, { type: "address" }),
      nativeToScVal(params.token, { type: "address" }),
      nativeToScVal(params.amount, { type: "i128" }),
      nativeToScVal(params.durationSeconds, { type: "u64" }),
      nativeToScVal(params.autoRenew, { type: "bool" })
    );
  }

  withdraw(streamId: string, recipient: string): xdr.Operation {
    return this.contract.call(
      "withdraw",
      nativeToScVal(BigInt(streamId), { type: "u64" }),
      nativeToScVal(recipient, { type: "address" })
    );
  }

  cancelStream(streamId: string, sender: string): xdr.Operation {
    return this.contract.call(
      "cancel_stream",
      nativeToScVal(BigInt(streamId), { type: "u64" }),
      nativeToScVal(sender, { type: "address" })
    );
  }

  topUp(streamId: string, sender: string, amount: bigint): xdr.Operation {
    return this.contract.call(
      "top_up",
      nativeToScVal(BigInt(streamId), { type: "u64" }),
      nativeToScVal(sender, { type: "address" }),
      nativeToScVal(amount, { type: "i128" })
    );
  }
}

class V2Encoder extends V1Encoder {
  constructor(contract: Contract) {
    super(contract);
  }
}

export function createContractEncoder(
  contract: Contract,
  version: ContractVersion
): ContractCallEncoder {
  switch (version) {
    case "v2":
      return new V2Encoder(contract);
    case "v1":
    default:
      return new V1Encoder(contract);
  }
}

#!/usr/bin/env node

import { createPublicKey, verify as verifySignature } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

const ZERO_HASH = "0".repeat(64);
const DEFAULT_PROGRAM_ID =
  process.env.TRADESTARS_PROGRAM_ID ??
  "2YEsWGLfhsUwDWoFCEZQQeES8KN9jHHRXLkbtwoDQGV8";
const DEFAULT_BASE_URL = process.env.TRADESTARS_BASE_URL ?? "tradestars.app";
const DEFAULT_RPC =
  process.env.SOLANA_RPC ??
  process.env.TRADESTARS_SOLANA_RPC ??
  "https://api.devnet.solana.com";

const CLAIM_WINNINGS_DISCRIMINATOR = Buffer.from([
  161, 215, 24, 59, 14, 236, 242, 221,
]);
const CLAIM_REFUND_DISCRIMINATOR = Buffer.from([
  15, 16, 30, 161, 255, 228, 97, 60,
]);

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

type ProofKey = {
  keyId: string;
  publicKeyPem: string;
};

type StatsProofEvent = {
  arenaId: string;
  statsSeq: number;
  createdAt: number;
  previousStatsHash: string;
  sourceSnapshotsRoot: string;
  playerDeltasRoot: string;
  sourceSnapshots: unknown[];
  playerDeltas: unknown[];
  statsHash: string;
  signerKeyId: string;
  signature: string;
};

type SettlementProof = {
  arenaId: string;
  status: "proposed" | "finalized";
  settlementVersion: number;
  proposedAt: number;
  finalizedAt?: number;
  claimableAt: number;
  onChainStatus: "settled" | "finalized";
  finalStatsSeq: number;
  finalStatsHash: string;
  participantScoresRoot: string;
  payoutMerkleRoot: number[];
  payoutTxSignature: string;
  settlementManifestHash: string;
  signerKeyId: string;
  signature: string;
};

type ClaimProof = {
  arenaId: string;
  wallet: string;
  status: "proposed" | "finalized";
  onChainStatus: "settled" | "finalized";
  settlementVersion: number;
  claimableAt: number;
  payoutMerkleRoot: number[];
  lockedAmountRaw: string;
  payoutAmountRaw: string;
  proof: number[][];
  settlementManifestHash: string;
  payoutTxSignature: string;
};

type ArenaEntryCommitment = {
  arenaId: string;
  commitmentSeq: number;
  createdAt: number;
  previousCommitmentHash: string;
  entryIdHash: string;
  entrySeq: number;
  entryHash: string;
  commitmentHash: string;
  signerKeyId: string;
  signature: string;
};

type EntryTimelineEvent = {
  arenaId: string;
  entryId: string;
  entrySeq: number;
  type:
    | "entry_created"
    | "trade_executed"
    | "score_applied"
    | "theta_decay_applied"
    | "entry_finalized";
  occurredAt: number;
  previousEntryHash: string;
  payload: Record<string, unknown>;
  entryHash: string;
};

type ReplayProof = {
  entry: {
    id: string;
    arenaId: string;
    walletAddress: string;
    entryNumber: number;
    tier: "free" | "paid";
    createdAt: number;
    entryTxSignature: string;
  };
  arena: {
    id: string;
    name: string;
    sport: "FOOTBALL" | "CRICKET";
    status: string;
    startTime: number;
    endTime: number;
    entryFee: number;
  };
  entryIdHash: string;
  commitments: ArenaEntryCommitment[];
  events: EntryTimelineEvent[];
  settlement: SettlementProof | null;
  claimProof: ClaimProof | null;
};

type CommitmentsResponse = {
  arenaId: string;
  count: number;
  latestCommitmentHash: string;
  commitments: ArenaEntryCommitment[];
};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function requiredArg(name: string): string {
  const value = arg(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function baseUrl(): string {
  const value = (arg("--base-url") ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function rpcUrl(): string {
  return arg("--rpc") ?? DEFAULT_RPC;
}

function programId(): PublicKey {
  return new PublicKey(arg("--program-id") ?? DEFAULT_PROGRAM_ID);
}

function normalizeJson(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Cannot hash non-finite number");
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map((item) => normalizeJson(item));
  if (typeof value === "object") {
    const object = value as Record<string, unknown>;
    return Object.keys(object)
      .filter((key) => object[key] !== undefined)
      .sort()
      .reduce<Record<string, JsonValue>>((result, key) => {
        result[key] = normalizeJson(object[key]);
        return result;
      }, {});
  }
  throw new Error(`Cannot hash unsupported value type: ${typeof value}`);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function proofHash(value: unknown): string {
  return Buffer.from(keccak_256(Buffer.from(canonicalJson(value)))).toString(
    "hex",
  );
}

function hashPair(left: string, right: string): string {
  const ordered = left <= right ? [left, right] : [right, left];
  return Buffer.from(
    keccak_256(Buffer.concat(ordered.map((hash) => Buffer.from(hash, "hex")))),
  ).toString("hex");
}

function buildMerkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return ZERO_HASH;
  let level = leaves.slice().sort();
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const left = level[index];
      const right = level[index + 1];
      next.push(right ? hashPair(left, right) : left);
    }
    level = next.sort();
  }
  return level[0];
}

function hashBytes(bytes: Uint8Array): Buffer {
  return Buffer.from(keccak_256(bytes));
}

function hashPairBytes(left: Buffer, right: Buffer): Buffer {
  const ordered = Buffer.compare(left, right) <= 0 ? [left, right] : [right, left];
  return hashBytes(Buffer.concat(ordered));
}

function assertValid(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function verifyProofSignature(params: {
  hash: string;
  signature: string;
  publicKeyPem: string;
}): boolean {
  return verifySignature(
    null,
    Buffer.from(params.hash, "hex"),
    createPublicKey(params.publicKeyPem),
    Buffer.from(params.signature, "base64"),
  );
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(`${baseUrl()}${path}`);
  if (!response.ok) {
    throw new Error(`${path} returned ${response.status}`);
  }
  return (await response.json()) as T;
}

function u64Le(value: bigint): Buffer {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(value);
  return buffer;
}

function u32Le(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function arenaIdBuffer(arenaId: string): Buffer {
  const normalized = arenaId.replace(/-/g, "");
  if (normalized.length !== 32) {
    throw new Error("Arena ID must normalize to exactly 32 bytes");
  }
  return Buffer.from(normalized, "utf8");
}

function settlementLeaf(params: {
  arenaId: string;
  settlementVersion: number;
  wallet: string;
  lockedAmountRaw: bigint;
  payoutAmountRaw: bigint;
}): Buffer {
  return hashBytes(
    Buffer.concat([
      arenaIdBuffer(params.arenaId),
      u32Le(params.settlementVersion),
      new PublicKey(params.wallet).toBuffer(),
      u64Le(params.lockedAmountRaw),
      u64Le(params.payoutAmountRaw),
    ]),
  );
}

function verifyClaimProof(proof: ClaimProof): void {
  let hash = settlementLeaf({
    arenaId: proof.arenaId,
    settlementVersion: proof.settlementVersion,
    wallet: proof.wallet,
    lockedAmountRaw: BigInt(proof.lockedAmountRaw),
    payoutAmountRaw: BigInt(proof.payoutAmountRaw),
  });

  for (const node of proof.proof) {
    hash = hashPairBytes(hash, Buffer.from(node));
  }

  assertValid(
    Buffer.compare(hash, Buffer.from(proof.payoutMerkleRoot)) === 0,
    "claim proof does not reconstruct payout Merkle root",
  );
}

function verifyCommitment(
  commitment: ArenaEntryCommitment,
  proofKey: ProofKey,
): void {
  const { commitmentHash, signerKeyId, signature, ...unsigned } = commitment;
  assertValid(
    proofHash(unsigned) === commitmentHash,
    `commitment #${commitment.commitmentSeq}: hash mismatch`,
  );
  assertValid(
    signerKeyId === proofKey.keyId,
    `commitment #${commitment.commitmentSeq}: signer key mismatch`,
  );
  assertValid(
    verifyProofSignature({
      hash: commitmentHash,
      signature,
      publicKeyPem: proofKey.publicKeyPem,
    }),
    `commitment #${commitment.commitmentSeq}: invalid signature`,
  );
}

function verifyCommitmentChain(
  commitments: ArenaEntryCommitment[],
  proofKey: ProofKey,
): void {
  let previousCommitmentHash = ZERO_HASH;
  for (const commitment of [...commitments].sort(
    (a, b) => a.commitmentSeq - b.commitmentSeq,
  )) {
    assertValid(
      commitment.previousCommitmentHash === previousCommitmentHash,
      `commitment #${commitment.commitmentSeq}: previous hash mismatch`,
    );
    verifyCommitment(commitment, proofKey);
    previousCommitmentHash = commitment.commitmentHash;
  }
}

function getPlatformConfigPda(id: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("config")], id)[0];
}

function getTusdcMintPda(id: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from("tusdc_mint")], id)[0];
}

function getUserAccountPda(user: PublicKey, id: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user"), user.toBuffer()],
    id,
  )[0];
}

function getArenaPda(arenaId: string, id: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("arena"), arenaIdBuffer(arenaId)],
    id,
  )[0];
}

function getPositionPda(arena: PublicKey, user: PublicKey, id: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("position"), arena.toBuffer(), user.toBuffer()],
    id,
  )[0];
}

function readKeypair(path: string): Keypair {
  const expanded = path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
  const secret = JSON.parse(readFileSync(expanded, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(secret));
}

function numberPayloadValue(
  payload: Record<string, unknown>,
  key: string,
  context: string,
): number {
  const value = payload[key];
  assertValid(typeof value === "number", `${context}: missing numeric ${key}`);
  return value;
}

function stringPayloadValue(
  payload: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const value = payload[key];
  assertValid(typeof value === "string", `${context}: missing string ${key}`);
  return value;
}

function rawToUsd(value: string | number | bigint): string {
  const raw = typeof value === "bigint" ? value : BigInt(String(value));
  const whole = raw / 1_000_000n;
  const cents = (raw % 1_000_000n) / 10_000n;
  return `${whole}.${cents.toString().padStart(2, "0")}`;
}

function pointsRawToPoints(raw: number): string {
  return (raw / 10_000).toFixed(2).replace(/\.?0+$/, "");
}

function formatEventSummary(event: EntryTimelineEvent): string {
  if (event.type === "entry_created") {
    return `entry created with ${pointsRawToPoints(numberPayloadValue(event.payload, "creditsRaw", "entry created"))} credits`;
  }
  if (event.type === "trade_executed") {
    const side = String(event.payload.side);
    const playerId = String(event.payload.playerId);
    const sharesDeltaRaw = numberPayloadValue(event.payload, "sharesDeltaRaw", "trade");
    return `${side} ${pointsRawToPoints(Math.abs(sharesDeltaRaw))} shares of ${playerId}`;
  }
  if (event.type === "score_applied") {
    const before = numberPayloadValue(event.payload, "totalPointsBeforeRaw", "score");
    const after = numberPayloadValue(event.payload, "totalPointsAfterRaw", "score");
    return `score update #${String(event.payload.statsSeq)} applied ${pointsRawToPoints(after - before)} pts`;
  }
  if (event.type === "theta_decay_applied") {
    const before = numberPayloadValue(event.payload, "totalPointsBeforeRaw", "theta");
    const after = numberPayloadValue(event.payload, "totalPointsAfterRaw", "theta");
    return `theta decay applied ${pointsRawToPoints(after - before)} pts`;
  }
  const totalPointsRaw = numberPayloadValue(event.payload, "totalPointsRaw", "final");
  const rank = numberPayloadValue(event.payload, "rank", "final");
  const payoutAmountRaw = stringPayloadValue(event.payload, "payoutAmountRaw", "final");
  return `final score ${pointsRawToPoints(totalPointsRaw)} pts, rank #${rank}, payout ${rawToUsd(payoutAmountRaw)} USD`;
}

function verifyEntryReplay(replay: ReplayProof): {
  latestHash: string;
  finalEvent: EntryTimelineEvent | null;
} {
  let previousEntryHash = ZERO_HASH;
  let currentPointsRaw = 0;
  let finalEvent: EntryTimelineEvent | null = null;

  for (const event of [...replay.events].sort((a, b) => a.entrySeq - b.entrySeq)) {
    const { entryHash, ...unsigned } = event;
    const context = `entry ${event.entryId} seq ${event.entrySeq}`;
    assertValid(
      event.previousEntryHash === previousEntryHash,
      `${context}: previous hash mismatch`,
    );
    assertValid(proofHash(unsigned) === entryHash, `${context}: hash mismatch`);

    if (event.type === "score_applied") {
      const before = numberPayloadValue(event.payload, "totalPointsBeforeRaw", context);
      const after = numberPayloadValue(event.payload, "totalPointsAfterRaw", context);
      assertValid(before === currentPointsRaw, `${context}: score before mismatch`);
      const applications = event.payload.applications;
      assertValid(Array.isArray(applications), `${context}: missing score applications`);
      const appliedDelta = applications.reduce((sum, application) => {
        const value = (application as { pointsAddedRaw?: unknown }).pointsAddedRaw;
        assertValid(typeof value === "number", `${context}: invalid score application`);
        return sum + value;
      }, 0);
      assertValid(before + appliedDelta === after, `${context}: score arithmetic mismatch`);
      currentPointsRaw = after;
    }

    if (event.type === "theta_decay_applied") {
      const before = numberPayloadValue(event.payload, "totalPointsBeforeRaw", context);
      const after = numberPayloadValue(event.payload, "totalPointsAfterRaw", context);
      assertValid(before === currentPointsRaw, `${context}: theta before mismatch`);
      currentPointsRaw = after;
    }

    if (event.type === "entry_finalized") {
      const totalPointsRaw = numberPayloadValue(event.payload, "totalPointsRaw", context);
      assertValid(totalPointsRaw === currentPointsRaw, `${context}: final points mismatch`);
      finalEvent = event;
    }

    previousEntryHash = entryHash;
  }

  return { latestHash: previousEntryHash, finalEvent };
}

function claimWinningsInstruction(params: {
  arenaId: string;
  user: PublicKey;
  lockedAmountRaw: bigint;
  payoutAmountRaw: bigint;
  proof: number[][];
  programId: PublicKey;
}): TransactionInstruction {
  const tusdcMint = getTusdcMintPda(params.programId);
  const arena = getArenaPda(params.arenaId, params.programId);
  const data = Buffer.concat([
    CLAIM_WINNINGS_DISCRIMINATOR,
    u64Le(params.lockedAmountRaw),
    u64Le(params.payoutAmountRaw),
    u32Le(params.proof.length),
    ...params.proof.map((node) => Buffer.from(node)),
  ]);

  return new TransactionInstruction({
    programId: params.programId,
    keys: [
      { pubkey: getPlatformConfigPda(params.programId), isSigner: false, isWritable: false },
      { pubkey: arena, isSigner: false, isWritable: true },
      { pubkey: getUserAccountPda(params.user, params.programId), isSigner: false, isWritable: true },
      { pubkey: getPositionPda(arena, params.user, params.programId), isSigner: false, isWritable: true },
      { pubkey: tusdcMint, isSigner: false, isWritable: true },
      {
        pubkey: getAssociatedTokenAddressSync(
          tusdcMint,
          params.user,
          false,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: params.user, isSigner: true, isWritable: true },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

function claimRefundInstruction(params: {
  arenaId: string;
  user: PublicKey;
  programId: PublicKey;
}): TransactionInstruction {
  const tusdcMint = getTusdcMintPda(params.programId);
  const arena = getArenaPda(params.arenaId, params.programId);

  return new TransactionInstruction({
    programId: params.programId,
    keys: [
      { pubkey: getPlatformConfigPda(params.programId), isSigner: false, isWritable: false },
      { pubkey: arena, isSigner: false, isWritable: true },
      { pubkey: getUserAccountPda(params.user, params.programId), isSigner: false, isWritable: true },
      { pubkey: getPositionPda(arena, params.user, params.programId), isSigner: false, isWritable: true },
      { pubkey: tusdcMint, isSigner: false, isWritable: true },
      {
        pubkey: getAssociatedTokenAddressSync(
          tusdcMint,
          params.user,
          false,
          TOKEN_2022_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        ),
        isSigner: false,
        isWritable: true,
      },
      { pubkey: params.user, isSigner: true, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: CLAIM_REFUND_DISCRIMINATOR,
  });
}

async function verifyArena(): Promise<void> {
  const arenaId = requiredArg("--arena");
  const proofKey = await getJson<ProofKey>("/api/public/proof-key");
  const stats = await getJson<{ events: StatsProofEvent[] }>(
    `/api/public/arenas/${arenaId}/stats-proof`,
  );
  const settlement = await getJson<SettlementProof>(
    `/api/public/arenas/${arenaId}/settlement-proof`,
  );

  let previousStatsHash = ZERO_HASH;
  for (const event of [...stats.events].sort((a, b) => a.statsSeq - b.statsSeq)) {
    const { statsHash, signerKeyId, signature, ...unsigned } = event;
    assertValid(event.previousStatsHash === previousStatsHash, `stats #${event.statsSeq}: previous hash mismatch`);
    assertValid(buildMerkleRoot(event.sourceSnapshots.map((leaf) => proofHash(leaf))) === event.sourceSnapshotsRoot, `stats #${event.statsSeq}: source root mismatch`);
    assertValid(buildMerkleRoot(event.playerDeltas.map((leaf) => proofHash(leaf))) === event.playerDeltasRoot, `stats #${event.statsSeq}: player root mismatch`);
    assertValid(proofHash(unsigned) === statsHash, `stats #${event.statsSeq}: hash mismatch`);
    assertValid(signerKeyId === proofKey.keyId, `stats #${event.statsSeq}: key mismatch`);
    assertValid(verifyProofSignature({ hash: statsHash, signature, publicKeyPem: proofKey.publicKeyPem }), `stats #${event.statsSeq}: invalid signature`);
    previousStatsHash = statsHash;
  }

  const { settlementManifestHash, signerKeyId, signature, ...unsignedSettlement } = settlement;
  assertValid(proofHash(unsignedSettlement) === settlementManifestHash, "settlement hash mismatch");
  assertValid(signerKeyId === proofKey.keyId, "settlement key mismatch");
  assertValid(verifyProofSignature({ hash: settlementManifestHash, signature, publicKeyPem: proofKey.publicKeyPem }), "settlement signature invalid");

  console.log(JSON.stringify({
    ok: true,
    arenaId,
    statsEvents: stats.events.length,
    settlementStatus: settlement.status,
    onChainStatus: settlement.onChainStatus,
    payoutMerkleRoot: settlement.payoutMerkleRoot,
  }, null, 2));
}

async function showClaimProof(): Promise<void> {
  const arenaId = requiredArg("--arena");
  const wallet = new PublicKey(requiredArg("--wallet")).toBase58();
  const proof = await getJson<ClaimProof>(
    `/api/public/arenas/${arenaId}/claim-proof/${wallet}`,
  );
  assertValid(proof.wallet === wallet, "claim proof wallet does not match requested wallet");
  verifyClaimProof(proof);
  console.log(JSON.stringify(proof, null, 2));
}

async function replayEntry(): Promise<void> {
  const entryId = requiredArg("--entry");
  const proofKey = await getJson<ProofKey>("/api/public/proof-key");
  const replay = await getJson<ReplayProof>(
    `/api/public/entries/${entryId}/replay-proof`,
  );
  const arenaCommitments = await getJson<CommitmentsResponse>(
    `/api/public/arenas/${replay.entry.arenaId}/commitments`,
  );

  verifyCommitmentChain(arenaCommitments.commitments, proofKey);

  const replayResult = verifyEntryReplay(replay);
  const commitmentByEntrySeq = new Map(
    arenaCommitments.commitments
      .filter((commitment) => commitment.entryIdHash === replay.entryIdHash)
      .map((commitment) => [commitment.entrySeq, commitment]),
  );

  for (const event of replay.events) {
    const commitment = commitmentByEntrySeq.get(event.entrySeq);
    assertValid(
      commitment?.entryHash === event.entryHash,
      `entry seq ${event.entrySeq}: missing matching public live commitment`,
    );
  }

  const replaySeqs = new Set(replay.events.map((event) => event.entrySeq));
  for (const commitment of commitmentByEntrySeq.values()) {
    assertValid(
      replaySeqs.has(commitment.entrySeq),
      `entry seq ${commitment.entrySeq}: public live commitment missing from replay`,
    );
  }

  if (replay.claimProof) {
    verifyClaimProof(replay.claimProof);
    if (replayResult.finalEvent) {
      const finalPayout = stringPayloadValue(
        replayResult.finalEvent.payload,
        "payoutAmountRaw",
        "final event",
      );
      assertValid(
        finalPayout === replay.claimProof.payoutAmountRaw,
        "final event payout does not match claim proof payout",
      );
    }
  }

  const summaries = [...replay.events]
    .sort((a, b) => a.entrySeq - b.entrySeq)
    .map((event) => ({
      seq: event.entrySeq,
      type: event.type,
      committedLive: commitmentByEntrySeq.get(event.entrySeq)?.entryHash === event.entryHash,
      hash: event.entryHash,
      summary: formatEventSummary(event),
    }));

  console.log(
    JSON.stringify(
      {
        ok: true,
        entryId: replay.entry.id,
        arenaId: replay.entry.arenaId,
        wallet: replay.entry.walletAddress,
        eventCount: replay.events.length,
        latestEntryHash: replayResult.latestHash,
        liveCommitmentsChecked: arenaCommitments.count,
        claimProof: replay.claimProof
          ? {
              payoutAmountRaw: replay.claimProof.payoutAmountRaw,
              payoutUsd: rawToUsd(replay.claimProof.payoutAmountRaw),
              valid: true,
            }
          : null,
        events: summaries,
      },
      null,
      2,
    ),
  );
}

async function claim(): Promise<void> {
  const arenaId = requiredArg("--arena");
  const keypair = readKeypair(requiredArg("--keypair"));
  const wallet = keypair.publicKey.toBase58();
  const proof = await getJson<ClaimProof>(
    `/api/public/arenas/${arenaId}/claim-proof/${wallet}`,
  );
  assertValid(proof.wallet === wallet, "claim proof wallet does not match signing wallet");
  verifyClaimProof(proof);
  const connection = new Connection(rpcUrl(), "confirmed");
  const transaction = new Transaction().add(
    claimWinningsInstruction({
      arenaId,
      user: keypair.publicKey,
      lockedAmountRaw: BigInt(proof.lockedAmountRaw),
      payoutAmountRaw: BigInt(proof.payoutAmountRaw),
      proof: proof.proof,
      programId: programId(),
    }),
  );
  const signature = await sendAndConfirmTransaction(connection, transaction, [
    keypair,
  ]);
  console.log(JSON.stringify({ ok: true, signature }, null, 2));
}

async function refund(): Promise<void> {
  const arenaId = requiredArg("--arena");
  const keypair = readKeypair(requiredArg("--keypair"));
  const connection = new Connection(rpcUrl(), "confirmed");
  const transaction = new Transaction().add(
    claimRefundInstruction({
      arenaId,
      user: keypair.publicKey,
      programId: programId(),
    }),
  );
  const signature = await sendAndConfirmTransaction(connection, transaction, [
    keypair,
  ]);
  console.log(JSON.stringify({ ok: true, signature }, null, 2));
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "verify") return verifyArena();
  if (command === "replay-entry") return replayEntry();
  if (command === "claim-proof") return showClaimProof();
  if (command === "claim") return claim();
  if (command === "refund") return refund();
  throw new Error(
    "Usage: tradestars <verify|replay-entry|claim-proof|claim|refund>",
  );
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  }, null, 2));
  process.exit(1);
});

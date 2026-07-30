/**
 * 전송 규격. **페이로드 타입만 새 모델로 갈아끼웠다** — 방 코드·봉투(seq/actionId)·핑퐁·
 * 재접속 유예 같은 전송 계층의 성숙한 부분은 그대로 쓴다.
 *
 * 바뀐 것은 둘이다.
 *   - guest → host 의 intent 가 `FlowAction` (옛 `GameAction`)
 *   - host → guest 의 view 가 `ViewModel` (옛 `PlayerView`)
 */

import type { FlowAction } from "../flow/types.ts";
import { isViewModel, type ViewModel } from "../flow/viewModel.ts";

export const PROTOCOL_VERSION = 1 as const;
export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PEER_ID_PREFIX = "mafia-game-";
export const JOIN_TIMEOUT_MS = 12_000;
export const RECONNECT_GRACE_MS = 60_000;

const ROOM_CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;
export type RoomCode = string & { readonly __roomCode: unique symbol };

export interface MessageEnvelope<K extends string> {
  protocolVersion: typeof PROTOCOL_VERSION;
  kind: K;
  seq: number;
  actionId: string;
  sentAt: number;
}

export interface JoinMessage extends MessageEnvelope<"join"> {
  roomCode: RoomCode;
  playerName: string;
  resumeToken?: string;
}

export interface IntentMessage extends MessageEnvelope<"intent"> {
  action: FlowAction;
}

export interface PingMessage extends MessageEnvelope<"ping"> {
  nonce: string;
}

export interface PongMessage extends MessageEnvelope<"pong"> {
  nonce: string;
}

export interface WelcomeMessage extends MessageEnvelope<"welcome"> {
  playerId: string;
  resumeToken: string;
  /**
   * 접속 시점에 이미 시작된 방이면 첫 뷰가 실려 온다. 아직 시작 전이면 없다 —
   * 그때 게스트는 "자리에 앉았고 방장의 시작을 기다리는" 상태다.
   */
  view?: ViewModel;
}

export interface SnapshotMessage extends MessageEnvelope<"snapshot"> {
  view: ViewModel;
  ackActionId?: string;
}

export type SessionEventCode =
  | "guest-reconnecting"
  | "guest-reconnected"
  | "guest-replaced-by-ai"
  | "host-disconnected"
  | "game-ended";

export interface SessionEventMessage extends MessageEnvelope<"session-event"> {
  event: SessionEventCode;
  detail?: string;
  reconnectDeadlineAt?: number;
}

export type RejectCode =
  | "room-full"
  | "invalid-message"
  | "protocol-mismatch"
  | "invalid-resume-token"
  | "session-ended";

export interface RejectMessage extends MessageEnvelope<"reject"> {
  code: RejectCode;
  detail: string;
  rejectedActionId?: string;
}

export type GuestMessage = JoinMessage | IntentMessage | PingMessage | PongMessage;

export type HostMessage =
  | WelcomeMessage
  | SnapshotMessage
  | SessionEventMessage
  | RejectMessage
  | PingMessage
  | PongMessage;

export type ProtocolMessage = GuestMessage | HostMessage;

type GeneratedEnvelopeField =
  | "protocolVersion"
  | "seq"
  | "actionId"
  | "sentAt";

export type MessageWithoutEnvelope<T extends ProtocolMessage> = Omit<
  T,
  GeneratedEnvelopeField
>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown, maxLength = 128): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength
  );
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isSafeSequence(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0
  );
}

function hasValidEnvelope(value: Record<string, unknown>): boolean {
  return (
    value.protocolVersion === PROTOCOL_VERSION &&
    isNonEmptyString(value.kind, 32) &&
    isSafeSequence(value.seq) &&
    isNonEmptyString(value.actionId, 128) &&
    isTimestamp(value.sentAt)
  );
}

const SESSION_EVENT_CODES = new Set<SessionEventCode>([
  "guest-reconnecting",
  "guest-reconnected",
  "guest-replaced-by-ai",
  "host-disconnected",
  "game-ended",
]);

const REJECT_CODES = new Set<RejectCode>([
  "room-full",
  "invalid-message",
  "protocol-mismatch",
  "invalid-resume-token",
  "session-ended",
]);

function isSessionEventCode(value: unknown): value is SessionEventCode {
  return typeof value === "string" && SESSION_EVENT_CODES.has(value as SessionEventCode);
}

function isRejectCode(value: unknown): value is RejectCode {
  return typeof value === "string" && REJECT_CODES.has(value as RejectCode);
}

const FLOW_ACTION_TYPES: readonly FlowAction["type"][] = [
  "night-kill",
  "night-bomb",
  "investigate",
  "protect",
  "convert",
  "listen",
  "disguise",
  "nominate",
  "verdict",
  "snipe",
  "talk",
];

/**
 * 전송받은 행동이 우리가 아는 모양인가.
 *
 * **정당성은 검사하지 않는다** — 그 대상을 고를 수 있는지는 규칙의 몫이고 호스트의
 * `submit()` 이 판정한다. 여기서는 모양만 본다.
 */
export function isFlowAction(value: unknown): value is FlowAction {
  if (!isRecord(value) || !isNonEmptyString(value.actorId)) return false;
  if (typeof value.type !== "string") return false;
  if (!FLOW_ACTION_TYPES.includes(value.type as FlowAction["type"])) return false;

  switch (value.type as FlowAction["type"]) {
    case "night-bomb":
      return (
        isNonEmptyString(value.targetId) &&
        Array.isArray(value.candidates) &&
        value.candidates.length > 0 &&
        value.candidates.every((id) => isNonEmptyString(id))
      );
    case "night-kill":
    case "investigate":
    case "protect":
    case "nominate":
    case "snipe":
      return isNonEmptyString(value.targetId);
    case "convert":
      return value.targetId === null || isNonEmptyString(value.targetId);
    case "verdict":
      return value.choice === "kill" || value.choice === "spare";
    case "disguise":
      return typeof value.use === "boolean";
    case "talk":
      return isNonEmptyString(value.text, 280);
    case "listen":
      return true;
  }
}

export function isProtocolMessage(value: unknown): value is ProtocolMessage {
  if (!isRecord(value) || !hasValidEnvelope(value)) return false;

  switch (value.kind) {
    case "join": {
      const code =
        typeof value.roomCode === "string"
          ? normalizeRoomCode(value.roomCode)
          : null;
      return (
        code !== null &&
        code === value.roomCode &&
        isNonEmptyString(value.playerName, 24) &&
        value.playerName.trim() === value.playerName &&
        (value.resumeToken === undefined ||
          isNonEmptyString(value.resumeToken, 128))
      );
    }
    case "intent":
      return isFlowAction(value.action);
    case "ping":
    case "pong":
      return isNonEmptyString(value.nonce, 128);
    case "welcome":
      return (
        isNonEmptyString(value.playerId) &&
        isNonEmptyString(value.resumeToken, 128) &&
        (value.view === undefined || isViewModel(value.view))
      );
    case "snapshot":
      return (
        isViewModel(value.view) &&
        (value.ackActionId === undefined ||
          isNonEmptyString(value.ackActionId, 128))
      );
    case "session-event":
      return (
        isSessionEventCode(value.event) &&
        (value.detail === undefined || typeof value.detail === "string") &&
        (value.reconnectDeadlineAt === undefined ||
          isTimestamp(value.reconnectDeadlineAt))
      );
    case "reject":
      return (
        isRejectCode(value.code) &&
        typeof value.detail === "string" &&
        value.detail.length <= 500 &&
        (value.rejectedActionId === undefined ||
          isNonEmptyString(value.rejectedActionId, 128))
      );
    default:
      return false;
  }
}

export function isGuestMessage(value: unknown): value is GuestMessage {
  return (
    isProtocolMessage(value) &&
    (value.kind === "join" ||
      value.kind === "intent" ||
      value.kind === "ping" ||
      value.kind === "pong")
  );
}

export function isHostMessage(value: unknown): value is HostMessage {
  return (
    isProtocolMessage(value) &&
    (value.kind === "welcome" ||
      value.kind === "snapshot" ||
      value.kind === "session-event" ||
      value.kind === "reject" ||
      value.kind === "ping" ||
      value.kind === "pong")
  );
}

/**
 * User-entered room codes may contain spaces or hyphens for readability.
 * Ambiguous glyphs (0/O/1/I) and every other symbol are rejected.
 */
export function normalizeRoomCode(input: string): RoomCode | null {
  const normalized = input.toUpperCase().replace(/[\s-]+/g, "");
  return ROOM_CODE_PATTERN.test(normalized)
    ? (normalized as RoomCode)
    : null;
}

export function requireRoomCode(input: string): RoomCode {
  const normalized = normalizeRoomCode(input);
  if (normalized === null) {
    throw new Error(
      "방 코드는 0/O/1/I를 제외한 영문 대문자와 숫자 6자리여야 합니다.",
    );
  }
  return normalized;
}

export function isValidRoomCode(input: string): input is RoomCode {
  return normalizeRoomCode(input) === input;
}

export function generateRoomCode(
  random: () => number = Math.random,
): RoomCode {
  let code = "";
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    const sample = random();
    const safeSample =
      Number.isFinite(sample) && sample >= 0 && sample < 1 ? sample : 0;
    const alphabetIndex = Math.floor(safeSample * ROOM_CODE_ALPHABET.length);
    code += ROOM_CODE_ALPHABET[alphabetIndex];
  }
  return code as RoomCode;
}

export function roomCodeToPeerId(roomCode: string): string {
  return `${PEER_ID_PREFIX}${requireRoomCode(roomCode).toLowerCase()}`;
}

export function createActionId(prefix = "action"): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}:${uuid}`;

  const entropy = Math.random().toString(36).slice(2);
  return `${prefix}:${Date.now().toString(36)}:${entropy}`;
}

export function createResumeToken(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (!uuid) {
    throw new Error("보안 재접속 토큰을 생성할 수 없는 환경입니다.");
  }
  return `resume:${uuid}`;
}

export function createMessage<T extends ProtocolMessage>(
  message: MessageWithoutEnvelope<T>,
  envelope: {
    seq: number;
    actionId?: string;
    sentAt?: number;
  },
): T {
  if (!isSafeSequence(envelope.seq)) {
    throw new RangeError("seq must be a non-negative safe integer.");
  }

  return {
    ...message,
    protocolVersion: PROTOCOL_VERSION,
    seq: envelope.seq,
    actionId: envelope.actionId ?? createActionId(message.kind),
    sentAt: envelope.sentAt ?? Date.now(),
  } as T;
}

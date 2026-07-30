/**
 * 온라인 듀오 메시지 규격.
 *
 * 전송은 `peerRoom.ts`(PeerJS)를 그대로 쓰고, 이 파일은 **무엇을 주고받는지**만 정한다.
 * 옛 규격(`protocol.ts`)은 배포본의 행동 모델(`lib/game`)에 묶여 있어 새로 세웠다.
 *
 * 신뢰 모델 (AGENTS.md 6·7)
 *   - 호스트만 전체 `Session` 을 갖는다. 게스트에게는 **시야가 적용된 뷰모델**만 보낸다.
 *   - 게스트가 보내는 것은 intent 뿐이고, 호스트가 규칙으로 검증한다.
 *   - 게스트는 **자기 좌석의 행동만** 낼 수 있다. 남의 actorId 를 넣으면 호스트가 거절한다.
 */

import type { FlowAction } from "../flow/types.ts";
import { isViewModel, type ViewModel } from "../flow/viewModel.ts";

export const DUO_PROTOCOL_VERSION = 2 as const;

export type GuestToHost =
  | { readonly t: "join"; readonly v: typeof DUO_PROTOCOL_VERSION; readonly name: string }
  | { readonly t: "intent"; readonly v: typeof DUO_PROTOCOL_VERSION; readonly action: FlowAction }
  | { readonly t: "ping"; readonly v: typeof DUO_PROTOCOL_VERSION };

export type HostToGuest =
  | {
      readonly t: "welcome";
      readonly v: typeof DUO_PROTOCOL_VERSION;
      readonly playerId: string;
      readonly hostName: string;
    }
  | { readonly t: "view"; readonly v: typeof DUO_PROTOCOL_VERSION; readonly view: ViewModel }
  | { readonly t: "reject"; readonly v: typeof DUO_PROTOCOL_VERSION; readonly reason: string }
  | { readonly t: "pong"; readonly v: typeof DUO_PROTOCOL_VERSION };

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
 * 값의 **정당성**(그 대상을 고를 수 있는지 등)은 검사하지 않는다 — 그건 규칙의 몫이고
 * 호스트의 `submit()` 이 판정한다. 여기서는 모양만 본다.
 */
export function isFlowAction(value: unknown): value is FlowAction {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { type?: unknown; actorId?: unknown };
  if (typeof candidate.type !== "string") return false;
  if (!FLOW_ACTION_TYPES.includes(candidate.type as FlowAction["type"])) return false;
  if (typeof candidate.actorId !== "string" || candidate.actorId.length === 0) return false;

  const record = value as Record<string, unknown>;
  switch (candidate.type as FlowAction["type"]) {
    case "night-bomb":
      return (
        typeof record["targetId"] === "string" &&
        Array.isArray(record["candidates"]) &&
        record["candidates"].every((id) => typeof id === "string")
      );
    case "night-kill":
    case "investigate":
    case "protect":
    case "nominate":
    case "snipe":
      return typeof record["targetId"] === "string";
    case "convert":
      return typeof record["targetId"] === "string" || record["targetId"] === null;
    case "verdict":
      return record["choice"] === "kill" || record["choice"] === "spare";
    case "disguise":
      return typeof record["use"] === "boolean";
    case "talk":
      return typeof record["text"] === "string";
    case "listen":
      return true;
  }
}

export function isGuestToHost(value: unknown): value is GuestToHost {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<GuestToHost> & Record<string, unknown>;
  if (message.v !== DUO_PROTOCOL_VERSION) return false;
  if (message.t === "join") return typeof message["name"] === "string";
  if (message.t === "intent") return isFlowAction(message["action"]);
  return message.t === "ping";
}

export function isHostToGuest(value: unknown): value is HostToGuest {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Partial<HostToGuest> & Record<string, unknown>;
  if (message.v !== DUO_PROTOCOL_VERSION) return false;
  if (message.t === "welcome") {
    return typeof message["playerId"] === "string" && typeof message["hostName"] === "string";
  }
  if (message.t === "view") return isViewModel(message["view"]);
  if (message.t === "reject") return typeof message["reason"] === "string";
  return message.t === "pong";
}

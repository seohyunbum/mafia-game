"use client";

/**
 * 온라인 듀오 전송 배선. PeerJS 방(`lib/online/peerRoom`) 과 호스트 권위 계층
 * (`lib/online/duoHost`) 을 잇고, 화면에는 **구독 가능한 스냅샷 하나**만 노출한다.
 *
 * 역할이 다르지만 화면은 같다.
 *   - 호스트: 자기 `Session` 을 갖고, 게스트 intent 를 규칙에 통과시키고, 진행을 누른다.
 *   - 게스트: `Session` 이 없다. 받은 뷰모델을 그리고 intent 만 올린다.
 *
 * 그래서 `DuoController` 의 표면이 양쪽에서 같다 — 화면이 역할을 분기할 필요가 없고,
 * 게스트가 누를 수 없는 것(진행)은 뷰모델의 `canAdvance` 가 이미 false 로 알려 준다.
 */

import type { RulesConfig } from "@/lib/rules/config";
import type { FlowAction } from "@/lib/flow/types";
import type { ViewModel } from "@/lib/flow/viewModel";
import {
  DuoHost,
  GUEST_SEAT_ID,
  HOST_SEAT_ID,
  type HostOutbound,
} from "@/lib/online/duoHost";
import {
  createMessage,
  requireRoomCode,
  type JoinMessage,
  type IntentMessage,
  type ProtocolMessage,
  type RejectMessage,
  type SnapshotMessage,
  type WelcomeMessage,
} from "@/lib/online/protocol";
import {
  createPeerRoom,
  joinPeerRoom,
  type PeerRoom,
  type PeerRoomStatus,
} from "@/lib/online/peerRoom";

export type DuoRole = "host" | "guest";

export interface DuoSnapshot {
  readonly role: DuoRole;
  readonly roomCode: string;
  readonly status: PeerRoomStatus | "idle";
  /** 짝이 붙었는가 (호스트 기준). 게스트는 접속 자체가 곧 짝이 붙은 것이다 */
  readonly partnerConnected: boolean;
  readonly partnerName: string | null;
  /** 내가 그릴 뷰. 게임 시작 전에는 null */
  readonly view: ViewModel | null;
  readonly error: string | null;
  readonly started: boolean;
}

export interface DuoController {
  readonly role: DuoRole;
  snapshot(): DuoSnapshot;
  subscribe(listener: () => void): () => void;
  /** 호스트만. 짝이 붙은 뒤 누른다 */
  startGame(): void;
  submit(action: FlowAction): void;
  /** 호스트만. 게스트가 부르면 아무 일도 하지 않는다 */
  advance(): void;
  close(): void;
}

/** 봉투의 seq 를 매기는 작은 카운터. 재전송·순서 판별에 쓰인다 */
function sequencer(): () => number {
  let seq = 0;
  return () => {
    seq += 1;
    return seq;
  };
}

function randomToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}


/**
 * 방이 아직 손에 없을 때 보낸 메시지를 잃지 않게 큐에 담는다.
 *
 * `createPeerRoom`/`joinPeerRoom` 의 `onEvent` 는 **await 가 끝나기 전에 발화한다.** 그래서
 * 콜백 안에서 `room` 변수를 쓰면 그 시점엔 아직 `null` 이고, 첫 메시지(게스트의 join)가
 * 조용히 사라진다 — 실제로 그래서 호스트가 참가를 영원히 못 받았다.
 */
function makeOutbox() {
  const queue: ProtocolMessage[] = [];
  let target: PeerRoom | null = null;

  const flush = (): void => {
    if (!target) return;
    while (queue.length > 0) {
      const next = queue[0];
      if (next === undefined) {
        queue.shift();
        continue;
      }
      if (!target.send(next)) return; // 아직 못 보낸다 — 다음 기회에 다시 시도
      queue.shift();
    }
  };

  return {
    attach(room: PeerRoom) {
      target = room;
      flush();
    },
    send(message: ProtocolMessage) {
      queue.push(message);
      flush();
    },
    flush,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 호스트
// ─────────────────────────────────────────────────────────────────────────────

export async function hostDuoRoom(options: {
  readonly rules: RulesConfig;
  readonly hostName: string;
  readonly seed?: number;
}): Promise<DuoController> {
  const listeners = new Set<() => void>();
  const nextSeq = sequencer();
  const resumeToken = randomToken();

  const outbox = makeOutbox();
  let room: PeerRoom | null = null;
  let status: PeerRoomStatus | "idle" = "idle";
  let error: string | null = null;
  let started = false;
  /** 아직 방을 손에 넣기 전에 온 join 을 기억해 둔다 */
  let pendingJoinName: string | null = null;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const host = new DuoHost({
    rules: options.rules,
    hostName: options.hostName,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
    send: (message: HostOutbound) => {
      outbox.send(toProtocol(message));
    },
  });

  /** 도메인 사건에 전송 봉투를 씌운다. duoHost 는 봉투를 모른다. */
  function toProtocol(message: HostOutbound): ProtocolMessage {
    if (message.kind === "welcome") {
      const view = host.viewFor(GUEST_SEAT_ID);
      // 게임 시작 전에는 보낼 뷰가 없다. 시작하면 곧바로 snapshot 이 따라간다.
      return createMessage<WelcomeMessage>(
        {
          kind: "welcome",
          playerId: message.playerId,
          resumeToken,
          ...(view ? { view } : {}),
        },
        { seq: nextSeq() },
      );
    }
    if (message.kind === "snapshot") {
      return createMessage<SnapshotMessage>(
        { kind: "snapshot", view: message.view },
        { seq: nextSeq() },
      );
    }
    return createMessage<RejectMessage>(
      { kind: "reject", code: "invalid-message", detail: message.detail },
      { seq: nextSeq() },
    );
  }

  room = await createPeerRoom({
    onEvent: (event) => {
      if (event.type === "status") {
        status = event.status;
        if (event.status === "host-disconnected" || event.status === "closed") {
          host.onGuestLeave();
        }
        outbox.flush();
        notify();
        return;
      }
      if (event.type === "error") {
        error = event.error.message;
        notify();
        return;
      }

      const message = event.message;
      if (message.kind === "join") {
        // 방 코드가 맞는 손님만 들인다. peerRoom 이 이미 규격을 검사했다.
        if (room) {
          room.confirmConnection();
          host.onGuestJoin(message.playerName);
        } else {
          // await 가 끝나기 전에 온 join — 방을 손에 넣은 뒤 처리한다
          pendingJoinName = message.playerName;
        }
        notify();
        return;
      }
      if (message.kind === "intent") {
        const result = host.applyGuestIntent(message.action);
        if (!result.ok) error = result.reason ?? null;
        notify();
      }
    },
  });
  status = room.status;
  outbox.attach(room);
  if (pendingJoinName !== null) {
    room.confirmConnection();
    host.onGuestJoin(pendingJoinName);
    pendingJoinName = null;
  }

  return {
    role: "host",
    snapshot: () => ({
      role: "host",
      roomCode: room?.roomCode ?? "",
      status,
      partnerConnected: host.state.guestConnected,
      partnerName: host.state.guestName,
      view: started ? host.viewFor(HOST_SEAT_ID) : null,
      error,
      started,
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    startGame: () => {
      if (started) return;
      host.start();
      started = true;
      error = null;
      notify();
    },
    submit: (action) => {
      const result = host.applyHostAction({ ...action, actorId: HOST_SEAT_ID });
      error = result.ok ? null : (result.reason ?? null);
      notify();
    },
    advance: () => {
      const result = host.advancePhase();
      error = result.ok ? null : (result.reason ?? null);
      notify();
    },
    close: () => {
      room?.close("호스트가 방을 닫았습니다.");
      listeners.clear();
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 게스트
// ─────────────────────────────────────────────────────────────────────────────

export async function joinDuoRoom(options: {
  readonly roomCode: string;
  readonly guestName: string;
}): Promise<DuoController> {
  const listeners = new Set<() => void>();
  const nextSeq = sequencer();
  const roomCode = requireRoomCode(options.roomCode);

  const outbox = makeOutbox();
  let room: PeerRoom | null = null;
  let status: PeerRoomStatus | "idle" = "idle";
  let view: ViewModel | null = null;
  let error: string | null = null;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  room = await joinPeerRoom(roomCode, {
    onEvent: (event) => {
      if (event.type === "status") {
        status = event.status;
        if (event.status === "connected") {
          outbox.send(
            createMessage<JoinMessage>(
              { kind: "join", roomCode, playerName: options.guestName },
              { seq: nextSeq() },
            ),
          );
        }
        outbox.flush();
        notify();
        return;
      }
      if (event.type === "error") {
        error = event.error.message;
        notify();
        return;
      }

      const message = event.message;
      if (message.kind === "welcome") {
        // 방장 이름은 게임이 시작되면 좌석에서 보인다. welcome 에 뷰가 실려 오면
        // (이미 시작된 방) 곧바로 그린다.
        if (message.view) view = message.view;
        notify();
        return;
      }
      if (message.kind === "snapshot") {
        // 낡은 스냅샷이 새것을 덮지 않게 한다
        if (view === null || message.view.revision >= view.revision) view = message.view;
        error = null;
        notify();
        return;
      }
      if (message.kind === "reject") {
        error = message.detail;
        notify();
      }
    },
  });
  status = room.status;
  outbox.attach(room);

  return {
    role: "guest",
    snapshot: () => ({
      role: "guest",
      roomCode,
      status,
      partnerConnected: status === "connected",
      // 방장 이름은 프로토콜에 싣지 않는다 — 게임이 시작되면 좌석에서 보인다.
      // 시작 전 대기 화면은 Landing 이 "참가자" 로 대신 부른다.
      partnerName: null,
      view,
      error,
      started: view !== null,
    }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    startGame: () => {
      // 게스트는 시작할 수 없다. 진행 권한은 호스트에게만 있다.
    },
    submit: (action) => {
      outbox.send(
        createMessage<IntentMessage>(
          { kind: "intent", action: { ...action, actorId: GUEST_SEAT_ID } },
          { seq: nextSeq(), actionId: randomToken() },
        ),
      );
    },
    advance: () => {
      // 게스트는 진행할 수 없다.
    },
    close: () => {
      room?.close("게스트가 방을 떠났습니다.");
      listeners.clear();
    },
  };
}

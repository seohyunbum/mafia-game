/**
 * 호스트 권위 듀오 세션. **전송 계층을 모른다** — 메시지를 보내는 함수만 주입받는다.
 *
 * 그래서 브라우저 없이도 테스트할 수 있고(두 사람을 한 프로세스에서 돌려 볼 수 있다),
 * PeerJS 를 다른 전송으로 바꿔도 이 파일은 그대로다.
 *
 * 신뢰 모델: 호스트만 `Session` 을 갖고, 게스트에게는 시야가 적용된 뷰모델만 나간다.
 * 게스트 intent 는 **자기 좌석 것만** 통과한다.
 */

import type { RulesConfig } from "../rules/config.ts";
import { aiFiller, aiInterlude } from "../ai/brain.ts";
import { advance, createSession, isOver, submit } from "../flow/session.ts";
import type { FlowAction, Session } from "../flow/types.ts";
import { toViewModel, type ViewModel } from "../flow/viewModel.ts";
import type { HostToGuest } from "./duoProtocol.ts";

export interface DuoHostOptions {
  readonly rules: RulesConfig;
  readonly hostName: string;
  readonly seed?: number;
  /** 게스트에게 메시지를 보내는 통로. 전송 방식은 호출자가 정한다 */
  readonly send: (message: HostToGuest) => void;
}

export interface DuoHostState {
  readonly session: Session | null;
  readonly guestName: string | null;
  readonly guestConnected: boolean;
}

/** 호스트 좌석은 항상 첫 번째, 게스트는 두 번째다 (createSession 의 humanIds 규약). */
export const HOST_SEAT_ID = "p1";
export const GUEST_SEAT_ID = "p2";

export class DuoHost {
  private readonly rules: RulesConfig;
  private readonly hostName: string;
  private readonly seed: number | undefined;
  private readonly send: (message: HostToGuest) => void;

  private session: Session | null = null;
  private guestName: string | null = null;
  private revision = 0;

  constructor(options: DuoHostOptions) {
    this.rules = options.rules;
    this.hostName = options.hostName;
    this.seed = options.seed;
    this.send = options.send;
  }

  get state(): DuoHostState {
    return {
      session: this.session,
      guestName: this.guestName,
      guestConnected: this.guestName !== null,
    };
  }

  /** 게스트가 붙었다. 아직 게임을 시작하지는 않는다 — 시작은 호스트가 누른다. */
  onGuestJoin(name: string): void {
    this.guestName = name.trim().slice(0, 20) || "친구";
    this.send({
      t: "welcome",
      v: 2,
      playerId: GUEST_SEAT_ID,
      hostName: this.hostName,
    });
    if (this.session) this.broadcast();
  }

  onGuestLeave(): void {
    this.guestName = null;
  }

  /** 게임을 시작한다. 두 사람은 같은 진영이 된다 (DESIGN.md §2). */
  start(): Session {
    this.session = createSession(
      {
        mode: "duo",
        hostName: this.hostName,
        guestName: this.guestName ?? "친구",
        ...(this.seed === undefined ? {} : { seed: this.seed }),
      },
      this.rules,
    );
    this.revision += 1;
    this.broadcast();
    return this.session;
  }

  /**
   * 게스트 intent 를 규칙에 통과시킨다.
   *
   * 남의 좌석 행동은 받지 않는다 — 이걸 놓치면 게스트가 호스트의 밤 행동을 대신 낼 수 있다.
   */
  applyGuestIntent(action: FlowAction): { readonly ok: boolean; readonly reason?: string } {
    if (!this.session) return { ok: false, reason: "게임이 시작되지 않았습니다." };
    if (action.actorId !== GUEST_SEAT_ID) {
      return { ok: false, reason: "자기 좌석의 행동만 낼 수 있습니다." };
    }
    const result = submit(this.session, this.rules, action);
    if (!result.ok) {
      this.send({ t: "reject", v: 2, reason: result.reason });
      return { ok: false, reason: result.reason };
    }
    this.session = result.session;
    this.revision += 1;
    this.broadcast();
    return { ok: true };
  }

  /** 호스트 자신의 행동. */
  applyHostAction(action: FlowAction): { readonly ok: boolean; readonly reason?: string } {
    if (!this.session) return { ok: false, reason: "게임이 시작되지 않았습니다." };
    if (action.actorId !== HOST_SEAT_ID) {
      return { ok: false, reason: "자기 좌석의 행동만 낼 수 있습니다." };
    }
    const result = submit(this.session, this.rules, action);
    if (!result.ok) return { ok: false, reason: result.reason };
    this.session = result.session;
    this.revision += 1;
    this.broadcast();
    return { ok: true };
  }

  /** 진행. 호스트만 누를 수 있다 — 두 사람이 동시에 넘기면 순서가 어긋난다. */
  advancePhase(): { readonly ok: boolean; readonly reason?: string } {
    if (!this.session) return { ok: false, reason: "게임이 시작되지 않았습니다." };
    const withAi = aiInterlude(this.session, this.rules);
    const result = advance(withAi, this.rules, aiFiller);
    if (!result.ok) {
      this.session = withAi;
      this.revision += 1;
      this.broadcast();
      return { ok: false, reason: "아직 내지 않은 행동이 있습니다." };
    }
    this.session = aiInterlude(result.session, this.rules);
    this.revision += 1;
    this.broadcast();
    return { ok: true };
  }

  viewFor(seatId: string): ViewModel | null {
    if (!this.session) return null;
    return toViewModel(this.session, this.rules, seatId, {
      isHost: seatId === HOST_SEAT_ID,
      revision: this.revision,
    });
  }

  isOver(): boolean {
    return this.session !== null && isOver(this.session);
  }

  /** 게스트에게 그 사람 몫의 뷰를 보낸다. */
  private broadcast(): void {
    if (!this.session || this.guestName === null) return;
    const view = this.viewFor(GUEST_SEAT_ID);
    if (view) this.send({ t: "view", v: 2, view });
  }
}

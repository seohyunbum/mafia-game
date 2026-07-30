/**
 * 진행 계층 타입. 규칙 코어(`lib/rules`)가 모르는 것들만 여기 둔다 —
 * 좌석·조종 주체(사람/AI)·대화·가시성·사회자 호출 진행 위치.
 *
 * 코어는 순수하게 유지하고(누가 조종하는지 몰라야 한다), 진행·표현에 필요한 맥락은
 * 이 계층이 들고 있는다. 정본 규칙 설명은 docs/DESIGN.md.
 */

import type { Faction, GameState, Phase, RoleId, Verdict } from "../rules/types.ts";

export type Controller = "human-host" | "human-guest" | "ai";

/** 좌석. 코어의 Character 에 없는 표현·조종 정보를 담는다. */
export interface Seat {
  readonly id: string;
  readonly seat: number;
  readonly name: string;
  readonly avatar: string;
  readonly controller: Controller;
}

/** 사람에게 보여줄 한 줄. 코어 이벤트에 **가시성을 부여한** 결과다. */
export interface FeedEntry {
  readonly id: string;
  readonly day: number;
  readonly phase: Phase;
  readonly text: string;
  /**
   * `public` 은 모두, `mafia`/`cult` 는 그 진영, `private` 는 `forIds` 만 본다.
   * 코어는 가시성을 모른다(변신 노출 Q4 가 미정이라 의도적) — 부여는 이 계층 책임이다.
   */
  readonly visibility: "public" | "mafia" | "cult" | "private";
  readonly forIds?: readonly string[];
}

export interface TalkMessage {
  readonly id: string;
  readonly day: number;
  readonly speakerId: string | null;
  readonly text: string;
  readonly kind: "speech" | "system";
}

/** 그 밤에 모이는 제출물. 코어의 `NightActions` 로 변환되기 전 단계다. */
export interface NightDraft {
  /** 마피아팀원별 살해 제출. 팀 살해는 1회라 해소 직전에 하나로 취합한다 */
  readonly kills: Record<string, { readonly targetId: string; readonly candidates?: readonly string[] }>;
  readonly investigations: Record<string, string>;
  readonly protects: Record<string, string>;
  /** 교주의 포교. `null` 은 이번 밤 보류를 명시적으로 고른 것 (해소 직전에 복구되므로 가변) */
  conversion: { readonly targetId: string } | null | undefined;
  /** 시민의 야간 청취 — 상태를 바꾸지 않는 정보 행동 (DESIGN.md §6.1.2) */
  readonly listens: Record<string, true>;
}

/** 지금 이 페이즈에서 아직 채워지지 않은 제출 하나. */
export interface Requirement {
  readonly actorId: string
  readonly kind:
    | "night-kill"
    | "night-bomb"
    | "investigate"
    | "protect"
    | "convert"
    | "listen"
    | "disguise"
    | "nominate"
    | "verdict";
  /** true 면 채우지 않아도 진행을 막지 않는다 (스나이퍼·시민) */
  readonly optional: boolean;
}

export interface Session {
  readonly version: 2;
  readonly mode: "solo" | "duo";
  readonly seed: number;
  rngState: number;
  core: GameState;
  readonly seats: readonly Seat[];
  readonly humanIds: readonly string[];
  /** 듀오 짝의 진영 (솔로면 null) */
  readonly duoFaction: Faction | null;
  night: NightDraft;
  /** 사회자 호출 진행 위치. 이번 밤의 호출 목록 안에서의 인덱스 */
  nightStepIndex: number;
  disguiseChoices: Record<string, boolean>;
  nominationVotes: Record<string, string>;
  verdictVotes: Record<string, Verdict>;
  messages: TalkMessage[];
  feed: FeedEntry[];
  /**
   * 규칙 코어가 예상 못 한 입력으로 던진 경우의 기록.
   * 비어 있어야 정상이다 — 시뮬레이션 테스트가 이게 0 인지 본다.
   */
  flowErrors: string[];
}

export type FlowAction =
  | { readonly type: "night-kill"; readonly actorId: string; readonly targetId: string }
  | {
      readonly type: "night-bomb";
      readonly actorId: string;
      readonly targetId: string;
      readonly candidates: readonly string[];
    }
  | { readonly type: "investigate"; readonly actorId: string; readonly targetId: string }
  | { readonly type: "protect"; readonly actorId: string; readonly targetId: string }
  | { readonly type: "convert"; readonly actorId: string; readonly targetId: string | null }
  | { readonly type: "listen"; readonly actorId: string }
  | { readonly type: "disguise"; readonly actorId: string; readonly use: boolean }
  | { readonly type: "nominate"; readonly actorId: string; readonly targetId: string }
  | { readonly type: "verdict"; readonly actorId: string; readonly choice: Verdict }
  | { readonly type: "snipe"; readonly actorId: string; readonly targetId: string }
  | { readonly type: "talk"; readonly actorId: string; readonly text: string };

export type SubmitResult =
  | { readonly ok: true; readonly session: Session }
  | { readonly ok: false; readonly reason: string };

export type AdvanceResult =
  | { readonly ok: true; readonly session: Session }
  /** 사람이 아직 내지 않은 필수 제출이 있어 진행하지 않았다. 상태는 바뀌지 않는다 */
  | { readonly ok: false; readonly blocked: readonly Requirement[] };

/** 역할별 밤 능력 종류. UI 가 어떤 패널을 그릴지 정하는 데 쓴다. */
export const NIGHT_ABILITY: Readonly<Record<RoleId, Requirement["kind"] | null>> = {
  citizen: "listen",
  police: "investigate",
  doctor: "protect",
  mafia: "night-kill",
  bomber: "night-bomb",
  sniper: null,
  cultleader: "convert",
};

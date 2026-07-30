/**
 * 화면이 그리는 데 필요한 것 전부를 담은 한 덩어리.
 *
 * **왜 필요한가** — 온라인 듀오의 게스트는 `Session` 을 갖지 않는다. 전체 상태를 게스트에게
 * 보내면 남의 정체가 그대로 새기 때문이다(AGENTS.md 6). 그래서 화면이 `Session` 을 직접
 * 읽으면 솔로용 화면과 게스트용 화면이 갈라진다.
 *
 * 대신 화면은 **이 뷰모델만** 본다. 만드는 쪽이 둘이다.
 *   - 솔로·호스트: 자기 `Session` 에서 직접 만든다 (`toViewModel`)
 *   - 게스트: 호스트가 만들어 전송해 준 것을 그대로 받는다
 *
 * 그래서 화면은 하나로 유지되고, 게스트에게 보내는 정보의 범위가 이 파일 한 곳에 모인다.
 * 직렬화되어 선을 타므로 **순수 데이터만** 담는다 (함수·클래스 금지).
 */

import type { RulesConfig } from "../rules/config.ts";
import { sniperCanFire } from "../rules/engine.ts";
import type { Faction, Phase, RoleId, Verdict } from "../rules/types.ts";
import {
  blockingHumanRequirements,
  characterOf,
  currentNightStep,
  currentNightSteps,
  legalSnipeTargets,
  legalTargets,
  nameOf,
  requirements,
  seatViews,
  visibleFeed,
  type SeatView,
} from "./session.ts";
import type { FeedEntry, Requirement, Session, TalkMessage } from "./types.ts";

export const VIEW_MODEL_VERSION = 1 as const;

export interface SelfView {
  readonly id: string;
  readonly name: string;
  readonly roleId: RoleId;
  readonly faction: Faction;
  readonly hp: number;
  readonly alive: boolean;
  /** 사제가 된 날. null 이면 전향하지 않았다 */
  readonly convertedAtDay: number | null;
}

export interface AllyView {
  readonly id: string;
  readonly name: string;
  readonly roleId: RoleId;
}

export interface ViewModel {
  readonly version: typeof VIEW_MODEL_VERSION;
  /** 게스트가 낡은 스냅샷을 덮어쓰지 않도록 하는 단조 증가 번호 */
  readonly revision: number;
  readonly viewerId: string;
  readonly mode: "solo" | "duo";
  readonly day: number;
  readonly phase: Phase;
  readonly seats: readonly SeatView[];
  readonly self: SelfView;
  /** 나에게 정체가 보이는 같은 편 (마피아팀·교주팀만) */
  readonly allies: readonly AllyView[];
  /** 지금 내가 내야 하는 제출 */
  readonly myRequirements: readonly Requirement[];
  /** 제출 종류별로 고를 수 있는 좌석 id */
  readonly legalTargetIds: Readonly<Partial<Record<Requirement["kind"], readonly string[]>>>;
  /** 저격 가능한 좌석 id (스나이퍼가 아니거나 탄이 없으면 빈 배열) */
  readonly snipeTargetIds: readonly string[];
  readonly snipeShotsLeft: number;
  /** 사회자 호출 — 밤이 아니면 null */
  readonly nightStepPrompt: string | null;
  readonly nightStepIndex: number;
  readonly nightStepCount: number;
  readonly nomineeId: string | null;
  readonly messages: readonly TalkMessage[];
  readonly feed: readonly FeedEntry[];
  readonly winner: Faction | null;
  /**
   * 진행을 막고 있는 제출들. **누구 것인지는 보내지 않는다** — 게스트에게
   * "아직 안 낸 사람이 누구인지" 를 알려주면 정체 추론 단서가 된다.
   */
  readonly blockingKinds: readonly Requirement["kind"][];
  /** 내가 진행 버튼을 누를 수 있는가 (호스트만 true 가 될 수 있다) */
  readonly canAdvance: boolean;
  /** 이 뷰어가 진행 권한을 갖는가 */
  readonly isHost: boolean;
}

const TARGETING_KINDS: readonly Requirement["kind"][] = [
  "night-kill",
  "night-bomb",
  "investigate",
  "protect",
  "convert",
  "nominate",
];

/** 이 사람이 지금 내야 하는 제출만 골라 뷰모델을 만든다. */
export function toViewModel(
  session: Session,
  rules: RulesConfig,
  viewerId: string,
  options: { readonly isHost: boolean; readonly revision: number },
): ViewModel {
  const character = characterOf(session, viewerId);
  if (!character) {
    throw new Error(`없는 참가자: ${viewerId}`);
  }

  const myRequirements = requirements(session, rules).filter((r) => r.actorId === viewerId);
  const legalTargetIds: Partial<Record<Requirement["kind"], readonly string[]>> = {};
  for (const requirement of myRequirements) {
    if (!TARGETING_KINDS.includes(requirement.kind)) continue;
    legalTargetIds[requirement.kind] = legalTargets(session, rules, viewerId, requirement.kind).map(
      (c) => c.id,
    );
  }

  const step = currentNightStep(session, rules);
  const steps = currentNightSteps(session, rules);
  const blocking = blockingHumanRequirements(session, rules);

  // 같은 진영이라고 서로를 다 아는 게 아니다 — 시민팀은 아무도 모른다
  // (session.ts 의 knownRoleFor 와 같은 규칙).
  const allies: AllyView[] =
    character.faction === "citizen"
      ? []
      : session.core.characters
          .filter((c) => c.id !== viewerId && c.faction === character.faction)
          .map((c) => ({ id: c.id, name: nameOf(session, c.id), roleId: c.roleId }));

  // **듀오 짝은 진영과 무관하게 서로를 안다** (DESIGN.md §2 — "둘이 같이 편먹는다").
  // 이게 없으면 둘 다 시민팀일 때 서로를 못 알아보고, 같이 하는 의미가 사라진다.
  if (session.mode === "duo" && session.humanIds.includes(viewerId)) {
    for (const partnerId of session.humanIds) {
      if (partnerId === viewerId) continue;
      if (allies.some((ally) => ally.id === partnerId)) continue;
      const partner = characterOf(session, partnerId);
      if (!partner) continue;
      allies.unshift({ id: partner.id, name: nameOf(session, partner.id), roleId: partner.roleId });
    }
  }

  const shotsLeft =
    character.roleId === "sniper"
      ? Math.max(0, (rules.sniper.usesPerGame ?? 0) - (session.core.abilityUses[viewerId] ?? 0))
      : 0;

  return {
    version: VIEW_MODEL_VERSION,
    revision: options.revision,
    viewerId,
    mode: session.mode,
    day: session.core.day,
    phase: session.core.phase,
    seats: seatViews(session, viewerId),
    self: {
      id: character.id,
      name: nameOf(session, character.id),
      roleId: character.roleId,
      faction: character.faction,
      hp: character.hp,
      alive: character.alive,
      convertedAtDay: character.convertedAtDay,
    },
    allies,
    myRequirements,
    legalTargetIds,
    snipeTargetIds: sniperCanFire(session.core, rules, viewerId)
      ? legalSnipeTargets(session, rules, viewerId).map((c) => c.id)
      : [],
    snipeShotsLeft: shotsLeft,
    nightStepPrompt: step?.prompt ?? null,
    nightStepIndex: session.nightStepIndex,
    nightStepCount: steps.length,
    nomineeId: session.core.nominee,
    messages: session.messages,
    feed: visibleFeed(session, viewerId),
    winner: session.core.winner,
    blockingKinds: blocking.map((r) => r.kind),
    canAdvance: options.isHost && blocking.length === 0,
    isHost: options.isHost,
  };
}

/** 전송받은 뷰모델이 우리가 아는 모양인가. 게스트는 남의 데이터를 믿지 않는다. */
export function isViewModel(value: unknown): value is ViewModel {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ViewModel>;
  return (
    candidate.version === VIEW_MODEL_VERSION &&
    typeof candidate.revision === "number" &&
    typeof candidate.viewerId === "string" &&
    typeof candidate.day === "number" &&
    typeof candidate.phase === "string" &&
    Array.isArray(candidate.seats) &&
    typeof candidate.self === "object" &&
    candidate.self !== null &&
    Array.isArray(candidate.myRequirements) &&
    Array.isArray(candidate.messages) &&
    Array.isArray(candidate.feed) &&
    typeof candidate.canAdvance === "boolean" &&
    typeof candidate.isHost === "boolean"
  );
}

/** 뷰모델에서 좌석 하나를 찾는다 (표시 이름 조회용). */
export function seatOfView(view: ViewModel, id: string | null): SeatView | undefined {
  if (id === null) return undefined;
  return view.seats.find((seat) => seat.id === id);
}

export function displayNameIn(view: ViewModel, id: string | null): string {
  return seatOfView(view, id)?.displayName ?? "";
}

export type { SeatView, Verdict };

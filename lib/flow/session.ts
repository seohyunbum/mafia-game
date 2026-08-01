/**
 * 진행 드라이버. 규칙 코어(`lib/rules`)를 감싸 **막히지 않는 한 줄기 흐름**을 만든다.
 *
 * 배포본(codex 라인)의 진행이 멈춘 원인은 구조였다 — 진행 함수가 "아직 안 낸 사람이 있다"며
 * 예외를 던지고, 던져진 예외를 화면이 받을 데가 없었다. 그래서 이 계층의 규약은 셋이다.
 *
 * 1. `advance()` 는 **절대 던지지 않는다.** 못 가면 `{ok:false, blocked}` 로 이유를 돌려준다.
 * 2. AI 가 낼 제출은 진행 시점에 드라이버가 **스스로 채운다.** AI 때문에 사람이 멈추지 않는다.
 * 3. 낼 수 있는 합법 대상이 없는 제출은 `optional` 로 강등한다. 규칙상 막힌 밤이 생기지 않는다.
 *
 * 규칙 자체는 하나도 여기서 판정하지 않는다. 판정은 전부 `lib/rules/engine.ts` 다.
 */

import {
  alive,
  cultCanAct,
  knownAllies,
  fireSniper,
  nightSteps,
  resolveDawn,
  resolveDay,
  resolveDusk,
  resolveMorning,
  resolveNight,
  resolveTrial,
  sniperCanFire,
  verdictVoters,
  type ActiveNightStep,
} from "../rules/engine.ts";
import { createGame, factionOf } from "../rules/setup.ts";
import type { RulesConfig } from "../rules/config.ts";
import type {
  Character,
  Faction,
  GameEvent,
  GameState,
  NightActions,
  RoleId,
  Rng,
  Verdict,
} from "../rules/types.ts";
import { RuleError } from "../rules/types.ts";
import {
  NIGHT_ABILITY,
  type AdvanceResult,
  type Controller,
  type FeedEntry,
  type FlowAction,
  type NightDraft,
  type Requirement,
  type Seat,
  type Session,
  type SubmitResult,
  type TalkMessage,
} from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 로스터·구성
// ─────────────────────────────────────────────────────────────────────────────

export const SEAT_TEMPLATES: ReadonlyArray<{ readonly name: string; readonly avatar: string }> = [
  { name: "서윤", avatar: "🕵️" },
  { name: "도윤", avatar: "🎩" },
  { name: "하린", avatar: "🧥" },
  { name: "준호", avatar: "🕶️" },
  { name: "수아", avatar: "🌹" },
  { name: "민재", avatar: "🗝️" },
  { name: "예린", avatar: "🦊" },
  { name: "태오", avatar: "🃏" },
  { name: "지안", avatar: "🌙" },
  { name: "은우", avatar: "🕯️" },
  { name: "채원", avatar: "📻" },
  { name: "시혁", avatar: "🍷" },
  { name: "나연", avatar: "🎞️" },
];

/**
 * 12인 표준 구성 (DESIGN.md Q10 해소, 2026-07-30).
 *
 * 시민6 · 경찰1 · 의사1 / 마피아1 · 폭탄마1 · 스나이퍼1 / 교주1 → 시민팀 8 · 마피아팀 3 · 교주팀 1.
 *
 * 배포본은 9인(시민5·마피아1·폭탄마1·교주1·신도1)이었고 시민 5 명 전원이 능력이 없어
 * **9 명 중 5 명은 밤에 할 일이 아무것도 없었다.** 게다가 낮 투표가 HP 를 1 만 깎아
 * 시민팀 승률이 1.7% 였다(60 판 측정). 정본의 경찰·의사·스나이퍼를 되살리고 인원을 12 로
 * 늘려 세 진영 승률을 시민 35.7 / 마피아 28.3 / 교주 36.0 으로 맞췄다(300 판 측정).
 *
 * 코어는 구성을 인자로 받으므로(setup.ts) 이 상수는 표준값일 뿐 규칙이 아니다.
 */
export const STANDARD_COMPOSITION: readonly RoleId[] = [
  "citizen",
  "citizen",
  "citizen",
  "citizen",
  "citizen",
  "citizen",
  "police",
  "doctor",
  "mafia",
  "bomber",
  "sniper",
  "cultleader",
];

// ─────────────────────────────────────────────────────────────────────────────
// 결정론적 난수 — 시드가 같으면 같은 판이 나온다
// ─────────────────────────────────────────────────────────────────────────────

function nextRngState(state: number): number {
  return (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
}

/** 세션의 rngState 를 갱신하며 [0,1) 을 내주는 rng. 코어에 주입한다. */
function makeRng(session: { rngState: number }): Rng {
  return () => {
    session.rngState = nextRngState(session.rngState);
    return session.rngState / 0x1_0000_0000;
  };
}

export function pickWith<T>(items: readonly T[], rng: Rng): T | null {
  if (items.length === 0) return null;
  const index = Math.min(items.length - 1, Math.floor(rng() * items.length));
  return items[index] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 세션 만들기
// ─────────────────────────────────────────────────────────────────────────────

function emptyNight(): NightDraft {
  return { kills: {}, investigations: {}, protects: {}, conversion: undefined, listens: {} };
}

function cloneNight(draft: NightDraft): NightDraft {
  return {
    kills: { ...draft.kills },
    investigations: { ...draft.investigations },
    protects: { ...draft.protects },
    conversion: draft.conversion === undefined ? undefined : draft.conversion,
    listens: { ...draft.listens },
  };
}

export function cloneSession(session: Session): Session {
  return {
    ...session,
    core: {
      ...session.core,
      characters: session.core.characters.map((c) => ({ ...c })),
      abilityUses: { ...session.core.abilityUses },
      nominationVotes: { ...session.core.nominationVotes },
      verdictVotes: { ...session.core.verdictVotes },
      log: [...session.core.log],
    },
    night: cloneNight(session.night),
    disguiseChoices: { ...session.disguiseChoices },
    nominationVotes: { ...session.nominationVotes },
    verdictVotes: { ...session.verdictVotes },
    messages: [...session.messages],
    feed: [...session.feed],
    flowErrors: [...session.flowErrors],
  };
}

function safeName(value: string | undefined, fallback: string): string {
  const normalized = value?.trim().replace(/\s+/g, " ").slice(0, 20);
  return normalized || fallback;
}

export interface CreateSessionOptions {
  readonly mode: "solo" | "duo";
  readonly seed?: number;
  readonly hostName?: string;
  readonly guestName?: string;
  readonly composition?: readonly RoleId[];
}

export function createSession(options: CreateSessionOptions, rules: RulesConfig): Session {
  const composition = options.composition ?? STANDARD_COMPOSITION;
  const seed = (Math.trunc(options.seed ?? Date.now()) >>> 0) || 0x4d414649;
  const cursor = { rngState: seed };
  const rng = makeRng(cursor);

  const humanCount = options.mode === "duo" ? 2 : 1;
  const shuffledTemplates = [...SEAT_TEMPLATES];
  for (let i = shuffledTemplates.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    const a = shuffledTemplates[i];
    const b = shuffledTemplates[j];
    if (a && b) {
      shuffledTemplates[i] = b;
      shuffledTemplates[j] = a;
    }
  }

  const seats: Seat[] = composition.map((_, index) => {
    const template = shuffledTemplates[index] ?? SEAT_TEMPLATES[index] ?? { name: `좌석${index + 1}`, avatar: "🎭" };
    const controller: Controller =
      index === 0 ? "human-host" : options.mode === "duo" && index === 1 ? "human-guest" : "ai";
    const name =
      index === 0
        ? safeName(options.hostName, "방장")
        : options.mode === "duo" && index === 1
          ? safeName(options.guestName, "친구")
          : template.name;
    return { id: `p${index + 1}`, seat: index + 1, name, avatar: template.avatar, controller };
  });

  const humanIds = seats.slice(0, humanCount).map((seat) => seat.id);
  const duoTeam =
    options.mode === "duo" && humanIds[0] !== undefined && humanIds[1] !== undefined
      ? ([humanIds[0], humanIds[1]] as [string, string])
      : undefined;

  const core = createGame(
    {
      mode: options.mode,
      roster: seats.map((seat) => ({ id: seat.id, name: seat.name })),
      roles: composition,
      ...(duoTeam ? { duoTeam } : {}),
    },
    rules,
    rng,
  );

  const duoFaction =
    duoTeam === undefined ? null : (core.characters.find((c) => c.id === duoTeam[0])?.faction ?? null);

  return {
    version: 2,
    mode: options.mode,
    seed,
    rngState: cursor.rngState,
    core,
    seats,
    humanIds,
    duoFaction,
    night: emptyNight(),
    nightStepIndex: 0,
    disguiseChoices: {},
    nominationVotes: {},
    verdictVotes: {},
    messages: [
      {
        id: "m1",
        day: 1,
        speakerId: null,
        text: "도시가 잠듭니다. 사회자가 첫 번째 밤을 엽니다.",
        kind: "system",
      },
    ],
    feed: [],
    flowErrors: [],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 조회 헬퍼
// ─────────────────────────────────────────────────────────────────────────────

export function seatOf(session: Session, id: string): Seat | undefined {
  return session.seats.find((seat) => seat.id === id);
}

export function characterOf(session: Session, id: string): Character | undefined {
  return session.core.characters.find((c) => c.id === id);
}

export function nameOf(session: Session, id: string): string {
  return seatOf(session, id)?.name ?? id;
}

/** 남이 보는 이름. 변신 중이면 흉내낸 좌석의 이름이 나온다 (§5.1). */
export function displayNameOf(session: Session, id: string): string {
  const character = characterOf(session, id);
  if (character?.disguisedAs) {
    const origin = characterOf(session, character.disguisedAs);
    if (origin?.alive) return nameOf(session, origin.id);
  }
  return nameOf(session, id);
}

export function isAi(session: Session, id: string): boolean {
  return seatOf(session, id)?.controller === "ai";
}

export function isHuman(session: Session, id: string): boolean {
  return session.humanIds.includes(id);
}

/** 이번 밤의 사회자 호출 목록. */
export function currentNightSteps(session: Session, rules: RulesConfig): ActiveNightStep[] {
  return nightSteps(session.core, rules);
}

/** 지금 진행 중인 호출. 밤이 아니거나 호출이 끝났으면 null. */
export function currentNightStep(session: Session, rules: RulesConfig): ActiveNightStep | null {
  if (session.core.phase !== "night") return null;
  const steps = currentNightSteps(session, rules);
  return steps[session.nightStepIndex] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 합법 대상 — UI 가 그대로 그리고, AI 가 그대로 고른다
// ─────────────────────────────────────────────────────────────────────────────

export function legalTargets(
  session: Session,
  rules: RulesConfig,
  actorId: string,
  kind: Requirement["kind"],
): Character[] {
  const state = session.core;
  const actor = characterOf(session, actorId);
  if (!actor || !actor.alive) return [];
  const living = alive(state);

  switch (kind) {
    case "night-kill":
      // 포교당한 마피아는 역할은 그대로지만 진영이 교주팀이다 (§5.4). 팀 살해 권한을 잃는다.
      if (actor.faction !== "mafia") return [];
      return living.filter((c) => c.faction !== "mafia");
    case "night-bomb": {
      if (actor.faction !== "mafia") return [];
      // 폭탄 횟수 제한을 드라이버도 안다. 모르면 다 쓴 폭탄을 계속 제출해 밤이 끝나지 않는다.
      const limit = rules.bomber.usesPerGame;
      if (limit !== null && (state.abilityUses[actorId] ?? 0) >= limit) return [];
      return living.filter((c) => c.faction !== "mafia");
    }
    case "investigate":
      return living.filter((c) => rules.police.allowSelf || c.id !== actorId);
    case "protect":
      return living.filter((c) => rules.doctor.allowSelf || c.id !== actorId);
    case "convert":
      return living.filter(
        (c) => c.id !== actorId && c.faction !== "cult" && (rules.cult.canConvertMafia || c.faction !== "mafia"),
      );
    case "nominate":
      return living.filter((c) => c.id !== actorId);
    case "verdict":
      return [];
    case "listen":
    case "disguise":
      return [];
  }
}

export function legalSnipeTargets(session: Session, rules: RulesConfig, sniperId: string): Character[] {
  if (!sniperCanFire(session.core, rules, sniperId)) return [];
  const sniper = characterOf(session, sniperId);
  if (!sniper) return [];
  return alive(session.core).filter(
    (c) => c.id !== sniperId && (rules.sniper.canTargetOwnFaction || c.faction !== sniper.faction),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 요구 사항 — "지금 누가 무엇을 내야 하는가"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 이 사람이 이번 밤에 쓸 능력의 종류.
 *
 * 폭탄마만 상황에 따라 달라진다 — 폭탄을 다 쓰면(Q12b 제한) 폭발이 아니라 평범한 살해를 낸다.
 * 이렇게 두지 않으면 다 쓴 폭탄마가 마피아 호출에서 낼 것이 없어 시간초과로 죽는다.
 */
export function nightAbilityOf(
  session: Session,
  rules: RulesConfig,
  character: Character,
): Requirement["kind"] | null {
  if (character.roleId !== "bomber") return NIGHT_ABILITY[character.roleId];
  const limit = rules.bomber.usesPerGame;
  const used = session.core.abilityUses[character.id] ?? 0;
  return limit !== null && used >= limit ? "night-kill" : "night-bomb";
}

function nightRequirementFor(
  session: Session,
  rules: RulesConfig,
  step: ActiveNightStep,
  actorId: string,
): Requirement | null {
  const character = characterOf(session, actorId);
  if (!character || !character.alive) return null;
  const kind = nightAbilityOf(session, rules, character);
  if (kind === null) return null;

  // 진영이 바뀌면 능력도 함께 옮겨간다. 마피아팀 살해는 마피아팀만 할 수 있으므로,
  // 포교당한 마피아·폭탄마에게는 요구를 만들지 않는다 (요구를 남기면 낼 수 없는 제출을
  // 기다리며 밤이 영원히 끝나지 않는다).
  if ((kind === "night-kill" || kind === "night-bomb") && character.faction !== "mafia") return null;

  const already =
    kind === "night-kill" || kind === "night-bomb"
      ? session.night.kills[actorId] !== undefined
      : kind === "investigate"
        ? session.night.investigations[actorId] !== undefined
        : kind === "protect"
          ? session.night.protects[actorId] !== undefined
          : kind === "convert"
            ? session.night.conversion !== undefined
            : session.night.listens[actorId] === true;
  if (already) return null;

  // 교주는 짝수 밤에만 움직인다 — 홀수 밤에는 요구 자체가 없다 (§5.4)
  if (kind === "convert" && !cultCanAct(session.core, rules)) return null;

  // 합법 대상이 없는 제출은 강등한다. 규칙이 막아서 밤이 멈추는 일이 없게 한다.
  const hasTarget = kind === "listen" ? true : legalTargets(session, rules, actorId, kind).length > 0;
  return { actorId, kind, optional: !step.required || !hasTarget };
}

/**
 * 지금 채워지지 않은 제출 목록.
 *
 * 밤에는 **진행 중인 호출 하나만** 본다 — 사회자가 직업을 하나씩 깨우는 구조이므로(§6.1)
 * 아직 부르지 않은 직업의 제출을 요구하면 흐름이 뒤엉킨다.
 */
export function requirements(session: Session, rules: RulesConfig): Requirement[] {
  const state = session.core;
  if (state.phase === "ended") return [];

  if (state.phase === "night") {
    const step = currentNightStep(session, rules);
    if (!step) return [];
    const out: Requirement[] = [];
    for (const actorId of step.actorIds) {
      const requirement = nightRequirementFor(session, rules, step, actorId);
      if (requirement) out.push(requirement);
    }
    return out;
  }

  if (state.phase === "morning") {
    return alive(state)
      .filter(
        (c) =>
          c.roleId === "mafia" &&
          // 포교당한 마피아는 진영이 교주팀이라 변신 능력도 잃는다 (코어가 진영으로 판정한다)
          c.faction === "mafia" &&
          session.disguiseChoices[c.id] === undefined,
      )
      .map((c) => ({ actorId: c.id, kind: "disguise" as const, optional: false }));
  }

  if (state.phase === "day") {
    return alive(state)
      .filter((c) => session.nominationVotes[c.id] === undefined)
      .map((c) => ({ actorId: c.id, kind: "nominate" as const, optional: false }));
  }

  if (state.phase === "trial") {
    return verdictVoters(state, rules)
      .filter((c) => session.verdictVotes[c.id] === undefined)
      .map((c) => ({ actorId: c.id, kind: "verdict" as const, optional: false }));
  }

  return [];
}

/** 사람이 아직 내지 않은 **필수** 제출. 이게 비면 진행 버튼이 열린다. */
export function blockingHumanRequirements(session: Session, rules: RulesConfig): Requirement[] {
  return requirements(session, rules).filter((r) => !r.optional && isHuman(session, r.actorId));
}

// ─────────────────────────────────────────────────────────────────────────────
// 제출
// ─────────────────────────────────────────────────────────────────────────────

function fail(reason: string): SubmitResult {
  return { ok: false, reason };
}

function targetAllowed(
  session: Session,
  rules: RulesConfig,
  actorId: string,
  kind: Requirement["kind"],
  targetId: string,
): boolean {
  return legalTargets(session, rules, actorId, kind).some((c) => c.id === targetId);
}

/**
 * 이미 낸 제출을 또 내려는 것인가.
 *
 * 요구 목록에서는 이미 사라지므로 화면은 다시 묻지 않는다. 그래도 API 가 조용히
 * **덮어쓰기**를 허용하면 한 사람이 두 번 투표한 셈이 되고, 온라인에서는 낸 뒤에 마음을
 * 바꿔 다시 내는 길이 열린다. 배포본 엔진도 이걸 거부했다(DUPLICATE_ACTION).
 */
function alreadySubmitted(session: Session, action: FlowAction): boolean {
  switch (action.type) {
    case "night-kill":
    case "night-bomb":
      return session.night.kills[action.actorId] !== undefined;
    case "investigate":
      return session.night.investigations[action.actorId] !== undefined;
    case "protect":
      return session.night.protects[action.actorId] !== undefined;
    case "convert":
      return session.night.conversion !== undefined;
    case "listen":
      return session.night.listens[action.actorId] === true;
    case "disguise":
      return session.disguiseChoices[action.actorId] !== undefined;
    case "nominate":
      return session.nominationVotes[action.actorId] !== undefined;
    case "verdict":
      return session.verdictVotes[action.actorId] !== undefined;
    case "snipe":
    case "talk":
      // 저격은 횟수 제한이 규칙에 있고, 발언은 여러 번 할 수 있다
      return false;
  }
}

export function submit(session: Session, rules: RulesConfig, action: FlowAction): SubmitResult {
  const state = session.core;
  if (state.phase === "ended") return fail("이미 끝난 게임입니다.");

  const actor = characterOf(session, action.actorId);
  if (!actor) return fail("없는 참가자입니다.");
  if (!actor.alive) return fail(`${nameOf(session, action.actorId)}님은 사망해 행동할 수 없습니다.`);

  // 저격은 페이즈 밖의 행동이라 페이즈 검사를 하지 않는다 (§5.5).
  if (action.type === "snipe") {
    if (!sniperCanFire(state, rules, action.actorId)) return fail("지금은 쏠 수 없습니다.");
    if (!legalSnipeTargets(session, rules, action.actorId).some((c) => c.id === action.targetId)) {
      return fail("쏠 수 없는 대상입니다.");
    }
    const next = cloneSession(session);
    const before = next.core.log.length;
    try {
      next.core = fireSniper(next.core, rules, { sniperId: action.actorId, targetId: action.targetId });
    } catch (error) {
      return fail(error instanceof RuleError ? error.message : "저격에 실패했습니다.");
    }
    appendFeed(next, next.core.log.slice(before));
    return { ok: true, session: next };
  }

  if (action.type === "talk") {
    if (state.phase !== "day") return fail("발언은 낮 토론에서만 할 수 있습니다.");
    const text = action.text.trim().replace(/\s+/g, " ").slice(0, 280);
    if (!text) return fail("빈 발언은 보낼 수 없습니다.");
    const next = cloneSession(session);
    next.messages.push({
      id: `m${next.messages.length + 1}`,
      day: state.day,
      speakerId: action.actorId,
      text,
      kind: "speech",
    });
    return { ok: true, session: next };
  }

  const expectedPhase: Record<Exclude<FlowAction["type"], "snipe" | "talk">, GameState["phase"]> = {
    "night-kill": "night",
    "night-bomb": "night",
    investigate: "night",
    protect: "night",
    convert: "night",
    listen: "night",
    disguise: "morning",
    nominate: "day",
    verdict: "trial",
  };
  if (state.phase !== expectedPhase[action.type]) {
    return fail(`지금 단계에서 낼 수 있는 행동이 아닙니다 (현재: ${state.phase}).`);
  }

  if (alreadySubmitted(session, action)) {
    return fail("이미 제출했습니다. 한 번 낸 행동은 바꿀 수 없습니다.");
  }

  const next = cloneSession(session);

  switch (action.type) {
    case "night-kill": {
      // 폭탄을 다 쓴 폭탄마도 평범한 살해는 할 수 있다 (마피아팀 살해 1회는 남아 있다).
      if (nightAbilityOf(session, rules, actor) !== "night-kill") {
        return fail("지금 당신의 밤 행동은 평범한 살해가 아닙니다.");
      }
      if (!targetAllowed(session, rules, action.actorId, "night-kill", action.targetId)) {
        return fail("살해할 수 없는 대상입니다.");
      }
      next.night.kills[action.actorId] = { targetId: action.targetId };
      return { ok: true, session: next };
    }
    case "night-bomb": {
      if (actor.roleId !== "bomber") return fail("폭탄마의 밤 행동입니다.");
      const pool = legalTargets(session, rules, action.actorId, "night-bomb");
      const required = Math.min(rules.bomber.candidateCount, pool.length);
      const unique = [...new Set(action.candidates)];
      if (unique.length !== required) return fail(`후보를 정확히 ${required}명 고르세요.`);
      if (!unique.includes(action.targetId)) return fail("찍은 대상은 후보 안에 있어야 합니다.");
      if (!unique.every((id) => pool.some((c) => c.id === id))) return fail("후보로 세울 수 없는 대상이 있습니다.");
      next.night.kills[action.actorId] = { targetId: action.targetId, candidates: unique };
      return { ok: true, session: next };
    }
    case "investigate": {
      if (actor.roleId !== "police") return fail("경찰의 밤 행동입니다.");
      if (!targetAllowed(session, rules, action.actorId, "investigate", action.targetId)) {
        return fail("검사할 수 없는 대상입니다.");
      }
      next.night.investigations[action.actorId] = action.targetId;
      return { ok: true, session: next };
    }
    case "protect": {
      if (actor.roleId !== "doctor") return fail("의사의 밤 행동입니다.");
      if (!targetAllowed(session, rules, action.actorId, "protect", action.targetId)) {
        return fail("보호할 수 없는 대상입니다.");
      }
      next.night.protects[action.actorId] = action.targetId;
      return { ok: true, session: next };
    }
    case "convert": {
      if (actor.roleId !== "cultleader") return fail("교주의 밤 행동입니다.");
      if (!cultCanAct(state, rules)) return fail("교주는 짝수 밤에만 움직입니다.");
      if (action.targetId === null) {
        next.night.conversion = null;
        return { ok: true, session: next };
      }
      if (!targetAllowed(session, rules, action.actorId, "convert", action.targetId)) {
        return fail("포교할 수 없는 대상입니다.");
      }
      next.night.conversion = { targetId: action.targetId };
      return { ok: true, session: next };
    }
    case "listen": {
      if (actor.roleId !== "citizen") return fail("시민의 밤 행동입니다.");
      next.night.listens[action.actorId] = true;
      return { ok: true, session: next };
    }
    case "disguise": {
      if (actor.roleId !== "mafia" || actor.faction !== "mafia") {
        return fail("변신은 마피아팀 일반 마피아의 아침 능력입니다.");
      }
      next.disguiseChoices[action.actorId] = action.use;
      return { ok: true, session: next };
    }
    case "nominate": {
      if (!targetAllowed(session, rules, action.actorId, "nominate", action.targetId)) {
        return fail("지목할 수 없는 대상입니다.");
      }
      next.nominationVotes[action.actorId] = action.targetId;
      return { ok: true, session: next };
    }
    case "verdict": {
      if (!verdictVoters(state, rules).some((c) => c.id === action.actorId)) {
        return fail("생사 투표 자격이 없습니다.");
      }
      next.verdictVotes[action.actorId] = action.choice;
      return { ok: true, session: next };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 마피아팀 살해 취합 — 그 밤의 팀 살해는 1회 (§5.1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 팀원이 각자 낸 지목을 **하나로 확정**한다.
 *
 * 배포본은 팀원 표가 갈리면 "합의 실패"로 아무도 죽지 않았다(측정 60판 중 21회). 정본에
 * 그런 규칙은 없다 — 팀 살해는 1회이고, 형태는 수행자의 역할이 정한다. 그래서 여기서
 * 폭탄마 제출을 우선하고(폭탄이 일반 살해를 대체한다), 나머지는 최다 지목·동률은 난수로 정한다.
 */
export function consolidateKill(session: Session, rng: Rng): NightActions["kill"] {
  const entries = Object.entries(session.night.kills);
  if (entries.length === 0) return null;

  const bomb = entries.find(([, submission]) => submission.candidates !== undefined);
  if (bomb) {
    const [actorId, submission] = bomb;
    return { actorId, targetId: submission.targetId, candidates: submission.candidates };
  }

  const tally = new Map<string, string[]>();
  for (const [actorId, submission] of entries) {
    const bucket = tally.get(submission.targetId) ?? [];
    bucket.push(actorId);
    tally.set(submission.targetId, bucket);
  }
  const top = Math.max(...[...tally.values()].map((ids) => ids.length));
  const leaders = [...tally.entries()].filter(([, ids]) => ids.length === top);
  const chosen = pickWith(leaders, rng);
  if (!chosen) return null;
  const [targetId, actorIds] = chosen;
  const actorId = actorIds[0];
  if (actorId === undefined) return null;
  return { actorId, targetId };
}

/**
 * 해소 직전에 제출물을 현재 상태에 맞춰 고친다.
 *
 * 저격은 페이즈 밖이라 **밤 도중에도** 사람을 죽인다 (§5.5). 그러면 이미 제출된 살해 대상·
 * 폭탄 후보·검사 대상이 그 자리에서 무효가 되고, 엄격한 코어는 예외를 던진다. 코어를 느슨하게
 * 만드는 대신 경계에서 고친다 — 규칙은 그대로 두고, 흐름만 살린다.
 *
 * 고칠 수 없을 때(합법 대상이 아예 없을 때)만 제출을 버린다. 그때는 "필수 호출에 행동 없음"
 * 이므로 시간초과 규칙이 정당하게 작동한다.
 */
function repairNightDraft(session: Session, rules: RulesConfig): NightDraft {
  const draft = cloneNight(session.night);

  for (const actorId of Object.keys(draft.kills)) {
    const submission = draft.kills[actorId];
    const actor = characterOf(session, actorId);
    if (!submission || !actor?.alive || actor.faction !== "mafia") {
      delete draft.kills[actorId];
      continue;
    }
    // 폭탄인지 아닌지는 **역할이 아니라 제출 형태**가 정한다. 폭탄을 다 쓴 폭탄마는 평범한
    // 살해를 내는데, 역할로 판정하면 그 제출을 폭탄 기준으로 검사해 버려서 통째로 삭제된다
    // (그러면 마피아 호출이 미이행이 되어 폭탄마가 시간초과로 죽었다 — 측정 300판 170회).
    const isBomb = submission.candidates !== undefined;
    const pool = legalTargets(session, rules, actorId, isBomb ? "night-bomb" : "night-kill");
    if (pool.length === 0) {
      delete draft.kills[actorId];
      continue;
    }
    if (!isBomb) {
      if (!pool.some((c) => c.id === submission.targetId)) {
        const replacement = pool[0];
        if (replacement) draft.kills[actorId] = { targetId: replacement.id };
      }
      continue;
    }
    const required = Math.min(rules.bomber.candidateCount, pool.length);
    const kept = (submission.candidates ?? []).filter((id) => pool.some((c) => c.id === id));
    const filler = pool.map((c) => c.id).filter((id) => !kept.includes(id));
    const candidates = [...kept, ...filler].slice(0, required);
    const targetId = candidates.includes(submission.targetId) ? submission.targetId : candidates[0];
    if (targetId === undefined) {
      delete draft.kills[actorId];
      continue;
    }
    draft.kills[actorId] = { targetId, candidates };
  }

  const retarget = (
    book: Record<string, string>,
    kind: Requirement["kind"],
    roleId: RoleId,
  ): void => {
    for (const actorId of Object.keys(book)) {
      const actor = characterOf(session, actorId);
      if (!actor?.alive || actor.roleId !== roleId) {
        delete book[actorId];
        continue;
      }
      const pool = legalTargets(session, rules, actorId, kind);
      if (pool.length === 0) {
        delete book[actorId];
        continue;
      }
      const current = book[actorId];
      if (current === undefined || !pool.some((c) => c.id === current)) {
        const replacement = pool[0];
        if (replacement) book[actorId] = replacement.id;
      }
    }
  };
  retarget(draft.investigations, "investigate", "police");
  retarget(draft.protects, "protect", "doctor");

  if (draft.conversion) {
    const leader = alive(session.core).find((c) => c.roleId === "cultleader");
    if (!leader || !cultCanAct(session.core, rules)) {
      draft.conversion = undefined;
    } else {
      const pool = legalTargets(session, rules, leader.id, "convert");
      if (pool.length === 0) {
        draft.conversion = undefined;
      } else if (!pool.some((c) => c.id === draft.conversion?.targetId)) {
        const replacement = pool[0];
        draft.conversion = replacement ? { targetId: replacement.id } : undefined;
      }
    }
  }

  return draft;
}

function toNightActions(session: Session, rules: RulesConfig, rng: Rng): NightActions {
  const repaired = repairNightDraft(session, rules);
  const scoped: Session = { ...session, night: repaired };

  const investigations = Object.entries(repaired.investigations).map(([policeId, targetId]) => ({
    policeId,
    targetId,
  }));
  const protects = Object.entries(repaired.protects).map(([doctorId, targetId]) => ({
    doctorId,
    targetId,
  }));
  const leader = alive(session.core).find((c) => c.roleId === "cultleader");
  const conversion =
    repaired.conversion && leader
      ? { cultLeaderId: leader.id, targetId: repaired.conversion.targetId }
      : undefined;

  return {
    kill: consolidateKill(scoped, rng),
    investigations,
    protects,
    ...(conversion ? { conversion } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 서사 로그 — 코어 이벤트에 가시성을 부여한다
// ─────────────────────────────────────────────────────────────────────────────

function push(session: Session, entry: Omit<FeedEntry, "id" | "day" | "phase">): void {
  session.feed.push({
    id: `f${session.feed.length + 1}`,
    day: session.core.day,
    phase: session.core.phase,
    ...entry,
  });
}

const DEATH_CAUSE_TEXT: Readonly<Record<string, string>> = {
  night_kill: "밤사이 살해되었습니다",
  execution: "재판 결과 처형되었습니다",
  vote_damage: "상처가 쌓여 숨을 거뒀습니다",
  collateral: "폭발에 휘말려 사망했습니다",
  snipe: "총성 한 발에 쓰러졌습니다",
  timeout: "제 시간에 움직이지 않아 목숨을 잃었습니다",
};

/** 코어가 새로 남긴 이벤트를 사람이 읽을 줄로 옮긴다. */
export function appendFeed(session: Session, events: readonly GameEvent[]): void {
  for (const event of events) {
    const name = (id: string): string => nameOf(session, id);
    switch (event.kind) {
      case "night_kill":
        push(session, { text: `${name(event.targetId)}님을 표적으로 정했습니다.`, visibility: "mafia" });
        break;
      case "bomb":
        push(session, {
          text: `폭탄 후보 ${event.candidates.map(name).join(" · ")} 중 ${name(event.targetId)}님을 찍었습니다.`,
          visibility: "mafia",
        });
        break;
      case "collateral":
        push(session, {
          text: `${name(event.characterId)}님이 폭발 여파로 상처를 입었습니다.`,
          visibility: "public",
        });
        break;
      case "kill_blocked":
        push(session, { text: "누군가를 노린 손이 그 밤에 막혔습니다.", visibility: "public" });
        break;
      case "protected":
        push(session, {
          text: `${name(event.targetId)}님을 지켰습니다.`,
          visibility: "private",
          forIds: [event.doctorId],
        });
        break;
      case "investigated":
        // 검사 결과는 **익명으로 공개**한다.
        //
        // 정본 §5.3 은 "결과를 누구에게 보여줄지는 표현층이 정한다"로 이 결정을 열어 두었다.
        // 경찰만 알게 두면 그 정보가 시민팀 전체의 판단으로 이어지지 못해, 처형이 사실상
        // 추측이 된다(측정: 처형 중 마피아 적중률 30%, 시민팀 승률 16%). 결과만 공개하고
        // **누가 검사했는지는 숨기면** 경찰의 정체는 지켜지고 시민팀에는 판단 근거가 생긴다.
        push(session, {
          text: `밤사이 확인된 사실 — ${name(event.targetId)}님은 ${event.result === "mafia" ? "마피아팀입니다" : "마피아팀이 아닙니다"}.`,
          visibility: "public",
        });
        push(session, {
          text: `당신의 검사 결과입니다 — ${name(event.targetId)}님은 ${event.result === "mafia" ? "마피아팀" : "마피아팀이 아님"}.`,
          visibility: "private",
          forIds: [event.policeId],
        });
        break;
      case "converted":
        push(session, { text: `${name(event.targetId)}님이 사제가 되었습니다.`, visibility: "cult" });
        push(session, {
          text: "당신은 교주의 사제가 되었습니다. 이제 교주팀의 승리가 당신의 승리입니다.",
          visibility: "private",
          forIds: [event.targetId],
        });
        break;
      case "conversion_blocked":
        push(session, { text: "포교가 막혔습니다.", visibility: "cult" });
        break;
      case "disguised":
        push(session, {
          text: `${name(event.originId)}님의 외형을 뒤집어썼습니다.`,
          visibility: "mafia",
        });
        break;
      case "disguise_unavailable":
        push(session, { text: "뒤집어쓸 얼굴이 없었습니다.", visibility: "mafia" });
        break;
      case "disguise_ended":
        push(session, { text: "변신이 풀렸습니다.", visibility: "mafia" });
        break;
      case "nominated":
        push(session, {
          text: `${displayNameOf(session, event.nomineeId)}님이 ${event.votes}표로 법정에 섰습니다.`,
          visibility: "public",
        });
        break;
      case "no_nomination":
        push(session, {
          text: event.reason === "tie" ? "표가 갈려 아무도 법정에 서지 않았습니다." : "지목이 없어 재판이 열리지 않았습니다.",
          visibility: "public",
        });
        break;
      case "verdict":
        push(session, {
          text: `생사 투표 — 죽인다 ${event.kill} · 살린다 ${event.spare} (자격자 ${event.voters}) → ${event.decision === "kill" ? "가결" : "부결"}`,
          visibility: "public",
        });
        break;
      case "disguise_absorbed":
        push(session, {
          text: `처형이 빗나갔습니다. ${name(event.originId)}님이 대신 상처를 입었습니다.`,
          visibility: "public",
        });
        break;
      case "sniped":
        push(session, { text: `${name(event.targetId)}님이 총에 맞았습니다.`, visibility: "public" });
        break;
      case "timed_out":
        push(session, {
          text: `${name(event.characterId)}님이 호출에 응하지 않았습니다.`,
          visibility: "public",
        });
        break;
      case "died":
        push(session, {
          text: `${name(event.characterId)}님이 ${DEATH_CAUSE_TEXT[event.cause] ?? "사망했습니다"}.`,
          visibility: "public",
        });
        break;
      case "victory":
        push(session, { text: `${FACTION_LABEL[event.faction]}이 승리했습니다.`, visibility: "public" });
        break;
      case "all_dead":
        push(session, { text: "생존자가 남지 않았습니다. 승자 없이 끝났습니다.", visibility: "public" });
        break;
    }
  }
}

export const FACTION_LABEL: Readonly<Record<Faction, string>> = {
  citizen: "시민팀",
  mafia: "마피아팀",
  cult: "교주팀",
};

function systemMessage(session: Session, text: string): void {
  session.messages.push({
    id: `m${session.messages.length + 1}`,
    day: session.core.day,
    speakerId: null,
    text,
    kind: "system",
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 진행 — 절대 던지지 않는다
// ─────────────────────────────────────────────────────────────────────────────

/** 코어 호출을 감싼다. 규칙 위반이 나오면 게임을 멈추지 않고 기록만 남긴다. */
function guard(session: Session, label: string, run: () => GameState): GameState {
  try {
    return run();
  } catch (error) {
    session.flowErrors.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    return session.core;
  }
}

export type AiFiller = (session: Session, rules: RulesConfig, requirement: Requirement) => Session;

/**
 * 한 단계 진행한다.
 *
 * `fillAi` 를 주면 AI 몫의 제출을 진행 시점에 채운다 (기본은 채우지 않음 — 순수 규칙 테스트용).
 * 사람 몫 필수 제출이 남아 있으면 상태를 바꾸지 않고 `{ok:false, blocked}` 를 돌려준다.
 */
export function advance(session: Session, rules: RulesConfig, fillAi?: AiFiller): AdvanceResult {
  if (session.core.phase === "ended") return { ok: false, blocked: [] };

  let working = session;
  if (fillAi) {
    // AI 제출은 진행을 막는 이유가 되지 않는다. 낼 수 있는 건 지금 다 낸다.
    for (let guardCount = 0; guardCount < 64; guardCount += 1) {
      const pending = requirements(working, rules).filter((r) => isAi(working, r.actorId));
      if (pending.length === 0) break;
      const before = working;
      for (const requirement of pending) {
        working = fillAi(working, rules, requirement);
      }
      if (working === before) break;
    }
  }

  const blocked = blockingHumanRequirements(working, rules);
  if (blocked.length > 0) return { ok: false, blocked };

  const next = cloneSession(working);
  const rng = makeRng(next);
  const before = next.core.log.length;
  const phase = next.core.phase;

  switch (phase) {
    case "night": {
      const steps = currentNightSteps(next, rules);
      if (next.nightStepIndex < steps.length - 1) {
        // 아직 부를 직업이 남았다 — 다음 호출로 넘어간다 (밤 해소는 마지막 호출 뒤에)
        next.nightStepIndex += 1;
        return { ok: true, session: next };
      }
      const actions = toNightActions(next, rules, rng);
      next.core = guard(next, "resolveNight", () => resolveNight(next.core, rules, actions));
      next.night = emptyNight();
      next.nightStepIndex = 0;
      systemMessage(next, "밤이 지나고 새벽이 옵니다.");
      break;
    }
    case "dawn":
      next.core = guard(next, "resolveDawn", () => resolveDawn(next.core));
      systemMessage(next, "아침입니다. 마피아가 얼굴을 바꿀 수 있는 시간입니다.");
      break;
    case "morning": {
      const users = alive(next.core)
        .filter((c) => c.roleId === "mafia" && c.faction === "mafia" && next.disguiseChoices[c.id] === true)
        .map((c) => c.id);
      next.core = guard(next, "resolveMorning", () => resolveMorning(next.core, rules, users, rng));
      next.disguiseChoices = {};
      systemMessage(next, "토론이 시작됩니다. 의심을 말하고, 한 명을 법정에 세우세요.");
      break;
    }
    case "day":
      next.core = guard(next, "resolveDay", () => resolveDay(next.core, rules, next.nominationVotes, rng));
      next.nominationVotes = {};
      if (next.core.phase === "trial" && next.core.nominee) {
        systemMessage(next, `${displayNameOf(next, next.core.nominee)}님의 변론이 시작됩니다.`);
      }
      break;
    case "trial":
      next.core = guard(next, "resolveTrial", () => resolveTrial(next.core, rules, next.verdictVotes));
      next.verdictVotes = {};
      break;
    case "dusk":
      next.core = guard(next, "resolveDusk", () => resolveDusk(next.core, rules));
      next.night = emptyNight();
      next.nightStepIndex = 0;
      next.nominationVotes = {};
      next.verdictVotes = {};
      systemMessage(next, `${next.core.day}일차 밤이 시작됩니다.`);
      break;
    default:
      break;
  }

  appendFeed(next, next.core.log.slice(before));

  // 재판이 성립하지 않은 날(피고 없음)은 코어가 이미 dusk 로 보냈다. 흐름이 멈추지 않게
  // 여기서 한 번 더 확인만 하고, 실제 전이는 다음 advance 가 처리한다.
  return { ok: true, session: next };
}


/**
 * **사람이 할 일이 생길 때까지** 자동으로 진행한다.
 *
 * 밤에는 사회자가 직업을 하나씩 부르는데(§6.1), 12인 판이면 호출이 5~6개이고 그중 내 차례는
 * 하나다. 호출마다 클릭을 요구하면 사람이 하는 일의 대부분이 "다음 단계로" 누르기가 된다
 * (측정: 판당 결정 6.4회 대 그냥 넘김 36.9회 — 클릭의 85%가 빈 클릭이었다).
 *
 * 그래서 멈추는 지점을 넷으로 좁혔다.
 *   - 사람이 낼 필수 제출이 생겼다
 *   - **새벽** — 밤에 무슨 일이 있었는지 확인하는 자리다
 *   - 게임이 끝났다
 *   - 사람 없이 더 갈 수 없다 (막힘)
 *
 * 지나간 호출은 사라지지 않는다. 어떤 직업이 불려 나갔는지 요약해 기록에 남긴다 —
 * 호출 순서 자체가 판의 구성을 읽는 단서이기 때문이다(§6.1).
 */
export function advanceUntilInput(
  session: Session,
  rules: RulesConfig,
  fillAi?: AiFiller,
  limit = 40,
): AdvanceResult {
  let working = session;
  let moved = false;
  const skippedCalls: string[] = [];

  for (let step = 0; step < limit; step += 1) {
    if (working.core.phase === "ended") break;

    // 사람 차례면 여기서 멈춘다
    if (blockingHumanRequirements(working, rules).length > 0) break;
    // 사람이 낼 수 있는 선택적 제출(시민의 청취·스나이퍼의 저격)도 기다려 준다
    if (
      working.core.phase === "night" &&
      requirements(working, rules).some(
        (r) => isHuman(working, r.actorId) && characterOf(working, r.actorId)?.alive === true,
      )
    ) {
      break;
    }

    const before = working;
    const beforePhase = working.core.phase;
    const beforeCall = currentNightStep(working, rules)?.prompt ?? null;

    const result = advance(working, rules, fillAi);
    if (!result.ok) {
      return moved ? { ok: true, session: withSkipNote(working, skippedCalls) } : result;
    }
    working = result.session;
    moved = true;

    if (beforePhase === "night" && working.core.phase === "night" && beforeCall) {
      skippedCalls.push(beforeCall);
    }
    if (working === before) break;

    // 새벽은 확인하는 자리다 — 여기서 멈춘다.
    // 단 **사람이 이미 다 죽었으면 멈추지 않는다.** 시체가 새벽마다 '다음 단계로' 를 누르는
    // 것은 노동이지 게임이 아니다 (측정: 판당 2.6회, 남은 빈 클릭의 46%가 사망 후 관전이었다).
    // 끝까지 달려가 결과를 보여준다.
    if (working.core.phase === "dawn" && alive(working.core).some((c) => isHuman(working, c.id))) {
      break;
    }
    if (working.core.phase === "ended") break;
  }

  return { ok: true, session: withSkipNote(working, skippedCalls) };
}

/** 자동으로 지나간 사회자 호출을 기록에 남긴다. 호출 순서는 그 자체가 정보다 (§6.1). */
function withSkipNote(session: Session, skipped: readonly string[]): Session {
  if (skipped.length === 0) return session;
  const next = cloneSession(session);
  systemMessage(next, `사회자가 차례로 불렀습니다 — ${skipped.map((p) => `“${p}”`).join(" ")}`);
  return next;
}

/** 승부가 났는가. */
export function isOver(session: Session): boolean {
  return session.core.phase === "ended" || session.core.winner !== null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 시야 — 이 사람이 아는 것만
// ─────────────────────────────────────────────────────────────────────────────

export interface SeatView {
  readonly id: string;
  readonly seat: number;
  readonly displayName: string;
  readonly avatar: string;
  readonly hp: number;
  readonly alive: boolean;
  /** 같은 이름이 둘 보이는 상태 — 변신 때문이다 */
  readonly duplicated: boolean;
  /** 나에게 정체가 보이는 사람 (같은 진영 등) */
  readonly knownRoleId: RoleId | null;
}

export function visibleFeed(session: Session, viewerId: string): FeedEntry[] {
  const viewer = characterOf(session, viewerId);
  return session.feed.filter((entry) => {
    if (entry.visibility === "public") return true;
    if (entry.visibility === "private") return entry.forIds?.includes(viewerId) ?? false;
    return viewer?.faction === entry.visibility;
  });
}

/**
 * 이 사람에게 저 사람의 정체가 보이는가.
 *
 * 판정은 **규칙이 한다** — `knownAllies` (§4.4, 8차 입력). 여기서는 규칙 밖의 두 가지만 얹는다.
 *   - 듀오 짝은 진영과 무관하게 서로를 안다 (§2 — "둘이 같이 편먹는다")
 *   - 죽은 사람은 모두를 본다 (§13.5 — 관전)
 */
export function knownRoleFor(
  session: Session,
  rules: RulesConfig,
  viewerId: string,
  targetId: string,
): RoleId | null {
  const viewer = characterOf(session, viewerId);
  const target = characterOf(session, targetId);
  if (!viewer || !target) return null;
  if (viewer.id === target.id) return target.roleId;

  // **죽은 사람은 모든 정체를 본다.** 오프라인 마피아의 관례이고 규칙에는 영향이 없다
  // (사망자는 더 이상 아무것도 낼 수 없다). 사람은 판의 79% 에서 죽고 그 뒤 평균 2.2일이
  // 남는데(측정), 아무것도 못 보는 관전은 그냥 기다리기다.
  if (!viewer.alive) return target.roleId;

  // 시작할 때 나눠 받은 정보 (§4.4). 기준은 배정 당시의 원래 진영이다.
  if (knownAllies(session.core, rules, viewer.id).some((c) => c.id === target.id)) {
    return target.roleId;
  }

  // 듀오 짝은 진영과 무관하게 서로를 안다 (§2).
  if (session.mode === "duo" && session.humanIds.includes(viewer.id) && session.humanIds.includes(target.id)) {
    return target.roleId;
  }
  return null;
}

export function seatViews(session: Session, rules: RulesConfig, viewerId: string): SeatView[] {
  const names = new Map<string, number>();
  for (const seat of session.seats) {
    const character = characterOf(session, seat.id);
    if (!character?.alive) continue;
    const shown = displayNameOf(session, seat.id);
    names.set(shown, (names.get(shown) ?? 0) + 1);
  }

  return session.seats.map((seat) => {
    const character = characterOf(session, seat.id);
    const shown = displayNameOf(session, seat.id);
    return {
      id: seat.id,
      seat: seat.seat,
      displayName: shown,
      avatar: seat.avatar,
      hp: character?.hp ?? 0,
      alive: character?.alive ?? false,
      duplicated: (names.get(shown) ?? 0) > 1,
      knownRoleId: knownRoleFor(session, rules, viewerId, seat.id),
    };
  });
}

/**
 * AI 참가자. 규칙 기반이고 외부 모델을 쓰지 않는다 (AGENTS.md 불변 규칙 5).
 *
 * 배포본 AI 의 결정적 결함은 의심 점수가 **"대화에서 이름이 몇 번 불렸는가"** 였다는 점이다.
 * AI 들이 무작위로 서로의 이름을 부르며 사람 이름도 함께 불렀고, 그 결과 사람이 매 판
 * 최다 득표자가 되었다. 그래서 여기서는 이름 언급 횟수를 **점수에 쓰지 않는다.** 대신
 * 규칙이 만들어내는 실제 증거만 쓴다.
 *
 * | 증거 | 근거 | 효과 |
 * |---|---|---|
 * | 폭탄 후보였다 | 폭탄마는 같은 팀을 후보에 넣지 못한다 (§5.2) | **마피아팀이 아님이 증명**된다 |
 * | 같은 얼굴이 둘 보인다 | 변신은 시민 얼굴을 뒤집어쓴다 (§5.1) | 둘 중 하나가 마피아다 |
 * | 검사 결과 | 경찰만 안다 (§5.3) | 확정 정보 |
 * | 같은 진영 | 마피아팀·교주팀은 서로를 안다 | 절대 찍지 않는다 |
 */

import type { RulesConfig } from "../rules/config.ts";
import { alive } from "../rules/engine.ts";
import type { Character, Verdict } from "../rules/types.ts";
import {
  characterOf,
  cloneSession,
  displayNameOf,
  legalSnipeTargets,
  legalTargets,
  pickWith,
  submit,
} from "../flow/session.ts";
import type { FlowAction, Requirement, Session } from "../flow/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// 증거 수집 — 코어 로그에서 규칙이 남긴 사실만 읽는다
// ─────────────────────────────────────────────────────────────────────────────

export interface Evidence {
  /** 폭탄 후보로 올랐던 사람 = 마피아팀이 아님이 증명된 사람 */
  readonly provenNotMafia: ReadonlySet<string>;
  /** 경찰별 검사 기록: policeId → (targetId → 마피아 여부) */
  readonly investigations: ReadonlyMap<string, ReadonlyMap<string, boolean>>;
  /** 검사로 마피아팀임이 공개 확인된 사람 (결과는 익명 공개다 — flow/session.ts 의 feed 참조) */
  readonly publicMafia: ReadonlySet<string>;
  /** 검사로 마피아팀이 아님이 공개 확인된 사람 */
  readonly publicClear: ReadonlySet<string>;
  /** 이전에 법정에 섰다가 살아남은 사람 */
  readonly survivedTrial: ReadonlySet<string>;
  /** 지금 같은 표시 이름이 둘 이상 보이는 이름 */
  readonly duplicatedNames: ReadonlySet<string>;
}

export function gatherEvidence(session: Session): Evidence {
  const provenNotMafia = new Set<string>();
  const investigations = new Map<string, Map<string, boolean>>();
  const publicMafia = new Set<string>();
  const publicClear = new Set<string>();
  const survivedTrial = new Set<string>();

  for (const event of session.core.log) {
    if (event.kind === "bomb") {
      for (const id of event.candidates) provenNotMafia.add(id);
    } else if (event.kind === "investigated") {
      const book = investigations.get(event.policeId) ?? new Map<string, boolean>();
      book.set(event.targetId, event.result === "mafia");
      investigations.set(event.policeId, book);
      if (event.result === "mafia") publicMafia.add(event.targetId);
      else publicClear.add(event.targetId);
    } else if (event.kind === "verdict" && event.decision === "spare") {
      survivedTrial.add(event.nomineeId);
    }
  }

  const nameCount = new Map<string, number>();
  for (const character of alive(session.core)) {
    const shown = displayNameOf(session, character.id);
    nameCount.set(shown, (nameCount.get(shown) ?? 0) + 1);
  }
  const duplicatedNames = new Set(
    [...nameCount.entries()].filter(([, count]) => count > 1).map(([name]) => name),
  );

  return { provenNotMafia, investigations, publicMafia, publicClear, survivedTrial, duplicatedNames };
}

/** 같은 진영이라 절대 찍지 않는 상대인가 (마피아팀·교주팀은 서로를 안다). */
function isKnownAlly(viewer: Character, target: Character): boolean {
  if (viewer.id === target.id) return true;
  if (viewer.faction === "citizen") return false;
  return viewer.faction === target.faction;
}

/**
 * 의심 점수. 높을수록 마피아팀일 것 같다는 뜻이다.
 * **조종 주체(사람/AI)를 보지 않는다** — 사람이 표적이 되는 편향을 만들지 않기 위해서다.
 */
export function suspicion(
  session: Session,
  evidence: Evidence,
  viewer: Character,
  target: Character,
  jitter: number,
): number {
  if (isKnownAlly(viewer, target)) return Number.NEGATIVE_INFINITY;

  let score = jitter;

  // 검사 결과는 익명으로 공개되므로 **모두가** 쓴다. 이게 시민팀의 유일한 확정 정보다.
  if (evidence.publicMafia.has(target.id)) score += 120;
  else if (evidence.publicClear.has(target.id)) score -= 60;

  if (evidence.duplicatedNames.has(displayNameOf(session, target.id))) score += 40;
  // 폭탄 후보 증거는 **마피아팀이 아님**만 증명한다. 교주팀은 전혀 걸러내지 못한다 (§5.3 의
  // 검사 결과와 같은 구멍이다). 이걸 절대적 무죄로 취급하면 교주팀이 영원히 살아남아
  // 판이 교착한다(측정: 3인 남은 상태로 42일차 반복). 그래서 참고 수준의 감점만 준다.
  if (evidence.provenNotMafia.has(target.id)) score -= 15;
  if (evidence.survivedTrial.has(target.id)) score += 8;
  // 상처는 폭탄 후보나 변신 흡수의 흔적이라 오히려 결백의 방증에 가깝다.
  if (target.hp < 2) score -= 6;

  // 교주팀은 사망이 곧 승리 조건이라 누구든 밀어붙인다.
  if (viewer.faction === "cult") score += 5;

  return score;
}

function rankTargets(
  session: Session,
  evidence: Evidence,
  viewer: Character,
  candidates: readonly Character[],
  rng: () => number,
): Character[] {
  return [...candidates]
    .map((candidate) => ({ candidate, score: suspicion(session, evidence, viewer, candidate, rng() * 6) }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((a, b) => b.score - a.score)
    .map(({ candidate }) => candidate);
}

/** 공개 정보로 결백에 가까운 사람 = 마피아팀이 죽이고 싶은 사람. */
function trustRank(session: Session, evidence: Evidence, candidates: readonly Character[]): Character[] {
  return [...candidates].sort((a, b) => {
    const trust = (c: Character): number =>
      (evidence.publicClear.has(c.id) ? 3 : 0) +
      (evidence.provenNotMafia.has(c.id) ? 2 : 0) +
      (evidence.duplicatedNames.has(displayNameOf(session, c.id)) ? -1 : 0) +
      (c.hp === 2 ? 1 : 0);
    return trust(b) - trust(a);
  });
}

/**
 * 상위권에서 무작위로 하나 고른다.
 *
 * 마피아의 표적 선정과 의사의 보호가 **같은 순위 함수를 결정론적으로** 쓰면 둘이 매번 같은
 * 사람을 골라 밤 살해가 통째로 막힌다(측정: 판당 무살해 밤 4.69회, 판이 7일 이상 늘어져
 * 시간이 이득인 교주팀이 47% 독주). 상위권 안에서 흔들어 두 판단을 떼어 놓는다.
 */
function pickAmongTop(ranked: readonly Character[], rng: () => number, top = 3): Character | null {
  if (ranked.length === 0) return null;
  const window = ranked.slice(0, Math.min(top, ranked.length));
  return window[Math.min(window.length - 1, Math.floor(rng() * window.length))] ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 밤·아침·낮 제출 채우기
// ─────────────────────────────────────────────────────────────────────────────

function apply(session: Session, rules: RulesConfig, action: FlowAction): Session {
  const result = submit(session, rules, action);
  return result.ok ? result.session : session;
}

/** 세션의 rngState 를 굴려 [0,1) 을 얻는다. 시드가 같으면 AI 도 같게 움직인다. */
function roll(session: Session): number {
  session.rngState = (Math.imul(session.rngState, 1_664_525) + 1_013_904_223) >>> 0;
  return session.rngState / 0x1_0000_0000;
}

export function fillRequirement(session: Session, rules: RulesConfig, requirement: Requirement): Session {
  const working = cloneSession(session);
  const rng = (): number => roll(working);
  const actor = characterOf(working, requirement.actorId);
  if (!actor || !actor.alive) return working;
  const evidence = gatherEvidence(working);

  switch (requirement.kind) {
    case "listen":
      return apply(working, rules, { type: "listen", actorId: actor.id });

    case "disguise":
      // 변신은 표를 흡수해 시민을 대신 때리는 공격기다 — 쓸 수 있으면 쓴다 (§5.1).
      return apply(working, rules, { type: "disguise", actorId: actor.id, use: true });

    case "night-kill": {
      const pool = legalTargets(working, rules, actor.id, "night-kill");
      const target = pickAmongTop(trustRank(working, evidence, pool), rng) ?? pickWith(pool, rng);
      if (!target) return working;
      return apply(working, rules, { type: "night-kill", actorId: actor.id, targetId: target.id });
    }

    case "night-bomb": {
      const pool = legalTargets(working, rules, actor.id, "night-bomb");
      const count = Math.min(rules.bomber.candidateCount, pool.length);
      if (count === 0) return working;
      const ordered = trustRank(working, evidence, pool);
      const candidates = ordered.slice(0, count).map((c) => c.id);
      const targetId = candidates[Math.min(candidates.length - 1, Math.floor(rng() * candidates.length))];
      if (targetId === undefined) return working;
      return apply(working, rules, { type: "night-bomb", actorId: actor.id, targetId, candidates });
    }

    case "investigate": {
      const pool = legalTargets(working, rules, actor.id, "investigate");
      const book = evidence.investigations.get(actor.id);
      // 이미 본 사람을 다시 보는 건 정보 낭비다.
      const fresh = pool.filter((c) => !book?.has(c.id));
      const ranked = rankTargets(working, evidence, actor, fresh.length > 0 ? fresh : pool, rng);
      const target = ranked[0] ?? pickWith(pool, rng);
      if (!target) return working;
      return apply(working, rules, { type: "investigate", actorId: actor.id, targetId: target.id });
    }

    case "protect": {
      const pool = legalTargets(working, rules, actor.id, "protect");
      // 마피아팀이 노릴 만한 사람 = 공개적으로 결백해 보이는 사람. 없으면 자기를 지킨다.
      const ordered = trustRank(working, evidence, pool.filter((c) => c.id !== actor.id));
      const target = pickAmongTop(ordered, rng) ?? pool.find((c) => c.id === actor.id) ?? pickWith(pool, rng);
      if (!target) return working;
      return apply(working, rules, { type: "protect", actorId: actor.id, targetId: target.id });
    }

    case "convert": {
      const pool = legalTargets(working, rules, actor.id, "convert");
      // 시민을 먼저 전향시킨다 — 마피아팀은 계속 남을 죽여 승리 조건을 채워 준다 (§5.4 Q28).
      const citizens = pool.filter((c) => c.faction === "citizen");
      const target = trustRank(working, evidence, citizens.length > 0 ? citizens : pool)[0] ?? pickWith(pool, rng);
      if (!target) return working;
      return apply(working, rules, { type: "convert", actorId: actor.id, targetId: target.id });
    }

    case "nominate": {
      const pool = legalTargets(working, rules, actor.id, "nominate");
      const ranked = rankTargets(working, evidence, actor, pool, rng);
      // 마피아팀·교주팀은 자기 편이 아닌 사람 중 이미 의심받는 쪽에 얹는다(밴드왜건).
      const target = ranked[0] ?? pickWith(pool.filter((c) => !isKnownAlly(actor, c)), rng) ?? pickWith(pool, rng);
      if (!target) return working;
      return apply(working, rules, { type: "nominate", actorId: actor.id, targetId: target.id });
    }

    case "verdict": {
      const nomineeId = working.core.nominee;
      if (nomineeId === null) return working;
      const nominee = characterOf(working, nomineeId);
      if (!nominee) return working;
      const choice = decideVerdict(working, rules, evidence, actor, nominee, rng);
      return apply(working, rules, { type: "verdict", actorId: actor.id, choice });
    }
  }
}

/**
 * 생사 투표 판단.
 *
 * 진영마다 셈이 다르다 — 마피아팀은 팀원을 살리고 남을 죽이며, 교주팀은 **사망 자체가
 * 승리 조건에 가까워지므로**(§5.4 Q28) 대체로 죽인다. 시민팀만 증거를 본다.
 */
export function decideVerdict(
  session: Session,
  rules: RulesConfig,
  evidence: Evidence,
  voter: Character,
  nominee: Character,
  rng: () => number,
): Verdict {
  if (isKnownAlly(voter, nominee)) return "spare";

  // 진영 이익이 **검사 기록보다 먼저**다. 포교당한 경찰(§5.4 — 사제는 원래 역할을 유지한다)은
  // 자기가 무죄로 확인해 둔 시민을 계속 살리려 하는데, 그러면 2인 이하 국면에서 1-1 동표가
  // 영원히 반복된다(측정: 같은 피고를 두고 16일차까지 spare 반복). 전향한 순간 정보의 주인이
  // 바뀌므로 판단 기준도 새 진영을 따른다.
  if (voter.faction === "mafia" || voter.faction === "cult") return "kill";

  if (evidence.publicMafia.has(nominee.id)) return "kill";

  // 막판에는 넘기는 것이 곧 패배다. 남은 사람이 적으면 시민팀도 결론을 낸다 —
  // 이게 없으면 "아무도 죽이지 못해 밤낮만 반복되는" 교착이 생긴다.
  if (alive(session.core).length <= 4) return "kill";

  const others = alive(session.core).filter((c) => c.id !== voter.id);

  // 검사로 "마피아팀이 아님"이 확인된 사람은 살린다 — **단, 아직 확인되지 않은 사람이 남아
  // 있을 때만이다.** 검사 결과는 교주팀을 걸러내지 못하므로(§5.3), 남은 사람이 전부 '확인된
  // 비마피아'라면 그 안에 반드시 교주팀이 섞여 있다. 그때도 살려 두면 판이 끝나지 않는다
  // (측정: 시민 3명 + 전향자 1명이 남아 65일차까지 spare 반복).
  if (evidence.publicClear.has(nominee.id) && others.some((c) => !evidence.publicClear.has(c.id))) {
    return "spare";
  }
  const ranked = rankTargets(session, evidence, voter, others, rng);
  const rank = ranked.findIndex((c) => c.id === nominee.id);
  const cutoff = Math.max(1, Math.ceil(ranked.length / 2));
  return rank >= 0 && rank < cutoff ? "kill" : "spare";
}

// ─────────────────────────────────────────────────────────────────────────────
// 저격 — 페이즈 밖의 행동이라 요구 목록에 없다. 진행 때마다 따로 묻는다 (§5.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * AI 스나이퍼가 지금 쏠지 정한다.
 *
 * 총알이 1 발이라(🟡 Q29) 아무 때나 쏘면 낭비다. 두 경우에만 쏜다.
 * 1. 한 명 더 죽으면 마피아팀이 그 자리에서 이긴다.
 * 2. 판이 좁아졌는데(비-마피아 3 명 이하) 아직 총알이 남아 있다.
 */
export function maybeSnipe(session: Session, rules: RulesConfig): Session {
  let working = session;
  for (const sniper of alive(working.core).filter((c) => c.roleId === "sniper")) {
    if (!isAiSeat(working, sniper.id)) continue;
    const targets = legalSnipeTargets(working, rules, sniper.id);
    if (targets.length === 0) continue;

    const nonMafia = alive(working.core).filter((c) => c.faction !== "mafia");
    const winsNow = nonMafia.length === 1;
    const endgame = nonMafia.length <= 3;
    if (!winsNow && !endgame) continue;

    const evidence = gatherEvidence(working);
    const target = trustRank(working, evidence, targets)[0];
    if (!target) continue;
    working = apply(working, rules, { type: "snipe", actorId: sniper.id, targetId: target.id });
  }
  return working;
}

function isAiSeat(session: Session, id: string): boolean {
  return session.seats.find((seat) => seat.id === id)?.controller === "ai";
}

// ─────────────────────────────────────────────────────────────────────────────
// 발언 — 증거를 말하게 한다. 근거 없는 무작위 지목이 사람을 몰아세우던 문제를 없앤다
// ─────────────────────────────────────────────────────────────────────────────

export function speakAll(session: Session, rules: RulesConfig): Session {
  let working = cloneSession(session);
  if (working.core.phase !== "day") return working;

  for (const speaker of alive(working.core)) {
    if (!isAiSeat(working, speaker.id)) continue;
    const alreadySpoke = working.messages.some(
      (message) =>
        message.day === working.core.day && message.kind === "speech" && message.speakerId === speaker.id,
    );
    if (alreadySpoke) continue;

    const evidence = gatherEvidence(working);
    const line = composeLine(working, rules, evidence, speaker, () => roll(working));
    if (!line) continue;
    working = apply(working, rules, { type: "talk", actorId: speaker.id, text: line });
  }
  return working;
}

function composeLine(
  session: Session,
  rules: RulesConfig,
  evidence: Evidence,
  speaker: Character,
  rng: () => number,
): string | null {
  const others = alive(session.core).filter((c) => c.id !== speaker.id);
  if (others.length === 0) return null;
  const ranked = rankTargets(session, evidence, speaker, others, rng);
  const suspect = ranked[0];

  // 1) 같은 얼굴이 둘 보이면 그게 가장 강한 공개 증거다.
  const duplicated = [...evidence.duplicatedNames][0];
  if (duplicated !== undefined && rng() < 0.7) {
    return `${duplicated}님이 두 명 보입니다. 둘 중 하나는 얼굴을 뒤집어쓴 자입니다.`;
  }

  // 2) 폭탄 후보였던 사람은 마피아팀이 아님이 증명된다 — 표를 아끼자고 말한다.
  const cleared = others.find((c) => evidence.provenNotMafia.has(c.id));
  if (cleared && rng() < 0.5) {
    return `${displayNameOf(session, cleared.id)}님은 폭탄 후보였습니다. 폭탄마는 같은 편을 후보로 세우지 않으니 그쪽에 표를 낭비하지 마세요.`;
  }

  // 3) 경찰은 결과를 말할 수 있다 — 다만 정체가 드러나는 위험을 감수한다.
  const flagged = others.find((c) => evidence.publicMafia.has(c.id));
  if (flagged) {
    return `밤사이 확인된 사실이 있습니다. ${displayNameOf(session, flagged.id)}님을 먼저 법정에 세워야 합니다.`;
  }

  if (!suspect) return null;
  const name = displayNameOf(session, suspect.id);
  const lines =
    speaker.faction === "citizen"
      ? [
          `저는 ${name}님이 가장 걸립니다. 어젯밤 무엇을 했는지 말해 주세요.`,
          `${name}님, 지금까지의 표 행방을 설명해 주시겠습니까.`,
        ]
      : [
          `${name}님 쪽이 조용합니다. 조용한 쪽이 더 위험합니다.`,
          `저는 ${name}님에게 한 표를 두겠습니다. 반박이 있으면 지금 하세요.`,
        ];
  return pickWith(lines, rng) ?? null;
}

/** 진행 직전에 AI 가 하는 페이즈 밖 행동 묶음 (발언·저격). */
export function aiInterlude(session: Session, rules: RulesConfig): Session {
  let working = session;
  if (working.core.phase === "day") working = speakAll(working, rules);
  working = maybeSnipe(working, rules);
  return working;
}

export function aiFiller(session: Session, rules: RulesConfig, requirement: Requirement): Session {
  return fillRequirement(session, rules, requirement);
}

/** 진행 계층이 참조하는 이름 (테스트·시뮬레이션에서 사용). */
export const AI_LABEL = "규칙 기반 AI";

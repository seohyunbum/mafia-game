/**
 * 시뮬레이션 하네스. 아홉 좌석 전부를 AI 로 돌려 판을 끝까지 진행한다.
 *
 * 측정하는 것은 셋이다.
 * 1. **막힘** — `advance` 가 사람 없이도 끝까지 가는가 (배포본이 무너진 지점).
 * 2. **flowErrors** — 규칙 코어가 예상 못 한 입력을 받았는가 (0 이어야 한다).
 * 3. **밸런스** — 세 진영 승률과 판 길이, 그리고 역할별로 능력을 몇 번 썼는가.
 */

import { getRules } from "../../lib/rules/browserRules.ts";
import type { RulesConfig } from "../../lib/rules/config.ts";
import { alive } from "../../lib/rules/engine.ts";
import type { Faction, RoleId } from "../../lib/rules/types.ts";
import { aiFiller, aiInterlude } from "../../lib/ai/brain.ts";
import { advance, createSession, isOver, STANDARD_COMPOSITION } from "../../lib/flow/session.ts";
import type { Session } from "../../lib/flow/types.ts";

export const RULES: RulesConfig = getRules();

/** 사람 좌석까지 AI 로 바꾼 세션 (시뮬레이션 전용). */
export function allAi(session: Session): Session {
  return { ...session, seats: session.seats.map((seat) => ({ ...seat, controller: "ai" as const })) };
}

export interface PlayResult {
  readonly seed: number;
  readonly winner: Faction | null;
  readonly days: number;
  readonly steps: number;
  readonly stuck: boolean;
  readonly flowErrors: readonly string[];
  /** 역할별 밤 능력 사용 횟수 (사용 기회가 실제로 왔는지 본다) */
  readonly abilityUseByRole: Readonly<Partial<Record<RoleId, number>>>;
  readonly executions: number;
  readonly noNominationDays: number;
  readonly nightsWithoutKill: number;
  readonly timeoutDeaths: number;
}

export function playOut(seed: number, composition: readonly RoleId[] = STANDARD_COMPOSITION): PlayResult {
  let session = allAi(createSession({ mode: "solo", seed, composition }, RULES));
  let steps = 0;
  let stuck = false;

  const abilityUseByRole: Partial<Record<RoleId, number>> = {};
  let executions = 0;
  let noNominationDays = 0;
  let nightsWithoutKill = 0;
  let timeoutDeaths = 0;
  let seenLog = 0;

  const roleOf = (id: string): RoleId | undefined =>
    session.core.characters.find((c) => c.id === id)?.roleId;
  const bump = (roleId: RoleId | undefined): void => {
    if (!roleId) return;
    abilityUseByRole[roleId] = (abilityUseByRole[roleId] ?? 0) + 1;
  };

  while (!isOver(session) && steps < 500) {
    steps += 1;
    const nightBefore = session.core.phase === "night";
    session = aiInterlude(session, RULES);
    const result = advance(session, RULES, aiFiller);
    if (!result.ok) {
      stuck = true;
      break;
    }
    const previous = session;
    session = result.session;

    // 새로 쌓인 코어 이벤트에서 지표를 뽑는다
    for (const event of session.core.log.slice(seenLog)) {
      switch (event.kind) {
        case "night_kill":
          bump(roleOf(event.actorId));
          break;
        case "bomb":
          bump(roleOf(event.bomberId));
          break;
        case "investigated":
          bump(roleOf(event.policeId));
          break;
        case "protected":
          bump(roleOf(event.doctorId));
          break;
        case "converted":
          bump(roleOf(event.cultLeaderId));
          break;
        case "sniped":
          bump(roleOf(event.sniperId));
          break;
        case "no_nomination":
          noNominationDays += 1;
          break;
        case "verdict":
          if (event.decision === "kill") executions += 1;
          break;
        case "died":
          if (event.cause === "timeout") timeoutDeaths += 1;
          break;
        default:
          break;
      }
    }
    seenLog = session.core.log.length;

    // 밤이 해소됐는데 아무도 죽지 않았는지 (배포본의 '합의 실패' 자리)
    if (nightBefore && session.core.phase === "dawn") {
      const before = alive(previous.core).length;
      const after = alive(session.core).length;
      if (before === after) nightsWithoutKill += 1;
    }
  }

  return {
    seed,
    winner: session.core.winner,
    days: session.core.day,
    steps,
    stuck: stuck || steps >= 500,
    flowErrors: session.flowErrors,
    abilityUseByRole,
    executions,
    noNominationDays,
    nightsWithoutKill,
    timeoutDeaths,
  };
}

export interface Summary {
  readonly games: number;
  readonly stuck: number;
  readonly flowErrors: number;
  readonly winRate: Readonly<Record<string, number>>;
  readonly avgDays: number;
  readonly avgExecutions: number;
  readonly avgNoNomination: number;
  readonly avgNightsWithoutKill: number;
  readonly timeoutDeaths: number;
  readonly abilityUseByRole: Readonly<Partial<Record<RoleId, number>>>;
  readonly samples: readonly PlayResult[];
}

export function simulate(games: number, composition?: readonly RoleId[]): Summary {
  const samples: PlayResult[] = [];
  for (let seed = 1; seed <= games; seed += 1) samples.push(playOut(seed, composition));

  const winners: Record<string, number> = { citizen: 0, mafia: 0, cult: 0, none: 0 };
  const abilityUseByRole: Partial<Record<RoleId, number>> = {};
  let stuck = 0;
  let flowErrors = 0;
  let days = 0;
  let executions = 0;
  let noNomination = 0;
  let nightsWithoutKill = 0;
  let timeoutDeaths = 0;

  for (const sample of samples) {
    winners[sample.winner ?? "none"] = (winners[sample.winner ?? "none"] ?? 0) + 1;
    if (sample.stuck) stuck += 1;
    flowErrors += sample.flowErrors.length;
    days += sample.days;
    executions += sample.executions;
    noNomination += sample.noNominationDays;
    nightsWithoutKill += sample.nightsWithoutKill;
    timeoutDeaths += sample.timeoutDeaths;
    for (const [role, count] of Object.entries(sample.abilityUseByRole)) {
      const key = role as RoleId;
      abilityUseByRole[key] = (abilityUseByRole[key] ?? 0) + (count ?? 0);
    }
  }

  return {
    games,
    stuck,
    flowErrors,
    winRate: Object.fromEntries(
      Object.entries(winners).map(([key, count]) => [key, Math.round((count / games) * 1000) / 10]),
    ),
    avgDays: Math.round((days / games) * 100) / 100,
    avgExecutions: Math.round((executions / games) * 100) / 100,
    avgNoNomination: Math.round((noNomination / games) * 100) / 100,
    avgNightsWithoutKill: Math.round((nightsWithoutKill / games) * 100) / 100,
    timeoutDeaths,
    abilityUseByRole,
    samples,
  };
}

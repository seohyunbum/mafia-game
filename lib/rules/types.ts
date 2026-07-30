/**
 * 코어 타입 정의. 정본 설명은 docs/DESIGN.md §7.
 *
 * 이 파일은 규칙을 담지 않는다 — 규칙 수치는 data/*.json 에서 오고(→ config.ts),
 * 규칙 진행은 engine.ts 가 한다.
 */

export type Faction = 'citizen' | 'mafia' | 'cult'

/**
 * 교주팀 역할은 아직 설계되지 않았다 (DESIGN.md Q11). 폭탄마는 id 만 있고 능력이 없다 (Q12).
 * `citizen` 은 능력이 없는 게 확정 규칙이다 — 빈 자리가 아니다 (§5.3).
 */
export const ROLE_IDS = [
  'citizen',
  'police',
  'doctor',
  'mafia',
  'bomber',
  'sniper',
  'cultleader',
] as const

export type RoleId = (typeof ROLE_IDS)[number]

export function isRoleId(value: unknown): value is RoleId {
  return typeof value === 'string' && (ROLE_IDS as readonly string[]).includes(value)
}

/**
 * DESIGN.md §6 의 페이즈. `trial` 은 Q3 답(지목 → 변론 → 생사 투표)에서 나왔고,
 * `ended` 는 승자가 정해져 더 진행하지 않는 상태다.
 */
export type Phase = 'night' | 'dawn' | 'morning' | 'day' | 'trial' | 'dusk' | 'ended'

export type Verdict = 'kill' | 'spare'

export interface Character {
  readonly id: string
  readonly name: string
  /** 전향해도 바뀌지 않는다 — 사제는 역할이 아니라 진영 상태다 (§5.4) */
  readonly roleId: RoleId
  /** 포교로 'cult' 가 될 수 있다. 그래서 readonly 가 아니다 */
  faction: Faction
  hp: number
  alive: boolean
  /** 변신 중이면 흉내내고 있는 캐릭터 id, 아니면 null */
  disguisedAs: string | null
  /** 사제가 된 날. null 이면 전향하지 않았다 — 원래 진영 정보를 잃지 않기 위해 날짜로 남긴다 */
  convertedAtDay: number | null
}

/** 교주에게 포교당해 교주팀이 된 사람. 교주 본인은 사제가 아니다. */
export function isConvert(character: Character): boolean {
  return character.convertedAtDay !== null
}

/**
 * 사망 원인. 밤 살해와 처형은 HP 를 무시하고 죽이고(Q2·Q3),
 * `vote_damage` 는 변신 흡수 피해가 누적돼 HP 가 0 이 된 경우다 — 지금 HP 2 가 쓰이는 유일한 경로.
 */
export type DeathCause =
  | 'night_kill'
  | 'execution'
  | 'vote_damage'
  | 'collateral'
  | 'snipe'
  /** 밤 호출에서 제한시간 안에 능력을 쓰지 않아 죽었다 (§6.1) */
  | 'timeout'

/**
 * 페이즈에서 실제로 벌어진 일. 표현층이 이걸 읽어 화면을 만든다.
 *
 * 의도적으로 **공개 범위를 담지 않는다** — 변신이 남에게 보이는지(Q4)가 미정이라서,
 * 코어는 "무슨 일이 있었다"만 남기고 누구에게 보여줄지는 표현층이 정한다.
 */
export type GameEvent =
  | { readonly kind: 'night_kill'; readonly actorId: string; readonly targetId: string }
  /** 필수 밤 호출에 행동이 없었다 = 시간초과 (§6.1). 뒤따라 `died`(timeout) 가 온다 */
  | { readonly kind: 'timed_out'; readonly stepId: string; readonly characterId: string }
  /** 폭탄마가 고른 후보 명단 (§5.2). 상처가 곧 공개 정보가 된다 */
  | {
      readonly kind: 'bomb'
      readonly bomberId: string
      readonly targetId: string
      readonly candidates: readonly string[]
    }
  | { readonly kind: 'collateral'; readonly characterId: string; readonly damage: number }
  /** 스나이퍼의 저격 (§5.5). 페이즈 무관이라 어느 시점에도 로그에 끼어들 수 있다 */
  | {
      readonly kind: 'sniped'
      readonly sniperId: string
      readonly targetId: string
      readonly phase: Phase
    }
  /** 경찰 검사 결과 (§5.3). 결과를 누구에게 보여줄지는 표현층이 정한다 */
  | {
      readonly kind: 'investigated'
      readonly policeId: string
      readonly targetId: string
      readonly result: 'mafia' | 'not_mafia'
    }
  | { readonly kind: 'protected'; readonly doctorId: string; readonly targetId: string }
  /** 교주의 포교 (§5.4). 전향 사실을 누구에게 보여줄지는 표현층이 정한다 */
  | {
      readonly kind: 'converted'
      readonly cultLeaderId: string
      readonly targetId: string
      readonly fromFaction: Faction
    }
  /** 의사 보호가 포교를 막는 규칙이 켜져 있을 때만 나온다 */
  | { readonly kind: 'conversion_blocked'; readonly targetId: string }
  /** 의사가 그 밤의 살해를 막았다 */
  | { readonly kind: 'kill_blocked'; readonly targetId: string }
  | { readonly kind: 'disguised'; readonly mafiaId: string; readonly originId: string }
  | { readonly kind: 'disguise_unavailable'; readonly mafiaId: string }
  | { readonly kind: 'disguise_ended'; readonly mafiaId: string; readonly originId: string }
  | { readonly kind: 'nominated'; readonly nomineeId: string; readonly votes: number }
  | { readonly kind: 'no_nomination'; readonly reason: 'no_votes' | 'tie' }
  | {
      readonly kind: 'verdict'
      readonly nomineeId: string
      readonly kill: number
      readonly spare: number
      readonly voters: number
      readonly decision: Verdict
    }
  /** 변신한 피고 대신 원본 시민이 피해를 받았다 (Q1 확정 규칙) */
  | {
      readonly kind: 'disguise_absorbed'
      readonly nomineeId: string
      readonly originId: string
      readonly damage: number
    }
  | { readonly kind: 'died'; readonly characterId: string; readonly cause: DeathCause }
  | { readonly kind: 'victory'; readonly faction: Faction }

export interface GameState {
  readonly mode: 'solo' | 'duo'
  /** 듀오일 때 한 편인 캐릭터 id 쌍 (DESIGN.md §2) */
  readonly duoTeam: readonly [string, string] | null
  day: number
  phase: Phase
  characters: Character[]
  /** 직전 밤에 살해된 캐릭터 — Dawn 공개용. 거르거나 막힌 밤은 null */
  nightKillTarget: string | null
  /**
   * 캐릭터별 능력 사용 횟수 (캐릭터 id → 횟수).
   * 역할은 캐릭터당 하나라서 카운터도 하나면 된다 — 폭탄(Q12b)·저격(Q29) 제한이 이걸 본다.
   */
  abilityUses: Record<string, number>
  /** Day 지목 투표: 투표자 id → 지목 대상 id */
  nominationVotes: Record<string, string>
  /** Trial 에 세워진 피고. 지목이 성립하지 않은 날은 null */
  nominee: string | null
  /** Trial 생사 투표: 투표자 id → 판단 */
  verdictVotes: Record<string, Verdict>
  winner: Faction | null
  /** 이번 게임에서 벌어진 일의 순서 있는 기록 */
  log: GameEvent[]
}

/**
 * 그 밤 마피아팀의 살해 1회. **수행자의 역할이 형태를 정한다** (DESIGN.md §5.1·§5.2).
 * - 일반 마피아 → `targetId` 한 명 즉사. `candidates` 는 주지 않는다.
 * - 폭탄마 → `candidates` 3명 중 `targetId` 즉사, 나머지 후보는 HP -1.
 */
export interface NightKillAction {
  readonly actorId: string
  readonly targetId: string
  readonly candidates?: readonly string[]
}

/**
 * 한 밤에 제출되는 행동들. 역할들이 동시에 내고 한꺼번에 해소한다 (DESIGN.md §6).
 * 살해를 거른 밤은 `kill: null`.
 */
export interface NightActions {
  readonly kill: NightKillAction | null
  readonly protects?: readonly { readonly doctorId: string; readonly targetId: string }[]
  readonly investigations?: readonly { readonly policeId: string; readonly targetId: string }[]
  /** 교주의 포교. 짝수 밤에만 낼 수 있다 (§5.4) */
  readonly conversion?: { readonly cultLeaderId: string; readonly targetId: string }
}

/** 무작위성은 전부 주입받는다 — 테스트가 결정론적이어야 하기 때문이다 (DESIGN.md §8.1). */
export type Rng = () => number

/** 규칙 위반 입력. 호출자 버그이므로 상태를 바꾸지 않고 던진다. */
export class RuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuleError'
  }
}

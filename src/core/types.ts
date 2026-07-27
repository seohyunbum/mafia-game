/**
 * 코어 타입 정의. 정본 설명은 docs/DESIGN.md §7.
 *
 * 이 파일은 규칙을 담지 않는다 — 규칙 수치는 data/*.json 에서 오고(→ config.ts),
 * 규칙 진행은 engine.ts 가 한다.
 */

export type Faction = 'citizen' | 'mafia' | 'cult'

/** 교주팀 역할은 아직 설계되지 않았다 (DESIGN.md Q11). 폭탄마는 id 만 있고 능력이 없다 (Q12). */
export type RoleId = 'citizen' | 'mafia' | 'bomber'

/**
 * DESIGN.md §6 의 페이즈. `trial` 은 Q3 답(지목 → 변론 → 생사 투표)에서 나왔고,
 * `ended` 는 승자가 정해져 더 진행하지 않는 상태다.
 */
export type Phase = 'night' | 'dawn' | 'morning' | 'day' | 'trial' | 'dusk' | 'ended'

export type Verdict = 'kill' | 'spare'

export interface Character {
  readonly id: string
  readonly name: string
  readonly roleId: RoleId
  readonly faction: Faction
  hp: number
  alive: boolean
  /** 변신 중이면 흉내내고 있는 캐릭터 id, 아니면 null */
  disguisedAs: string | null
}

/**
 * 사망 원인. 밤 살해와 처형은 HP 를 무시하고 죽이고(Q2·Q3),
 * `vote_damage` 는 변신 흡수 피해가 누적돼 HP 가 0 이 된 경우다 — 지금 HP 2 가 쓰이는 유일한 경로.
 */
export type DeathCause = 'night_kill' | 'execution' | 'vote_damage'

/**
 * 페이즈에서 실제로 벌어진 일. 표현층이 이걸 읽어 화면을 만든다.
 *
 * 의도적으로 **공개 범위를 담지 않는다** — 변신이 남에게 보이는지(Q4)가 미정이라서,
 * 코어는 "무슨 일이 있었다"만 남기고 누구에게 보여줄지는 표현층이 정한다.
 */
export type GameEvent =
  | { readonly kind: 'night_kill'; readonly targetId: string }
  | { readonly kind: 'night_skipped' }
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
  /** 직전 밤에 살해된 캐릭터 — Dawn 공개용. 거른 밤은 null */
  nightKillTarget: string | null
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

/** 무작위성은 전부 주입받는다 — 테스트가 결정론적이어야 하기 때문이다 (DESIGN.md §8.1). */
export type Rng = () => number

/** 규칙 위반 입력. 호출자 버그이므로 상태를 바꾸지 않고 던진다. */
export class RuleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'RuleError'
  }
}

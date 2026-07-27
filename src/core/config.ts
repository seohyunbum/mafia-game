/**
 * data/rules.json → 코어가 쓰는 설정 객체.
 *
 * **정의 데이터는 fail-fast 다.** 필요한 값이 없거나 모르는 값이면 기동을 실패시킨다.
 * 조용히 기본값으로 넘어가면 "확정 안 된 규칙으로 게임이 돌아가는" 최악의 상태가 된다.
 *
 * `_*_status` 주석 키들은 사람이 읽는 메타데이터라 파서가 무시한다.
 */

export const RULES_SCHEMA_VERSION = 2

/** 밤 살해 판정 (DESIGN.md Q2 = instant / Q17 이 뒤집히면 damage) */
export type LethalMode = { readonly kind: 'instant' } | { readonly kind: 'damage'; readonly amount: number }

export interface RulesConfig {
  readonly startHp: number
  readonly nightKill: {
    readonly lethality: LethalMode
    readonly maySkip: boolean
  }
  readonly nomination: {
    /** 동표일 때: 아무도 세우지 않거나, 동표 중 무작위 1명 */
    readonly tie: 'no_nomination' | 'random'
  }
  readonly verdict: {
    /** 피고 본인이 자기 생사 투표에 참여하는가 */
    readonly nomineeVotes: boolean
    /**
     * '죽인다' 가결 기준. 투표 자격자 수 기준이다 (기권은 살리는 쪽에 가산되는 셈).
     * `over_half` → 정확히 반이면 살린다(동표 = 살린다). `half_or_more` → 정확히 반이면 죽인다.
     */
    readonly threshold: 'over_half' | 'half_or_more'
    readonly executionResult: LethalMode
    readonly damageToDisguiseOrigin: number
    /** 처형이 변신에 흡수됐을 때 마피아 본인이 살아남는가 */
    readonly disguisedNomineeSurvives: boolean
  }
  readonly disguise: {
    readonly targetPool: 'alive_citizens' | 'all_citizens'
    readonly allowDuplicateTarget: boolean
    readonly expiresAtEndOfDay: boolean
  }
  readonly victory: {
    /** 해당 진영의 승리를 판정하는가. null 이면 판정하지 않는다 (교주팀 = Q11 미설계) */
    readonly citizen: boolean
    readonly mafia: boolean
    readonly cult: boolean
  }
  readonly turn: {
    readonly firstPhase: 'night' | 'day'
  }
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`data/rules.json: ${message}`)
    this.name = 'ConfigError'
  }
}

type Json = Record<string, unknown>

function obj(source: Json, key: string): Json {
  const value = source[key]
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ConfigError(`${key} 는 객체여야 한다 (받은 값: ${JSON.stringify(value)})`)
  }
  return value as Json
}

function bool(source: Json, path: string, key: string): boolean {
  const value = source[key]
  if (typeof value !== 'boolean') {
    throw new ConfigError(`${path}.${key} 는 true/false 여야 한다 — 미정(null)이면 규칙을 정해야 한다 (받은 값: ${JSON.stringify(value)})`)
  }
  return value
}

function posInt(source: Json, path: string, key: string): number {
  const value = source[key]
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new ConfigError(`${path}.${key} 는 1 이상의 정수여야 한다 (받은 값: ${JSON.stringify(value)})`)
  }
  return value
}

function enumOf<T extends string>(source: Json, path: string, key: string, allowed: readonly T[]): T {
  const value = source[key]
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) {
    throw new ConfigError(
      `${path}.${key} 는 ${allowed.map((a) => `'${a}'`).join(' | ')} 중 하나여야 한다 (받은 값: ${JSON.stringify(value)})`,
    )
  }
  return value as T
}

/**
 * 즉사/HP 감소 두 갈래를 읽는다.
 * `instantKey` 가 true → 즉사. false → `damageKey` 에 1 이상 정수가 있어야 한다.
 */
function lethality(source: Json, path: string, instant: boolean, damageKey: string): LethalMode {
  if (instant) return { kind: 'instant' }
  return { kind: 'damage', amount: posInt(source, path, damageKey) }
}

/** 승리 조건 문자열 → 판정 여부. null = 미설계 진영이라 판정하지 않는다. */
function victoryFlag(source: Json, key: string): boolean {
  const value = source[key]
  if (value === null) return false
  if (value === 'opposing_factions_all_dead') return true
  throw new ConfigError(
    `victory.${key} 는 'opposing_factions_all_dead' 또는 null 이어야 한다 (받은 값: ${JSON.stringify(value)})`,
  )
}

export function parseRules(raw: unknown): RulesConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError('최상위가 객체가 아니다')
  }
  const root = raw as Json

  if (root['schema_version'] !== RULES_SCHEMA_VERSION) {
    throw new ConfigError(
      `schema_version 이 ${RULES_SCHEMA_VERSION} 이어야 한다 (받은 값: ${JSON.stringify(root['schema_version'])}). ` +
        '스키마를 바꿨다면 RULES_SCHEMA_VERSION 과 파서를 같은 커밋에서 올려라.',
    )
  }

  const nightKill = obj(root, 'night_kill')
  const dayVote = obj(root, 'day_vote')
  const nomination = obj(dayVote, 'nomination')
  const verdict = obj(dayVote, 'verdict')
  const disguise = obj(root, 'disguise')

  const resolution = enumOf(dayVote, 'day_vote', 'resolution', ['nominate_then_trial'] as const)
  // 지금 코어는 Q3 이 확정한 2단계 낮만 구현한다. 다른 값이 오면 위 enumOf 가 이미 던진다.
  void resolution

  enumOf(nomination, 'day_vote.nomination', 'rule', ['plurality_one'] as const)

  const executionResult = enumOf(dayVote, 'day_vote', 'execution_result', ['death', 'damage'] as const)

  return {
    startHp: posInt(obj(root, 'character'), 'character', 'start_hp'),
    nightKill: {
      lethality: lethality(nightKill, 'night_kill', bool(nightKill, 'night_kill', 'instant_death'), 'damage'),
      maySkip: bool(nightKill, 'night_kill', 'may_skip'),
    },
    nomination: {
      tie: enumOf(nomination, 'day_vote.nomination', 'tie', ['no_nomination', 'random'] as const),
    },
    verdict: {
      nomineeVotes: bool(verdict, 'day_vote.verdict', 'nominee_votes'),
      threshold: enumOf(verdict, 'day_vote.verdict', 'threshold', ['over_half', 'half_or_more'] as const),
      executionResult: lethality(dayVote, 'day_vote', executionResult === 'death', 'execution_damage'),
      damageToDisguiseOrigin: posInt(dayVote, 'day_vote', 'damage_to_disguise_origin'),
      disguisedNomineeSurvives: bool(dayVote, 'day_vote', 'disguised_nominee_survives'),
    },
    disguise: {
      targetPool: enumOf(disguise, 'disguise', 'target_pool', ['alive_citizens', 'all_citizens'] as const),
      allowDuplicateTarget: bool(disguise, 'disguise', 'allow_duplicate_target'),
      expiresAtEndOfDay: bool(disguise, 'disguise', 'expires_at_end_of_day'),
    },
    victory: {
      citizen: victoryFlag(obj(root, 'victory'), 'citizen'),
      mafia: victoryFlag(obj(root, 'victory'), 'mafia'),
      cult: victoryFlag(obj(root, 'victory'), 'cult'),
    },
    turn: {
      firstPhase: enumOf(obj(root, 'turn'), 'turn', 'first_phase', ['night', 'day'] as const),
    },
  }
}

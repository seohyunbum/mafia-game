/**
 * data/rules.json → 코어가 쓰는 설정 객체.
 *
 * **정의 데이터는 fail-fast 다.** 필요한 값이 없거나 모르는 값이면 기동을 실패시킨다.
 * 조용히 기본값으로 넘어가면 "확정 안 된 규칙으로 게임이 돌아가는" 최악의 상태가 된다.
 *
 * `_*_status` 주석 키들은 사람이 읽는 메타데이터라 파서가 무시한다.
 */

export const RULES_SCHEMA_VERSION = 3

/** 밤 살해 판정 (DESIGN.md Q2 = instant / Q17 이 뒤집히면 damage) */
export type LethalMode = { readonly kind: 'instant' } | { readonly kind: 'damage'; readonly amount: number }

export interface RulesConfig {
  readonly startHp: number
  readonly nightKill: {
    readonly lethality: LethalMode
    readonly maySkip: boolean
  }
  readonly bomber: {
    readonly candidateCount: number
    readonly collateralDamage: number
    /** 후보로 세울 생존자가 모자라면 있는 만큼만 고르게 할지 */
    readonly allowFewerCandidatesWhenShort: boolean
    readonly canTargetOwnFaction: boolean
    /** null = 횟수 제한 없음 (Q12b) */
    readonly usesPerGame: number | null
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
  readonly police: {
    /** 'is_mafia' = 마피아팀 여부만. 정확한 직업까지 보는 규칙은 아직 구현하지 않았다 (Q22) */
    readonly result: 'is_mafia'
    readonly allowSelf: boolean
  }
  readonly doctor: {
    /** 'prevent_night_kill' = 그 밤의 살해를 막는다. 부활 규칙은 구현하지 않았다 (Q23) */
    readonly effect: 'prevent_night_kill'
    readonly allowSelf: boolean
  }
  readonly disguise: {
    readonly targetPool: 'alive_citizens' | 'all_citizens'
    readonly allowDuplicateTarget: boolean
    readonly expiresAtEndOfDay: boolean
  }
  readonly sniper: {
    readonly lethality: LethalMode
    /** null = 횟수 제한 없음 (Q29) */
    readonly usesPerGame: number | null
    readonly canTargetOwnFaction: boolean
    readonly ignoresProtection: boolean
  }
  readonly cult: {
    /** 교주가 움직일 수 있는 밤. 'even' = 짝수 날 (2, 4, …) */
    readonly activeNights: 'even'
    readonly conversionsPerActivation: number
    readonly canConvertMafia: boolean
    readonly protectBlocksConversion: boolean
  }
  readonly victory: {
    /** 상대 진영이 전멸하면 승리하는 진영들 */
    readonly citizen: boolean
    readonly mafia: boolean
    /**
     * 교주팀은 전멸형이 아니다 — "두 명 빼고 모두 사제". null 이면 판정하지 않는다.
     * `survivorsLeft` = 남겨도 되는 비-교주팀 생존자 수, `minConverts` = 최소 사제 수.
     */
    readonly cult: { readonly survivorsLeft: number; readonly minConverts: number } | null
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

/**
 * 아직 구현하지 않은 규칙 변형을 데이터로 켜는 걸 막는다.
 * 조용히 무시하면 "데이터는 바꿨는데 게임은 그대로"인 최악의 무음 실패가 된다.
 */
function requireTrue(source: Json, path: string, key: string): void {
  if (bool(source, path, key)) return
  throw new ConfigError(
    `${path}.${key}=false 는 아직 구현하지 않았다 — 지난 밤 지목 기록을 상태에 넣어야 한다`,
  )
}

/** 전멸형 승리 조건 → 판정 여부. null = 미설계 진영이라 판정하지 않는다. */
function victoryFlag(source: Json, key: string): boolean {
  const value = source[key]
  if (value === null) return false
  if (value === 'opposing_factions_all_dead') return true
  throw new ConfigError(
    `victory.${key} 는 'opposing_factions_all_dead' 또는 null 이어야 한다 (받은 값: ${JSON.stringify(value)})`,
  )
}

/** 교주팀 승리 조건. 전멸형이 아니라 "두 명 빼고 모두 사제" 형태다. */
function cultVictory(source: Json): { survivorsLeft: number; minConverts: number } | null {
  const value = source['cult']
  if (value === null) return null
  if (value !== 'all_but_n_converted') {
    throw new ConfigError(
      `victory.cult 는 'all_but_n_converted' 또는 null 이어야 한다 (받은 값: ${JSON.stringify(value)})`,
    )
  }
  const survivorsLeft = source['cult_survivors_left']
  if (typeof survivorsLeft !== 'number' || !Number.isInteger(survivorsLeft) || survivorsLeft < 0) {
    throw new ConfigError(
      `victory.cult_survivors_left 는 0 이상의 정수여야 한다 (받은 값: ${JSON.stringify(survivorsLeft)})`,
    )
  }
  return { survivorsLeft, minConverts: posInt(source, 'victory', 'cult_min_converts') }
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
  const bomber = obj(root, 'bomber')
  const sniper = obj(root, 'sniper')
  const cult = obj(root, 'cult')

  // 저격은 페이즈 무관이 확정 규칙이라 다른 값은 받지 않는다 (§5.5).
  enumOf(sniper, 'sniper', 'phase', ['any'] as const)
  // 저격이 밤 살해를 대체하는 변형은 구현하지 않았다 (Q30).
  if (bool(sniper, 'sniper', 'replaces_team_night_kill')) {
    throw new ConfigError('sniper.replaces_team_night_kill=true 는 아직 구현하지 않았다')
  }
  // 보호가 저격을 막는 변형도 구현하지 않았다 (Q31) — 보호 상태는 밤 해소 안에만 존재한다.
  requireTrue(sniper, 'sniper', 'ignores_protection')
  const police = obj(root, 'police')
  const doctor = obj(root, 'doctor')

  // 사제가 원래 역할을 잃는 변형은 구현하지 않았다.
  requireTrue(cult, 'cult', 'converts_keep_role')
  // 교주가 죽으면 사제가 풀리는 변형도 구현하지 않았다 (Q27).
  if (bool(cult, 'cult', 'leader_death_frees_converts')) {
    throw new ConfigError('cult.leader_death_frees_converts=true 는 아직 구현하지 않았다')
  }

  // 사망 시 자동 폭발은 구현하지 않았다 (Q12a).
  enumOf(bomber, 'bomber', 'trigger', ['active_night'] as const)

  // 밤 이외의 시점은 구현하지 않았다 — 낮 검사는 변신과 얽혀서 규칙이 따로 필요하다 (Q21).
  enumOf(police, 'police', 'phase', ['night'] as const)
  enumOf(doctor, 'doctor', 'phase', ['night'] as const)
  requireTrue(police, 'police', 'allow_repeat_target')
  requireTrue(doctor, 'doctor', 'allow_repeat_target')

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
    bomber: {
      candidateCount: posInt(bomber, 'bomber', 'candidate_count'),
      collateralDamage: posInt(bomber, 'bomber', 'collateral_damage'),
      allowFewerCandidatesWhenShort: bool(bomber, 'bomber', 'allow_fewer_candidates_when_short'),
      canTargetOwnFaction: bool(bomber, 'bomber', 'can_target_own_faction'),
      usesPerGame: bomber['uses_per_game'] === null ? null : posInt(bomber, 'bomber', 'uses_per_game'),
    },
    police: {
      result: enumOf(police, 'police', 'result', ['is_mafia'] as const),
      allowSelf: bool(police, 'police', 'allow_self'),
    },
    doctor: {
      effect: enumOf(doctor, 'doctor', 'effect', ['prevent_night_kill'] as const),
      allowSelf: bool(doctor, 'doctor', 'allow_self'),
    },
    disguise: {
      targetPool: enumOf(disguise, 'disguise', 'target_pool', ['alive_citizens', 'all_citizens'] as const),
      allowDuplicateTarget: bool(disguise, 'disguise', 'allow_duplicate_target'),
      expiresAtEndOfDay: bool(disguise, 'disguise', 'expires_at_end_of_day'),
    },
    sniper: {
      lethality: lethality(sniper, 'sniper', bool(sniper, 'sniper', 'instant_death'), 'damage'),
      usesPerGame: sniper['uses_per_game'] === null ? null : posInt(sniper, 'sniper', 'uses_per_game'),
      canTargetOwnFaction: bool(sniper, 'sniper', 'can_target_own_faction'),
      ignoresProtection: bool(sniper, 'sniper', 'ignores_protection'),
    },
    cult: {
      activeNights: enumOf(cult, 'cult', 'active_nights', ['even'] as const),
      conversionsPerActivation: posInt(cult, 'cult', 'conversions_per_activation'),
      canConvertMafia: bool(cult, 'cult', 'can_convert_mafia'),
      protectBlocksConversion: bool(cult, 'cult', 'protect_blocks_conversion'),
    },
    victory: {
      citizen: victoryFlag(obj(root, 'victory'), 'citizen'),
      mafia: victoryFlag(obj(root, 'victory'), 'mafia'),
      cult: cultVictory(obj(root, 'victory')),
    },
    turn: {
      firstPhase: enumOf(obj(root, 'turn'), 'turn', 'first_phase', ['night', 'day'] as const),
    },
  }
}

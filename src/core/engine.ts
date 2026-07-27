/**
 * 규칙 엔진. 순수하다 — 화면·엔진·파일 시스템 의존 0, 무작위성은 주입받는다.
 *
 * 각 `resolve*` 는 **새 상태를 반환**하고 인자로 받은 상태를 건드리지 않는다.
 * 정본 규칙은 docs/DESIGN.md §6·§7.1.
 *
 * 확정 규칙(✅)과 해석(🟡)의 구분은 코드가 아니라 데이터에 있다 — 해석은 전부
 * RulesConfig 값으로 내려와 있어서, 답이 오면 data/rules.json 만 고치면 된다.
 */

import type { Character, DeathCause, Faction, GameState, Phase, Rng, Verdict } from './types.ts'
import { RuleError } from './types.ts'
import type { LethalMode, RulesConfig } from './config.ts'

// ─────────────────────────────────────────────────────────────────────────────
// 내부 헬퍼
// ─────────────────────────────────────────────────────────────────────────────

function clone(state: GameState): GameState {
  return {
    ...state,
    characters: state.characters.map((c) => ({ ...c })),
    nominationVotes: { ...state.nominationVotes },
    verdictVotes: { ...state.verdictVotes },
    log: [...state.log],
  }
}

function find(state: GameState, id: string): Character {
  const character = state.characters.find((c) => c.id === id)
  if (!character) throw new RuleError(`없는 캐릭터 id: ${id}`)
  return character
}

function requirePhase(state: GameState, expected: Phase): void {
  if (state.phase !== expected) {
    throw new RuleError(`${expected} 페이즈에서만 가능하다 (현재: ${state.phase})`)
  }
}

export function alive(state: GameState): Character[] {
  return state.characters.filter((c) => c.alive)
}

export function aliveOf(state: GameState, faction: Faction): Character[] {
  return state.characters.filter((c) => c.alive && c.faction === faction)
}

/**
 * 죽인다. 이미 죽은 캐릭터는 다시 죽이지 않는다(이벤트 중복 방지).
 * 변신 중이던 캐릭터가 죽으면 변신도 함께 끝난다 — 죽은 몸이 남의 얼굴을 계속 쓰고 있으면
 * 상태가 어긋난다.
 */
function kill(next: GameState, character: Character, cause: DeathCause): void {
  if (!character.alive) return
  character.alive = false
  character.hp = 0
  character.disguisedAs = null
  next.log.push({ kind: 'died', characterId: character.id, cause })
}

/** 즉사 또는 HP 감소를 적용한다 (밤 살해·처형이 공유). */
function applyLethal(
  next: GameState,
  character: Character,
  mode: LethalMode,
  cause: 'night_kill' | 'execution',
): void {
  if (mode.kind === 'instant') {
    kill(next, character, cause)
    return
  }
  character.hp -= mode.amount
  if (character.hp <= 0) kill(next, character, cause)
}

/**
 * 승리 판정. 사망이 생길 수 있는 지점마다 호출한다 (DESIGN.md §3).
 * 판정하지 않는 진영(교주팀 = Q11 미설계)은 config 에서 꺼져 있다.
 */
function checkVictory(next: GameState, rules: RulesConfig): void {
  if (next.winner !== null) return

  const contenders: Faction[] = ['citizen', 'mafia', 'cult']
  for (const faction of contenders) {
    if (!rules.victory[faction]) continue
    if (aliveOf(next, faction).length === 0) continue
    const opponentsAlive = contenders
      .filter((f) => f !== faction)
      .some((f) => aliveOf(next, f).length > 0)
    if (!opponentsAlive) {
      next.winner = faction
      next.phase = 'ended'
      next.log.push({ kind: 'victory', faction })
      return
    }
  }
}

/** 결정론적 선택 — rng 는 [0,1) 를 반환한다고 가정한다. */
function pick<T>(items: readonly T[], rng: Rng): T {
  if (items.length === 0) throw new RuleError('빈 목록에서 뽑을 수 없다')
  const index = Math.min(items.length - 1, Math.floor(rng() * items.length))
  const chosen = items[index]
  if (chosen === undefined) throw new RuleError('선택 실패 — rng 가 [0,1) 범위를 벗어났다')
  return chosen
}

// ─────────────────────────────────────────────────────────────────────────────
// Night — 마피아 살해 (✅ 즉사, Q2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 밤 살해를 적용하고 Dawn 으로 넘어간다.
 * `targetId === null` 은 살해를 거른 밤 (🟡 Q19 — `night_kill.may_skip`).
 */
export function resolveNight(state: GameState, rules: RulesConfig, targetId: string | null): GameState {
  requirePhase(state, 'night')
  const next = clone(state)
  next.nominationVotes = {}
  next.verdictVotes = {}
  next.nominee = null

  if (targetId === null) {
    if (!rules.nightKill.maySkip) throw new RuleError('이 규칙에서는 밤 살해를 거를 수 없다')
    next.nightKillTarget = null
    next.log.push({ kind: 'night_skipped' })
  } else {
    const target = find(next, targetId)
    if (!target.alive) throw new RuleError(`이미 죽은 캐릭터를 살해할 수 없다: ${targetId}`)
    if (target.faction === 'mafia') throw new RuleError(`마피아는 같은 팀을 살해하지 않는다: ${targetId}`)
    next.nightKillTarget = targetId
    next.log.push({ kind: 'night_kill', targetId })
    applyLethal(next, target, rules.nightKill.lethality, 'night_kill')
  }

  next.phase = 'dawn'
  checkVictory(next, rules)
  return next
}

// ─────────────────────────────────────────────────────────────────────────────
// Dawn — 밤 결과 공개. 상태를 바꾸지 않는 정지점(표현층용)
// ─────────────────────────────────────────────────────────────────────────────

export function resolveDawn(state: GameState): GameState {
  requirePhase(state, 'dawn')
  const next = clone(state)
  next.phase = 'morning'
  return next
}

// ─────────────────────────────────────────────────────────────────────────────
// Morning — 변신 (✅ 랜덤 시민, Q1 확정 규칙의 준비 단계)
// ─────────────────────────────────────────────────────────────────────────────

/** 변신 대상 풀. 마피아가 고르지 않으므로 이 목록에서 rng 로 뽑는다. */
function disguisePool(state: GameState, rules: RulesConfig): Character[] {
  const taken = new Set(
    state.characters.filter((c) => c.disguisedAs !== null).map((c) => c.disguisedAs as string),
  )
  return state.characters.filter((c) => {
    if (c.faction !== 'citizen') return false
    if (rules.disguise.targetPool === 'alive_citizens' && !c.alive) return false
    if (!rules.disguise.allowDuplicateTarget && taken.has(c.id)) return false
    return true
  })
}

/**
 * 변신을 쓰겠다고 한 마피아들에게 무작위 시민 얼굴을 씌우고 Day 로 넘어간다.
 *
 * `userIds` 는 변신을 **사용하기로 한** 살아있는 마피아 목록이다 (변신은 선택적 ✅).
 * 순서에 따라 남은 풀이 달라지므로 입력 순서를 그대로 존중한다.
 */
export function resolveMorning(
  state: GameState,
  rules: RulesConfig,
  userIds: readonly string[],
  rng: Rng,
): GameState {
  requirePhase(state, 'morning')
  const next = clone(state)

  for (const id of userIds) {
    const mafia = find(next, id)
    if (!mafia.alive) throw new RuleError(`죽은 캐릭터는 변신할 수 없다: ${id}`)
    if (mafia.faction !== 'mafia') throw new RuleError(`변신은 마피아팀 능력이다: ${id}`)
    if (mafia.disguisedAs !== null) throw new RuleError(`이미 변신 중이다: ${id}`)

    const pool = disguisePool(next, rules)
    if (pool.length === 0) {
      // 씌울 얼굴이 없으면 조용히 넘기지 않고 이벤트로 남긴다.
      next.log.push({ kind: 'disguise_unavailable', mafiaId: id })
      continue
    }
    const origin = pick(pool, rng)
    mafia.disguisedAs = origin.id
    next.log.push({ kind: 'disguised', mafiaId: id, originId: origin.id })
  }

  next.phase = 'day'
  return next
}

// ─────────────────────────────────────────────────────────────────────────────
// Day — 지목 투표 (✅ 최다득표 1명이 피고, Q3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 지목 투표를 집계해 피고를 정한다.
 * 피고가 나오면 Trial 로, 안 나오면 Trial 을 건너뛰고 Dusk 로 간다.
 */
export function resolveDay(
  state: GameState,
  rules: RulesConfig,
  votes: Readonly<Record<string, string>>,
  rng: Rng,
): GameState {
  requirePhase(state, 'day')
  const next = clone(state)

  const tally = new Map<string, number>()
  for (const [voterId, targetId] of Object.entries(votes)) {
    const voter = find(next, voterId)
    if (!voter.alive) throw new RuleError(`죽은 캐릭터는 투표할 수 없다: ${voterId}`)
    const target = find(next, targetId)
    if (!target.alive) throw new RuleError(`죽은 캐릭터를 지목할 수 없다: ${targetId}`)
    tally.set(targetId, (tally.get(targetId) ?? 0) + 1)
  }
  next.nominationVotes = { ...votes }

  if (tally.size === 0) {
    next.nominee = null
    next.log.push({ kind: 'no_nomination', reason: 'no_votes' })
    next.phase = 'dusk'
    return next
  }

  const top = Math.max(...tally.values())
  const leaders = [...tally.entries()].filter(([, count]) => count === top).map(([id]) => id)

  if (leaders.length > 1 && rules.nomination.tie === 'no_nomination') {
    next.nominee = null
    next.log.push({ kind: 'no_nomination', reason: 'tie' })
    next.phase = 'dusk'
    return next
  }

  const nominee = leaders.length === 1 ? leaders[0] : pick(leaders, rng)
  if (nominee === undefined) throw new RuleError('지목 집계 실패')
  next.nominee = nominee
  next.log.push({ kind: 'nominated', nomineeId: nominee, votes: top })
  next.phase = 'trial'
  return next
}

// ─────────────────────────────────────────────────────────────────────────────
// Trial — 변론 후 생사 투표 (✅ Q3) + 변신 흡수 (✅ Q1)
// ─────────────────────────────────────────────────────────────────────────────

/** 생사 투표 자격자 — 살아있는 사람에서 (규칙에 따라) 피고를 뺀다. */
export function verdictVoters(state: GameState, rules: RulesConfig): Character[] {
  return alive(state).filter((c) => rules.verdict.nomineeVotes || c.id !== state.nominee)
}

/**
 * 생사 투표를 집계해 결과를 적용하고 Dusk 로 넘어간다.
 *
 * 가결 시:
 * - 피고가 변신한 마피아면 → **흉내낸 원본 시민**이 피해를 받는다 (✅ Q1). 마피아 본인은 무피해.
 * - 그 외 → 사망 (✅ Q3).
 */
export function resolveTrial(
  state: GameState,
  rules: RulesConfig,
  votes: Readonly<Record<string, Verdict>>,
): GameState {
  requirePhase(state, 'trial')
  const nomineeId = state.nominee
  if (nomineeId === null) throw new RuleError('피고가 없는데 Trial 에 들어왔다')

  const next = clone(state)
  const nominee = find(next, nomineeId)

  const eligible = new Set(verdictVoters(next, rules).map((c) => c.id))
  let kills = 0
  let spares = 0
  for (const [voterId, choice] of Object.entries(votes)) {
    if (!eligible.has(voterId)) {
      throw new RuleError(`생사 투표 자격이 없다: ${voterId}`)
    }
    if (choice === 'kill') kills += 1
    else spares += 1
  }
  next.verdictVotes = { ...votes }

  // 기준은 자격자 수다 — 기권은 살리는 쪽으로 작동한다 (🟡 Q15).
  const voters = eligible.size
  const decision: Verdict =
    rules.verdict.threshold === 'over_half'
      ? kills * 2 > voters
        ? 'kill'
        : 'spare'
      : kills * 2 >= voters
        ? 'kill'
        : 'spare'

  next.log.push({ kind: 'verdict', nomineeId, kill: kills, spare: spares, voters, decision })

  if (decision === 'kill') {
    if (nominee.disguisedAs !== null) {
      // ✅ Q1: 피해는 흉내낸 원본 시민에게. 마피아 본인은 무피해.
      const origin = find(next, nominee.disguisedAs)
      const damage = rules.verdict.damageToDisguiseOrigin
      next.log.push({ kind: 'disguise_absorbed', nomineeId, originId: origin.id, damage })
      origin.hp -= damage
      if (origin.hp <= 0) kill(next, origin, 'vote_damage')
      if (!rules.verdict.disguisedNomineeSurvives) {
        applyLethal(next, nominee, rules.verdict.executionResult, 'execution')
      }
    } else {
      applyLethal(next, nominee, rules.verdict.executionResult, 'execution')
    }
  }

  next.phase = 'dusk'
  checkVictory(next, rules)
  return next
}

// ─────────────────────────────────────────────────────────────────────────────
// Dusk — 변신 해제, 다음 날로
// ─────────────────────────────────────────────────────────────────────────────

export function resolveDusk(state: GameState, rules: RulesConfig): GameState {
  requirePhase(state, 'dusk')
  const next = clone(state)

  if (rules.disguise.expiresAtEndOfDay) {
    for (const character of next.characters) {
      if (character.disguisedAs === null) continue
      next.log.push({ kind: 'disguise_ended', mafiaId: character.id, originId: character.disguisedAs })
      character.disguisedAs = null
    }
  }

  next.nominee = null
  next.nominationVotes = {}
  next.verdictVotes = {}
  next.nightKillTarget = null
  next.day += 1
  next.phase = 'night'
  return next
}

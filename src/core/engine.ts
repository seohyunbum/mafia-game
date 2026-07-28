/**
 * 규칙 엔진. 순수하다 — 화면·엔진·파일 시스템 의존 0, 무작위성은 주입받는다.
 *
 * 각 `resolve*` 는 **새 상태를 반환**하고 인자로 받은 상태를 건드리지 않는다.
 * 정본 규칙은 docs/DESIGN.md §6·§7.1.
 *
 * 확정 규칙(✅)과 해석(🟡)의 구분은 코드가 아니라 데이터에 있다 — 해석은 전부
 * RulesConfig 값으로 내려와 있어서, 답이 오면 data/rules.json 만 고치면 된다.
 */

import type {
  Character,
  DeathCause,
  Faction,
  GameState,
  NightActions,
  NightKillAction,
  Phase,
  Rng,
  Verdict,
} from './types.ts'
import { RuleError, isConvert } from './types.ts'
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
    abilityUses: { ...state.abilityUses },
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
  cause: 'night_kill' | 'execution' | 'snipe',
): void {
  if (mode.kind === 'instant') {
    kill(next, character, cause)
    return
  }
  character.hp -= mode.amount
  if (character.hp <= 0) kill(next, character, cause)
}

function win(next: GameState, faction: Faction): void {
  next.winner = faction
  next.phase = 'ended'
  next.log.push({ kind: 'victory', faction })
}

/**
 * 승리 판정. 사망·전향이 생길 수 있는 지점마다 호출한다 (DESIGN.md §3).
 *
 * 진영마다 이기는 방식이 다르다 — 마피아팀·시민팀은 **전멸형**, 교주팀은 **전향형**이다.
 * 전향형을 먼저 본다: 교주팀 조건은 교주팀 생존을 요구하므로 전멸형과 동시에 성립하지 않는다.
 */
function checkVictory(next: GameState, rules: RulesConfig): void {
  if (next.winner !== null) return

  // 교주팀 — "두 명 빼고 모두 사제" (§5.4)
  const cultRule = rules.victory.cult
  if (cultRule !== null) {
    const converts = aliveOf(next, 'cult').filter(isConvert).length
    const outsiders = alive(next).filter((c) => c.faction !== 'cult').length
    if (converts >= cultRule.minConverts && outsiders <= cultRule.survivorsLeft) {
      win(next, 'cult')
      return
    }
  }

  // 전멸형 — 상대 진영이 다 죽으면 승리
  const contenders: Faction[] = ['citizen', 'mafia', 'cult']
  for (const faction of contenders) {
    if (faction !== 'cult' && !rules.victory[faction]) continue
    if (faction === 'cult') continue // 교주팀은 전향형만 판정한다
    if (aliveOf(next, faction).length === 0) continue
    const opponentsAlive = contenders
      .filter((f) => f !== faction)
      .some((f) => aliveOf(next, f).length > 0)
    if (!opponentsAlive) {
      win(next, faction)
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
// Night — 검사(경찰) → 보호(의사) → 살해(마피아팀). 셋을 한꺼번에 해소한다 (§6)
// ─────────────────────────────────────────────────────────────────────────────

/** 경찰 검사. 살해를 적용하기 **전** 상태를 본다 🟡 — 그 밤에 죽는 사람도 결과는 나온다. */
function resolveInvestigations(next: GameState, rules: RulesConfig, actions: NightActions): void {
  const seen = new Set<string>()
  for (const { policeId, targetId } of actions.investigations ?? []) {
    const police = find(next, policeId)
    if (police.roleId !== 'police') throw new RuleError(`검사는 경찰의 능력이다: ${policeId}`)
    if (!police.alive) throw new RuleError(`죽은 경찰은 검사할 수 없다: ${policeId}`)
    if (seen.has(policeId)) throw new RuleError(`한 밤에 두 번 검사할 수 없다: ${policeId}`)
    seen.add(policeId)

    if (!rules.police.allowSelf && policeId === targetId) {
      throw new RuleError(`자기 자신은 검사하지 않는다: ${policeId}`)
    }
    const target = find(next, targetId)
    if (!target.alive) throw new RuleError(`죽은 캐릭터는 검사할 수 없다: ${targetId}`)

    // 'is_mafia' — 마피아팀인지 아닌지만 알려준다 (🟡 Q22).
    // 교주팀은 미설계라 지금은 'not_mafia' 로 나온다 (Q11 답이 오면 재검토).
    next.log.push({
      kind: 'investigated',
      policeId,
      targetId,
      result: target.faction === 'mafia' ? 'mafia' : 'not_mafia',
    })
  }
}

/** 의사 보호. 지켜진 사람은 그 밤 피해를 아예 받지 않는다 (즉사도 부수 피해도). */
function resolveProtections(next: GameState, rules: RulesConfig, actions: NightActions): Set<string> {
  const protectedIds = new Set<string>()
  const seen = new Set<string>()
  for (const { doctorId, targetId } of actions.protects ?? []) {
    const doctor = find(next, doctorId)
    if (doctor.roleId !== 'doctor') throw new RuleError(`보호는 의사의 능력이다: ${doctorId}`)
    if (!doctor.alive) throw new RuleError(`죽은 의사는 보호할 수 없다: ${doctorId}`)
    if (seen.has(doctorId)) throw new RuleError(`한 밤에 두 번 보호할 수 없다: ${doctorId}`)
    seen.add(doctorId)

    if (!rules.doctor.allowSelf && doctorId === targetId) {
      throw new RuleError(`자기 자신은 보호할 수 없다: ${doctorId}`)
    }
    const target = find(next, targetId)
    if (!target.alive) throw new RuleError(`죽은 캐릭터는 보호할 수 없다: ${targetId}`)

    protectedIds.add(targetId)
    next.log.push({ kind: 'protected', doctorId, targetId })
  }
  return protectedIds
}

/** 교주가 이번 밤에 움직일 수 있는가 — 짝수 밤만 ✅ (§5.4). */
export function cultCanAct(state: GameState, rules: RulesConfig): boolean {
  return rules.cult.activeNights === 'even' && state.day % 2 === 0
}

/**
 * 교주의 포교. 대상은 원래 역할을 유지한 채 진영만 교주팀이 된다 (🟡 §5.4).
 * 살해보다 먼저 해소되므로 전향된 그 밤에 죽을 수도 있다.
 */
function resolveConversion(
  next: GameState,
  rules: RulesConfig,
  actions: NightActions,
  protectedIds: ReadonlySet<string>,
): void {
  const conversion = actions.conversion
  if (conversion === undefined) return

  const leader = find(next, conversion.cultLeaderId)
  if (leader.roleId !== 'cultleader') throw new RuleError(`포교는 교주의 능력이다: ${leader.id}`)
  if (!leader.alive) throw new RuleError(`죽은 교주는 포교할 수 없다: ${leader.id}`)
  if (!cultCanAct(next, rules)) {
    throw new RuleError(`교주는 짝수 밤에만 움직인다 (현재 ${next.day}일차)`)
  }

  const target = find(next, conversion.targetId)
  if (!target.alive) throw new RuleError(`죽은 캐릭터는 포교할 수 없다: ${target.id}`)
  if (target.id === leader.id) throw new RuleError('교주는 자기 자신을 포교하지 않는다')
  if (target.faction === 'cult') throw new RuleError(`이미 교주팀이다: ${target.id}`)
  if (!rules.cult.canConvertMafia && target.faction === 'mafia') {
    throw new RuleError(`마피아팀은 포교할 수 없다: ${target.id}`)
  }
  if (rules.cult.protectBlocksConversion && protectedIds.has(target.id)) {
    // 이 규칙이 켜져 있으면 의사 보호가 포교도 막는다. 조용히 넘기지 않고 이벤트로 남긴다.
    next.log.push({ kind: 'conversion_blocked', targetId: target.id })
    return
  }

  next.log.push({
    kind: 'converted',
    cultLeaderId: leader.id,
    targetId: target.id,
    fromFaction: target.faction,
  })
  target.faction = 'cult'
  target.convertedAtDay = next.day
}

/** 폭탄마 후보 명단 검증 — 규칙 위반은 밤이 해소되기 전에 잡는다. */
function validateBombCandidates(
  next: GameState,
  rules: RulesConfig,
  bomber: Character,
  action: NightKillAction,
): readonly string[] {
  const candidates = action.candidates ?? []
  if (new Set(candidates).size !== candidates.length) {
    throw new RuleError('후보에 같은 사람을 두 번 넣을 수 없다')
  }
  if (!candidates.includes(action.targetId)) {
    throw new RuleError('찍은 대상은 후보 안에 있어야 한다')
  }

  for (const id of candidates) {
    const candidate = find(next, id)
    if (!candidate.alive) throw new RuleError(`죽은 캐릭터는 후보가 될 수 없다: ${id}`)
    if (!rules.bomber.canTargetOwnFaction && candidate.faction === bomber.faction) {
      throw new RuleError(`후보에 같은 팀을 넣지 않는다: ${id}`)
    }
  }

  // 후보를 다 채울 만큼 대상이 남아 있는지 — 막판에 밤이 막히면 안 된다 (🟡).
  const eligible = next.characters.filter(
    (c) => c.alive && (rules.bomber.canTargetOwnFaction || c.faction !== bomber.faction),
  ).length
  const required = Math.min(rules.bomber.candidateCount, eligible)
  if (candidates.length !== required) {
    if (!rules.bomber.allowFewerCandidatesWhenShort && candidates.length !== rules.bomber.candidateCount) {
      throw new RuleError(`후보는 정확히 ${rules.bomber.candidateCount}명이어야 한다`)
    }
    throw new RuleError(`후보는 ${required}명이어야 한다 (남은 대상 ${eligible}명)`)
  }
  return candidates
}

/** 그 밤 마피아팀의 살해 1회. 수행자가 폭탄마면 폭발 형태가 된다 (§5.2). */
function resolveKill(
  next: GameState,
  rules: RulesConfig,
  action: NightKillAction,
  protectedIds: ReadonlySet<string>,
): void {
  const actor = find(next, action.actorId)
  if (!actor.alive) throw new RuleError(`죽은 캐릭터는 살해할 수 없다: ${action.actorId}`)
  if (actor.faction !== 'mafia') throw new RuleError(`밤 살해는 마피아팀의 행동이다: ${action.actorId}`)

  const target = find(next, action.targetId)
  if (!target.alive) throw new RuleError(`이미 죽은 캐릭터를 살해할 수 없다: ${action.targetId}`)
  if (target.faction === 'mafia' && !(actor.roleId === 'bomber' && rules.bomber.canTargetOwnFaction)) {
    throw new RuleError(`마피아는 같은 팀을 살해하지 않는다: ${action.targetId}`)
  }

  if (actor.roleId !== 'bomber') {
    if (action.candidates !== undefined) {
      throw new RuleError('후보 명단은 폭탄마만 낸다 — 일반 마피아는 한 명을 지목한다')
    }
    next.nightKillTarget = protectedIds.has(target.id) ? null : target.id
    next.log.push({ kind: 'night_kill', actorId: actor.id, targetId: target.id })
    if (protectedIds.has(target.id)) {
      next.log.push({ kind: 'kill_blocked', targetId: target.id })
      return
    }
    applyLethal(next, target, rules.nightKill.lethality, 'night_kill')
    return
  }

  // ── 폭탄마 (§5.2) ──
  const used = next.abilityUses[actor.id] ?? 0
  if (rules.bomber.usesPerGame !== null && used >= rules.bomber.usesPerGame) {
    throw new RuleError(`폭탄을 더 쓸 수 없다 (${rules.bomber.usesPerGame}회 제한): ${actor.id}`)
  }
  const candidates = validateBombCandidates(next, rules, actor, action)
  next.abilityUses[actor.id] = used + 1

  next.nightKillTarget = protectedIds.has(target.id) ? null : target.id
  next.log.push({ kind: 'bomb', bomberId: actor.id, targetId: target.id, candidates: [...candidates] })

  // 찍힌 1명 → 즉사. 나머지 후보 → HP -1. 지켜진 사람은 어느 쪽도 받지 않는다.
  if (protectedIds.has(target.id)) {
    next.log.push({ kind: 'kill_blocked', targetId: target.id })
  } else {
    applyLethal(next, target, rules.nightKill.lethality, 'night_kill')
  }

  for (const id of candidates) {
    if (id === target.id) continue
    if (protectedIds.has(id)) {
      next.log.push({ kind: 'kill_blocked', targetId: id })
      continue
    }
    const splashed = find(next, id)
    const damage = rules.bomber.collateralDamage
    next.log.push({ kind: 'collateral', characterId: id, damage })
    splashed.hp -= damage
    if (splashed.hp <= 0) kill(next, splashed, 'collateral')
  }
}

/**
 * 밤 행동을 모두 해소하고 Dawn 으로 넘어간다.
 * `actions.kill === null` 은 살해를 거른 밤 (🟡 Q19 — `night_kill.may_skip`).
 */
export function resolveNight(state: GameState, rules: RulesConfig, actions: NightActions): GameState {
  requirePhase(state, 'night')
  const next = clone(state)
  next.nominationVotes = {}
  next.verdictVotes = {}
  next.nominee = null
  next.nightKillTarget = null

  resolveInvestigations(next, rules, actions)
  const protectedIds = resolveProtections(next, rules, actions)
  resolveConversion(next, rules, actions, protectedIds)

  if (actions.kill === null) {
    if (!rules.nightKill.maySkip) throw new RuleError('이 규칙에서는 밤 살해를 거를 수 없다')
    next.log.push({ kind: 'night_skipped' })
  } else {
    resolveKill(next, rules, actions.kill, protectedIds)
  }

  next.phase = 'dawn'
  checkVictory(next, rules)
  return next
}

// ─────────────────────────────────────────────────────────────────────────────
// 스나이퍼 — 페이즈 밖의 행동 (§5.5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 스나이퍼가 지금 쏠 수 있는가.
 *
 * 다른 능력은 모두 특정 페이즈에 묶여 있지만 저격만 **어디서나** 가능하다 ✅.
 * 그래서 페이즈 검사가 없고, 끝난 게임만 막는다.
 */
export function sniperCanFire(state: GameState, rules: RulesConfig, sniperId: string): boolean {
  if (state.winner !== null || state.phase === 'ended') return false
  const sniper = state.characters.find((c) => c.id === sniperId)
  if (!sniper || !sniper.alive || sniper.roleId !== 'sniper') return false
  const limit = rules.sniper.usesPerGame
  return limit === null || (state.abilityUses[sniperId] ?? 0) < limit
}

/**
 * 저격. **어느 페이즈에서든** 호출할 수 있고 (승부가 난 뒤만 제외),
 * 그 자리에서 사망·승리 판정이 일어난다.
 *
 * 의사 보호는 무시한다 🟡 (Q31) — 보호는 밤 해소 안에서만 존재하는 상태이고,
 * 저격은 페이즈 밖이라 보호가 걸려 있지 않은 시점에도 발생한다.
 */
export function fireSniper(
  state: GameState,
  rules: RulesConfig,
  shot: { readonly sniperId: string; readonly targetId: string },
): GameState {
  if (state.winner !== null || state.phase === 'ended') {
    throw new RuleError('승부가 난 뒤에는 쏠 수 없다')
  }

  const next = clone(state)
  const sniper = find(next, shot.sniperId)
  if (sniper.roleId !== 'sniper') throw new RuleError(`저격은 스나이퍼의 능력이다: ${sniper.id}`)
  if (!sniper.alive) throw new RuleError(`죽은 스나이퍼는 쏠 수 없다: ${sniper.id}`)

  const used = next.abilityUses[sniper.id] ?? 0
  const limit = rules.sniper.usesPerGame
  if (limit !== null && used >= limit) {
    throw new RuleError(`저격을 더 쓸 수 없다 (${limit}회 제한): ${sniper.id}`)
  }

  const target = find(next, shot.targetId)
  if (!target.alive) throw new RuleError(`이미 죽은 캐릭터를 쏠 수 없다: ${target.id}`)
  if (target.id === sniper.id) throw new RuleError('자기 자신을 쏠 수 없다')
  if (!rules.sniper.canTargetOwnFaction && target.faction === sniper.faction) {
    throw new RuleError(`같은 팀은 쏘지 않는다: ${target.id}`)
  }

  next.abilityUses[sniper.id] = used + 1
  next.log.push({ kind: 'sniped', sniperId: sniper.id, targetId: target.id, phase: next.phase })
  applyLethal(next, target, rules.sniper.lethality, 'snipe')

  // 변론 중인 피고를 쏴 죽였으면 재판이 성립하지 않는다.
  // 여기서 Dusk 로 넘기지 않으면 Trial 에 피고가 없어 그 날이 갈 곳을 잃는다(소프트락).
  if (next.nominee === target.id) {
    next.nominee = null
    if (next.phase === 'trial') next.phase = 'dusk'
  }

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

/**
 * 게임 생성 — 캐릭터 로스터를 받아 역할을 배정하고 첫 페이즈를 세운다.
 *
 * **인원 수·진영 비율을 하드코딩하지 않는다** (DESIGN.md Q10 미정). 호출자가 구성을 주고,
 * 코어는 그 구성이 규칙상 성립하는지만 본다.
 */

import type { Faction, GameState, RoleId, Rng } from './types.ts'
import { RuleError } from './types.ts'
import type { RulesConfig } from './config.ts'

/** 역할 → 진영. data/roles.json 의 faction 과 일치해야 한다. */
const ROLE_FACTION: Readonly<Record<RoleId, Faction>> = {
  citizen: 'citizen',
  police: 'citizen',
  doctor: 'citizen',
  mafia: 'mafia',
  bomber: 'mafia',
}

export function factionOf(roleId: RoleId): Faction {
  return ROLE_FACTION[roleId]
}

export interface RosterEntry {
  readonly id: string
  readonly name: string
}

export interface SetupOptions {
  readonly mode: 'solo' | 'duo'
  /** 등장 인물. 이름·id 는 호출자가 정한다 (고정 로스터인지는 Q9 미정) */
  readonly roster: readonly RosterEntry[]
  /**
   * 배정할 역할 목록. roster 와 길이가 같아야 한다.
   * 순서는 무시하고 rng 로 섞어 배정한다 — "시작 즉시 무작위 배정" ✅ (DESIGN.md §4.2).
   */
  readonly roles: readonly RoleId[]
  /** 듀오 모드에서 한 편이 될 두 캐릭터 id */
  readonly duoTeam?: readonly [string, string]
}

/** Fisher–Yates. rng 주입이라 테스트에서 결정론적이다. */
function shuffle<T>(items: readonly T[], rng: Rng): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)))
    const a = out[i]
    const b = out[j]
    if (a === undefined || b === undefined) throw new RuleError('셔플 실패')
    out[i] = b
    out[j] = a
  }
  return out
}

/**
 * 듀오 짝을 같은 진영으로 맞춘다 🟡 (DESIGN.md §2 — "둘이 같이 편먹는다").
 *
 * 배정을 먼저 하고 사후에 검사해서 던지면 게임이 **무작위로** 시작에 실패한다.
 * 그래서 검사하지 않고 교정한다 — 짝 한쪽의 역할을, 같은 진영 역할을 가진 제3자와 맞바꾼다.
 * 그런 제3자가 없으면 그 구성으로는 듀오가 성립하지 않으므로 그때만 던진다.
 */
function enforceDuoSameFaction(
  roster: readonly RosterEntry[],
  assigned: RoleId[],
  duo: readonly [string, string],
): void {
  const indexA = roster.findIndex((r) => r.id === duo[0])
  const indexB = roster.findIndex((r) => r.id === duo[1])
  const roleA = assigned[indexA]
  const roleB = assigned[indexB]
  if (roleA === undefined || roleB === undefined) throw new RuleError('듀오 짝의 역할을 찾지 못했다')
  if (factionOf(roleA) === factionOf(roleB)) return

  const swapWith = assigned.findIndex(
    (role, i) => i !== indexA && i !== indexB && factionOf(role) === factionOf(roleA),
  )
  if (swapWith < 0) {
    throw new RuleError(
      `이 구성으로는 듀오 짝을 같은 진영에 둘 수 없다 — ${factionOf(roleA)} 역할이 2개 이상 필요하다`,
    )
  }
  const displaced = assigned[swapWith]
  if (displaced === undefined) throw new RuleError('역할 교환 실패')
  assigned[swapWith] = roleB
  assigned[indexB] = displaced
}

export function createGame(options: SetupOptions, rules: RulesConfig, rng: Rng): GameState {
  const { mode, roster, roles } = options

  if (roster.length === 0) throw new RuleError('로스터가 비어 있다')
  if (roster.length !== roles.length) {
    throw new RuleError(`로스터(${roster.length})와 역할(${roles.length}) 수가 다르다`)
  }
  const ids = new Set(roster.map((r) => r.id))
  if (ids.size !== roster.length) throw new RuleError('로스터에 중복 id 가 있다')

  // 두 진영이 다 없으면 시작하자마자 승부가 나거나 아무도 못 이긴다.
  const factions = new Set(roles.map(factionOf))
  if (factions.size < 2) {
    throw new RuleError('진영이 하나뿐이면 게임이 성립하지 않는다 — 최소 두 진영이 필요하다')
  }

  if (mode === 'duo') {
    const duo = options.duoTeam
    if (!duo) throw new RuleError('듀오 모드는 duoTeam 이 필요하다')
    if (duo[0] === duo[1]) throw new RuleError('듀오 짝이 같은 캐릭터다')
    for (const id of duo) {
      if (!ids.has(id)) throw new RuleError(`듀오 짝이 로스터에 없다: ${id}`)
    }
  } else if (options.duoTeam) {
    throw new RuleError('솔로 모드에는 duoTeam 을 줄 수 없다')
  }

  const assigned = shuffle(roles, rng)
  if (mode === 'duo' && options.duoTeam) {
    enforceDuoSameFaction(roster, assigned, options.duoTeam)
  }

  const characters = roster.map((entry, index) => {
    const roleId = assigned[index]
    if (roleId === undefined) throw new RuleError('역할 배정 실패')
    return {
      id: entry.id,
      name: entry.name,
      roleId,
      faction: factionOf(roleId),
      hp: rules.startHp,
      alive: true,
      disguisedAs: null,
    }
  })

  const duoTeam = mode === 'duo' && options.duoTeam ? ([...options.duoTeam] as [string, string]) : null

  const state: GameState = {
    mode,
    duoTeam,
    day: 1,
    phase: rules.turn.firstPhase,
    characters,
    nightKillTarget: null,
    bombUses: {},
    nominationVotes: {},
    nominee: null,
    verdictVotes: {},
    winner: null,
    log: [],
  }

  return state
}

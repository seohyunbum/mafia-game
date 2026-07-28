/** 테스트용 상태 조립기. 규칙 테스트가 setup 절차에 묶이지 않게 상태를 직접 만든다. */

import type { Character, GameState, Phase, RoleId, Rng } from '../src/core/types.ts'
import { factionOf } from '../src/core/setup.ts'
import { loadRules } from '../src/core/data.ts'

/** 실제 data/rules.json — 데이터가 코어와 어긋나면 테스트가 먼저 깨진다. */
export const RULES = loadRules()

export function character(id: string, roleId: RoleId, overrides: Partial<Character> = {}): Character {
  return {
    id,
    name: id,
    roleId,
    faction: factionOf(roleId),
    hp: 2,
    alive: true,
    disguisedAs: null,
    convertedAtDay: null,
    ...overrides,
  }
}

export function stateOf(characters: Character[], phase: Phase, overrides: Partial<GameState> = {}): GameState {
  return {
    mode: 'solo',
    duoTeam: null,
    day: 1,
    phase,
    characters,
    nightKillTarget: null,
    abilityUses: {},
    nominationVotes: {},
    nominee: null,
    verdictVotes: {},
    winner: null,
    log: [],
    ...overrides,
  }
}

/** 정해진 순서대로 값을 내주는 rng. 다 쓰면 마지막 값을 반복한다. */
export function seededRng(values: readonly number[]): Rng {
  let index = 0
  return () => {
    const value = values[Math.min(index, values.length - 1)] ?? 0
    index += 1
    return value
  }
}

export function hpOf(state: GameState, id: string): number {
  const found = state.characters.find((c) => c.id === id)
  if (!found) throw new Error(`없는 캐릭터: ${id}`)
  return found.hp
}

export function isAlive(state: GameState, id: string): boolean {
  const found = state.characters.find((c) => c.id === id)
  if (!found) throw new Error(`없는 캐릭터: ${id}`)
  return found.alive
}

export function kinds(state: GameState): string[] {
  return state.log.map((e) => e.kind)
}

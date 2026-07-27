/**
 * 폭탄마 (DESIGN.md §5.2) — 후보 3명 중 1명 즉사 + 나머지 2명 HP -1.
 * HP 2 가 매 밤 작동하게 만드는 규칙이라 경계를 꼼꼼히 본다.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveNight } from '../src/core/engine.ts'
import { parseRules } from '../src/core/config.ts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../src/core/data.ts'
import { RULES, character, hpOf, isAlive, kinds, stateOf } from './helpers.ts'

function bombState() {
  return stateOf(
    [
      character('b1', 'bomber'),
      character('c1', 'citizen'),
      character('c2', 'citizen'),
      character('c3', 'citizen'),
      character('c4', 'citizen'),
    ],
    'night',
  )
}

const BOMB = { actorId: 'b1', targetId: 'c1', candidates: ['c1', 'c2', 'c3'] }

test('찍힌 1명은 죽고 나머지 후보 2명은 HP 1 을 잃는다 (확정)', () => {
  const after = resolveNight(bombState(), RULES, { kill: BOMB })

  assert.equal(isAlive(after, 'c1'), false, '찍힌 사람은 즉사')
  assert.equal(hpOf(after, 'c2'), 1)
  assert.equal(hpOf(after, 'c3'), 1)
  assert.equal(isAlive(after, 'c2'), true, 'HP 2 라 한 번은 버틴다')
  assert.equal(hpOf(after, 'c4'), 2, '후보가 아닌 사람은 멀쩡하다')

  assert.deepEqual(kinds(after), ['bomb', 'died', 'collateral', 'collateral'])
})

test('후보 명단이 로그에 남는다 — 상처가 곧 공개 정보다', () => {
  const after = resolveNight(bombState(), RULES, { kill: BOMB })

  assert.deepEqual(
    after.log.find((e) => e.kind === 'bomb'),
    { kind: 'bomb', bomberId: 'b1', targetId: 'c1', candidates: ['c1', 'c2', 'c3'] },
  )
})

test('이미 다친 사람이 후보에 또 오르면 죽는다 — 두 번째 폭발', () => {
  const state = bombState()
  state.characters.find((c) => c.id === 'c2')!.hp = 1 // 어젯밤 후보였다

  const after = resolveNight(state, RULES, { kill: BOMB })

  assert.equal(isAlive(after, 'c2'), false)
  assert.deepEqual(
    after.log.filter((e) => e.kind === 'died'),
    [
      { kind: 'died', characterId: 'c1', cause: 'night_kill' },
      { kind: 'died', characterId: 'c2', cause: 'collateral' },
    ],
  )
})

test('찍은 대상은 반드시 후보 안에 있어야 한다', () => {
  assert.throws(
    () => resolveNight(bombState(), RULES, { kill: { ...BOMB, targetId: 'c4' } }),
    /후보 안에 있어야/,
  )
})

test('후보에 같은 사람을 두 번 넣을 수 없다', () => {
  assert.throws(
    () => resolveNight(bombState(), RULES, { kill: { ...BOMB, candidates: ['c1', 'c1', 'c2'] } }),
    /두 번 넣을 수 없다/,
  )
})

test('후보에 마피아팀을 넣지 않는다 — 자기 자신도 (🟡 Q12c)', () => {
  const state = stateOf(
    [
      character('b1', 'bomber'),
      character('m1', 'mafia'),
      character('c1', 'citizen'),
      character('c2', 'citizen'),
    ],
    'night',
  )
  assert.throws(
    () => resolveNight(state, RULES, { kill: { actorId: 'b1', targetId: 'c1', candidates: ['c1', 'c2', 'm1'] } }),
    /같은 팀을 넣지 않는다/,
  )
  assert.throws(
    () => resolveNight(state, RULES, { kill: { actorId: 'b1', targetId: 'c1', candidates: ['c1', 'c2', 'b1'] } }),
    /같은 팀을 넣지 않는다/,
  )
})

test('후보 수가 3명이 아니면 받지 않는다', () => {
  assert.throws(
    () => resolveNight(bombState(), RULES, { kill: { ...BOMB, candidates: ['c1', 'c2'] } }),
    /후보는 3명이어야 한다/,
  )
  assert.throws(
    () => resolveNight(bombState(), RULES, { kill: { ...BOMB, candidates: ['c1', 'c2', 'c3', 'c4'] } }),
    /후보는 3명이어야 한다/,
  )
})

test('대상이 3명 미만으로 남으면 있는 만큼만 고른다 — 막판에 밤이 막히지 않는다 (🟡)', () => {
  const state = stateOf(
    [character('b1', 'bomber'), character('c1', 'citizen'), character('c2', 'citizen')],
    'night',
  )
  const after = resolveNight(state, RULES, {
    kill: { actorId: 'b1', targetId: 'c1', candidates: ['c1', 'c2'] },
  })

  assert.equal(isAlive(after, 'c1'), false)
  assert.equal(hpOf(after, 'c2'), 1)
})

test('죽은 사람은 후보가 될 수 없다', () => {
  const state = bombState()
  state.characters.find((c) => c.id === 'c3')!.alive = false
  assert.throws(() => resolveNight(state, RULES, { kill: BOMB }), /죽은 캐릭터는 후보가/)
})

test('폭발로 마지막 시민들이 쓸려나가면 마피아팀 승리다', () => {
  const state = stateOf(
    [
      character('b1', 'bomber'),
      character('c1', 'citizen'),
      character('c2', 'citizen', { hp: 1 }),
      character('c3', 'citizen', { hp: 1 }),
    ],
    'night',
  )
  const after = resolveNight(state, RULES, { kill: BOMB })

  assert.equal(after.winner, 'mafia')
  assert.equal(after.phase, 'ended')
})

test('사용 횟수 제한을 걸 수 있다 — 데이터만 고치면 된다 (🟡 Q12b)', () => {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, 'rules.json'), 'utf8'))
  raw['bomber']['uses_per_game'] = 1
  const limited = parseRules(raw)

  const first = resolveNight(bombState(), RULES, { kill: BOMB })
  assert.equal(first.bombUses['b1'], 1, '기본 규칙에서도 사용 횟수는 센다')

  const secondNight = stateOf(
    [
      character('b1', 'bomber'),
      character('c1', 'citizen'),
      character('c2', 'citizen'),
      character('c3', 'citizen'),
    ],
    'night',
    { bombUses: { b1: 1 } },
  )
  assert.throws(() => resolveNight(secondNight, limited, { kill: BOMB }), /폭탄을 더 쓸 수 없다/)
})

test('기본 규칙에서는 횟수 제한이 없다 (🟡 Q12b)', () => {
  assert.equal(RULES.bomber.usesPerGame, null)
  const state = stateOf(
    [
      character('b1', 'bomber'),
      character('c1', 'citizen'),
      character('c2', 'citizen'),
      character('c3', 'citizen'),
    ],
    'night',
    { bombUses: { b1: 5 } },
  )
  const after = resolveNight(state, RULES, { kill: BOMB })
  assert.equal(after.bombUses['b1'], 6)
})

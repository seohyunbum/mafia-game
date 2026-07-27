import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveNight } from '../src/core/engine.ts'
import { RuleError } from '../src/core/types.ts'
import { RULES, character, hpOf, isAlive, kinds, stateOf } from './helpers.ts'

function nightState() {
  return stateOf(
    [
      character('m1', 'mafia'),
      character('c1', 'citizen'),
      character('c2', 'citizen'),
      character('c3', 'citizen'),
    ],
    'night',
  )
}

test('밤 살해는 HP 2 여도 즉사다 (Q2 확정)', () => {
  const after = resolveNight(nightState(), RULES, 'c1')

  assert.equal(isAlive(after, 'c1'), false)
  assert.equal(hpOf(after, 'c1'), 0, 'HP 를 1 만 깎고 살려두지 않는다')
  assert.deepEqual(kinds(after), ['night_kill', 'died'])
  assert.equal(after.phase, 'dawn')
})

test('살해를 거른 밤도 있다 (🟡 Q19)', () => {
  const after = resolveNight(nightState(), RULES, null)

  assert.equal(after.nightKillTarget, null)
  assert.deepEqual(kinds(after), ['night_skipped'])
  assert.equal(after.characters.filter((c) => c.alive).length, 4)
})

test('마피아는 같은 팀을 살해하지 않고, 죽은 사람을 다시 죽이지 않는다', () => {
  assert.throws(() => resolveNight(nightState(), RULES, 'm1'), RuleError)

  const withDead = stateOf(
    [character('m1', 'mafia'), character('c1', 'citizen', { alive: false, hp: 0 }), character('c2', 'citizen')],
    'night',
  )
  assert.throws(() => resolveNight(withDead, RULES, 'c1'), RuleError)
  assert.throws(() => resolveNight(withDead, RULES, 'nobody'), RuleError)
})

test('입력 상태를 변경하지 않는다 — 새 상태를 돌려준다', () => {
  const before = nightState()
  const after = resolveNight(before, RULES, 'c1')

  assert.equal(isAlive(before, 'c1'), true, '원본은 그대로여야 한다')
  assert.equal(isAlive(after, 'c1'), false)
  assert.notEqual(before.log, after.log)
})

test('마지막 시민이 밤에 죽으면 그 자리에서 마피아팀 승리다', () => {
  const state = stateOf([character('m1', 'mafia'), character('c1', 'citizen')], 'night')
  const after = resolveNight(state, RULES, 'c1')

  assert.equal(after.winner, 'mafia')
  assert.equal(after.phase, 'ended')
  assert.deepEqual(kinds(after), ['night_kill', 'died', 'victory'])
})

test('밤 페이즈가 아니면 밤 행동을 받지 않는다', () => {
  const state = stateOf([character('m1', 'mafia'), character('c1', 'citizen')], 'day')
  assert.throws(() => resolveNight(state, RULES, 'c1'), /night 페이즈/)
})

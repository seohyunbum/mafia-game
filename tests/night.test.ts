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

test('일반 마피아의 밤 살해는 HP 2 여도 즉사다 (Q2 확정)', () => {
  const after = resolveNight(nightState(), RULES, { kill: { actorId: 'm1', targetId: 'c1' } })

  assert.equal(isAlive(after, 'c1'), false)
  assert.equal(hpOf(after, 'c1'), 0, 'HP 를 1 만 깎고 살려두지 않는다')
  assert.deepEqual(kinds(after), ['night_kill', 'died'])
  assert.equal(after.phase, 'dawn')
})

test('살해를 거르면 마피아가 죽는다 — 밤 호출을 이행하지 않은 것이다 (확정 §6.1)', () => {
  const after = resolveNight(nightState(), RULES, { kill: null })

  assert.equal(after.nightKillTarget, null)
  assert.equal(isAlive(after, 'm1'), false, '시간 안에 능력을 쓰지 않으면 사망')
  assert.deepEqual(kinds(after), ['timed_out', 'died', 'victory'])
})

test('일반 마피아는 후보 명단을 내지 않는다 — 그건 폭탄마 것이다', () => {
  assert.throws(
    () =>
      resolveNight(nightState(), RULES, {
        kill: { actorId: 'm1', targetId: 'c1', candidates: ['c1', 'c2', 'c3'] },
      }),
    /후보 명단은 폭탄마만/,
  )
})

test('마피아는 같은 팀을 살해하지 않고, 죽은 사람을 다시 죽이지 않는다', () => {
  assert.throws(() => resolveNight(nightState(), RULES, { kill: { actorId: 'm1', targetId: 'm1' } }), RuleError)

  const withDead = stateOf(
    [character('m1', 'mafia'), character('c1', 'citizen', { alive: false, hp: 0 }), character('c2', 'citizen')],
    'night',
  )
  assert.throws(() => resolveNight(withDead, RULES, { kill: { actorId: 'm1', targetId: 'c1' } }), RuleError)
  assert.throws(() => resolveNight(withDead, RULES, { kill: { actorId: 'm1', targetId: 'nobody' } }), RuleError)
})

test('시민은 밤 살해를 수행할 수 없다', () => {
  assert.throws(
    () => resolveNight(nightState(), RULES, { kill: { actorId: 'c1', targetId: 'c2' } }),
    /마피아팀의 행동/,
  )
})

test('입력 상태를 변경하지 않는다 — 새 상태를 돌려준다', () => {
  const before = nightState()
  const after = resolveNight(before, RULES, { kill: { actorId: 'm1', targetId: 'c1' } })

  assert.equal(isAlive(before, 'c1'), true, '원본은 그대로여야 한다')
  assert.equal(isAlive(after, 'c1'), false)
  assert.notEqual(before.log, after.log)
})

test('마지막 시민이 밤에 죽으면 그 자리에서 마피아팀 승리다', () => {
  const state = stateOf([character('m1', 'mafia'), character('c1', 'citizen')], 'night')
  const after = resolveNight(state, RULES, { kill: { actorId: 'm1', targetId: 'c1' } })

  assert.equal(after.winner, 'mafia')
  assert.equal(after.phase, 'ended')
  assert.deepEqual(kinds(after), ['night_kill', 'died', 'victory'])
})

test('밤 페이즈가 아니면 밤 행동을 받지 않는다', () => {
  const state = stateOf([character('m1', 'mafia'), character('c1', 'citizen')], 'day')
  assert.throws(() => resolveNight(state, RULES, { kill: { actorId: 'm1', targetId: 'c1' } }), /night 페이즈/)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveDawn, resolveDusk, resolveMorning } from '../src/core/engine.ts'
import { RuleError } from '../src/core/types.ts'
import { RULES, character, kinds, seededRng, stateOf } from './helpers.ts'

function morningState() {
  return stateOf(
    [
      character('m1', 'mafia'),
      character('m2', 'mafia'),
      character('c1', 'citizen'),
      character('c2', 'citizen'),
    ],
    'morning',
  )
}

function disguisedAs(state: ReturnType<typeof morningState>, id: string): string | null {
  const found = state.characters.find((c) => c.id === id)
  if (!found) throw new Error(`없는 캐릭터: ${id}`)
  return found.disguisedAs
}

test('변신 대상은 마피아가 고르지 않고 무작위로 정해진다 (확정)', () => {
  const first = resolveMorning(morningState(), RULES, ['m1'], seededRng([0]))
  const second = resolveMorning(morningState(), RULES, ['m1'], seededRng([0.99]))

  assert.equal(disguisedAs(first, 'm1'), 'c1')
  assert.equal(disguisedAs(second, 'm1'), 'c2', 'rng 이 다르면 대상도 달라진다')
  assert.deepEqual(kinds(first), ['disguised'])
})

test('변신은 선택적이다 — 안 쓴 마피아는 그대로다', () => {
  const after = resolveMorning(morningState(), RULES, [], seededRng([0]))

  assert.equal(disguisedAs(after, 'm1'), null)
  assert.equal(disguisedAs(after, 'm2'), null)
  assert.deepEqual(kinds(after), [])
  assert.equal(after.phase, 'day')
})

test('마피아 둘이 같은 얼굴을 쓰지 않는다 (🟡 Q6)', () => {
  const after = resolveMorning(morningState(), RULES, ['m1', 'm2'], seededRng([0, 0]))

  const a = disguisedAs(after, 'm1')
  const b = disguisedAs(after, 'm2')
  assert.ok(a !== null && b !== null, '둘 다 변신했어야 한다')
  assert.notEqual(a, b)
})

test('씌울 얼굴이 없으면 조용히 넘기지 않고 이벤트로 남긴다', () => {
  const state = stateOf(
    [character('m1', 'mafia'), character('c1', 'citizen', { alive: false, hp: 0 })],
    'morning',
  )
  const after = resolveMorning(state, RULES, ['m1'], seededRng([0]))

  assert.equal(disguisedAs(after, 'm1'), null)
  assert.deepEqual(kinds(after), ['disguise_unavailable'])
})

test('죽은 시민의 얼굴로는 변신하지 않는다 (🟡 Q6 — alive_citizens)', () => {
  const state = stateOf(
    [
      character('m1', 'mafia'),
      character('c1', 'citizen', { alive: false, hp: 0 }),
      character('c2', 'citizen'),
    ],
    'morning',
  )
  const after = resolveMorning(state, RULES, ['m1'], seededRng([0]))
  assert.equal(disguisedAs(after, 'm1'), 'c2')
})

test('시민은 변신할 수 없고, 이미 변신 중이면 또 못 한다', () => {
  assert.throws(() => resolveMorning(morningState(), RULES, ['c1'], seededRng([0])), RuleError)

  const already = stateOf(
    [character('m1', 'mafia', { disguisedAs: 'c1' }), character('c1', 'citizen')],
    'morning',
  )
  assert.throws(() => resolveMorning(already, RULES, ['m1'], seededRng([0])), /이미 변신 중/)
})

test('변신은 그 날 Dusk 에 풀린다 (🟡 Q5)', () => {
  const state = stateOf(
    [character('m1', 'mafia', { disguisedAs: 'c1' }), character('c1', 'citizen')],
    'dusk',
  )
  const after = resolveDusk(state, RULES)

  assert.equal(disguisedAs(after, 'm1'), null)
  assert.deepEqual(kinds(after), ['disguise_ended'])
  assert.equal(after.day, 2)
  assert.equal(after.phase, 'night')
})

test('Dawn 은 상태를 바꾸지 않는 정지점이다', () => {
  const state = stateOf([character('m1', 'mafia'), character('c1', 'citizen')], 'dawn', {
    nightKillTarget: 'c1',
  })
  const after = resolveDawn(state)

  assert.equal(after.phase, 'morning')
  assert.equal(after.nightKillTarget, 'c1', 'Dawn 은 공개용이라 결과를 지우지 않는다')
  assert.deepEqual(kinds(after), [])
})

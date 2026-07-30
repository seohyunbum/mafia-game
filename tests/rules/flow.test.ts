/**
 * 턴 한 바퀴 전체 흐름 (DESIGN.md §6). 페이즈 배선이 어긋나면 여기서 잡힌다.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  resolveDawn,
  resolveDay,
  resolveDusk,
  resolveMorning,
  resolveNight,
  resolveTrial,
} from '../../lib/rules/engine.ts'
import { RULES, character, hpOf, isAlive, kinds, seededRng, stateOf } from './helpers.ts'

test('Night → Dawn → Morning → Day → Trial → Dusk → 다음 Night 로 한 바퀴 돈다', () => {
  const rng = seededRng([0])
  // 마피아를 둘 둔다 — 변신 흡수로 피고가 처형되면(2026-07-30 변경) 마피아가 하나뿐이면
  // 그 자리에서 시민팀 승리로 게임이 끝나 한 바퀴를 볼 수 없다.
  let state = stateOf(
    [
      character('m1', 'mafia'),
      character('m2', 'mafia'),
      character('c1', 'citizen'),
      character('c2', 'citizen'),
      character('c3', 'citizen'),
      character('c4', 'citizen'),
    ],
    'night',
  )

  state = resolveNight(state, RULES, { kill: { actorId: 'm1', targetId: 'c4' } })
  assert.equal(state.phase, 'dawn')
  assert.equal(isAlive(state, 'c4'), false, '밤 살해는 즉사')

  state = resolveDawn(state)
  assert.equal(state.phase, 'morning')

  state = resolveMorning(state, RULES, ['m1'], rng)
  assert.equal(state.phase, 'day')
  assert.equal(state.characters.find((c) => c.id === 'm1')?.disguisedAs, 'c1', '살아있는 첫 시민으로 변신')

  // 시민들이 변신한 마피아를 지목한다 — 겉보기엔 c1 을 찍는 셈이다.
  state = resolveDay(state, RULES, { c1: 'm1', c2: 'm1', c3: 'm1' }, rng)
  assert.equal(state.phase, 'trial')
  assert.equal(state.nominee, 'm1')

  state = resolveTrial(state, RULES, { c1: 'kill', c2: 'kill', c3: 'kill', m2: 'spare' })
  assert.equal(state.phase, 'dusk')
  assert.equal(hpOf(state, 'c1'), 1, '피해는 흉내낸 원본 시민이 받는다 (Q1 확정)')
  assert.equal(isAlive(state, 'm1'), false, '흡수했어도 피고는 처형된다 (2026-07-30 변경)')

  state = resolveDusk(state, RULES)
  assert.equal(state.phase, 'night')
  assert.equal(state.day, 2)
  assert.equal(state.nominee, null)
  assert.deepEqual(state.nominationVotes, {})
  assert.equal(state.nightKillTarget, null)

  assert.deepEqual(kinds(state), [
    'night_kill',
    'died',
    'disguised',
    'nominated',
    'verdict',
    'disguise_absorbed',
    'died',
  ])
})

test('표가 아예 없는 날은 Trial 을 건너뛰고 바로 Dusk 다', () => {
  const rng = seededRng([0])
  let state = stateOf(
    [character('m1', 'mafia'), character('c1', 'citizen'), character('c2', 'citizen')],
    'day',
  )

  state = resolveDay(state, RULES, {}, rng)
  assert.equal(state.phase, 'dusk')

  state = resolveDusk(state, RULES)
  assert.equal(state.phase, 'night')
  assert.equal(state.day, 2)
})

test('동표면 그 중 한 명을 무작위로 법정에 세운다 (🟡 Q15 — 2026-07-30 변경)', () => {
  // 동표로 하루를 버리는 규칙은 낮을 헛돌게 하고(판당 0.90회), 2인 국면에서는
  // 1-1 동표가 영원히 반복돼 판이 끝나지 않았다 (측정: 48일차 교착).
  const state = stateOf(
    [character('m1', 'mafia'), character('c1', 'citizen'), character('c2', 'citizen')],
    'day',
  )
  const after = resolveDay(state, RULES, { c1: 'm1', m1: 'c1' }, seededRng([0]))

  assert.equal(after.phase, 'trial')
  assert.ok(after.nominee === 'm1' || after.nominee === 'c1', '동표 중 한 명이 피고가 된다')
})

test('시민이 마피아를 다 잡으면 시민팀이 이긴다 (🟡 Q16 — 비우면 소프트락)', () => {
  const state = stateOf(
    [character('m1', 'mafia'), character('c1', 'citizen'), character('c2', 'citizen')],
    'trial',
    { nominee: 'm1' },
  )
  const after = resolveTrial(state, RULES, { c1: 'kill', c2: 'kill' })

  assert.equal(after.winner, 'citizen')
  assert.equal(after.phase, 'ended')
})

test('승부가 난 뒤에는 페이즈를 더 진행하지 않는다', () => {
  const ended = stateOf([character('m1', 'mafia'), character('c1', 'citizen', { alive: false })], 'ended', {
    winner: 'mafia',
  })
  assert.throws(() => resolveNight(ended, RULES, { kill: null }), /night 페이즈/)
  assert.throws(() => resolveDusk(ended, RULES), /dusk 페이즈/)
})

test('여러 턴을 굴려도 게임이 끝난다 — 무한 루프로 남지 않는다', () => {
  const rng = seededRng([0])
  let state = stateOf(
    [
      character('m1', 'mafia'),
      character('c1', 'citizen'),
      character('c2', 'citizen'),
      character('c3', 'citizen'),
    ],
    'night',
  )

  // 마피아가 매 밤 한 명씩 죽이고 낮에는 아무도 지목되지 않는 최악의 시민 플레이.
  for (let guard = 0; guard < 10 && state.winner === null; guard += 1) {
    const prey = state.characters.find((c) => c.alive && c.faction === 'citizen')
    state = resolveNight(state, RULES, {
      kill: prey ? { actorId: 'm1', targetId: prey.id } : null,
    })
    if (state.winner !== null) break
    state = resolveDawn(state)
    state = resolveMorning(state, RULES, [], rng)
    state = resolveDay(state, RULES, {}, rng)
    state = resolveDusk(state, RULES)
  }

  assert.equal(state.winner, 'mafia')
  assert.equal(state.day, 3, '시민 3명 → 3번째 밤에 끝난다')
})

/**
 * 서로를 아는 관계 (DESIGN.md §4.4 — 8차 입력).
 *
 * 이 게임의 첫 정보 규칙이다. 마피아팀만 서로를 알고, 시민팀은 능력자끼리도 모르며,
 * 교주팀은 미정(Q37)이라 지금은 모르는 것으로 처리한다.
 *
 * 판정 기준이 **배정 당시의 원래 진영**이라는 점이 핵심이다 — 전향해도 시작 때 나눈
 * 정보는 사라지지 않는다. 그 어긋남이 교주팀의 유일한 정보 우위다.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { knownAllies } from '../../lib/rules/engine.ts'
import { RULES, character, stateOf } from './helpers.ts'

function roster() {
  return [
    character('m1', 'mafia'),
    character('b1', 'bomber'),
    character('s1', 'sniper'),
    character('c1', 'citizen'),
    character('p1', 'police'),
    character('d1', 'doctor'),
    character('k1', 'cultleader'),
  ]
}

const idsOf = (list: ReturnType<typeof roster>): string[] => list.map((c) => c.id).sort()

test('마피아팀은 서로를 안다 — 마피아·폭탄마·스나이퍼 (확정)', () => {
  const state = stateOf(roster(), 'night')
  assert.deepEqual(idsOf(knownAllies(state, RULES, 'm1')), ['b1', 's1'])
  assert.deepEqual(idsOf(knownAllies(state, RULES, 'b1')), ['m1', 's1'])
  assert.deepEqual(idsOf(knownAllies(state, RULES, 's1')), ['b1', 'm1'])
})

test('시민팀은 서로 모른다 — 경찰·의사끼리도 (🟡)', () => {
  const state = stateOf(roster(), 'night')
  assert.deepEqual(knownAllies(state, RULES, 'c1'), [])
  assert.deepEqual(knownAllies(state, RULES, 'p1'), [])
  assert.deepEqual(knownAllies(state, RULES, 'd1'), [])
})

test('교주팀은 미정이라 모르는 것으로 처리한다 (⬜ Q37)', () => {
  assert.equal(RULES.knowledge.cult, null, '답이 오면 데이터만 고치면 된다')
  const state = stateOf(roster(), 'night')
  assert.deepEqual(knownAllies(state, RULES, 'k1'), [])
})

test('전향해도 마피아팀은 그를 계속 동료로 안다 — 기준이 원래 진영이다', () => {
  const list = roster()
  const converted = list.find((c) => c.id === 'b1')
  assert.ok(converted)
  converted.faction = 'cult'
  converted.convertedAtDay = 2
  const state = stateOf(list, 'night', { day: 3 })

  assert.deepEqual(idsOf(knownAllies(state, RULES, 'm1')), ['b1', 's1'], '동료 목록에서 사라지지 않는다')
  assert.deepEqual(
    idsOf(knownAllies(state, RULES, 'b1')),
    ['m1', 's1'],
    '전향한 본인도 옛 동료를 계속 안다 — 교주팀의 정보 우위다',
  )
})

test('죽은 동료도 목록에 남는다 — 알던 사실이 죽음으로 지워지지 않는다', () => {
  const list = roster()
  const dead = list.find((c) => c.id === 's1')
  assert.ok(dead)
  dead.alive = false
  dead.hp = 0
  const state = stateOf(list, 'day')

  assert.deepEqual(idsOf(knownAllies(state, RULES, 'm1')), ['b1', 's1'])
})

test('자기 자신은 동료 목록에 넣지 않는다', () => {
  const state = stateOf(roster(), 'night')
  assert.equal(knownAllies(state, RULES, 'm1').some((c) => c.id === 'm1'), false)
})

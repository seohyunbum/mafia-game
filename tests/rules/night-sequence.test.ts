/**
 * 밤 진행 순서 (DESIGN.md §6.1) — 사회자가 직업을 하나씩 깨우고, 90초 안에 능력을
 * 쓰지 않으면 죽는다. 이 게임에서 가장 특이한 규칙이라 경계를 촘촘히 본다.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { nightSteps, resolveNight } from '../../lib/rules/engine.ts'
import { RULES, character, isAlive, kinds, stateOf } from './helpers.ts'

function fullTable(day: number) {
  return stateOf(
    [
      character('m1', 'mafia'),
      character('b1', 'bomber'),
      character('s1', 'sniper'),
      character('p1', 'police'),
      character('d1', 'doctor'),
      character('k1', 'cultleader'),
      character('c1', 'citizen'),
      character('c2', 'citizen'),
    ],
    'night',
    { day },
  )
}

/** 모든 필수 호출을 이행하는 행동 묶음 — 시간초과를 일으키지 않는다. */
function everyoneActs(day: number) {
  return {
    kill: { actorId: 'm1', targetId: 'c1' },
    investigations: [{ policeId: 'p1', targetId: 'm1' }],
    protects: [{ doctorId: 'd1', targetId: 'c2' }],
    ...(day % 2 === 0 ? { conversion: { cultLeaderId: 'k1', targetId: 'c2' } } : {}),
  }
}

// ── 호출 순서 ────────────────────────────────────────────────────────────────

test('사회자는 정해진 순서대로 직업을 부른다 (확정)', () => {
  const steps = nightSteps(fullTable(2), RULES)

  assert.deepEqual(
    steps.map((s) => s.id),
    ['mafia', 'sniper', 'police', 'doctor', 'citizen', 'cult'],
  )
  assert.equal(steps[0]?.prompt, '마피아는 일어나주세요')
})

test('제한시간은 직업마다 1분 30초다 (확정)', () => {
  for (const step of nightSteps(fullTable(2), RULES)) {
    assert.equal(step.timeLimitSeconds, 90, `${step.id} 의 제한시간이 다르다`)
  }
})

test('교주는 짝수 밤에만 호출된다 (확정)', () => {
  const odd = nightSteps(fullTable(1), RULES).map((s) => s.id)
  const even = nightSteps(fullTable(2), RULES).map((s) => s.id)

  assert.equal(odd.includes('cult'), false)
  assert.equal(even.includes('cult'), true)
})

test('스나이퍼와 시민만 면제다 — 나머지는 필수 (확정)', () => {
  const steps = nightSteps(fullTable(2), RULES)
  const optional = steps.filter((s) => !s.required).map((s) => s.id)

  assert.deepEqual(optional, ['sniper', 'citizen'])
})

test('마피아와 폭탄마는 한 호출로 함께 일어난다 (🟡 Q32)', () => {
  const steps = nightSteps(fullTable(1), RULES)
  const mafiaStep = steps.find((s) => s.id === 'mafia')

  assert.deepEqual(mafiaStep?.actorIds, ['m1', 'b1'])
})

test('시민도 호출된다 — 호출 순서만 듣고 구성을 읽지 못하게 (확정)', () => {
  const steps = nightSteps(fullTable(2), RULES)
  const citizenStep = steps.find((s) => s.id === 'citizen')

  assert.deepEqual(citizenStep?.actorIds, ['c1', 'c2'])
  assert.equal(citizenStep?.required, false, '불려 나오지만 아무것도 안 해도 된다')
})

test('그 직업 생존자가 없으면 호출 자체가 빠진다', () => {
  const state = stateOf(
    [character('m1', 'mafia'), character('c1', 'citizen'), character('c2', 'citizen')],
    'night',
  )
  assert.deepEqual(
    nightSteps(state, RULES).map((s) => s.id),
    ['mafia', 'citizen'],
  )

  const deadPolice = fullTable(1)
  deadPolice.characters.find((c) => c.id === 'p1')!.alive = false
  assert.equal(
    nightSteps(deadPolice, RULES).some((s) => s.id === 'police'),
    false,
  )
})

test('낮 조사 시간은 5분이다 (확정)', () => {
  assert.equal(RULES.daySchedule.investigationSeconds, 300)
})

// ── 시간초과 사망 ────────────────────────────────────────────────────────────

test('필수 호출에 행동이 없으면 그 직업이 죽는다 (확정)', () => {
  // 경찰만 검사를 안 했다.
  const after = resolveNight(fullTable(1), RULES, {
    kill: { actorId: 'm1', targetId: 'c1' },
    protects: [{ doctorId: 'd1', targetId: 'c2' }],
  })

  assert.equal(isAlive(after, 'p1'), false, '검사를 안 한 경찰은 죽는다')
  assert.equal(isAlive(after, 'd1'), true, '보호한 의사는 살아 있다')
  assert.deepEqual(
    after.log.find((e) => e.kind === 'timed_out'),
    { kind: 'timed_out', stepId: 'police', characterId: 'p1' },
  )
  assert.deepEqual(
    after.log.filter((e) => e.kind === 'died' && e.cause === 'timeout'),
    [{ kind: 'died', characterId: 'p1', cause: 'timeout' }],
  )
})

test('모두 행동하면 아무도 시간초과로 죽지 않는다', () => {
  const after = resolveNight(fullTable(2), RULES, everyoneActs(2))

  assert.equal(
    after.log.some((e) => e.kind === 'timed_out'),
    false,
  )
  assert.equal(isAlive(after, 'p1'), true)
  assert.equal(isAlive(after, 'd1'), true)
  assert.equal(isAlive(after, 'k1'), true)
})

test('스나이퍼는 안 쏴도 죽지 않는다 (확정)', () => {
  const after = resolveNight(fullTable(2), RULES, everyoneActs(2))

  assert.equal(isAlive(after, 's1'), true, '총알을 아껴도 벌받지 않는다')
})

test('마피아팀은 둘 중 하나만 행동해도 둘 다 산다 (🟡 Q32)', () => {
  // 폭탄마가 그 밤의 살해를 수행한다 → 일반 마피아도 이행으로 본다.
  const after = resolveNight(fullTable(1), RULES, {
    kill: { actorId: 'b1', targetId: 'c1', candidates: ['c1', 'c2', 'p1'] },
    investigations: [{ policeId: 'p1', targetId: 'm1' }],
    protects: [{ doctorId: 'd1', targetId: 'c2' }],
  })

  assert.equal(isAlive(after, 'm1'), true, '폭탄마가 대신 했으므로 마피아도 산다')
  assert.equal(isAlive(after, 'b1'), true)
})

test('홀수 밤에는 교주가 호출되지 않으므로 시간초과도 없다 (확정)', () => {
  const after = resolveNight(fullTable(1), RULES, everyoneActs(1))

  assert.equal(isAlive(after, 'k1'), true, '홀수 밤엔 일어나지 않으니 벌받을 일도 없다')
})

test('짝수 밤에 교주가 포교를 안 하면 죽는다 (확정)', () => {
  const after = resolveNight(fullTable(2), RULES, {
    kill: { actorId: 'm1', targetId: 'c1' },
    investigations: [{ policeId: 'p1', targetId: 'm1' }],
    protects: [{ doctorId: 'd1', targetId: 'c2' }],
  })

  assert.equal(isAlive(after, 'k1'), false)
})

test('그 밤에 살해당한 사람을 시간초과로 또 죽이지 않는다', () => {
  // 경찰이 마피아에게 죽고, 검사도 하지 않았다 — 사망 이벤트는 한 번만 나와야 한다.
  const after = resolveNight(fullTable(1), RULES, {
    kill: { actorId: 'm1', targetId: 'p1' },
    protects: [{ doctorId: 'd1', targetId: 'c2' }],
  })

  const deaths = after.log.filter((e) => e.kind === 'died' && e.characterId === 'p1')
  assert.equal(deaths.length, 1)
  assert.deepEqual(deaths[0], { kind: 'died', characterId: 'p1', cause: 'night_kill' })
})

test('여러 직업이 동시에 시간초과로 죽을 수 있다', () => {
  const after = resolveNight(fullTable(2), RULES, { kill: null })

  for (const id of ['m1', 'b1', 'p1', 'd1', 'k1']) {
    assert.equal(isAlive(after, id), false, `${id} 가 살아 있다`)
  }
  assert.equal(isAlive(after, 's1'), true, '스나이퍼는 면제')
  assert.equal(isAlive(after, 'c1'), true, '시민은 호출받지만 면제')
})

test('시간초과 사망도 승리 판정을 부른다', () => {
  const state = stateOf([character('m1', 'mafia'), character('c1', 'citizen')], 'night')
  const after = resolveNight(state, RULES, { kill: null })

  assert.equal(after.winner, 'citizen', '마피아가 스스로 죽었다')
  assert.equal(after.phase, 'ended')
  assert.deepEqual(kinds(after), ['timed_out', 'died', 'victory'])
})

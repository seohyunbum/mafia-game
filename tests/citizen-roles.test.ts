/**
 * 시민팀 직업 (DESIGN.md §5.3) — 경찰 검사, 의사 보호, 일반 시민은 능력 없음.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import { resolveNight } from '../src/core/engine.ts'
import { factionOf } from '../src/core/setup.ts'
import { RULES, character, hpOf, isAlive, kinds, stateOf } from './helpers.ts'

function nightState() {
  return stateOf(
    [
      character('m1', 'mafia'),
      character('p1', 'police'),
      character('d1', 'doctor'),
      character('c1', 'citizen'),
      character('c2', 'citizen'),
    ],
    'night',
  )
}

test('경찰·의사는 시민팀이다', () => {
  assert.equal(factionOf('police'), 'citizen')
  assert.equal(factionOf('doctor'), 'citizen')
})

// ── 경찰 ─────────────────────────────────────────────────────────────────────

test('경찰은 밤에 한 명을 검사해 마피아팀 여부를 받는다 (확정)', () => {
  const after = resolveNight(nightState(), RULES, {
    kill: null,
    investigations: [{ policeId: 'p1', targetId: 'm1' }],
  })

  assert.deepEqual(
    after.log.find((e) => e.kind === 'investigated'),
    { kind: 'investigated', policeId: 'p1', targetId: 'm1', result: 'mafia' },
  )
})

test('시민을 검사하면 마피아 아님으로 나온다', () => {
  const after = resolveNight(nightState(), RULES, {
    kill: null,
    investigations: [{ policeId: 'p1', targetId: 'c1' }],
  })

  assert.equal(after.log.find((e) => e.kind === 'investigated')?.result, 'not_mafia')
})

test('폭탄마도 마피아팀으로 나온다', () => {
  const state = stateOf([character('b1', 'bomber'), character('p1', 'police')], 'night')
  const after = resolveNight(state, RULES, {
    kill: null,
    investigations: [{ policeId: 'p1', targetId: 'b1' }],
  })

  assert.equal(after.log.find((e) => e.kind === 'investigated')?.result, 'mafia')
})

test('검사는 살해 적용 전 상태를 본다 — 그 밤에 죽는 사람도 결과가 나온다 (🟡)', () => {
  // 의사까지 행동시킨다 — 안 그러면 §6.1 시간초과로 의사가 죽어서 로그가 섞인다.
  const after = resolveNight(nightState(), RULES, {
    kill: { actorId: 'm1', targetId: 'c1' },
    investigations: [{ policeId: 'p1', targetId: 'c1' }],
    protects: [{ doctorId: 'd1', targetId: 'c2' }],
  })

  assert.equal(after.log.find((e) => e.kind === 'investigated')?.result, 'not_mafia')
  assert.equal(isAlive(after, 'c1'), false)
  assert.deepEqual(kinds(after), ['investigated', 'protected', 'night_kill', 'died'])
})

test('경찰만 검사하고, 죽은 경찰은 못 하고, 한 밤에 두 번은 못 한다', () => {
  const base = { kill: null } as const
  assert.throws(
    () => resolveNight(nightState(), RULES, { ...base, investigations: [{ policeId: 'c1', targetId: 'm1' }] }),
    /경찰의 능력/,
  )
  assert.throws(
    () =>
      resolveNight(nightState(), RULES, {
        ...base,
        investigations: [
          { policeId: 'p1', targetId: 'm1' },
          { policeId: 'p1', targetId: 'c1' },
        ],
      }),
    /두 번 검사할 수 없다/,
  )

  const deadPolice = nightState()
  deadPolice.characters.find((c) => c.id === 'p1')!.alive = false
  assert.throws(
    () => resolveNight(deadPolice, RULES, { ...base, investigations: [{ policeId: 'p1', targetId: 'm1' }] }),
    /죽은 경찰/,
  )
})

test('경찰은 자기 자신을 검사하지 않는다 (🟡)', () => {
  assert.throws(
    () =>
      resolveNight(nightState(), RULES, { kill: null, investigations: [{ policeId: 'p1', targetId: 'p1' }] }),
    /자기 자신은 검사하지 않는다/,
  )
})

// ── 의사 ─────────────────────────────────────────────────────────────────────

test('의사가 지킨 사람은 밤 살해를 맞아도 죽지 않는다 (확정)', () => {
  const after = resolveNight(nightState(), RULES, {
    kill: { actorId: 'm1', targetId: 'c1' },
    protects: [{ doctorId: 'd1', targetId: 'c1' }],
    investigations: [{ policeId: 'p1', targetId: 'm1' }],
  })

  assert.equal(isAlive(after, 'c1'), true)
  assert.equal(hpOf(after, 'c1'), 2, '보호는 피해를 0 으로 만든다 — HP 를 깎지 않는다')
  assert.equal(after.nightKillTarget, null, '아무도 죽지 않은 밤이다')
  assert.deepEqual(kinds(after), ['investigated', 'protected', 'night_kill', 'kill_blocked'])
})

test('엉뚱한 사람을 지키면 살해는 그대로 성립한다', () => {
  const after = resolveNight(nightState(), RULES, {
    kill: { actorId: 'm1', targetId: 'c1' },
    protects: [{ doctorId: 'd1', targetId: 'c2' }],
  })

  assert.equal(isAlive(after, 'c1'), false)
})

test('의사는 자기 자신도 지킬 수 있다 (🟡)', () => {
  const after = resolveNight(nightState(), RULES, {
    kill: { actorId: 'm1', targetId: 'd1' },
    protects: [{ doctorId: 'd1', targetId: 'd1' }],
  })

  assert.equal(isAlive(after, 'd1'), true)
})

test('보호는 폭탄 부수 피해도 막는다 — 후보였어도 안 깎인다 (🟡)', () => {
  const state = stateOf(
    [
      character('b1', 'bomber'),
      character('d1', 'doctor'),
      character('c1', 'citizen'),
      character('c2', 'citizen'),
    ],
    'night',
  )
  const after = resolveNight(state, RULES, {
    kill: { actorId: 'b1', targetId: 'c1', candidates: ['c1', 'c2', 'd1'] },
    protects: [{ doctorId: 'd1', targetId: 'c2' }],
  })

  assert.equal(isAlive(after, 'c1'), false, '찍힌 사람은 죽는다')
  assert.equal(hpOf(after, 'c2'), 2, '지켜진 후보는 안 깎인다')
  assert.equal(hpOf(after, 'd1'), 1, '안 지켜진 후보는 깎인다')
})

test('의사만 보호하고, 죽은 의사는 못 하고, 한 밤에 두 번은 못 한다', () => {
  const base = { kill: null } as const
  assert.throws(
    () => resolveNight(nightState(), RULES, { ...base, protects: [{ doctorId: 'c1', targetId: 'c2' }] }),
    /의사의 능력/,
  )
  assert.throws(
    () =>
      resolveNight(nightState(), RULES, {
        ...base,
        protects: [
          { doctorId: 'd1', targetId: 'c1' },
          { doctorId: 'd1', targetId: 'c2' },
        ],
      }),
    /두 번 보호할 수 없다/,
  )

  const deadDoctor = nightState()
  deadDoctor.characters.find((c) => c.id === 'd1')!.alive = false
  assert.throws(
    () => resolveNight(deadDoctor, RULES, { ...base, protects: [{ doctorId: 'd1', targetId: 'c1' }] }),
    /죽은 의사/,
  )
})

// ── 셋이 같은 밤에 ───────────────────────────────────────────────────────────

test('검사 → 보호 → 살해가 한 밤에 같이 해소된다', () => {
  const after = resolveNight(nightState(), RULES, {
    kill: { actorId: 'm1', targetId: 'c1' },
    protects: [{ doctorId: 'd1', targetId: 'c1' }],
    investigations: [{ policeId: 'p1', targetId: 'm1' }],
  })

  assert.deepEqual(kinds(after), ['investigated', 'protected', 'night_kill', 'kill_blocked'])
  assert.equal(after.characters.filter((c) => c.alive).length, 5, '아무도 죽지 않았다')
  assert.equal(after.phase, 'dawn')
})

test('일반 시민은 호출은 받지만 능력이 없어 시간초과로 죽지 않는다 (§6.1)', () => {
  const state = stateOf(
    [character('m1', 'mafia'), character('c1', 'citizen'), character('c2', 'citizen')],
    'night',
  )
  const after = resolveNight(state, RULES, { kill: { actorId: 'm1', targetId: 'c1' } })

  assert.equal(isAlive(after, 'c2'), true, '아무 능력도 안 썼지만 시민은 멀쩡하다')
  assert.equal(
    after.log.some((e) => e.kind === 'timed_out'),
    false,
  )
})

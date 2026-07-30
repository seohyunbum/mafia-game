/**
 * 스나이퍼 (DESIGN.md §5.5) — 밤이든 낮이든 어디서나 한 명을 죽인다.
 * 페이즈에 묶이지 않는 유일한 능력이라 "어디서나"가 정말 되는지, 그리고
 * 페이즈 흐름을 깨뜨리지 않는지를 본다.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { fireSniper, resolveTrial, sniperCanFire } from '../../lib/rules/engine.ts'
import { parseRules } from '../../lib/rules/config.ts'
import { DATA_DIR } from '../../lib/rules/data.ts'
import { factionOf } from '../../lib/rules/setup.ts'
import type { Phase } from '../../lib/rules/types.ts'
import { RULES, character, isAlive, kinds, stateOf } from './helpers.ts'

function sniperState(phase: Phase) {
  return stateOf(
    [
      character('s1', 'sniper'),
      character('c1', 'citizen'),
      character('c2', 'citizen'),
      character('c3', 'citizen'),
    ],
    phase,
  )
}

test('스나이퍼는 마피아팀이다', () => {
  assert.equal(factionOf('sniper'), 'mafia')
})

test('어느 페이즈에서든 쏠 수 있다 (확정)', () => {
  const phases: Phase[] = ['night', 'dawn', 'morning', 'day', 'trial', 'dusk']

  for (const phase of phases) {
    const state = sniperState(phase)
    if (phase === 'trial') state.nominee = 'c3'

    const after = fireSniper(state, RULES, { sniperId: 's1', targetId: 'c1' })
    assert.equal(isAlive(after, 'c1'), false, `${phase} 에서 못 쐈다`)
  }
})

test('저격은 즉사다 — HP 2 를 무시한다', () => {
  const after = fireSniper(sniperState('day'), RULES, { sniperId: 's1', targetId: 'c1' })

  const target = after.characters.find((c) => c.id === 'c1')!
  assert.equal(target.alive, false)
  assert.equal(target.hp, 0)
  assert.deepEqual(
    after.log.find((e) => e.kind === 'died'),
    { kind: 'died', characterId: 'c1', cause: 'snipe' },
  )
})

test('쏜 페이즈가 로그에 남는다 — 언제 끼어들었는지가 정보다', () => {
  const after = fireSniper(sniperState('trial'), RULES, { sniperId: 's1', targetId: 'c1' })

  assert.deepEqual(
    after.log.find((e) => e.kind === 'sniped'),
    { kind: 'sniped', sniperId: 's1', targetId: 'c1', phase: 'trial' },
  )
})

test('페이즈를 바꾸지 않는다 — 저격은 턴을 넘기는 행동이 아니다', () => {
  const after = fireSniper(sniperState('day'), RULES, { sniperId: 's1', targetId: 'c1' })
  assert.equal(after.phase, 'day')
})

test('입력 상태를 변경하지 않는다', () => {
  const before = sniperState('day')
  const after = fireSniper(before, RULES, { sniperId: 's1', targetId: 'c1' })

  assert.equal(isAlive(before, 'c1'), true)
  assert.equal(isAlive(after, 'c1'), false)
})

// ── 사용 횟수 ────────────────────────────────────────────────────────────────

test('기본 규칙은 게임당 1발이다 (🟡 Q29)', () => {
  assert.equal(RULES.sniper.usesPerGame, 1)

  const after = fireSniper(sniperState('day'), RULES, { sniperId: 's1', targetId: 'c1' })
  assert.equal(after.abilityUses['s1'], 1)
  assert.equal(sniperCanFire(after, RULES, 's1'), false, '총알을 다 썼다')

  assert.throws(
    () => fireSniper(after, RULES, { sniperId: 's1', targetId: 'c2' }),
    /저격을 더 쓸 수 없다/,
  )
})

test('무제한으로 바꿀 수 있다 — 데이터 한 줄 (Q29)', () => {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, 'rules.json'), 'utf8'))
  raw['sniper']['uses_per_game'] = null
  const unlimited = parseRules(raw)

  let state = sniperState('day')
  state = fireSniper(state, unlimited, { sniperId: 's1', targetId: 'c1' })
  state = fireSniper(state, unlimited, { sniperId: 's1', targetId: 'c2' })

  assert.equal(state.abilityUses['s1'], 2)
})

test('sniperCanFire 가 쏠 수 있는 상태를 알려준다', () => {
  assert.equal(sniperCanFire(sniperState('day'), RULES, 's1'), true)
  assert.equal(sniperCanFire(sniperState('day'), RULES, 'c1'), false, '시민은 못 쏜다')
  assert.equal(sniperCanFire(sniperState('day'), RULES, 'nobody'), false)

  const dead = sniperState('day')
  dead.characters.find((c) => c.id === 's1')!.alive = false
  assert.equal(sniperCanFire(dead, RULES, 's1'), false)
})

// ── 제약 ─────────────────────────────────────────────────────────────────────

test('스나이퍼만 쏘고, 죽은 스나이퍼는 못 쏜다', () => {
  assert.throws(
    () => fireSniper(sniperState('day'), RULES, { sniperId: 'c1', targetId: 'c2' }),
    /스나이퍼의 능력/,
  )

  const dead = sniperState('day')
  dead.characters.find((c) => c.id === 's1')!.alive = false
  assert.throws(
    () => fireSniper(dead, RULES, { sniperId: 's1', targetId: 'c1' }),
    /죽은 스나이퍼/,
  )
})

test('같은 팀과 자기 자신은 쏘지 않는다 — 그래서 변신과도 얽히지 않는다', () => {
  const state = stateOf(
    [
      character('s1', 'sniper'),
      character('m1', 'mafia', { disguisedAs: 'c1' }),
      character('c1', 'citizen'),
      character('c2', 'citizen'),
    ],
    'day',
  )
  assert.throws(
    () => fireSniper(state, RULES, { sniperId: 's1', targetId: 'm1' }),
    /같은 팀은 쏘지 않는다/,
  )
  assert.throws(() => fireSniper(state, RULES, { sniperId: 's1', targetId: 's1' }), /자기 자신/)
})

test('이미 죽은 사람은 쏠 수 없다', () => {
  const state = sniperState('day')
  state.characters.find((c) => c.id === 'c1')!.alive = false
  assert.throws(() => fireSniper(state, RULES, { sniperId: 's1', targetId: 'c1' }), /이미 죽은/)
})

test('승부가 난 뒤에는 쏠 수 없다', () => {
  const ended = stateOf([character('s1', 'sniper'), character('c1', 'citizen')], 'ended', {
    winner: 'mafia',
  })
  assert.throws(() => fireSniper(ended, RULES, { sniperId: 's1', targetId: 'c1' }), /승부가 난 뒤/)
  assert.equal(sniperCanFire(ended, RULES, 's1'), false)
})

// ── 페이즈 흐름을 깨뜨리지 않는지 ────────────────────────────────────────────

test('변론 중인 피고를 쏘면 그 날은 Dusk 로 넘어간다 — 재판이 갈 곳을 잃지 않는다', () => {
  const state = sniperState('trial')
  state.nominee = 'c1'

  const after = fireSniper(state, RULES, { sniperId: 's1', targetId: 'c1' })

  assert.equal(isAlive(after, 'c1'), false)
  assert.equal(after.nominee, null)
  assert.equal(after.phase, 'dusk', 'Trial 에 피고 없이 남으면 그 날이 진행되지 못한다')
  assert.throws(() => resolveTrial(after, RULES, {}), /dusk|피고가 없는데/)
})

test('피고가 아닌 사람을 쏘면 재판은 계속된다', () => {
  const state = sniperState('trial')
  state.nominee = 'c1'

  const after = fireSniper(state, RULES, { sniperId: 's1', targetId: 'c2' })

  assert.equal(after.phase, 'trial')
  assert.equal(after.nominee, 'c1')

  // 남은 자격자(s1, c3)가 모두 죽인다고 하면 피고는 처형된다.
  const resolved = resolveTrial(after, RULES, { s1: 'kill', c3: 'kill' })
  assert.equal(isAlive(resolved, 'c1'), false)
})

test('저격으로 마지막 시민이 죽으면 그 자리에서 마피아팀 승리다', () => {
  const state = stateOf([character('s1', 'sniper'), character('c1', 'citizen')], 'day')
  const after = fireSniper(state, RULES, { sniperId: 's1', targetId: 'c1' })

  assert.equal(after.winner, 'mafia')
  assert.equal(after.phase, 'ended')
  assert.deepEqual(kinds(after), ['sniped', 'died', 'victory'])
})

test('저격은 마피아팀 밤 살해와 별개다 — 같은 밤에 둘 다 일어난다 (🟡 Q30)', () => {
  const state = stateOf(
    [
      character('s1', 'sniper'),
      character('m1', 'mafia'),
      character('c1', 'citizen'),
      character('c2', 'citizen'),
      character('c3', 'citizen'),
    ],
    'night',
  )

  // 저격이 밤 살해를 대체하지 않으므로, 쏜 뒤에도 마피아는 따로 죽일 수 있다.
  const sniped = fireSniper(state, RULES, { sniperId: 's1', targetId: 'c1' })
  assert.equal(sniped.phase, 'night', '저격은 밤을 소모하지 않는다')

  assert.equal(RULES.sniper.usesPerGame, 1, '그래서 총알이 1발로 제한돼 있다')
})

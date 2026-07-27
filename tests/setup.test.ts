import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createGame, factionOf } from '../src/core/setup.ts'
import { RuleError, type RoleId } from '../src/core/types.ts'
import { RULES, seededRng } from './helpers.ts'

const ROSTER = [
  { id: 'p1', name: '유누' },
  { id: 'p2', name: '아빠' },
  { id: 'p3', name: '엄마' },
  { id: 'p4', name: '이모' },
]

const ROLES: RoleId[] = ['mafia', 'citizen', 'citizen', 'citizen']

test('시작하자마자 역할이 배정되고 전원 HP 2 로 선다 (확정)', () => {
  const game = createGame({ mode: 'solo', roster: ROSTER, roles: ROLES }, RULES, seededRng([0.5]))

  assert.equal(game.characters.length, 4)
  assert.ok(game.characters.every((c) => c.hp === 2 && c.alive && c.disguisedAs === null))
  assert.equal(game.characters.filter((c) => c.faction === 'mafia').length, 1)
  assert.equal(game.phase, 'night', '첫 페이즈는 밤 (🟡 Q18)')
  assert.equal(game.day, 1)
  assert.equal(game.winner, null)
})

test('배정은 무작위다 — rng 가 다르면 누가 마피아인지 달라진다', () => {
  const a = createGame({ mode: 'solo', roster: ROSTER, roles: ROLES }, RULES, seededRng([0, 0, 0]))
  const b = createGame({ mode: 'solo', roster: ROSTER, roles: ROLES }, RULES, seededRng([0.99, 0.99, 0.99]))

  const mafiaOf = (game: typeof a) => game.characters.find((c) => c.faction === 'mafia')?.id
  assert.notEqual(mafiaOf(a), mafiaOf(b))
})

test('인원 구성을 하드코딩하지 않는다 — 호출자가 준 만큼 만든다 (Q10 미정)', () => {
  const roster = Array.from({ length: 9 }, (_, i) => ({ id: `p${i}`, name: `p${i}` }))
  const roles: RoleId[] = ['mafia', 'mafia', 'bomber', ...Array<RoleId>(6).fill('citizen')]

  const game = createGame({ mode: 'solo', roster, roles }, RULES, seededRng([0.3]))

  assert.equal(game.characters.length, 9)
  assert.equal(game.characters.filter((c) => c.faction === 'mafia').length, 3, '폭탄마도 마피아편이다')
})

test('폭탄마는 마피아편이다 (확정) — 능력은 아직 없다 (Q12)', () => {
  assert.equal(factionOf('bomber'), 'mafia')
})

test('성립하지 않는 구성은 시작 전에 막는다', () => {
  const rng = seededRng([0])
  assert.throws(() => createGame({ mode: 'solo', roster: [], roles: [] }, RULES, rng), /비어 있다/)
  assert.throws(
    () => createGame({ mode: 'solo', roster: ROSTER, roles: ['mafia'] }, RULES, rng),
    /수가 다르다/,
  )
  assert.throws(
    () =>
      createGame(
        { mode: 'solo', roster: [ROSTER[0]!, ROSTER[0]!], roles: ['mafia', 'citizen'] },
        RULES,
        rng,
      ),
    /중복 id/,
  )
  assert.throws(
    () =>
      createGame(
        { mode: 'solo', roster: ROSTER, roles: ['citizen', 'citizen', 'citizen', 'citizen'] },
        RULES,
        rng,
      ),
    /진영이 하나뿐/,
  )
})

test('듀오 짝은 항상 같은 진영이 된다 — 무작위 배정에 좌우되지 않는다 (🟡 §2)', () => {
  // rng 을 여러 값으로 굴려도 짝의 진영이 갈리지 않아야 한다.
  for (const seed of [0, 0.25, 0.5, 0.75, 0.99]) {
    const game = createGame(
      { mode: 'duo', roster: ROSTER, roles: ['mafia', 'mafia', 'citizen', 'citizen'], duoTeam: ['p1', 'p2'] },
      RULES,
      seededRng([seed, seed, seed, seed]),
    )
    const a = game.characters.find((c) => c.id === 'p1')
    const b = game.characters.find((c) => c.id === 'p2')
    assert.equal(a?.faction, b?.faction, `seed ${seed} 에서 짝의 진영이 갈렸다`)
    assert.deepEqual(game.duoTeam, ['p1', 'p2'])
  }
})

test('같은 진영 역할이 하나뿐이면 듀오는 성립하지 않는다 — 조용히 넘기지 않는다', () => {
  assert.throws(
    () =>
      createGame(
        { mode: 'duo', roster: [ROSTER[0]!, ROSTER[1]!], roles: ['mafia', 'citizen'], duoTeam: ['p1', 'p2'] },
        RULES,
        seededRng([0]),
      ),
    /같은 진영에 둘 수 없다/,
  )
})

test('듀오 인자 실수를 막는다', () => {
  const rng = seededRng([0])
  assert.throws(() => createGame({ mode: 'duo', roster: ROSTER, roles: ROLES }, RULES, rng), /duoTeam 이 필요/)
  assert.throws(
    () => createGame({ mode: 'solo', roster: ROSTER, roles: ROLES, duoTeam: ['p1', 'p2'] }, RULES, rng),
    /솔로 모드에는/,
  )
  assert.throws(
    () =>
      createGame(
        { mode: 'duo', roster: ROSTER, roles: ROLES, duoTeam: ['p1', 'nobody'] },
        RULES,
        rng,
      ),
    /로스터에 없다/,
  )
  assert.throws(
    () => createGame({ mode: 'duo', roster: ROSTER, roles: ROLES, duoTeam: ['p1', 'p1'] }, RULES, rng),
    /같은 캐릭터/,
  )
})

test('솔로 게임에는 duoTeam 이 없다', () => {
  const game = createGame({ mode: 'solo', roster: ROSTER, roles: ROLES }, RULES, seededRng([0]))
  assert.equal(game.duoTeam, null)
  assert.equal(game.mode, 'solo')
})

test('RuleError 로 던진다 — 호출자가 구분할 수 있어야 한다', () => {
  assert.throws(() => createGame({ mode: 'solo', roster: [], roles: [] }, RULES, seededRng([0])), RuleError)
})

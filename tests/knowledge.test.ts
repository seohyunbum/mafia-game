/**
 * 서로를 아는 관계 (DESIGN.md §4.4) — 마피아팀은 서로를 안다.
 * 전향(사제)과 겹치는 경계가 이 규칙의 핵심이라 거기를 집중적으로 본다.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { knownAllies } from '../src/core/engine.ts'
import { parseRules } from '../src/core/config.ts'
import { DATA_DIR } from '../src/core/data.ts'
import { RULES, character, stateOf } from './helpers.ts'

function table() {
  return stateOf(
    [
      character('m1', 'mafia'),
      character('b1', 'bomber'),
      character('s1', 'sniper'),
      character('p1', 'police'),
      character('d1', 'doctor'),
      character('k1', 'cultleader'),
      character('c1', 'citizen'),
    ],
    'night',
  )
}

const ids = (list: readonly { id: string }[]): string[] => list.map((c) => c.id).sort()

test('마피아팀은 서로를 안다 — 폭탄마·스나이퍼까지 같은 팀이다 (확정)', () => {
  const g = table()

  assert.deepEqual(ids(knownAllies(g, RULES, 'm1')), ['b1', 's1'])
  assert.deepEqual(ids(knownAllies(g, RULES, 'b1')), ['m1', 's1'])
  assert.deepEqual(ids(knownAllies(g, RULES, 's1')), ['b1', 'm1'])
})

test('자기 자신은 동료 목록에 없다', () => {
  const g = table()
  assert.equal(
    knownAllies(g, RULES, 'm1').some((c) => c.id === 'm1'),
    false,
  )
})

test('시민팀은 서로 모른다 — 알면 추리가 성립하지 않는다 (🟡)', () => {
  const g = table()

  assert.deepEqual(knownAllies(g, RULES, 'p1'), [])
  assert.deepEqual(knownAllies(g, RULES, 'd1'), [])
  assert.deepEqual(knownAllies(g, RULES, 'c1'), [])
})

test('교주팀은 아직 안 정했으므로 모르는 것으로 처리한다 (⬜ Q37)', () => {
  assert.equal(RULES.knowledge.cult, null)
  assert.deepEqual(knownAllies(table(), RULES, 'k1'), [])
})

test('죽은 동료도 목록에 남는다 — 알던 사실은 사라지지 않는다', () => {
  const g = table()
  g.characters.find((c) => c.id === 'b1')!.alive = false

  assert.deepEqual(ids(knownAllies(g, RULES, 'm1')), ['b1', 's1'])
})

// ── 전향과 겹치는 경계 ───────────────────────────────────────────────────────

test('사제로 전향한 마피아를 다른 마피아는 여전히 동료로 안다', () => {
  const g = table()
  const convert = g.characters.find((c) => c.id === 'b1')!
  convert.faction = 'cult'
  convert.convertedAtDay = 2

  assert.deepEqual(
    ids(knownAllies(g, RULES, 'm1')),
    ['b1', 's1'],
    '현재 진영이 아니라 배정 당시 진영으로 판단한다',
  )
})

test('전향한 마피아도 옛 동료들을 계속 안다 — 교주팀의 정보 우위', () => {
  const g = table()
  const convert = g.characters.find((c) => c.id === 'b1')!
  convert.faction = 'cult'
  convert.convertedAtDay = 2

  assert.deepEqual(ids(knownAllies(g, RULES, 'b1')), ['m1', 's1'])
})

test('사제가 된 시민은 교주팀이 되어도 아는 사람이 늘지 않는다', () => {
  const g = table()
  const convert = g.characters.find((c) => c.id === 'c1')!
  convert.faction = 'cult'
  convert.convertedAtDay = 2

  assert.deepEqual(knownAllies(g, RULES, 'c1'), [], '교주팀 상호 인지가 미정이므로 비어 있다')
})

// ── 데이터로 끌 수 있다 ──────────────────────────────────────────────────────

test('마피아 상호 인지를 끄면 아무도 모른다 — 데이터 한 줄', () => {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, 'rules.json'), 'utf8'))
  raw['knowledge']['mafia_know_each_other'] = false
  const blind = parseRules(raw)

  assert.deepEqual(knownAllies(table(), blind, 'm1'), [])
})

test('교주팀 상호 인지를 켜면 사제와 교주가 서로를 안다 (Q37 답이 오면)', () => {
  const raw = JSON.parse(readFileSync(join(DATA_DIR, 'rules.json'), 'utf8'))
  raw['knowledge']['cult_know_each_other'] = true
  const rules = parseRules(raw)

  // 원래 진영 기준이므로 "교주로 배정된 사람들"끼리 안다. 전향자는 포함되지 않는다 —
  // 전향은 진행 중에 생기는 일이고, 이 규칙은 시작 시점의 정보다.
  const g = stateOf(
    [character('k1', 'cultleader'), character('k2', 'cultleader'), character('c1', 'citizen')],
    'night',
  )
  assert.deepEqual(ids(knownAllies(g, rules, 'k1')), ['k2'])
})

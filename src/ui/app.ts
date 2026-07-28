/**
 * 사회자 진행 화면.
 *
 * 규칙은 한 줄도 여기서 판정하지 않는다 — `src/core` 가 정본이고 이 파일은
 * **상태를 그리고 행동을 전달**하기만 한다 (DESIGN.md §8 — UI 는 마지막에 얇게).
 * 시간을 재는 것만 UI 의 책임이다 (§6.1 — 코어는 시계를 갖지 않는다).
 */

import './style.css'
import rulesJson from '../../data/rules.json'

import { parseRules, type RulesConfig } from '../core/config.ts'
import { createGame, factionOf, type RosterEntry } from '../core/setup.ts'
import {
  cultCanAct,
  fireSniper,
  nightSteps,
  resolveDawn,
  resolveDay,
  resolveDusk,
  resolveMorning,
  resolveNight,
  resolveTrial,
  sniperCanFire,
  verdictVoters,
  type ActiveNightStep,
} from '../core/engine.ts'
import type {
  Character,
  GameEvent,
  GameState,
  NightActions,
  NightKillAction,
  RoleId,
  Verdict,
} from '../core/types.ts'
import { portraitSvg } from './portrait.ts'
import {
  DEATH_STAMP,
  DEATH_STORY,
  DEFAULT_NAMES,
  FACTION_NAME,
  ROLE_NAME,
  ROSTER_TAG,
  clock,
  subject,
  topic,
} from './labels.ts'

const RULES: RulesConfig = parseRules(rulesJson)
const rng = (): number => Math.random()

// ─────────────────────────────────────────────────────────────────────────────
// 화면 상태 (게임 상태와 별개 — 진행 중 입력을 모아두는 곳)
// ─────────────────────────────────────────────────────────────────────────────

interface Setup {
  counts: Record<RoleId, number>
}

interface NightProgress {
  steps: ActiveNightStep[]
  index: number
  actions: {
    kill: NightKillAction | null
    protects: { doctorId: string; targetId: string }[]
    investigations: { policeId: string; targetId: string }[]
    conversion?: { cultLeaderId: string; targetId: string }
  }
  /** 현재 호출에서 고르는 중인 값들 */
  actorId: string | null
  candidates: string[]
  /** 마지막 검사 결과 — 사회자가 경찰에게 읽어준다 */
  report: string | null
  timedOut: boolean
  /** 첫 호출 전에 "모두 방으로" 화면을 한 번 보여준다 (§6.1.1) */
  lightsOut: boolean
}

const setup: Setup = {
  counts: { citizen: 3, police: 1, doctor: 1, mafia: 1, bomber: 1, sniper: 1, cultleader: 1 },
}

let game: GameState | null = null
let night: NightProgress | null = null
let dayVotes: Record<string, string> = {}
let verdicts: Record<string, Verdict> = {}
let sniperMode = false
/** 새벽 신문에 실을 사건 = 이 지점 이후의 로그 */
let logMark = 0
/** 남은 초. null 이면 시계가 돌지 않는다. */
let remaining: number | null = null
let limit = 1
let ticker: number | null = null

const root = document.getElementById('app') as HTMLElement

// ─────────────────────────────────────────────────────────────────────────────
// 시계 — UI 만의 책임
// ─────────────────────────────────────────────────────────────────────────────

function startClock(seconds: number, onExpire: () => void): void {
  stopClock()
  limit = seconds
  remaining = seconds
  ticker = window.setInterval(() => {
    if (remaining === null) return
    remaining -= 1
    if (remaining <= 0) {
      stopClock()
      onExpire()
      return
    }
    paintClock()
  }, 1000)
}

function stopClock(): void {
  if (ticker !== null) window.clearInterval(ticker)
  ticker = null
  remaining = null
}

function paintClock(): void {
  const host = document.querySelector('.clock')
  if (!host || remaining === null) return
  host.classList.toggle('urgent', remaining <= 15)
  const hand = host.querySelector<SVGCircleElement>('.hand')
  const readout = host.querySelector('.readout')
  const circumference = 2 * Math.PI * 48
  if (hand) hand.style.strokeDashoffset = String(circumference * (1 - remaining / limit))
  if (readout) readout.textContent = clock(remaining)
}

function clockHtml(): string {
  if (remaining === null) return ''
  const c = 2 * Math.PI * 48
  return `<div class="clock ${remaining <= 15 ? 'urgent' : ''}">
    <svg viewBox="0 0 112 112"><circle class="face" cx="56" cy="56" r="48" />
    <circle class="hand" cx="56" cy="56" r="48"
      style="stroke-dasharray:${c};stroke-dashoffset:${c * (1 - remaining / limit)}" /></svg>
    <span class="readout">${clock(remaining)}</span>
  </div>`
}

// ─────────────────────────────────────────────────────────────────────────────
// 조각들
// ─────────────────────────────────────────────────────────────────────────────

function tilt(id: string): string {
  let h = 0
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 1000
  return `${((h % 9) - 4) * 0.35}deg`
}

interface CardOptions {
  picked?: readonly string[]
  disabled?: (c: Character) => boolean
  action?: string
  /** 역할을 드러내도 되는 화면에서만 true (사회자 화면이라 기본 노출) */
  showRole?: boolean
}

/**
 * 사망 도장 문구는 로그의 사망 사유에서 온다 — 상태에는 사유가 없다.
 * 렌더할 때 한 번 만들어 카드가 공유한다.
 */
let stamps: Record<string, string> = {}

function collectStamps(g: GameState): Record<string, string> {
  const map: Record<string, string> = {}
  for (const e of g.log) {
    if (e.kind === 'died') map[e.characterId] = DEATH_STAMP[e.cause]
  }
  return map
}

function cardHtml(c: Character, options: CardOptions = {}): string {
  const picked = options.picked?.includes(c.id) ?? false
  const disabled = !c.alive || (options.disabled?.(c) ?? false)
  const wounds = Array.from({ length: RULES.startHp }, (_, i) =>
    `<i class="${i < RULES.startHp - c.hp ? 'gone' : ''}"></i>`,
  ).join('')
  const stamp = stamps[c.id] ?? '사망'
  const tag = options.showRole === false ? '&nbsp;' : ROSTER_TAG[c.roleId]
  const faction = c.faction !== factionOf(c.roleId) ? ' · 사제' : ''

  return `<button class="card ${c.alive ? '' : 'dead'} ${picked ? 'picked' : ''}"
    style="--tilt:${tilt(c.id)}"
    data-stamp="${stamp}"
    data-id="${c.id}"
    data-action="${options.action ?? ''}"
    ${disabled ? 'disabled' : ''}>
    ${portraitSvg(c.id, !c.alive)}
    <div class="name">${c.name}</div>
    <div class="tag">${tag}${faction}</div>
    <div class="wounds">${wounds}</div>
  </button>`
}

function rosterHtml(list: readonly Character[], options: CardOptions = {}): string {
  return `<div class="roster">${list.map((c) => cardHtml(c, options)).join('')}</div>`
}

// ── 복도와 방 (§6.1.1) ──────────────────────────────────────────────────────

interface CorridorOptions {
  /** 지금 방에서 나와 있는 사람들 (호출받은 직업) */
  out: readonly string[]
  /** 고를 수 있는 문 */
  selectable?: readonly string[]
  picked?: readonly string[]
  action?: string
}

/**
 * 밤의 복도. 대상 선택이 카드가 아니라 **문 고르기**인 것이 이 게임의 진행 방식이다 —
 * 능력의 대상은 방 안에 있는 사람이고, 호출받은 사람만 복도에 나와 있다.
 */
function corridorHtml(list: readonly Character[], options: CorridorOptions): string {
  const rooms = list
    .map((c, index) => {
      const out = options.out.includes(c.id)
      const selectable = (options.selectable?.includes(c.id) ?? false) && c.alive
      const picked = options.picked?.includes(c.id) ?? false
      const classes = [
        'room',
        c.alive ? '' : 'dead',
        out ? 'out' : '',
        selectable ? 'selectable' : '',
        picked ? 'picked' : '',
      ]
        .filter(Boolean)
        .join(' ')

      return `<div class="${classes}"
        data-id="${c.id}"
        data-action="${selectable ? (options.action ?? '') : ''}">
        <div class="inside">${portraitSvg(c.id, !c.alive, true)}</div>
        <div class="door"><span class="plate">${String(index + 1).padStart(2, '0')}</span>
          <span class="knob"></span></div>
        <div class="nameplate">
          <div class="name">${c.name}</div>
          <div class="tag">${c.alive ? (out ? '복도' : '방 안') : (stamps[c.id] ?? '사망')}</div>
        </div>
      </div>`
    })
    .join('')
  return `<div class="corridor">${rooms}</div>`
}

function slug(g: GameState): string {
  const alive = g.characters.filter((c) => c.alive).length
  const phase =
    g.phase === 'night'
      ? '밤'
      : g.phase === 'dawn'
        ? '새벽'
        : g.phase === 'morning'
          ? '아침'
          : g.phase === 'day'
            ? '낮'
            : g.phase === 'trial'
              ? '재판'
              : g.phase === 'dusk'
                ? '저녁'
                : '종료'
  return `<div class="slug"><span>제 ${g.day} 일</span><span>${phase}</span><span>생존 ${alive}명</span></div>`
}

function newEvents(g: GameState): GameEvent[] {
  return g.log.slice(logMark)
}

// ─────────────────────────────────────────────────────────────────────────────
// 화면 — 설정
// ─────────────────────────────────────────────────────────────────────────────

const SETUP_ORDER: RoleId[] = ['citizen', 'police', 'doctor', 'mafia', 'bomber', 'sniper', 'cultleader']

function totalCount(): number {
  return SETUP_ORDER.reduce((sum, role) => sum + setup.counts[role], 0)
}

function setupScreen(): string {
  const total = totalCount()
  const factions = new Set(SETUP_ORDER.filter((r) => setup.counts[r] > 0).map(factionOf))
  const problem =
    total < 3
      ? '최소 3명은 있어야 판이 성립한다.'
      : factions.size < 2
        ? '두 진영 이상 필요하다.'
        : total > DEFAULT_NAMES.length
          ? `이름이 ${DEFAULT_NAMES.length}개까지만 준비돼 있다.`
          : null

  return `<section class="sheet paper">
    <div class="masthead">
      <h1 class="offset">밤의 심판</h1>
      <div class="sub">사회자 진행판 · 세 진영 심리 추리</div>
    </div>
    <h2 class="headline">배역을 짠다</h2>
    <p class="deck">인원 구성은 아직 확정되지 않은 항목이다. 여기서 직접 짜 본다.</p>
    <div class="setup-grid">
      ${SETUP_ORDER.map(
        (role) => `<div class="field">
        <label>${ROLE_NAME[role]}</label>
        <div class="stepper">
          <button data-action="dec" data-role="${role}">−</button>
          <span class="value">${setup.counts[role]}</span>
          <button data-action="inc" data-role="${role}">+</button>
        </div>
      </div>`,
      ).join('')}
    </div>
    <div class="tally">총 ${total}명 · ${[...factions].map((f) => FACTION_NAME[f]).join(' / ')}</div>
    ${problem ? `<p class="warn">${problem}</p>` : ''}
    <div class="actions">
      <div class="spacer"></div>
      <button class="primary" data-action="start" ${problem ? 'disabled' : ''}>밤을 시작한다</button>
    </div>
  </section>`
}

// ─────────────────────────────────────────────────────────────────────────────
// 화면 — 밤
// ─────────────────────────────────────────────────────────────────────────────

function stepTargets(g: GameState, step: ActiveNightStep, actorId: string | null): Character[] {
  const actor = (actorId === null ? undefined : g.characters.find((c) => c.id === actorId)) ?? null
  return g.characters.filter((c) => {
    if (!c.alive) return false
    if (step.id === 'police') return c.id !== actorId
    if (step.id === 'cult') return c.id !== actorId && c.faction !== 'cult'
    if (step.id === 'mafia' || step.id === 'sniper') {
      return actor === null ? c.faction !== 'mafia' : c.faction !== actor.faction
    }
    return true
  })
}

function lightsOutScreen(g: GameState, p: NightProgress): string {
  return `<section class="sheet paper">
    ${slug(g)}
    <div class="call">
      <p class="call-prompt">모두 방으로 들어가주세요</p>
      <p class="call-note">밤이 왔다 · 오늘 호출 ${p.steps.length}회</p>
    </div>
    <p class="deck">문이 닫히면 서로를 볼 수 없다. 자기 직업이 불리면 나온다.</p>
    ${corridorHtml(g.characters, { out: [] })}
    <div class="actions">
      <span class="spacer"></span>
      <button class="primary" data-action="first-call">첫 호출</button>
    </div>
  </section>`
}

function nightScreen(g: GameState, p: NightProgress): string {
  if (p.lightsOut) return lightsOutScreen(g, p)
  const step = p.steps[p.index]
  if (step === undefined) return ''
  const actor = p.actorId === null ? null : g.characters.find((c) => c.id === p.actorId)
  const needsActor = step.actorIds.length > 1 && p.actorId === null
  const isBomber = actor?.roleId === 'bomber'
  const targets = stepTargets(g, step, p.actorId)

  const targetIds = targets.map((c) => c.id)
  let body: string
  // 시민 호출이 먼저다 — 고를 행위자가 없으므로 행위자 선택 화면으로 들어가면 안 된다.
  if (step.id === 'citizen') {
    body = `<p class="deck">시민은 능력이 없다. 나왔다가 그대로 들어간다 — 그 자체가 위장이다.</p>
      ${corridorHtml(g.characters, { out: step.actorIds })}`
  } else if (needsActor) {
    body = `<p class="deck">누가 나오는가.</p>
      ${corridorHtml(g.characters, {
        out: step.actorIds,
        selectable: step.actorIds,
        action: 'pick-actor',
      })}`
  } else if (isBomber && p.candidates.length < bomberQuota(g)) {
    body = `<p class="deck">후보 ${bomberQuota(g)}명의 문을 고른다. 다시 누르면 빠진다. (${p.candidates.length}/${bomberQuota(g)})</p>
      ${corridorHtml(g.characters, {
        out: step.actorIds,
        selectable: targetIds,
        picked: p.candidates,
        action: 'pick-candidate',
      })}`
  } else if (isBomber) {
    body = `<p class="deck">이 셋 중 어느 방이 터지는가. 나머지 둘은 상처를 입는다.</p>
      ${corridorHtml(g.characters, {
        out: step.actorIds,
        selectable: p.candidates,
        picked: p.candidates,
        action: 'pick-target',
      })}
      <div class="actions"><button data-action="reset-candidates">후보 다시 고르기</button></div>`
  } else {
    body = `<p class="deck">${stepPrompt(step.id)}</p>
      ${corridorHtml(g.characters, {
        out: step.actorIds,
        selectable: targetIds,
        action: 'pick-target',
      })}`
  }

  return `<section class="sheet paper">
    ${slug(g)}
    <div class="call">
      <div class="call-row">
        <div>
          <p class="call-prompt">${step.prompt}</p>
          <p class="call-note">${
            p.timedOut
              ? '시간초과 — 움직이지 않았다'
              : step.required
                ? `제한시간 ${clock(step.timeLimitSeconds)} · 쓰지 않으면 사망`
                : `제한시간 ${clock(step.timeLimitSeconds)} · 쓰지 않아도 된다`
          }</p>
        </div>
        ${clockHtml()}
      </div>
    </div>
    ${p.report ? `<p class="secret">사회자: ${p.report}</p>` : ''}
    ${body}
    <div class="actions">
      <span class="spacer"></span>
      ${step.required ? '' : '<button data-action="skip-step">쓰지 않는다</button>'}
    </div>
    <div class="log">호출 ${p.index + 1} / ${p.steps.length} — ${p.steps
      .map((s) => (s.id === step.id ? `<b>${s.prompt}</b>` : s.prompt))
      .join(' · ')}</div>
  </section>`
}

function stepPrompt(id: string): string {
  if (id === 'mafia') return '어느 방에 들어갈 것인가.'
  if (id === 'sniper') return '어느 방을 겨눌 것인가. 총알은 아껴도 된다.'
  if (id === 'police') return '어느 방을 조사할 것인가.'
  if (id === 'doctor') return '어느 방을 지킬 것인가.'
  if (id === 'cult') return '어느 방의 문을 두드릴 것인가.'
  return '문을 고른다.'
}

function bomberQuota(g: GameState): number {
  const eligible = g.characters.filter((c) => c.alive && c.faction !== 'mafia').length
  return Math.min(RULES.bomber.candidateCount, eligible)
}

// ─────────────────────────────────────────────────────────────────────────────
// 화면 — 새벽 신문
// ─────────────────────────────────────────────────────────────────────────────

function dawnScreen(g: GameState): string {
  const events = newEvents(g)
  const deaths = events.filter((e) => e.kind === 'died')
  const wounded = events.filter((e) => e.kind === 'collateral' || e.kind === 'disguise_absorbed')
  const blocked = events.some((e) => e.kind === 'kill_blocked')
  const name = (id: string): string => g.characters.find((c) => c.id === id)?.name ?? id

  const headline =
    deaths.length === 0
      ? '아무도 죽지 않았다'
      : deaths.length === 1
        ? `${name(deaths[0]!.kind === 'died' ? deaths[0]!.characterId : '')} 사망`
        : `하룻밤에 ${deaths.length}명`

  const story: string[] = []
  for (const e of deaths) {
    if (e.kind !== 'died') continue
    story.push(`${topic(name(e.characterId))} ${DEATH_STORY[e.cause]}.`)
  }
  for (const e of wounded) {
    if (e.kind === 'collateral') story.push(`${topic(name(e.characterId))} 상처를 입고 살아남았다.`)
    if (e.kind === 'disguise_absorbed') story.push(`${subject(name(e.originId))} 알 수 없는 이유로 다쳤다.`)
  }
  if (blocked) story.push('누군가 죽을 뻔했으나 손길이 닿았다.')
  if (story.length === 0) story.push('밤은 조용했다. 그것이 더 불길하다.')

  return `<section class="sheet paper">
    ${slug(g)}
    <div class="masthead">
      <h1 class="offset">밤의 심판</h1>
      <div class="sub">제 ${g.day} 일 · 조간</div>
    </div>
    <h2 class="headline">${headline}</h2>
    <div class="frontpage">
      ${story.map((line) => `<p>${line}</p>`).join('')}
      <p class="quiet">상처는 기록으로 남는다. 명부의 빗금을 확인하라.</p>
    </div>
    <div class="actions">
      <span class="spacer"></span>
      <button class="primary" data-action="to-morning">시체를 조사한다</button>
    </div>
  </section>`
}

// ─────────────────────────────────────────────────────────────────────────────
// 화면 — 아침(5분) · 낮 · 재판 · 저녁 · 종료
// ─────────────────────────────────────────────────────────────────────────────

let disguiseUsers: string[] = []

function morningScreen(g: GameState): string {
  const shifters = g.characters.filter((c) => c.alive && c.roleId === 'mafia' && c.disguisedAs === null)

  return `<section class="sheet paper">
    ${slug(g)}
    <div class="call">
      <div class="call-row">
        <div>
          <p class="call-prompt">시체를 조사한다</p>
          <p class="call-note">${clock(RULES.daySchedule.investigationSeconds)} 동안 자유롭게 움직인다</p>
        </div>
        ${clockHtml()}
      </div>
    </div>
    <h2 class="headline">명부</h2>
    <p class="deck">빗금은 상처다. 두 칸이 다 채워지면 죽는다.</p>
    ${rosterHtml(g.characters, { action: '' })}
    ${
      shifters.length > 0
        ? `<h2 class="headline" style="margin-top:26px">변신</h2>
           <p class="deck">고른 마피아는 무작위 시민의 얼굴을 쓴다. 대상은 스스로 고르지 못한다.</p>
           ${rosterHtml(shifters, { action: 'toggle-disguise', picked: disguiseUsers })}`
        : ''
    }
    <div class="actions">
      <span class="spacer"></span>
      <button class="primary" data-action="to-day">투표로 넘어간다</button>
    </div>
  </section>`
}

function dayScreen(g: GameState): string {
  const alive = g.characters.filter((c) => c.alive)
  const cast = Object.keys(dayVotes).length

  return `<section class="sheet paper">
    ${slug(g)}
    <h2 class="headline">지목 투표</h2>
    <p class="deck">최다득표 한 명이 법정에 선다. 동표면 아무도 세우지 않는다.</p>
    <table class="ledger">
      <thead><tr><th>투표자</th><th>지목</th></tr></thead>
      <tbody>
        ${alive
          .map(
            (voter) => `<tr>
          <td>${voter.name} <span class="tag">${ROSTER_TAG[voter.roleId]}</span></td>
          <td><select data-action="vote" data-id="${voter.id}">
            <option value="">— 기권 —</option>
            ${alive
              .filter((t) => t.id !== voter.id)
              .map(
                (t) =>
                  `<option value="${t.id}" ${dayVotes[voter.id] === t.id ? 'selected' : ''}>${t.name}</option>`,
              )
              .join('')}
          </select></td>
        </tr>`,
          )
          .join('')}
      </tbody>
    </table>
    <div class="tally">${cast} / ${alive.length} 명 투표</div>
    <div class="actions">
      <span class="spacer"></span>
      <button class="primary" data-action="tally-day">개표한다</button>
    </div>
  </section>`
}

function trialScreen(g: GameState): string {
  const nominee = g.characters.find((c) => c.id === g.nominee)
  if (!nominee) return ''
  const voters = verdictVoters(g, RULES)
  const kills = Object.values(verdicts).filter((v) => v === 'kill').length

  return `<section class="sheet paper">
    ${slug(g)}
    <h2 class="headline">변론</h2>
    <p class="deck">${subject(nominee.name)} 살아야 할 이유를 말한다. 그 다음 생사를 정한다.</p>
    <div style="display:flex;gap:20px;align-items:flex-start;flex-wrap:wrap">
      <div style="width:180px">${cardHtml(nominee, { action: '' })}</div>
      <div style="flex:1 1 320px">
        <table class="ledger">
          <thead><tr><th>배심</th><th>판단</th></tr></thead>
          <tbody>
            ${voters
              .map(
                (v) => `<tr>
              <td>${v.name}</td>
              <td><div class="verdict-pick">
                <button class="${verdicts[v.id] === 'spare' ? 'primary' : ''}"
                  data-action="verdict" data-id="${v.id}" data-choice="spare">살린다</button>
                <button class="${verdicts[v.id] === 'kill' ? 'danger' : ''}"
                  data-action="verdict" data-id="${v.id}" data-choice="kill">죽인다</button>
              </div></td>
            </tr>`,
              )
              .join('')}
          </tbody>
        </table>
        <div class="tally">죽인다 ${kills} / 자격자 ${voters.length} — 과반을 넘어야 가결</div>
      </div>
    </div>
    <div class="actions">
      <span class="spacer"></span>
      <button class="primary" data-action="tally-verdict">판결한다</button>
    </div>
  </section>`
}

function duskScreen(g: GameState): string {
  const events = newEvents(g)
  const name = (id: string): string => g.characters.find((c) => c.id === id)?.name ?? id
  const lines: string[] = []
  for (const e of events) {
    if (e.kind === 'no_nomination') lines.push(e.reason === 'tie' ? '동표 — 아무도 세우지 못했다.' : '표가 없었다.')
    if (e.kind === 'verdict') lines.push(`${name(e.nomineeId)} — 죽인다 ${e.kill}, 살린다 ${e.spare}. ${e.decision === 'kill' ? '가결.' : '부결.'}`)
    if (e.kind === 'disguise_absorbed') lines.push(`칼끝은 ${name(e.originId)}에게 갔다. 얼굴이 달랐다.`)
    if (e.kind === 'died') lines.push(`${topic(name(e.characterId))} ${DEATH_STORY[e.cause]}.`)
    if (e.kind === 'timed_out') lines.push(`${topic(name(e.characterId))} 제 시간에 움직이지 않았다.`)
  }
  if (lines.length === 0) lines.push('아무 일도 없었다.')

  return `<section class="sheet paper">
    ${slug(g)}
    <h2 class="headline">해가 진다</h2>
    <div class="frontpage">${lines.map((l) => `<p>${l}</p>`).join('')}</div>
    <div class="actions">
      <span class="spacer"></span>
      <button class="primary" data-action="to-night">밤이 온다</button>
    </div>
  </section>`
}

function endedScreen(g: GameState): string {
  const winner = g.winner
  return `<section class="sheet paper">
    <div class="masthead">
      <h1 class="offset">밤의 심판</h1>
      <div class="sub">제 ${g.day} 일 · 호외</div>
    </div>
    <h2 class="headline">${winner ? `${FACTION_NAME[winner]} 승리` : '판이 끝났다'}</h2>
    <div class="stamp">${winner ? FACTION_NAME[winner] : '종료'}</div>
    <p class="deck">모두의 정체를 공개한다.</p>
    ${rosterHtml(g.characters, { action: '' })}
    <div class="actions">
      <span class="spacer"></span>
      <button class="primary" data-action="restart">새 판</button>
    </div>
  </section>`
}

function sniperOverlay(g: GameState): string {
  const shooter = g.characters.find((c) => c.alive && c.roleId === 'sniper')
  if (!shooter) return ''
  const targets = g.characters.filter((c) => c.alive && c.faction !== shooter.faction)
  return `<section class="sheet paper">
    <h2 class="headline">저격</h2>
    <p class="deck">${topic(shooter.name)} 페이즈와 무관하게 쏠 수 있다. 남은 탄 ${
      RULES.sniper.usesPerGame === null
        ? '무제한'
        : RULES.sniper.usesPerGame - (g.abilityUses[shooter.id] ?? 0)
    }</p>
    ${rosterHtml(targets, { action: 'snipe' })}
    <div class="actions">
      <span class="spacer"></span>
      <button data-action="close-snipe">닫는다</button>
    </div>
  </section>`
}

// ─────────────────────────────────────────────────────────────────────────────
// 렌더
// ─────────────────────────────────────────────────────────────────────────────

function render(): void {
  const g = game
  document.body.classList.toggle('is-night', g !== null && g.phase === 'night')

  if (g === null) {
    root.innerHTML = setupScreen()
    return
  }
  stamps = collectStamps(g)

  let screen: string
  if (sniperMode) screen = sniperOverlay(g)
  else if (g.phase === 'night' && night !== null) screen = nightScreen(g, night)
  else if (g.phase === 'dawn') screen = dawnScreen(g)
  else if (g.phase === 'morning') screen = morningScreen(g)
  else if (g.phase === 'day') screen = dayScreen(g)
  else if (g.phase === 'trial') screen = trialScreen(g)
  else if (g.phase === 'dusk') screen = duskScreen(g)
  else screen = endedScreen(g)

  const canSnipe = g.characters.some((c) => sniperCanFire(g, RULES, c.id))
  const dock =
    canSnipe && !sniperMode
      ? `<div class="snipe-dock"><button data-action="open-snipe">저격</button></div>`
      : ''

  root.innerHTML = screen + dock
}

// ─────────────────────────────────────────────────────────────────────────────
// 진행
// ─────────────────────────────────────────────────────────────────────────────

function beginNight(): void {
  const g = game
  if (g === null) return
  logMark = g.log.length
  night = {
    steps: nightSteps(g, RULES),
    index: 0,
    actions: { kill: null, protects: [], investigations: [] },
    actorId: null,
    candidates: [],
    report: null,
    timedOut: false,
    lightsOut: true,
  }
  stopClock()
  render()
}

function enterStep(): void {
  const g = game
  const p = night
  if (g === null || p === null) return

  if (p.index >= p.steps.length) {
    finishNight()
    return
  }
  const step = p.steps[p.index]!
  p.actorId = step.actorIds.length === 1 ? (step.actorIds[0] ?? null) : null
  p.candidates = []
  p.report = null
  p.timedOut = false

  startClock(step.timeLimitSeconds, () => {
    // 시간초과 — 이 호출은 행동 없이 지나간다. 페널티는 코어가 매긴다 (§6.1).
    if (night !== null) night.timedOut = true
    render()
    window.setTimeout(nextStep, 1400)
  })
  render()
}

function nextStep(): void {
  if (night === null) return
  stopClock()
  night.index += 1
  enterStep()
}

function finishNight(): void {
  const g = game
  const p = night
  if (g === null || p === null) return
  stopClock()

  const actions: NightActions = {
    kill: p.actions.kill,
    protects: p.actions.protects,
    investigations: p.actions.investigations,
    ...(p.actions.conversion ? { conversion: p.actions.conversion } : {}),
  }
  game = resolveNight(g, RULES, actions)
  night = null
  render()
}

function advance(next: GameState): void {
  game = next
  render()
}

// ─────────────────────────────────────────────────────────────────────────────
// 입력
// ─────────────────────────────────────────────────────────────────────────────

root.addEventListener('click', (event) => {
  const target = event.target
  if (!(target instanceof Element)) return
  const el = target.closest<HTMLElement>('[data-action]')
  if (!el) return
  const action = el.dataset['action']
  const id = el.dataset['id'] ?? ''
  const g = game

  if (action === 'inc' || action === 'dec') {
    const role = el.dataset['role'] as RoleId
    const delta = action === 'inc' ? 1 : -1
    setup.counts[role] = Math.max(0, Math.min(6, setup.counts[role] + delta))
    render()
    return
  }

  if (action === 'start') {
    const roles: RoleId[] = SETUP_ORDER.flatMap((role) =>
      Array.from({ length: setup.counts[role] }, () => role),
    )
    const roster: RosterEntry[] = roles.map((_, i) => ({
      id: `p${i}`,
      name: DEFAULT_NAMES[i] ?? `${i + 1}번`,
    }))
    game = createGame({ mode: 'solo', roster, roles }, RULES, rng)
    beginNight()
    return
  }

  if (g === null) return

  if (action === 'open-snipe') {
    sniperMode = true
    render()
    return
  }
  if (action === 'close-snipe') {
    sniperMode = false
    render()
    return
  }
  if (action === 'snipe') {
    const shooter = g.characters.find((c) => c.alive && c.roleId === 'sniper')
    if (shooter) {
      game = fireSniper(g, RULES, { sniperId: shooter.id, targetId: id })
      sniperMode = false
      // 저격으로 판이 끝났으면 진행 중인 밤을 접는다.
      if (game.phase === 'ended') {
        stopClock()
        night = null
      }
      render()
    }
    return
  }

  const p = night
  if (p !== null && g.phase === 'night') {
    if (action === 'first-call') {
      p.lightsOut = false
      enterStep()
      return
    }
    const step = p.steps[p.index]
    if (step === undefined) return

    if (action === 'pick-actor') {
      p.actorId = id
      render()
      return
    }
    if (action === 'reset-candidates') {
      p.candidates = []
      render()
      return
    }
    if (action === 'pick-candidate') {
      // 토글 — 잘못 고른 후보를 다시 눌러 뺄 수 있어야 한다.
      p.candidates = p.candidates.includes(id)
        ? p.candidates.filter((x) => x !== id)
        : [...p.candidates, id]
      render()
      return
    }
    if (action === 'skip-step') {
      nextStep()
      return
    }
    if (action === 'pick-target') {
      const actorId = p.actorId
      if (actorId === null) return

      if (step.id === 'mafia') p.actions.kill = { actorId, targetId: id, ...(p.candidates.length > 0 ? { candidates: [...p.candidates] } : {}) }
      else if (step.id === 'police') {
        p.actions.investigations.push({ policeId: actorId, targetId: id })
        // 사회자가 그 자리에서 읽어주는 답. 정본 판정은 resolveNight 이 로그로 남긴다.
        const suspect = g.characters.find((c) => c.id === id)
        p.report = `${topic(suspect?.name ?? '')} 마피아팀이 ${suspect?.faction === 'mafia' ? '맞다' : '아니다'}.`
        render()
        window.setTimeout(nextStep, 1800)
        return
      } else if (step.id === 'doctor') p.actions.protects.push({ doctorId: actorId, targetId: id })
      else if (step.id === 'cult') p.actions.conversion = { cultLeaderId: actorId, targetId: id }
      else if (step.id === 'sniper') {
        game = fireSniper(g, RULES, { sniperId: actorId, targetId: id })
        if (game.phase === 'ended') {
          stopClock()
          night = null
          render()
          return
        }
        nextStep()
        return
      }
      nextStep()
      return
    }
  }

  if (action === 'to-morning') {
    advance(resolveDawn(g))
    startClock(RULES.daySchedule.investigationSeconds, () => render())
    render()
    return
  }
  if (action === 'toggle-disguise') {
    disguiseUsers = disguiseUsers.includes(id)
      ? disguiseUsers.filter((x) => x !== id)
      : [...disguiseUsers, id]
    render()
    return
  }
  if (action === 'to-day') {
    stopClock()
    const next = resolveMorning(g, RULES, disguiseUsers, rng)
    disguiseUsers = []
    dayVotes = {}
    logMark = next.log.length
    advance(next)
    return
  }
  if (action === 'tally-day') {
    logMark = g.log.length
    verdicts = {}
    advance(resolveDay(g, RULES, dayVotes, rng))
    return
  }
  if (action === 'verdict') {
    verdicts[id] = el.dataset['choice'] === 'kill' ? 'kill' : 'spare'
    render()
    return
  }
  if (action === 'tally-verdict') {
    advance(resolveTrial(g, RULES, verdicts))
    return
  }
  if (action === 'to-night') {
    game = resolveDusk(g, RULES)
    beginNight()
    return
  }
  if (action === 'restart') {
    game = null
    night = null
    stopClock()
    render()
    return
  }
})

root.addEventListener('change', (event) => {
  const el = event.target
  if (!(el instanceof HTMLSelectElement)) return
  if (el.dataset['action'] !== 'vote') return
  const voter = el.dataset['id'] ?? ''
  if (el.value === '') delete dayVotes[voter]
  else dayVotes[voter] = el.value
  const host = document.querySelector('.tally')
  if (host && game) {
    host.textContent = `${Object.keys(dayVotes).length} / ${game.characters.filter((c) => c.alive).length} 명 투표`
  }
})

render()

// 교주 호출은 짝수 밤에만 뜬다 — 콘솔에서도 확인할 수 있게 남겨 둔다.
if (game !== null) console.info('교주 활동 가능:', cultCanAct(game, RULES))

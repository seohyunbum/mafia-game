/** 화면 문구. 규칙 용어는 docs/DESIGN.md 표기를 그대로 따른다. */

import type { DeathCause, Faction, RoleId } from '../core/types.ts'

export const ROLE_NAME: Readonly<Record<RoleId, string>> = {
  citizen: '시민',
  police: '경찰',
  doctor: '의사',
  mafia: '마피아',
  bomber: '폭탄마',
  sniper: '스나이퍼',
  cultleader: '교주',
}

export const FACTION_NAME: Readonly<Record<Faction, string>> = {
  citizen: '시민팀',
  mafia: '마피아팀',
  cult: '교주팀',
}

export const DEATH_STAMP: Readonly<Record<DeathCause, string>> = {
  night_kill: '사망',
  execution: '처형',
  vote_damage: '사망',
  collateral: '폭사',
  snipe: '피격',
  timeout: '시간초과',
}

/** 새벽 신문에 쓰는 사망 사유 문장. */
export const DEATH_STORY: Readonly<Record<DeathCause, string>> = {
  night_kill: '밤중에 목숨을 잃었다',
  execution: '광장에서 처형됐다',
  vote_damage: '쌓인 상처를 버티지 못했다',
  collateral: '폭발에 휩쓸렸다',
  snipe: '어디선가 날아온 한 발에 쓰러졌다',
  timeout: '제 시간에 움직이지 않아 숨을 거뒀다',
}

/** 기본 로스터 이름 — 시대감을 맞춘 성씨. */
export const DEFAULT_NAMES = [
  '유누',
  '서 기자',
  '박 의원',
  '최 박사',
  '정 마담',
  '한 형사',
  '오 신부',
  '임 사장',
  '조 화백',
  '강 선장',
  '윤 약사',
  '노 교수',
]

export const ROSTER_TAG: Readonly<Record<RoleId, string>> = {
  citizen: '시민',
  police: '경찰',
  doctor: '의사',
  mafia: '마피아',
  bomber: '폭탄마',
  sniper: '스나이퍼',
  cultleader: '교주',
}

/**
 * 한글 조사. "서 기자은(는)" 같은 문장을 안 쓰기 위해 받침을 보고 고른다.
 * 마지막 글자가 한글이 아니면 받침 없는 쪽을 쓴다.
 */
function hasFinalConsonant(word: string): boolean {
  const last = word.trimEnd().slice(-1)
  const code = last.charCodeAt(0)
  if (code < 0xac00 || code > 0xd7a3) return false
  return (code - 0xac00) % 28 !== 0
}

/** 은/는 */
export function topic(word: string): string {
  return word + (hasFinalConsonant(word) ? '은' : '는')
}

/** 이/가 */
export function subject(word: string): string {
  return word + (hasFinalConsonant(word) ? '이' : '가')
}

export function clock(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

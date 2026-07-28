/**
 * 절차적 인물 초상 — 이미지 파일을 쓰지 않는다.
 *
 * 아트 디렉션이 "1930년대 인쇄물"이라 사진 대신 **하프톤 실루엣**을 그린다.
 * id 를 해시해서 모자·머리·어깨 모양을 고르므로 같은 인물은 항상 같은 얼굴이다.
 */

function hash(text: string): number {
  let h = 2166136261
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

const HEADWEAR = [
  // 페도라
  '<path d="M14 30 Q32 12 50 30 L54 33 Q32 26 10 33 Z" />',
  // 뉴스보이 캡
  '<path d="M15 31 Q32 14 49 29 L52 32 L13 32 Z" />',
  // 맨머리 (짧은 머리)
  '<path d="M18 30 Q32 16 46 30 Q32 24 18 30 Z" />',
  // 스카프 두른 머리
  '<path d="M17 31 Q32 13 47 31 Q40 25 32 26 Q24 25 17 31 Z" />',
  // 성직자 모자
  '<path d="M20 30 L32 15 L44 30 Z" />',
]

const SHOULDER = [
  'M8 64 Q32 44 56 64 L56 64 L8 64 Z',
  'M6 64 Q32 46 58 64 Z',
  'M10 64 Q20 48 32 48 Q44 48 54 64 Z',
]

/**
 * 64x64 SVG 문자열. `<svg>` 태그까지 포함해 그대로 innerHTML 에 넣을 수 있다.
 * 죽은 인물은 잉크가 바랜 것처럼 옅게 그린다.
 */
export function portraitSvg(id: string, dead: boolean, flat = false): string {
  const h = hash(id)
  const hat = HEADWEAR[h % HEADWEAR.length]
  const shoulder = SHOULDER[(h >> 3) % SHOULDER.length]
  const dotGap = 3 + ((h >> 6) % 2)
  const ink = dead ? 'rgba(22,19,15,0.32)' : '#16130f'
  const patternId = `ht-${h % 100000}`

  return `<svg class="portrait" viewBox="0 0 64 64" role="img" aria-hidden="true">
  <defs>
    <pattern id="${patternId}" width="${dotGap}" height="${dotGap}" patternUnits="userSpaceOnUse">
      <circle cx="${dotGap / 2}" cy="${dotGap / 2}" r="0.85" fill="${ink}" />
    </pattern>
  </defs>
  ${
    // 방 안(어두운 배경)에서는 하프톤 배경이 회색 판처럼 보인다 — 그때는 생략한다.
    flat ? '' : `<rect width="64" height="64" fill="url(#${patternId})" opacity="${dead ? 0.25 : 0.5}" />`
  }
  <g fill="${ink}">
    <ellipse cx="32" cy="38" rx="12" ry="14" />
    ${hat}
    <path d="${shoulder}" />
  </g>
  <g fill="var(--paper-2)">
    <ellipse cx="27" cy="37" rx="2.1" ry="2.6" />
    <ellipse cx="37" cy="37" rx="2.1" ry="2.6" />
  </g>
</svg>`
}

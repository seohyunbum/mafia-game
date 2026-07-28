/**
 * vite 빌드 결과를 파일 하나로 합친다.
 *
 * 링크로 공유하려면 외부 파일 참조가 없어야 한다. 로직을 따로 옮겨 적지 않고
 * **빌드된 코어를 그대로** 인라인하므로, 화면과 규칙이 어긋날 일이 없다.
 */

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const DIST = 'dist'
const ASSETS = join(DIST, 'assets')

const files = readdirSync(ASSETS)
const jsName = files.find((f) => f.endsWith('.js'))
const cssName = files.find((f) => f.endsWith('.css'))
if (!jsName) throw new Error('dist/assets 에 js 가 없다')

const js = readFileSync(join(ASSETS, jsName), 'utf8')
const css = cssName ? readFileSync(join(ASSETS, cssName), 'utf8') : ''

let html = readFileSync(join(DIST, 'index.html'), 'utf8')

// 외부 참조를 인라인으로 치환
html = html.replace(/<script[^>]*src="[^"]*"[^>]*><\/script>/g, '')
html = html.replace(/<link[^>]*rel="stylesheet"[^>]*>/g, '')
html = html.replace('</head>', `<style>\n${css}\n</style>\n</head>`)
html = html.replace('</body>', `<script type="module">\n${js}\n</script>\n</body>`)

const out = join(DIST, 'single.html')
writeFileSync(out, html, 'utf8')

/*
 * 공유용 조각 — 호스팅 쪽이 <!doctype>/<head>/<body> 를 씌워주므로
 * 문서 골격 없이 title·style·본문·script 만 담는다.
 */
const fragment = `<title>밤의 심판 — 마피아 사회자 진행판</title>
<style>
${css}
</style>
<div id="app"></div>
<script type="module">
${js}
</script>
`
const fragmentPath = join(DIST, 'artifact.html')
writeFileSync(fragmentPath, fragment, 'utf8')

const kb = (n) => (n / 1024).toFixed(0)
console.log(`${out} — ${kb(html.length)} KB (외부 참조 0)`)
console.log(`${fragmentPath} — ${kb(fragment.length)} KB (공유용)`)

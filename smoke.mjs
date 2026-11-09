/**
 * dsh-highlight-plugin 自检
 *
 * 两半都测：
 *   host 半 —— 起真端点（临时端口 3212）+ 临时存储根：新增（host 发 id）/ 列表 / 删除 /
 *              非法会话 id 400 / 坏颜色 400 / 超长正文 400 / 未知端点 404 / OPTIONS 预检 /
 *              删不存在的 id 幂等 removed:false / 存盘文件真的落了盘；
 *   client 半 —— 纯逻辑：规范化（空白折叠/零宽字符/小写）、归一化索引的双向映射、
 *              锚定（唯一命中 / 前后文消歧 / 歧义不画 / 找不到不画）、引文提取、
 *              pill 真值表、矩形合并、点击命中、会话 id 形状校验。
 *
 * 跑法：node smoke.mjs
 */

import { readFileSync, mkdtempSync, rmSync, existsSync, readFileSync as rf } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))

const problems = []
const ok = (cond, msg) => {
	if (!cond) problems.push(msg)
}
const eq = (a, b, msg) => {
	if (a !== b) problems.push(`${msg}（期望 ${JSON.stringify(b)}，实际 ${JSON.stringify(a)}）`)
}

/* ================================================================ client 半：载入（假 ModuleLoader） */

let clientFactory = null
globalThis.window = {
	__ModuleLoader__: {
		load({ factory }) {
			clientFactory = factory
		},
	},
}
// client.js 顶层只调 window.__ModuleLoader__.load，工厂体在 Node 里也能安全展开
eval(readFileSync(join(here, 'lib', 'client.js'), 'utf8'))
ok(typeof clientFactory === 'function', 'client.js 的工厂没有被 ModuleLoader 捕获')
const client = clientFactory ? clientFactory(() => undefined) : {}
const {
	normalize,
	buildNormIndex,
	findAnchor,
	normToRaw,
	offsetToNodeOffset,
	rawOffsetOf,
	extractQuote,
	shouldOfferHighlight,
	endpointsMarkable,
	mergeRects,
	hitTestRects,
	hitTestAll,
	sameQuote,
	planReplacement,
	resolveTextPoint,
	findUniqueNorm,
	validSid,
} = client

/* ---- 规范化 ---- */
eq(normalize('Hello   World'), 'hello world', '规范化：空白折叠+小写')
eq(normalize('a \u200b b\u200dc \u202Fd'), 'a bc d', '规范化：零宽字符去掉（两侧字拼回）、窄空格折叠')
eq(normalize('  首 尾  '), '首 尾', '规范化：首尾空白丢弃')
eq(normalize(''), '', '规范化：空串安全')

/* ---- 归一化索引：norm ↔ raw 双向 ---- */
const raw1 = 'Hello  \n World\u200b，你好'
const ni1 = buildNormIndex(raw1)
eq(ni1.norm, 'hello world，你好', '索引：归一化全文')
// norm[0]='h' ← raw[0]；norm[6]='w' ← raw[9]（两个空格+换行+一个空格折叠掉）
eq(normToRaw(ni1, 0), 0, '索引：首位映射')
eq(normToRaw(ni1, 6), 9, '索引：折叠空白后的映射')
eq(normToRaw(ni1, ni1.norm.length), raw1.length, '索引：末尾哨兵=raw 长度')

/* ---- 锚定 ---- */
const doc1 =
	'DSH 的会话界面可以划重点。DSH 的会话界面可以归档。重复句子出现两次时要靠上下文消歧。'
const n1 = buildNormIndex(doc1)
// 唯一句子：裸匹配就够
const q1 = extractQuote(doc1, doc1.indexOf('归档'), doc1.indexOf('归档') + 2)
const a1 = findAnchor(n1, q1)
ok(a1, '锚定：唯一短语裸命中')
eq(doc1.slice(normToRaw(n1, a1.start), normToRaw(n1, a1.end)).replace(/\s+/g, ' ').toLowerCase(), '归档', '锚定：落回原文正是那句')
// 重复句子：裸匹配歧义 → 必须靠 prefix/suffix 救
const rep = 'DSH 的会话界面'
const sA = doc1.indexOf(rep)
const sB = doc1.indexOf(rep, sA + 1)
ok(sB > sA, '测试数据：重复句确实出现两次')
const qAmb = extractQuote(doc1, sA, sA + rep.length)
const qCtx = extractQuote(doc1, sB, sB + rep.length)
ok(findAnchor(n1, { text: rep.toLowerCase(), prefix: '', suffix: '' }) === null, '锚定：裸匹配歧义 → 拒画（fail-closed）')
ok(findAnchor(n1, qAmb) !== null, '锚定：第一处靠自带上下文认回')
const aCtx = findAnchor(n1, qCtx)
ok(aCtx !== null, '锚定：第二处靠自带上下文认回')
if (aCtx) {
	const rawStart = normToRaw(n1, aCtx.start)
	ok(Math.abs(rawStart - sB) <= 1, `锚定：第二处落在正确位置（raw ${rawStart} vs ${sB}）`)
}
// 找不到
eq(findAnchor(n1, { text: '根本不存在的话', prefix: '', suffix: '' }), null, '锚定：找不到 → null')

/* ---- 空白折叠后仍能锚定（重渲染把一段拆成多个节点是常态） ---- */
const raw2 = '第一段。\n\n  第二段（中间隔了空行）'
const n2 = buildNormIndex(raw2)
const q2 = { text: '第一段。 第二段（中间隔了空行）', prefix: '', suffix: '' }
const a2 = findAnchor(n2, q2)
ok(a2 !== null, '锚定：跨空白段落合并后仍能找回')
if (a2) {
	const back = raw2.slice(normToRaw(n2, a2.start), normToRaw(n2, a2.end))
	eq(back.replace(/\s+/g, ''), '第一段。第二段（中间隔了空行）'.replace(/\s+/g, ''), '锚定：找回的原文内容一致')
}

/* ---- 引文提取 ---- */
const long = '前'.repeat(200) + '目标句' + '后'.repeat(200)
const q3 = extractQuote(long, 200, 203)
eq(q3.text, '目标句', '引文：正文原样')
ok(q3.prefix.length > 0 && q3.prefix.length <= 160, `引文：prefix 封顶 160（实际 ${q3.prefix.length}）`)
ok(q3.suffix.length > 0 && q3.suffix.length <= 160, `引文：suffix 封顶 160（实际 ${q3.suffix.length}）`)
eq(extractQuote('   ', 0, 3), null, '引文：纯空白 → null（不可标）')

/* ---- (节点,偏移) ↔ raw 全文坐标 ---- */
// 假节点要带 length（真 Text 节点有 nodeValue.length，offsetToNodeOffset 用它封顶）
const fakeA = { fake: 'a', length: 5 }
const fakeB = { fake: 'b', length: 5 }
const segs = [
	{ node: fakeA, start: 0, end: 5 },
	{ node: fakeB, start: 5, end: 10 },
]
eq(rawOffsetOf(segs, fakeA, 2), 2, '坐标：节点内偏移 → 全文')
eq(rawOffsetOf(segs, fakeB, 3), 8, '坐标：第二个节点 → 全文')
eq(rawOffsetOf(segs, { fake: '不在图里' }, 1), -1, '坐标：图外节点 → -1（不可标）')
eq(offsetToNodeOffset(segs, 3).node, fakeA, '坐标：全文 → 节点 A')
eq(offsetToNodeOffset(segs, 3).offset, 3, '坐标：全文 → 节点内偏移')
eq(offsetToNodeOffset(segs, 7).node, fakeB, '坐标：全文 → 节点 B')
const edge = offsetToNodeOffset(segs, 5) // 恰好在 A 末尾/B 开头
ok(edge && (edge.node === fakeA || edge.node === fakeB), '坐标：边界值落在某个节点上')
ok(offsetToNodeOffset(segs, 10) !== null, '坐标：全文末尾不炸')

/* ---- pill 真值表 ---- */
const base = {
	collapsed: false,
	hasRange: true,
	inOwnUi: false,
	inEditable: false,
	endpointsInText: true,
	text: '正常句子',
	textLen: 4,
}
eq(shouldOfferHighlight(base), true, 'pill：正常选区 → 浮')
eq(shouldOfferHighlight({ ...base, collapsed: true }), false, 'pill：选区塌陷 → 不浮')
eq(shouldOfferHighlight({ ...base, inOwnUi: true }), false, 'pill：在自己 UI 里松手 → 不浮')
eq(shouldOfferHighlight({ ...base, inEditable: true }), false, 'pill：composer/输入框里 → 不浮')
eq(shouldOfferHighlight({ ...base, endpointsInText: false }), false, 'pill：端点不在文本里 → 不浮')
eq(shouldOfferHighlight({ ...base, text: '' }), false, 'pill：空选区 → 不浮')
eq(shouldOfferHighlight({ ...base, textLen: 2001 }), false, 'pill：超 2000 字 → 不浮')
eq(shouldOfferHighlight({ ...base, hasRange: false }), false, 'pill：没有 range → 不浮')

/* ---- 端点判据 ---- */
const mkEl = (hit) => ({ closest: () => hit })
eq(endpointsMarkable(mkEl(null), mkEl(null)), true, '端点：普通元素 → 可标')
eq(endpointsMarkable(mkEl('[contenteditable="true"]'), mkEl(null)), false, '端点：起点在 composer → 不可标')
eq(endpointsMarkable(mkEl(null), mkEl('[data-dsh-hl-ui]')), false, '端点：终点在自己 UI → 不可标')
eq(endpointsMarkable(null, mkEl(null)), false, '端点：拿不到元素 → 不可标（fail-closed）')

/* ---- 矩形合并 + 命中 ---- */
const rects = [
	{ left: 10, top: 10, width: 50, height: 16 },
	{ left: 64, top: 10, width: 30, height: 16 }, // 同一行相邻 → 并
	{ left: 10, top: 40, width: 80, height: 16 }, // 下一行 → 留
]
const merged = mergeRects(rects)
eq(merged.length, 2, '合并：三矩形 → 两块')
eq(merged[0].width, 84, '合并：同行相邻并成一块')
const byId = new Map([['hl-1', merged]])
eq(hitTestRects(20, 12, byId), 'hl-1', '命中：块内点中')
eq(hitTestRects(400, 300, byId), '', '命中：块外不中')

/* ---- 叠层：命中全部 + 替换语义（2026-11-09 "叠色删不完"修复） ---- */
const stacked = new Map([
	['hl-a', [{ left: 10, top: 10, width: 50, height: 16 }]],
	['hl-b', [{ left: 12, top: 12, width: 50, height: 16 }]], // 与 hl-a 重叠
	['hl-c', [{ left: 300, top: 40, width: 50, height: 16 }]], // 不重叠
])
eq(hitTestRects(20, 12, stacked), 'hl-a', '叠层：旧接口仍回最先命中')
const allHits = hitTestAll(20, 12, stacked)
eq(allHits.length, 2, '叠层：一点命中两条')
ok(allHits.includes('hl-a') && allHits.includes('hl-b'), '叠层：两条都是点中的那两条（不含无关的 hl-c）')
eq(hitTestAll(20, 32, stacked).length, 0, '叠层：块间空隙不命中')

const quoteQ = { text: '同一句话', prefix: '前', suffix: '后' }
const ledger = [
	{ id: 'hl-1', text: '同一句话', prefix: '前', suffix: '后', color: 'yellow' },
	{ id: 'hl-2', text: '别的句子', prefix: '', suffix: '', color: 'blue' },
]
eq(planReplacement(ledger, quoteQ, 'yellow').skip, true, '替换：同句同色 → 无事可做（不叠层）')
let plan = planReplacement(ledger, quoteQ, 'green')
eq(plan.removeIds.join(','), 'hl-1', '替换：同句换色 → 撤旧换新')
eq(plan.skip, false, '替换：同句换色 → 不跳过')
const stackedLedger = [
	{ id: 'hl-1', text: '同一句话', prefix: '前', suffix: '后', color: 'yellow' },
	{ id: 'hl-2', text: '同一句话', prefix: '前', suffix: '后', color: 'blue' },
	{ id: 'hl-3', text: '别的句子', prefix: '', suffix: '', color: 'green' },
]
plan = planReplacement(stackedLedger, quoteQ, 'yellow')
eq(plan.removeIds.join(','), 'hl-1,hl-2', '替换：历史叠层一次清掉（换色即替换）')
eq(planReplacement([], quoteQ, 'yellow').removeIds.length, 0, '替换：无旧标 → 正常新增')
eq(sameQuote(quoteQ, { text: '同一句话', prefix: '前', suffix: '后' }), true, 'sameQuote：全等 → true')
eq(sameQuote(quoteQ, { text: '同一句话', prefix: '', suffix: '后' }), false, 'sameQuote：上下文不同 → false')

/* ---- 会话 id 形状 ---- */
eq(validSid('session-032a5b9c-1234-4567-89ab-cdef01234567'), true, 'sid：合法形态')
eq(validSid('session-'), false, 'sid：空壳拒绝')
eq(validSid(''), false, 'sid：空串拒绝')
eq(validSid('../../etc/passwd'), false, 'sid：路径穿越拒绝')
eq(validSid('session-ABC-<script>'), false, 'sid：带杂字符拒绝')

/* ---- 元素容器端点解析（2026-11-09 "加粗黑体字标色上不去"修复，微型假 DOM） ---- */
// 结构：<parent><p>前缀<strong>加粗</strong>后缀</p>"\n"<h>标题</h></parent>
// **加粗** 在段首/标题行起拖时，Range 端点是（元素, 子索引）而不是文本节点——查不到就整个标色放弃。
const hlText = (value, parent) => {
	const n = { nodeType: 3, nodeValue: value, length: value.length, parentNode: parent, previousSibling: null, nextSibling: null }
	return n
}
const hlEl = (childNodes, parent) => {
	const el = { nodeType: 1, childNodes, parentNode: parent, previousSibling: null, nextSibling: null, ownerDocument: null }
	for (const c of childNodes) {
		c.parentNode = el
		el.ownerDocument = c.ownerDocument || el.ownerDocument || fakeDoc // 真浏览器里元素必有 ownerDocument
	}
	// 兄弟链 + ownerDocument（假 TreeWalker）
	for (let i = 0; i < childNodes.length; i++) {
		childNodes[i].previousSibling = childNodes[i - 1] || null
		childNodes[i].nextSibling = childNodes[i + 1] || null
	}
	return el
}
const fakeDoc = {
	createTreeWalker(root) {
		const texts = []
		const walk = (n) => {
			for (const c of n.childNodes || []) {
				if (c.nodeType === 3) texts.push(c)
				else walk(c)
			}
		}
		walk(root)
		let i = 0
		return { nextNode: () => (i < texts.length ? texts[i++] : null) }
	},
}
const t1 = hlText('前缀')
const t2 = hlText('加粗')
const t3 = hlText('后缀')
const t4 = hlText('标题')
const strongEl = hlEl([t2])
const pEl = hlEl([t1, strongEl, t3])
const hEl = hlEl([t4])
t4.ownerDocument = fakeDoc
t2.ownerDocument = fakeDoc
const ws = hlText('\n  ', null)
const parentEl = hlEl([pEl, ws, hEl])
pEl.ownerDocument = fakeDoc
hEl.ownerDocument = fakeDoc
// 段落结构：前缀(<p>[0]) 加粗(<p>[1]) 后缀(<p>[2]) → 全文"前缀加粗后缀标题"（ws 收成空格不计段）
const segsFake = [
	{ node: t1, start: 0, end: 2 },
	{ node: t2, start: 2, end: 4 },
	{ node: t3, start: 4, end: 6 },
	{ node: t4, start: 6, end: 8 },
]
eq(resolveTextPoint(t2, 1, segsFake, false), 3, '端点：文本节点直查（加粗内偏移1）')
eq(resolveTextPoint(strongEl, 0, segsFake, false), 2, '端点：<strong> 元素容器 → 里面的文本开头')
eq(resolveTextPoint(strongEl, 1, segsFake, true), 4, '端点：<strong> 元素容器终点 → 文本末尾')
eq(resolveTextPoint(pEl, 1, segsFake, false), 2, '端点：段首起拖（<p> 子索引1=strong 前沿）→ 加粗开头')
eq(resolveTextPoint(pEl, 1, segsFake, true), 2, '端点：终点在 strong 前沿 → 前缀末尾')
eq(resolveTextPoint(hEl, 0, segsFake, true), 6, '端点：标题行开头（offset=0）→ 跨空白兄弟回退到上一段末尾')
eq(resolveTextPoint(strongEl, 0, segsFake, true), 2, '端点：元素开头终点 → 前兄弟（前缀）末尾')
eq(resolveTextPoint(hEl, 5, segsFake, false), -1, '端点：元素末尾之后又无后兄弟 → -1（fail-closed）')
eq(resolveTextPoint(null, 0, segsFake, false), -1, '端点：空节点 → -1')

/* ---- 空白文本节点端点（2026-11-09 截图复现"从雅前框选着色不上去"）----
 * `**2026-120** **雅江隧道…**` 两个 strong 之间的空格是纯空白文本节点（不在 segments 里），
 * Chromium 把"雅"前的光标规范化成（该空白节点, 末尾）→ 旧版查表 -1 直接放弃。 */
const t5 = hlText('编号')
const t6 = hlText('雅江')
const strongA = hlEl([t5])
const strongB = hlEl([t6])
strongA.ownerDocument = fakeDoc
strongB.ownerDocument = fakeDoc
const ws2 = hlText(' ', null)
const rowEl = hlEl([strongA, ws2, strongB])
rowEl.ownerDocument = fakeDoc
const segsRow = [
	{ node: t5, start: 0, end: 2 },
	{ node: t6, start: 2, end: 4 },
]
eq(resolveTextPoint(ws2, 1, segsRow, false), 2, '空白端点：起点=空白节点 → 后兄弟（雅江）开头')
eq(resolveTextPoint(ws2, 1, segsRow, true), 2, '空白端点：终点=空白节点 → 前兄弟（编号）末尾')
eq(resolveTextPoint(ws2, 0, segsRow, false), 2, '空白端点：偏移0同样解析')
const sJ = resolveTextPoint(ws2, 1, segsRow, false)
const eB = resolveTextPoint(t6, 2, segsRow, true)
ok(sJ >= 0 && eB > sJ, '空白端点：从雅前框选到加粗内 → 起终点成对成立')

/* ---- 兜底定位（v1.2.2）：端点解析不出时拿选区字符串找唯一命中 ---- */
const nF = buildNormIndex('甲乙丙丁重复句子重复句子尾巴')
eq(findUniqueNorm(nF, '唯一'), null, '兜底：不存在的文字 → null')
const tail = findUniqueNorm(nF, '尾巴')
ok(tail && tail.start === 12 && tail.end === 14, '兜底：唯一命中给坐标')
eq(findUniqueNorm(nF, '重复句子'), null, '兜底：多处命中 → null（fail-closed 不乱标）')
const oneHit = findUniqueNorm(nF, '甲乙丙')
ok(oneHit && oneHit.start === 0 && oneHit.end === 3, '兜底：开头唯一命中')

/* ---- 锚定分级匹配（v1.2.7）：前缀段被折叠/剪掉时靠后缀救 ---- */
const docG = '系统报错 proxy failure: tls se 常石船厂后续商务对接 — 今天 2026-138 浮盘限位杆 后续内容'
const nG = buildNormIndex(docG)
const quoteG = {
	text: normalize('常石船厂后续商务对接'),
	prefix: normalize('roxy failure: tls se'),
	suffix: normalize('— 今天 2026-138 浮盘限位杆'),
}
const aFull = findAnchor(nG, quoteG)
ok(aFull !== null, '分级①：整段上下文命中')
// 前缀所在内容被剪掉（模拟折叠）：全文里没有 "roxy failure" 了
const docG2 = '常石船厂后续商务对接 — 今天 2026-138 浮盘限位杆 后续内容 别处也提常石船厂后续商务对接一次'
const nG2 = buildNormIndex(docG2)
const aSuf = findAnchor(nG2, quoteG)
ok(aSuf !== null, '分级②：前缀断了 → 正文+后缀唯一命中')
if (aSuf) {
	const back = docG2.slice(normToRaw(nG2, aSuf.start), normToRaw(nG2, aSuf.end))
	eq(back, '常石船厂后续商务对接', '分级②：落点正确（不是后一次出现的同名句）')
}
// 后缀也断了 → 前缀+正文救
const docG3 = '系统报错 proxy failure: tls se 常石船厂后续商务对接（已改期）'
const nG3 = buildNormIndex(docG3)
const aPre = findAnchor(nG3, quoteG)
ok(aPre !== null, '分级③：后缀断了 → 前缀+正文唯一命中')
// 前后缀全断且裸正文多处出现 → 拒画
const docG4 = '常石船厂后续商务对接 甲 常石船厂后续商务对接'
const nG4 = buildNormIndex(docG4)
eq(findAnchor(nG4, quoteG), null, '分级④：全断且多处 → null（fail-closed）')

/* ================================================================ host 半 */

const PORT = 3212
process.env.DSH_HIGHLIGHT_PORT = String(PORT)
const { createHandler, addHighlight, listHighlights, removeHighlight, encodeSegment, sanitizeHighlightInput } =
	await import(pathToFileURL(join(here, 'index.js')).href)

const root = mkdtempSync(join(tmpdir(), 'dsh-hl-'))
const sidA = 'session-aaaa1111-2222-3333-4444-555566667777'
const sidB = 'session-bbbb1111-2222-3333-4444-555566667777'

/* ---- 直接调用存储函数 ---- */
const rec1 = await addHighlight(root, sidA, { text: '重点一句', prefix: '前面的话', suffix: '后面的话', color: 'yellow' })
ok(rec1.id && rec1.id.startsWith('hl-'), 'host：新增记录由 host 发 id')
ok(typeof rec1.createdAt === 'number', 'host：createdAt 由 host 发')
eq((await listHighlights(root, sidA)).length, 1, 'host：列表 1 条')
const rec2 = await addHighlight(root, sidA, { text: '另一句', prefix: '', suffix: '', color: 'blue' })
eq((await listHighlights(root, sidA)).length, 2, 'host：再增 1 条')
// 会话隔离
eq((await listHighlights(root, sidB)).length, 0, 'host：另一会话 0 条（按会话分文件）')
const rm1 = await removeHighlight(root, sidA, rec1.id)
eq(rm1.removed, true, 'host：删除成功')
const rmAgain = await removeHighlight(root, sidA, rec1.id)
eq(rmAgain.removed, false, 'host：重复删除幂等 removed:false')
eq((await listHighlights(root, sidA)).length, 1, 'host：删后剩 1 条')
// 文件真的落了盘
const seg = encodeSegment(sidA)
ok(existsSync(join(root, seg + '.json')), 'host：会话文件按 encodeSegment 落盘')
const onDisk = JSON.parse(rf(join(root, seg + '.json'), 'utf8'))
eq(onDisk.highlights.length, 1, 'host：盘上就是剩下的那条')
eq(encodeSegment('a/b:c\\d'), 'a~002Fb~003Ac~005Cd', 'host：encodeSegment 转义路径分隔符')

/* ---- 清洗 ---- */
eq(sanitizeHighlightInput({ text: ' x ', color: undefined }).color, 'yellow', '清洗：颜色缺省 yellow')
eq(sanitizeHighlightInput({ text: ' x ' }).text, ' x ', '清洗：文本原样保留（空白由 client 半规范化）')
let threw = ''
try {
	sanitizeHighlightInput({ text: '', color: 'yellow' })
} catch (e) {
	threw = String(e.message)
}
ok(threw.includes('text'), '清洗：空文本抛错')
threw = ''
try {
	sanitizeHighlightInput({ text: 'x', color: 'purple' })
} catch (e) {
	threw = String(e.message)
}
ok(threw.includes('颜色'), '清洗：坏颜色抛错')
threw = ''
try {
	sanitizeHighlightInput({ text: 'x'.repeat(2001) })
} catch (e) {
	threw = String(e.message)
}
ok(threw.includes('超长'), '清洗：超长文本抛错')

/* ---- 真端点 ---- */
const handler = createHandler({ effect: () => () => {} }, root)
const { createServer } = await import('node:http')
const server = createServer((req, res) => handler(req, res).catch(() => {}))
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const realPort = server.address().port
const ep = `http://127.0.0.1:${realPort}`

const j = async (path, opts) => {
	const res = await fetch(ep + path, opts)
	return { status: res.status, body: await res.json().catch(() => null) }
}

// 新增 → 回执带正式 id
const addRes = await j('/highlights', {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ sessionId: sidA, highlight: { text: '端点新增', prefix: '', suffix: '', color: 'green' } }),
})
eq(addRes.status, 200, '端点：新增 200')
ok(addRes.body && addRes.body.ok === true && addRes.body.record && addRes.body.record.id, '端点：回执带正式记录')

// 列表
const listRes = await j(`/highlights?sessionId=${encodeURIComponent(sidA)}`)
eq(listRes.status, 200, '端点：列表 200')
eq(listRes.body.highlights.length, 2, '端点：列表含直调+端点两条')

// 客户端给的 id 被丢弃
const addRes2 = await j('/highlights', {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({
		sessionId: sidA,
		highlight: { id: 'client-fake', text: '带假id', prefix: '', suffix: '', color: 'blue' },
	}),
})
ok(addRes2.body.record.id !== 'client-fake', '端点：客户端 id 被丢弃，host 发 id')

// 删除
const delRes = await j('/highlights/delete', {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ sessionId: sidA, id: addRes.body.record.id }),
})
eq(delRes.status, 200, '端点：删除 200')
eq(delRes.body.removed, true, '端点：删除 removed:true')
const delAgain = await j('/highlights/delete', {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ sessionId: sidA, id: addRes.body.record.id }),
})
eq(delAgain.body.removed, false, '端点：再删幂等 removed:false')

// 非法输入
eq((await j(`/highlights?sessionId=not-a-session`)).status, 400, '端点：GET 非法 sid 400')
const badColorRes = await j('/highlights', {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ sessionId: sidA, highlight: { text: 'x', color: 'pink' } }),
})
eq(badColorRes.status, 400, '端点：坏颜色 400（单独钉）')
const badSidRes = await j('/highlights', {
	method: 'POST',
	headers: { 'content-type': 'application/json' },
	body: JSON.stringify({ sessionId: '../../evil', highlight: { text: 'x' } }),
})
eq(badSidRes.status, 400, '端点：路径穿越 sid 400')

// 未知端点 / 预检
eq((await j('/nope')).status, 404, '端点：未知 404')
const optRes = await fetch(ep + '/highlights', { method: 'OPTIONS' })
eq(optRes.status, 204, '端点：OPTIONS 204')
ok(optRes.headers.get('access-control-allow-origin') !== null, '端点：CORS 头在')

server.close()
rmSync(root, { recursive: true, force: true })

/* ================================================================ 结果 */

if (problems.length) {
	console.error(`\n✗ 自检 ${problems.length} 项不过：`)
	for (const p of problems) console.error('  - ' + p)
	process.exit(1)
} else {
	console.log('\n✓ 自检全过（client 纯逻辑 + host 真端点 + 存盘落盘）')
}

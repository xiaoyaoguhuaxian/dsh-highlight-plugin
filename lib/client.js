/**
 * dsh-highlight-plugin —— client 半（Lazy-CJS bundle，不需要构建工具链）
 *
 * 大少爷 2026-11-09：「在与大模型的问答过程中，我可以在会话界面上选中任意需要留意的语句，
 * 将其鼠标划线以高亮标色块的方式标记为重点；每个标色块可单独手动删除，未手动删除的高亮
 * 标记将一直保留在会话中，直到我主动删除为止。」
 *
 * ## 为什么色块是"覆盖层"而不是往消息 DOM 里包 <mark>
 *
 * 会话正文是框架 React 管的 DOM：往里面插 <mark>，框架下一次重渲染（流式输出、
 * 换会话回来、任何 state 变化）就会把它冲掉，而且会污染 React 的 reconcile。
 * 所以走 Hypothesis / 网页划词批注那一套成熟路线：
 *   文本锚定（quote + 前后文）→ 在现 DOM 里重新定位出 Range → getClientRects()
 *   → 在一层 position:fixed 的覆盖 div（pointer-events:none）里画色块。
 * **框架 DOM 一个字节都不改**，色块被冲掉大不了重新锚定重画。
 *
 * ## 锚定怎么做到"重渲染/刷新后还能找回那句"
 *
 * 存的不是坐标（坐标随布局变），是**引文**：{ text, prefix, suffix }（正文 + 前 160 字 + 后 160 字，
 * 全部做过空白折叠/零宽字符清理/小写化的规范化）。重画时：
 *   ① 收集正文区全部文本节点拼成全文 + 归一化索引（norm ↔ raw 双向映射）；
 *   ② 先拿 `prefix+text+suffix` 整段匹配（解决一句出现多次的歧义）；
 *   ③ 退而求其次拿 `text` 裸匹配——**只有唯一命中才画**；多处命中又没上下文可分辨时
 *      宁可不画（fail-closed，画错地方比不画糟糕得多），等下次重锚。
 *
 * ## 交互
 *
 * - 选中（鼠标松手）→ 浮出取色 pill（黄/绿/蓝三颗色球）→ 点色球成标。
 * - 点已有色块 → 弹"删除这条重点标记？"小确认框 → 删除（POST 失败则保留并明说）。
 * - 标记按会话 id 存取（host 半 3205 端点）；换会话自动加载那一份；跨重启也在。
 * - Esc / 点空白收起 pill；滚动时 pill 收起、色块跟随。
 *
 * ## 排障
 *
 * `window.__DSH_HIGHLIGHT_DEBUG__`：ready / sid / active / anchored / orphan / created /
 * deleted / lastError —— 每一项都是做完读回来的结果，不是"我以为"。
 */

window.__ModuleLoader__.load({
	id: 'dsh-highlight-plugin',
	factory: () => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		/** 用到的框架服务名：会话控制器（当前会话 id 的兜底来源）。 */
		const inject = ['sessions']

		/** host 半那个只监听回环的小 HTTP 服务（端口与 index.js 的默认值一致）。 */
		const ENDPOINT = 'http://127.0.0.1:3205'
		const MAX_TEXT = 2000
		const CTX_CHARS = 160
		const COLORS = {
			yellow: 'rgba(255, 196, 0, .42)',
			green: 'rgba(64, 200, 90, .35)',
			blue: 'rgba(64, 140, 255, .32)',
		}
		/** 我们自己的 UI 与覆盖层的标记属性（收集文本 / 命中判断都要跳过自己）。 */
		const UI_ATTR = 'data-dsh-hl-ui'
		const OVERLAY_ATTR = 'data-dsh-hl-overlay'
		/** 会话 id 形态（host 端点只收这种，client 先把好第一道关）。 */
		const SESSION_ID_RE = /^session-[0-9a-fA-F-]{8,64}$/

		/* ================================================================ 纯函数（自检直接喂） */

		function isZeroWidth(ch) {
			return ch === '\u200b' || ch === '\u200c' || ch === '\u200d' || ch === '\ufeff'
		}

		/** 规范化：去零宽字符、空白折叠、小写。存储的引文与匹配时的全文都过同一把刀。 */
		function normalize(s) {
			let out = ''
			let lastWasSpace = false
			const raw = String(s || '')
			for (let i = 0; i < raw.length; i++) {
				const ch = raw[i]
				if (isZeroWidth(ch)) continue
				if (/\s/.test(ch)) {
					if (!lastWasSpace && out.length > 0) {
						out += ' '
						lastWasSpace = true
					}
					continue
				}
				out += ch.toLowerCase()
				lastWasSpace = false
			}
			// 去掉收尾可能残留的单个空格（lastWasSpace 挂在末尾时）
			return out.endsWith(' ') ? out.slice(0, -1) : out
		}

		/**
		 * 归一化索引：norm[i] 对应 raw 里的 map[i]。
		 * raw 里的空白被折叠/丢弃，所以 norm 比 raw 短；匹配在 norm 上做，落回 raw 再找节点。
		 */
		function buildNormIndex(raw) {
			const chars = []
			const map = []
			let lastWasSpace = true // 行首空白丢弃
			for (let i = 0; i < raw.length; i++) {
				const ch = raw[i]
				if (isZeroWidth(ch)) continue
				if (/\s/.test(ch)) {
					if (!lastWasSpace) {
						chars.push(' ')
						map.push(i)
						lastWasSpace = true
					}
					continue
				}
				chars.push(ch.toLowerCase())
				map.push(i)
				lastWasSpace = false
			}
			return { norm: chars.join(''), map, rawLen: raw.length }
		}

		/** 压缩比较用：规范化后再去掉全部空白。引文与正文边界处的空白（折叠/剪掉/重排）
		 *  会导致严格拼接匹配失败，比较上下文时一律用压缩形态。 */
		function compact(s) {
			return normalize(s).replace(/ /g, '')
		}

		/**
		 * 在归一化全文里找引文的位置（norm 坐标）。**分级匹配**（2026-11-09 改）：
		 * 先收集正文的所有出现位置，再逐个用**压缩形态**校验前后上下文（正文与上下文
		 * 之间的空白多少不限——normalize 会剪引文首尾空白，严格拼接永远对不上）：
		 * ① 前缀与后缀都对得上 → 取首个命中——上下文够长，首中几乎必对；
		 * ② 只有后缀、且唯一命中——**前缀所在内容被折叠/重渲染剪掉**（跨消息边界的
		 *    引文常态）时靠后缀救；
		 * ③ 只有前缀、且唯一命中——对称的另一半；
		 * ④ 裸正文唯一命中。
		 * ②③④都要求唯一（多处命中宁可不画，fail-closed），全失败才回 null。
		 * @returns `{ start, end }`（norm 坐标，end 排他）或 `null`。
		 */
		function findAnchor(normInfo, quote) {
			const norm = normInfo && normInfo.norm
			const text = normalize(String((quote && quote.text) || ''))
			if (!norm || !text) return null
			const preC = compact(String((quote && quote.prefix) || ''))
			const sufC = compact(String((quote && quote.suffix) || ''))
			const occs = []
			for (let from = 0; ; ) {
				const at = norm.indexOf(text, from)
				if (at < 0) break
				occs.push(at)
				from = at + 1
			}
			if (!occs.length) return null
			// 压缩后长度 ≤ 原文长，且 norm 里空白总在非空白之后：窗口取 2 倍 + 2 必够
			const preOk = (i) =>
				!preC || compact(norm.slice(Math.max(0, i - preC.length * 2 - 2), i)).endsWith(preC)
			const sufOk = (i) =>
				!sufC || compact(norm.slice(i + text.length, i + text.length + sufC.length * 2 + 2)).startsWith(sufC)
			// ① 只在确有上下文时启用；无上下文时裸歧义必须拒画（fail-closed 不变）
			let at = -1
			if (preC || sufC) at = occs.find((i) => preOk(i) && sufOk(i))
			if (at !== undefined && at >= 0) return { start: at, end: at + text.length }
			if (sufC) {
				const cands = occs.filter(sufOk)
				if (cands.length === 1) return { start: cands[0], end: cands[0] + text.length }
			}
			if (preC) {
				const cands = occs.filter(preOk)
				if (cands.length === 1) return { start: cands[0], end: cands[0] + text.length }
			}
			if (occs.length === 1) return { start: occs[0], end: occs[0] + text.length }
			return null
		}

		/** norm 坐标 → raw 坐标（map 末尾补了 rawLen 哨兵）。 */
		function normToRaw(normInfo, off) {
			const map = normInfo.map
			if (off >= map.length) return normInfo.rawLen
			return map[off]
		}

		/**
		 * raw 全文坐标 → (节点, 节点内偏移)。segments 是 collectTextMap 拼全文时记下的
		 * 每个文本节点占的 [start, end) 区间。
		 */
		function offsetToNodeOffset(segments, rawOff) {
			for (const seg of segments) {
				if (rawOff >= seg.start && rawOff <= seg.end) {
					return { node: seg.node, offset: Math.min(rawOff - seg.start, seg.node.length) }
				}
			}
			const last = segments[segments.length - 1]
			if (!last) return null
			return { node: last.node, offset: last.node.length }
		}

		/**
		 * 在归一化全文里找一段文字的**唯一**出现（纯函数，自检钉死）。
		 * 兜底定位用：端点解析不出时，拿"选区字符串"来认位置——多处命中不认（fail-closed，
		 * 画错地方比不画糟糕），唯一命中才给坐标。
		 */
		function findUniqueNorm(normInfo, needle) {
			const norm = normInfo && normInfo.norm
			const text = String(needle || '')
			if (!norm || !text) return null
			let from = 0
			let count = 0
			let first = -1
			for (;;) {
				const at = norm.indexOf(text, from)
				if (at < 0) break
				if (first < 0) first = at
				count += 1
				from = at + 1
				if (count > 1) break
			}
			if (count === 1) return { start: first, end: first + text.length }
			return null
		}

		/** (节点, 偏移) → raw 全文坐标；节点不在图里（比如在 composer 里）回 -1。 */
		function rawOffsetOf(segments, node, offset) {
			for (const seg of segments) {
				if (seg.node === node) return seg.start + Math.min(offset, node.length)
			}
			return -1
		}

		/** 元素里第一个/最后一个文本后代（含元素自身是文本节点的情况）；没有回 null。 */
		function textInElement(el, wantLast) {
			try {
				if (!el) return null
				if (el.nodeType === 3) return el
				const doc = el.ownerDocument || (typeof document !== 'undefined' ? document : null)
				if (!doc || typeof doc.createTreeWalker !== 'function') return null
				const walker = doc.createTreeWalker(el, 4 /* SHOW_TEXT */)
				let first = null
				let last = null
				let t
				while ((t = walker.nextNode())) {
					if (first === null) first = t
					last = t
				}
				return wantLast ? last : first
			} catch {
				return null
			}
		}

		/**
		 * 选区端点 → raw 全文坐标。**端点容器可能是元素**，不是只有文本节点：
		 * `**加粗**` 在段首时从行首起拖、选中整行标题、双击选词等场景，Chromium 会把
		 * Range 端点记成（元素, 子索引）——2026-11-09 实测"加粗黑体字标色上不去"：
		 * 旧版只按文本节点查表，查不到就把整个标色放弃了。
		 * 起点：定位到第 offset 个子节点里的第一个文本后代；终点：第 offset-1 个子节点里的
		 * 最后一个文本后代。所指子节点里没有文本时退到兄弟链（fail-closed：退无可退回 -1）。
		 */
		function resolveTextPoint(node, offset, segments, wantEnd) {
			try {
				if (!node) return -1
				/** 容器内从某个子节点起（向后）/止于某个子节点前（向前）扫文本，扫不到再退容器外兄弟。 */
				const scanKids = (from, dir) => {
					for (let i = from; i >= 0 && i < kids.length; i += dir) {
						const t = textInElement(kids[i], dir < 0)
						if (t) {
							const off = rawOffsetOf(segments, t, dir < 0 ? t.length : 0)
							if (off >= 0) return off
						}
					}
					return -1
				}
				const scanSiblings = (first, dir) => {
					let sib = first
					while (sib) {
						const t = textInElement(sib, dir < 0)
						if (t) {
							const off = rawOffsetOf(segments, t, dir < 0 ? t.length : 0)
							if (off >= 0) return off
						}
						sib = dir < 0 ? sib.previousSibling : sib.nextSibling
					}
					return -1
				}
				const kids = node.nodeType === 1 ? node.childNodes || [] : []
				if (node.nodeType === 3) {
					const off = rawOffsetOf(segments, node, offset)
					if (off >= 0) return off
					/**
					 * **端点落在纯空白文本节点上**（不在 segments 里）——Chromium 把"两个内联元素
					 * 之间"的光标规范化成（前一个文本节点, 末尾），而 `**2026-120** **雅江隧道…**`
					 * 之间那个空格正是这种节点。2026-11-09 复现："从雅前框选着色不上去"。
					 * 语义：该位置前后没有正文，起点取后面兄弟的首段文本，终点取前面兄弟的末段文本。
					 */
					return scanSiblings(wantEnd ? node.previousSibling : node.nextSibling, wantEnd ? -1 : 1)
				}
				if (node.nodeType !== 1) return -1
				if (wantEnd) {
					// 终点（元素, offset）：覆盖到第 offset-1 个子节点为止；其后无文本退容器外前兄弟。
					// ⚠️ 兄弟链上会有空白文本节点（`</p>\n<h2>` 之间的换行缩进，不在 segments 里）
					// —— 查不到坐标要**继续往前走**，不能停（2026-11-09 复现逮到）。
					const inKids = scanKids(Math.min(offset, kids.length) - 1, -1)
					if (inKids >= 0) return inKids
					return scanSiblings(node.previousSibling, -1)
				}
				// 起点（元素, offset）：从第 offset 个子节点起向后扫；无文本退容器外后兄弟。
				const inKids = scanKids(offset, 1)
				if (inKids >= 0) return inKids
				return scanSiblings(node.nextSibling, 1)
			} catch {
				return -1
			}
		}

		/**
		 * 从 raw 全文坐标区间提取引文（全部规范化存储）。
		 * prefix/suffix 各取 CTX_CHARS 字符——上下文越长，跨行/重名句子的定位越稳。
		 */
		function extractQuote(rawText, startRaw, endRaw) {
			const s = Math.max(0, Math.min(startRaw, rawText.length))
			const e = Math.max(s, Math.min(endRaw, rawText.length))
			const text = normalize(rawText.slice(s, e))
			if (!text) return null
			return {
				text: text.slice(0, MAX_TEXT),
				prefix: normalize(rawText.slice(Math.max(0, s - CTX_CHARS), s)).slice(-CTX_CHARS),
				suffix: normalize(rawText.slice(e, e + CTX_CHARS)).slice(0, CTX_CHARS),
			}
		}

		/**
		 * "该不该浮出取色 pill"的真值表（自检逐条钉）。
		 * 少任何一条都会出洋相：composer 里选字会被标、选中一整页会把账本写爆、
		 * 在我们自己的 pill 上松手会把自己标掉。
		 * 返回''=放行；否则给出被拦的这条理由（失败现场记录用，别让排障靠猜）。
		 */
		function shouldOfferHighlight(env) {
			return pillGateReason(env) === ''
		}

		function pillGateReason(env) {
			const e = env || {}
			if (e.collapsed !== false) return 'collapsed'
			if (e.hasRange !== true) return 'no-range'
			if (e.inOwnUi === true) return 'own-ui'
			if (e.inEditable === true) return 'editable'
			if (e.endpointsInText !== true) return 'no-endpoints'
			if (!e.text) return 'empty-text'
			if (e.textLen > MAX_TEXT) return 'text-too-long'
			return ''
		}

		/** 选中区的端点是否落在"可标"的文本里（不在我 UI / composer / 输入类元素里）。 */
		function endpointsMarkable(startEl, endEl) {
			const bad = '[data-dsh-hl-ui],[data-dsh-hl-overlay],[contenteditable="true"],input,textarea,select'
			try {
				for (const el of [startEl, endEl]) {
					if (!el || typeof el.closest !== 'function') return false
					if (el.closest(bad)) return false
				}
				return true
			} catch {
				return false
			}
		}

		/** Range 的非空 client rect（宽高 > 1px 才算，过滤折叠矩形）。 */
		function rectsForRange(range) {
			try {
				return Array.from(range.getClientRects()).filter((r) => r && r.width > 1 && r.height > 1)
			} catch {
				return []
			}
		}

		/** 合并同一行上相邻的矩形，减少色块数量（视觉上更整，DOM 更少）。 */
		function mergeRects(rects) {
			const sorted = rects.slice().sort((a, b) => a.top - b.top || a.left - b.left)
			const out = []
			for (const r of sorted) {
				const prev = out[out.length - 1]
				if (
					prev &&
					Math.abs(prev.top - r.top) < 2 &&
					Math.abs(prev.height - r.height) < 2 &&
					r.left - (prev.left + prev.width) < 6
				) {
					const right = Math.max(prev.left + prev.width, r.left + r.width)
					const top = Math.min(prev.top, r.top)
					const bottom = Math.max(prev.top + prev.height, r.top + r.height)
					out[out.length - 1] = { left: prev.left, top, width: right - prev.left, height: bottom - top }
				} else {
					out.push({ left: r.left, top: r.top, width: r.width, height: r.height })
				}
			}
			return out
		}

		/** 点 (x,y) 命中了哪条标记（命中判定用的就是画出来的同一批矩形）。 */
		function hitTestRects(x, y, rectsById) {
			for (const [id, rects] of rectsById) {
				for (const r of rects) {
					if (x >= r.left - 1 && x <= r.left + r.width + 1 && y >= r.top - 1 && y <= r.top + r.height + 1) {
						return id
					}
				}
			}
			return ''
		}

		/**
		 * 点 (x,y) 命中的**全部**标记（按绘制顺序 = 账本顺序，先画的在下）。
		 * 叠在一起的色块要能一眼看到有几层、一键清完——只回最上面一条是"删不完"的根源。
		 */
		function hitTestAll(x, y, rectsById) {
			const hits = []
			for (const [id, rects] of rectsById) {
				for (const r of rects) {
					if (x >= r.left - 1 && x <= r.left + r.width + 1 && y >= r.top - 1 && y <= r.top + r.height + 1) {
						hits.push(id)
						break
					}
				}
			}
			return hits
		}

		/** 两条标记是不是"同一句话"（同引文：正文 + 前后文全一致，颜色不论）。 */
		function sameQuote(a, b) {
			return Boolean(
				a && b && a.text === b.text && a.prefix === b.prefix && a.suffix === b.suffix,
			)
		}

		/**
		 * 同一句话再标一次该怎么办（纯函数，自检钉死）：
		 *   · 没有同引文旧标 → 正常新增；
		 *   · 同引文同颜色 → 无事可做（点十次也只一层）；
		 *   · 同引文换了颜色（或有历史叠层）→ **替换**：撤掉全部旧的，换成新色。
		 * 叠色的根源就是旧版只判"同颜色才跳过"——换色再标就叠一层。
		 */
		function planReplacement(activeList, quote, color) {
			const olds = (activeList || []).filter((h) => sameQuote(h, quote))
			if (!olds.length) return { removeIds: [], skip: false }
			if (olds.length === 1 && olds[0].color === color) return { removeIds: [], skip: true }
			return { removeIds: olds.map((h) => h.id), skip: false }
		}

		/** 会话 id 第一道关（host 端点只收 session-<uuid>，别把坏形状发过去）。 */
		function validSid(sid) {
			return typeof sid === 'string' && SESSION_ID_RE.test(sid)
		}

		/* ================================================================ 运行时状态与 DOM */

		const debug = {
			ready: false,
			ver: '1.2.8',
			sid: '',
			active: 0,
			anchored: 0,
			orphan: 0,
			created: 0,
			deleted: 0,
			ambiguous: 0,
			pillNoAnchor: 0,
			fallbackCreated: 0,
			lastError: '',
		}

		/** 当前会话的标记（宿主账本里的那一份 + 本轮新增/删除后的本地真相）。 */
		let active = []
		let sid = ''
		let pendingRange = null
		let overlay = null
		let pill = null
		let popup = null
		/** 画出来的矩形：hl.id → rect[]。命中判定与绘制共用同一份。 */
		const rectsById = new Map()
		/** 防竞态：换会话后晚到的 GET 回包不许覆盖新会话的数据。 */
		let loadEpoch = 0
		let sessionsCtx = null
		let reanchorTimer = null

		/** 当前会话 id：DOM 优先（composer 容器挂着 data-conversation-session），快照兜底。 */
		function currentSessionId() {
			try {
				const el = document.querySelector('[data-conversation-session]')
				const v = el && el.getAttribute('data-conversation-session')
				if (v) return v
			} catch {
				/* DOM 不可用走兜底 */
			}
			try {
				const snap =
					sessionsCtx && sessionsCtx.list && typeof sessionsCtx.list.getSnapshot === 'function'
						? sessionsCtx.list.getSnapshot()
						: null
				if (snap && typeof snap.current === 'string') return snap.current
			} catch {
				/* 快照拿不到就算了 */
			}
			return ''
		}

		/** 失败现场速记（给 __DSH_HIGHLIGHT_DEBUG__.lastFail）：端点形态 + 解析结果，排障不用复现。 */
		function describeNode(node, offset) {
			try {
				if (!node) return null
				const d = { nodeType: node.nodeType, offset }
				if (node.nodeType === 1) {
					d.tag = node.tagName
					d.kids = node.childNodes ? node.childNodes.length : 0
					const cls = typeof node.getAttribute === 'function' ? node.getAttribute('class') : null
					if (cls) d.class = String(cls).slice(0, 80)
				} else {
					d.len = (node.nodeValue || '').length
					d.text = String(node.nodeValue || '').slice(0, 60)
				}
				return d
			} catch {
				return null
			}
		}

		function captureFail(stage, range, extra) {
			try {
				debug.lastFail = {
					stage,
					at: new Date().toLocaleTimeString(),
					start: describeNode(range.startContainer, range.startOffset),
					end: describeNode(range.endContainer, range.endOffset),
					toString: String(range.toString() || '').slice(0, 100),
					...(extra || {}),
				}
			} catch {
				/* 记不了就算了 */
			}
		}

		/**
		 * 收集全文：正文区全部文本节点拼一份 + 每个节点占的区间。
		 * 跳过：我们自己（UI/覆盖层）、脚本样式、输入类、composer（contenteditable）。
		 * 纯空白节点占一个空格——否则相邻文本会"焊死"，锚定就串位了。
		 */
		function collectTextMap(root) {
			const segments = []
			let text = ''
			const SKIP = `${'[data-dsh-hl-ui],[data-dsh-hl-overlay],script,style,noscript,textarea,input,select'}`.slice(0)
			const walker = document.createTreeWalker(root, 4 /* SHOW_TEXT */, {
				acceptNode(node) {
					try {
						const p = node.parentElement
						if (!p || typeof p.closest !== 'function') return 2 /* REJECT */
						if (p.closest(SKIP) || p.closest('[contenteditable="true"]')) return 2
						return 1 /* ACCEPT */
					} catch {
						return 2
					}
				},
			})
			let n
			while ((n = walker.nextNode())) {
				const v = n.nodeValue || ''
				if (!/\S/.test(v)) {
					text += ' '
					continue
				}
				segments.push({ node: n, start: text.length, end: text.length + v.length })
				text += v
			}
			return { text, segments }
		}

		/* ---- 覆盖层与浮层 DOM ---- */

		function ensureOverlay(doc) {
			if (overlay && overlay.isConnected) return overlay
			overlay = doc.createElement('div')
			overlay.setAttribute(OVERLAY_ATTR, '1')
			doc.body.appendChild(overlay)
			return overlay
		}

		function draw() {
			const doc = document
			if (!doc || !doc.body) return
			const ol = ensureOverlay(doc)
			ol.textContent = ''
			rectsById.clear()
			for (const hl of active) {
				const rects = hl.__rects || []
				if (!rects.length) continue
				for (const r of rects) {
					const d = doc.createElement('div')
					d.className = 'dsh-hl-rect'
					d.style.left = r.left + 'px'
					d.style.top = r.top + 'px'
					d.style.width = r.width + 'px'
					d.style.height = r.height + 'px'
					d.style.background = COLORS[hl.color] || COLORS.yellow
					ol.appendChild(d)
				}
				rectsById.set(hl.id, rects)
			}
		}

		function hidePill() {
			pendingRange = null
			if (pill) pill.style.display = 'none'
		}

		function hidePopup() {
			if (popup) popup.style.display = 'none'
		}

		/** 取色 pill：三颗色球。位置贴在选区末尾矩形下方。 */
		function maybeShowPill() {
			const doc = document
			if (!doc) return
			const win = doc.defaultView || window
			let sel = null
			try {
				sel = win.getSelection()
			} catch {
				return
			}
			if (!sel || sel.isCollapsed || sel.rangeCount === 0) return hidePill()
			const range = sel.getRangeAt(0)
			const elOf = (container) => (container && container.nodeType === 1 ? container : container ? container.parentElement : null)
			const startEl = elOf(range.startContainer)
			const endEl = elOf(range.endContainer)
			const text = normalize(range.toString())
			const gate = pillGateReason({
				collapsed: sel.isCollapsed,
				hasRange: true,
				inOwnUi: Boolean(
					(startEl && startEl.closest(`[${UI_ATTR}]`)) || (endEl && endEl.closest(`[${UI_ATTR}]`)),
				),
				inEditable: !endpointsMarkable(startEl, endEl),
				endpointsInText: Boolean(startEl && endEl),
				text,
				textLen: text.length,
			})
			if (gate) {
				captureFail('pill-gated:' + gate, range, {})
				return hidePill()
			}
			// 端点必须落在我们收得了的文本里（含元素容器端点，**加粗**段首起拖的常态）
			const map = collectTextMap(doc.body)
			let s = resolveTextPoint(range.startContainer, range.startOffset, map.segments, false)
			let e = resolveTextPoint(range.endContainer, range.endOffset, map.segments, true)
			if (s < 0 || e <= s) {
				// 端点解析不出：试"选区文字在全文唯一命中"的兜底，唯一命中照样允许成标
				const selText = normalize(range.toString())
				const hit =
					selText && selText.length <= MAX_TEXT
						? findUniqueNorm(buildNormIndex(map.text), selText)
						: null
				if (!hit) {
					debug.pillNoAnchor = (debug.pillNoAnchor || 0) + 1
					captureFail('pill-no-anchor', range, { resolvedS: s, resolvedE: e, selText: selText.slice(0, 60) })
					return hidePill()
				}
			}
			const rects = rectsForRange(range)
			if (!rects.length) return hidePill()
			pendingRange = range.cloneRange()
			const last = rects[rects.length - 1]
			if (!pill) {
				pill = buildPill(doc)
				doc.body.appendChild(pill)
			}
			const px = Math.min(Math.max(8, last.right + 4), (win.innerWidth || 1200) - 130)
			const py = Math.min(last.bottom + 6, (win.innerHeight || 800) - 44)
			pill.style.left = px + 'px'
			pill.style.top = py + 'px'
			pill.style.display = 'flex'
		}

		function buildPill(doc) {
			const el = doc.createElement('div')
			el.className = 'dsh-hl-pill'
			el.setAttribute(UI_ATTR, '1')
			el.setAttribute('role', 'toolbar')
			el.setAttribute('aria-label', '标记重点')
			const swatches = [
				['yellow', '黄色重点'],
				['green', '绿色重点'],
				['blue', '蓝色重点'],
			]
			for (const [color, label] of swatches) {
				const b = doc.createElement('button')
				b.type = 'button'
				b.className = 'dsh-hl-swatch dsh-hl-swatch-' + color
				b.title = label
				b.setAttribute('aria-label', label)
				b.addEventListener('click', (ev) => {
					try {
						ev.stopPropagation()
						ev.preventDefault()
					} catch {
						/* 无碍 */
					}
					const range = pendingRange
					hidePill()
					if (range) createHighlight(range, color)
				})
				el.appendChild(b)
			}
			return el
		}

		/**
		 * 删除确认小弹框：贴着点击点。**认得叠层**——点击处有几条标记重叠就明说几条，
		 * 给"删除全部 N 条"一键清完（2026-11-09 实测："色块一次删除删不完"）。
		 */
		function openDeletePopup(hlIds, x, y) {
			const doc = document
			if (!doc) return
			const ids = Array.isArray(hlIds) ? hlIds : [hlIds]
			const targets = active.filter((h) => ids.includes(h.id))
			if (!targets.length) return
			if (!popup) {
				popup = buildPopup(doc)
				doc.body.appendChild(popup)
			}
			popup.dataset.hlIds = JSON.stringify(targets.map((h) => h.id))
			const top = targets[targets.length - 1] // 绘制顺序里最上面的一条
			const label = popup.querySelector('.dsh-hl-popup-text')
			if (label) {
				const preview = String(top.text || '')
				const shown = preview.length > 24 ? preview.slice(0, 24) + '…' : preview
				label.textContent =
					targets.length > 1
						? `这里有 ${targets.length} 条重点标记叠在一起（最上面一条：「${shown}」）。`
						: `删除这条重点标记？「${shown}」`
			}
			const err = popup.querySelector('.dsh-hl-popup-error')
			if (err) err.textContent = ''
			/** 按钮每次打开现搭：1 条 → [删除][取消]；多条 → [删除全部 N 条][只删最上一条][取消]。 */
			const actions = popup.querySelector('.dsh-hl-popup-actions')
			if (actions) {
				actions.textContent = ''
				const mk = (text, cls, fn) => {
					const b = doc.createElement('button')
					b.type = 'button'
					b.className = 'dsh-hl-popup-btn' + (cls ? ' ' + cls : '')
					b.textContent = text
					b.addEventListener('click', () => {
						hidePopup()
						fn()
					})
					actions.appendChild(b)
				}
				if (targets.length > 1) {
					mk(`删除全部 ${targets.length} 条`, 'dsh-hl-popup-danger', () =>
						deleteHighlights(targets.map((h) => h.id)),
					)
					mk('只删最上一条', '', () => deleteHighlights([top.id]))
				} else {
					mk('删除', 'dsh-hl-popup-danger', () => deleteHighlights([top.id]))
				}
				mk('取消', '', () => {})
			}
			const win = doc.defaultView || window
			popup.style.left = Math.min(Math.max(8, x), (win.innerWidth || 1200) - 260) + 'px'
			popup.style.top = Math.min(y + 10, (win.innerHeight || 800) - 110) + 'px'
			popup.style.display = 'block'
		}

		function buildPopup(doc) {
			const el = doc.createElement('div')
			el.className = 'dsh-hl-popup'
			el.setAttribute(UI_ATTR, '1')
			el.setAttribute('role', 'dialog')
			el.setAttribute('aria-label', '删除重点标记')
			const text = doc.createElement('div')
			text.className = 'dsh-hl-popup-text'
			const err = doc.createElement('div')
			err.className = 'dsh-hl-popup-error'
			const actions = doc.createElement('div')
			actions.className = 'dsh-hl-popup-actions'
			el.appendChild(text)
			el.appendChild(err)
			el.appendChild(actions)
			return el
		}

		/* ---- 账本操作（host 半 3205）---- */

		async function loadForSession(nextSid) {
			if (!validSid(nextSid)) {
				active = []
				sid = ''
				debug.sid = ''
				draw()
				return
			}
			const epoch = ++loadEpoch
			try {
				const res = await fetch(`${ENDPOINT}/highlights?sessionId=${encodeURIComponent(nextSid)}`)
				const data = await res.json().catch(() => null)
				if (epoch !== loadEpoch) return // 晚到的旧回包，丢弃
				if (!res.ok || !data || data.ok !== true) throw new Error((data && data.error) || `HTTP ${res.status}`)
				active = Array.isArray(data.highlights)
					? data.highlights.filter((h) => h && typeof h.id === 'string' && typeof h.text === 'string')
					: []
				sid = nextSid
				debug.sid = sid
				debug.lastError = ''
			} catch (err) {
				// 拉不下来不动旧数据：上一会话的标记不至于串到这一会话来，清空并明说
				active = []
				sid = nextSid
				debug.sid = sid
				debug.lastError = `加载标记失败：${String((err && err.message) || err)}`
			}
			debug.active = active.length
			reanchorAll()
		}

		async function createHighlight(range, color) {
			const doc = document
			if (!doc || !doc.body) return
			/** 会话根优先：选区两端都在会话正文里时，引文从会话内文本提取——
			 * 与重锚的"会话优先"同源，侧栏同名标题不再掺和。 */
			let root = doc.body
			try {
				const convEl = doc.querySelector('[data-conversation-session]')
				if (
					convEl &&
					convEl.contains(range.startContainer) &&
					convEl.contains(range.endContainer)
				) {
					root = convEl
				}
			} catch {
				/* 判不出就用全文 */
			}
			const map = collectTextMap(root)
			let s = resolveTextPoint(range.startContainer, range.startOffset, map.segments, false)
			let e = resolveTextPoint(range.endContainer, range.endOffset, map.segments, true)
			if (s < 0 || e <= s) {
				/**
				 * **兜底定位**：端点解析不出（又一种没见过的容器/空白形态），改拿"选区字符串"
				 * 在归一化全文里找唯一出现——唯一命中才认（多处命中不认，宁可不画不画错）。
				 * 引文从全文切出来，与渲染期重锚的锚定天然自洽。
				 */
				const selText = normalize(range.toString())
				const normInfo = buildNormIndex(map.text)
				const hit =
					selText && selText.length <= MAX_TEXT ? findUniqueNorm(normInfo, selText) : null
				if (!hit) {
					debug.lastError = '选区端点解析不出，且选区文字在正文里不是唯一出现——没标'
					captureFail('create-no-anchor', range, { resolvedS: s, resolvedE: e })
					return
				}
				s = normToRaw(normInfo, hit.start)
				e = normToRaw(normInfo, hit.end)
				debug.fallbackCreated = (debug.fallbackCreated || 0) + 1
			}
			const quote = extractQuote(map.text, s, e)
			if (!quote || !quote.text) return
			/**
			 * 同一句话再标 → **替换**而不是叠（凯哥 2026-11-09 实测："色似乎是叠上去的，
			 * 色块一次删除删不完"）。旧的（含账本里历史叠层）一并撤掉，换成新色。
			 */
			let plan = planReplacement(active, quote, color)
			if (plan.skip) {
				/** 同句同色"无事可做"有一个例外：已有的那条**锚定不上**（orphan，界面上根本
				 * 没画出来）——这时候还跳过，用户看到的就是"标了没反应"（2026-11-09 实测）。
				 * 把它撤掉换成新标，重锚给一次找回的机会。 */
				const existing = active.find((h) => sameQuote(h, quote) && h.color === color)
				if (existing && (!existing.__rects || !existing.__rects.length)) {
					plan = { removeIds: [existing.id], skip: false }
				} else {
					captureFail('dup-skip', range, {
						existingColor: existing ? existing.color : '',
						existingDrawn: existing ? Boolean(existing.__rects && existing.__rects.length) : false,
					})
					return
				}
			}
			if (!validSid(sid)) {
				debug.lastError = '没认出当前会话 id，标记先不落盘（本轮内存里有效）'
				active = active.filter((h) => !plan.removeIds.includes(h.id))
				const local = { id: 'local-' + Math.random().toString(36).slice(2), ...quote, color, createdAt: Date.now() }
				active.push(local)
				debug.active = active.length
				reanchorAll()
				return
			}
			/** 先本地成标（点一下立刻看到），host 回执到了再把临时 id 换成正式 id。 */
			const local = { id: 'local-' + Math.random().toString(36).slice(2), ...quote, color, createdAt: Date.now() }
			active = active.filter((h) => !plan.removeIds.includes(h.id))
			active.push(local)
			debug.active = active.length
			reanchorAll()
			try {
				const res = await fetch(`${ENDPOINT}/highlights`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ sessionId: sid, highlight: quoteToLocal(local) }),
				})
				const data = await res.json().catch(() => null)
				if (!res.ok || !data || data.ok !== true || !data.record || !data.record.id) {
					throw new Error((data && data.error) || `HTTP ${res.status}`)
				}
				const still = active.find((h) => h.id === local.id)
				if (still) still.id = data.record.id // 本地还在（没被并发删掉）才换 id
				debug.created += 1
				debug.lastError = ''
			} catch (err) {
				debug.lastError = `标记保存失败（本轮内存里仍有效）：${String((err && err.message) || err)}`
			}
			/** 被替换的旧标也要从账本里撤掉，否则下次刷新它们又回来了（叠层重现）。 */
			try {
				await dropFromLedger(plan.removeIds)
			} catch {
				/* 失败原因已写进 lastError：新标已在，旧标账本里还留着——如实提示即可 */
			}
		}

		/** POST 载荷：只发账本认识的四个字段，本地渲染用的 __rects/__range 不出门。 */
		function quoteToLocal(hl) {
			return { text: hl.text, prefix: hl.prefix, suffix: hl.suffix, color: hl.color }
		}

		/**
		 * 从 host 账本里撤掉一批标记（替换旧标 / 删除共用）。
		 * 逐条 POST；**任何一条失败就整批保留**并明说——删一半留一半比不删更坑。
		 * local- 开头的是没落过盘的临时记录，账本里本就没有，直接跳过。
		 */
		async function dropFromLedger(hlIds) {
			if (!validSid(sid) || !Array.isArray(hlIds) || !hlIds.length) return
			const remoteIds = hlIds.filter((id) => typeof id === 'string' && id && !String(id).startsWith('local-'))
			for (const id of remoteIds) {
				try {
					const res = await fetch(`${ENDPOINT}/highlights/delete`, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify({ sessionId: sid, id }),
					})
					const data = await res.json().catch(() => null)
					if (!res.ok || !data || data.ok !== true) {
						throw new Error((data && data.error) || `HTTP ${res.status}`)
					}
				} catch (err) {
					debug.lastError = `账本撤除失败（标记保留）：${String((err && err.message) || err)}`
					throw err // 调用方按"整批保留"处理
				}
			}
		}

		/**
		 * 删除一批标记（弹框的"只删这一条"/"删除全部 N 条"都走这里）。
		 * 账本撤除在前、本地移除在后：撤不干净就整批保留，不会出现"屏幕没了、刷新又回来"。
		 */
		async function deleteHighlights(hlIds) {
			const ids = Array.isArray(hlIds) ? hlIds.filter(Boolean) : []
			const targets = active.filter((h) => ids.includes(h.id))
			if (!targets.length) return
			try {
				await dropFromLedger(targets.map((h) => h.id))
			} catch {
				return // dropFromLedger 已把失败原因写进 lastError，标记保留
			}
			active = active.filter((h) => !ids.includes(h.id))
			debug.active = active.length
			debug.deleted += ids.length
			reanchorAll()
		}

		/* ---- 重锚定 + 主循环 ---- */

		function reanchorAll() {
			const doc = document
			if (!doc || !doc.body) return
			// 顺手对表：会话 id 变了就先换账本（换会话的主要路径就这一条）
			const nextSid = currentSessionId()
			if (nextSid !== sid) {
				sid = nextSid
				debug.sid = sid
				debug.active = 0
				debug.anchored = 0
				debug.orphan = 0
				if (validSid(sid)) loadForSession(sid)
				else {
					active = []
					draw()
				}
				return // loadForSession 完成后会再进来重锚
			}
			if (!active.length) {
				debug.anchored = 0
				debug.orphan = 0
				draw()
				return
			}
			/**
			 * 锚定范围：**会话正文区优先**（`[data-conversation-session]`），全文兜底。
			 * 侧栏的会话标题经常和正文里的句子同名（标题就是从首条消息生成的）——
			 * 全文匹配时同一句话出现两处 → 歧义 fail-closed → orphan（2026-11-09 实测
			 * "标记创建成功但 anchored=0"）。先在会话内找，找不到再扫全文。
			 */
			const maps = []
			try {
				const convEl = doc.querySelector('[data-conversation-session]')
				if (convEl) {
					const m = collectTextMap(convEl)
					if (m.text.replace(/\s/g, '').length > 0) {
						maps.push({ scope: 'conversation', map: m, norm: buildNormIndex(m.text) })
					}
				}
			} catch {
				/* 会话根拿不到就只用全文 */
			}
			try {
				const m = collectTextMap(doc.body)
				maps.push({ scope: 'body', map: m, norm: buildNormIndex(m.text) })
			} catch {
				/* 全文也收不了就这轮不锚 */
			}
			let anchored = 0
			let orphan = 0
			for (const hl of active) {
				let done = false
				for (const { map, norm } of maps) {
					const a = findAnchor(norm, hl)
					if (!a) continue
					const sRaw = normToRaw(norm, a.start)
					const eRaw = normToRaw(norm, a.end)
					const s = offsetToNodeOffset(map.segments, sRaw)
					const e = offsetToNodeOffset(map.segments, eRaw)
					if (!s || !e) continue
					try {
						const range = doc.createRange()
						range.setStart(s.node, s.offset)
						range.setEnd(e.node, e.offset)
						hl.__range = range
						hl.__rects = mergeRects(rectsForRange(range))
						anchored += 1
						done = true
						break
					} catch {
						continue
					}
				}
				if (!done) {
					hl.__range = null
					hl.__rects = []
					orphan += 1
				}
			}
			debug.anchored = anchored
			debug.orphan = orphan
			if (orphan > 0) {
				/** 有锚定不上的标记就记下现场（哪几条、引文长什么样）——排障不用猜。 */
				try {
					const orphans = active.filter((h) => !h.__rects || !h.__rects.length).slice(0, 3)
					debug.lastFail = {
						stage: 'orphan',
						at: new Date().toLocaleTimeString(),
						count: orphan,
						samples: orphans.map((h) => ({
							id: h.id,
							color: h.color,
							text: String(h.text || '').slice(0, 40),
							prefix: String(h.prefix || '').slice(0, 20),
							suffix: String(h.suffix || '').slice(0, 20),
						})),
					}
				} catch {
					/* 记不了就算了 */
				}
			}
			draw()
		}

		function scheduleReanchor() {
			if (reanchorTimer) return
			reanchorTimer = setTimeout(() => {
				reanchorTimer = null
				try {
					reanchorAll()
				} catch (err) {
					debug.lastError = String((err && err.message) || err)
				}
			}, 200)
		}

		/* ---- CSS ---- */

		const CSS = `
/* 高亮覆盖层：fixed 全屏、不接鼠标事件 —— 框架 DOM 一个字节都不改，色块纯"画"上去 */
[data-dsh-hl-overlay] { position: fixed; inset: 0; pointer-events: none; z-index: 2100000000; }
.dsh-hl-rect { position: fixed; pointer-events: none; border-radius: 2px; mix-blend-mode: multiply; }
/* 取色 pill / 删除弹框：真 UI，接鼠标 */
[data-dsh-hl-ui].dsh-hl-pill { position: fixed; display: none; gap: 6px; padding: 6px 8px;
  border-radius: 10px; background: var(--dsw-alias-bg-layer-1, #fff);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12));
  box-shadow: 0 6px 20px rgba(0,0,0,.18); z-index: 2100000001; }
.dsh-hl-swatch { width: 18px; height: 18px; border-radius: 50%; cursor: pointer; padding: 0;
  border: 1px solid rgba(0,0,0,.22); }
.dsh-hl-swatch-yellow { background: rgba(255,196,0,.85); }
.dsh-hl-swatch-green { background: rgba(64,200,90,.75); }
.dsh-hl-swatch-blue { background: rgba(64,140,255,.72); }
.dsh-hl-swatch:hover { transform: scale(1.15); }
[data-dsh-hl-ui].dsh-hl-popup { position: fixed; display: none; min-width: 200px; max-width: 260px;
  padding: 10px 12px; border-radius: 10px; font-size: 12px; line-height: 1.5;
  color: var(--dsw-alias-label-primary, #1f1f1f);
  background: var(--dsw-alias-bg-layer-1, #fff);
  border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.12));
  box-shadow: 0 10px 30px rgba(0,0,0,.22); z-index: 2100000001; }
.dsh-hl-popup-text { word-break: break-all; }
.dsh-hl-popup-error { margin-top: 4px; color: var(--dsw-alias-state-error-primary, #d05252); }
.dsh-hl-popup-actions { margin-top: 8px; display: flex; justify-content: flex-end; gap: 6px; }
.dsh-hl-popup-btn { font: inherit; font-size: 12px; cursor: pointer; padding: 4px 12px;
  border-radius: 999px; color: var(--dsw-alias-label-primary, #1f1f1f);
  background: transparent; border: .5px solid var(--dsw-alias-border-l4, rgba(0,0,0,.18)); }
.dsh-hl-popup-danger { color: var(--dsw-alias-state-error-primary, #d05252);
  border-color: var(--dsw-alias-state-error-primary, #d05252);
  background: var(--dsw-alias-state-error-bg, rgba(208,82,82,.08)); }
`

		function injectCss() {
			if (typeof document === 'undefined') return
			if (document.getElementById('dsh-hl-style')) return
			const el = document.createElement('style')
			el.id = 'dsh-hl-style'
			el.textContent = CSS
			document.head.appendChild(el)
		}

		/* ---- 安装 ---- */

		function install() {
			const doc = document
			if (!doc || typeof doc.addEventListener !== 'function') return false
			const win = doc.defaultView || window

			// 选区松手 → 浮 pill（setTimeout 0：让选区先落定）
			doc.addEventListener(
				'pointerup',
				() => {
					setTimeout(() => {
						try {
							maybeShowPill()
						} catch {
							/* 浮不出来就算了 */
						}
					}, 0)
				},
				true,
			)
			// 点击（捕获）：点色块 → 删除确认；点空白收 pill / 收弹框。
			// 自己 UI 上的点击放行（色球/按钮自己的监听要干活）。
			doc.addEventListener(
				'click',
				(ev) => {
					try {
						const t = ev.target
						if (t && typeof t.closest === 'function' && t.closest(`[${UI_ATTR}]`)) return
						hidePill()
						hidePopupIfOutside(t)
						const sel = win.getSelection ? win.getSelection() : null
						if (sel && !sel.isCollapsed) return // 正在选字，不谈删除
						if (typeof (ev.clientX) !== 'number') return
						const hits = hitTestAll(ev.clientX, ev.clientY, rectsById)
						if (hits.length) {
							try {
								ev.stopPropagation()
								ev.preventDefault()
							} catch {
								/* 无碍 */
							}
							openDeletePopup(hits, ev.clientX, ev.clientY)
						}
					} catch {
						/* 交互层出错不影响宿主 */
					}
				},
				true,
			)
			// Esc 收浮层
			doc.addEventListener(
				'keydown',
				(ev) => {
					if (ev && ev.key === 'Escape') {
						hidePill()
						hidePopup()
					}
				},
				true,
			)
			// 滚动：pill 收起（选区矩形已过时）；色块是 live Range 的矩形，重画即跟随
			doc.addEventListener(
				'scroll',
				() => {
					hidePill()
					draw()
				},
				true,
			)
			try {
				win.addEventListener('resize', () => {
					hidePill()
					draw()
				})
			} catch {
				/* 可选 */
			}
			// 框架重渲染/流式输出 → 防抖重锚（200ms 一拍，便宜够用）
			try {
				const Obs = win.MutationObserver
				if (Obs && doc.body) {
					const obs = new Obs(() => scheduleReanchor())
					obs.observe(doc.body, { childList: true, subtree: true, characterData: true })
				}
			} catch {
				/* 没有观察者就靠会话切换/手动重试 */
			}
			// 首次与兜底：会话界面可能晚于插件挂载，补两拍
			setTimeout(() => reanchorAll(), 800)
			setTimeout(() => reanchorAll(), 2500)
			debug.ready = true
			return true
		}

		function hidePopupIfOutside(target) {
			try {
				if (
					popup &&
					popup.style.display === 'block' &&
					(!target || typeof target.closest !== 'function' || !target.closest(`[${UI_ATTR}]`))
				) {
					hidePopup()
				}
			} catch {
				/* 无碍 */
			}
		}

		function apply(ctx) {
			sessionsCtx = ctx && ctx.sessions ? ctx.sessions : null
			injectCss()
			install()
			if (typeof window !== 'undefined') {
				window.__DSH_HIGHLIGHT_APPLIED__ = true
				window.__DSH_HIGHLIGHT_VERSION__ = debug.ver
				window.__DSH_HIGHLIGHT_DEBUG__ = debug
			}
			// 会话名单一变就对表（换会话的兜底路径；主路径是 reanchorAll 里的 DOM 对表）
			if (sessionsCtx && sessionsCtx.list && typeof sessionsCtx.list.subscribe === 'function') {
				ctx.effect(() => {
					const off = sessionsCtx.list.subscribe(() => scheduleReanchor())
					return () => {
						if (typeof off === 'function') off()
					}
				}, 'highlight: session change watch')
			}
			ctx.effect(
				() => () => {
					try {
						if (overlay && overlay.isConnected) overlay.remove()
						if (pill && pill.isConnected) pill.remove()
						if (popup && popup.isConnected) popup.remove()
					} catch {
						/* ignore */
					}
				},
				'highlight: remove overlay on unload',
			)
		}

		exports.apply = apply
		exports.inject = inject
		/* 自检 / 排障用：把"能不能标、能不能找回"的全部判据摊开 */
		exports.normalize = normalize
		exports.pillGateReason = pillGateReason
		exports.buildNormIndex = buildNormIndex
		exports.findAnchor = findAnchor
		exports.normToRaw = normToRaw
		exports.offsetToNodeOffset = offsetToNodeOffset
		exports.rawOffsetOf = rawOffsetOf
		exports.resolveTextPoint = resolveTextPoint
		exports.findUniqueNorm = findUniqueNorm
		exports.extractQuote = extractQuote
		exports.shouldOfferHighlight = shouldOfferHighlight
		exports.endpointsMarkable = endpointsMarkable
		exports.rectsForRange = rectsForRange
		exports.mergeRects = mergeRects
		exports.hitTestRects = hitTestRects
		exports.hitTestAll = hitTestAll
		exports.sameQuote = sameQuote
		exports.planReplacement = planReplacement
		exports.validSid = validSid
		exports.collectTextMap = collectTextMap
		exports.__state = {
			debug,
			getActive: () => active,
			setActive: (list) => {
				active = Array.isArray(list) ? list : []
			},
			getSid: () => sid,
			setSid: (v) => {
				sid = String(v || '')
			},
			reanchorAll,
		}
		return module.exports
	},
})

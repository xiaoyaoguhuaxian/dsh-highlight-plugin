/**
 * dsh-highlight-plugin —— host 半
 *
 * 只干一件事：**把"会话内划重点"的高亮标记按会话存取**（增 / 列 / 删）。
 *
 * 为什么要存盘：大少爷要的是"未手动删除的高亮标记一直保留在会话中"——
 * client 半的内存态撑不住宿主重启 / 页面刷新，所以标记落盘：
 *   ~/.dsh/highlights/<encodeSegment(会话id)>.json
 * 每个会话一个 JSON 文件，`{ highlights: [...] }`。文件小、无索引、并发只有一个
 * 桌面客户端写，够用。会话 id 沿用框架的 `session-<uuid>` 形态（重启不变，标记跟着会话走）。
 *
 * 端点（和 session-delete 同一套路：只监听本机回环 + CORS 全开，页面在 3080 属跨源）：
 *   GET  http://127.0.0.1:3205/highlights?sessionId=session-…   → 该会话的标记列表
 *   POST http://127.0.0.1:3205/highlights                       → 新增一条（id 由 host 发）
 *   POST http://127.0.0.1:3205/highlights/delete                → 按 id 删一条
 *
 * 三条安全线：
 *  1. 只接受形如 `session-<uuid>` 的会话 id（同 session-delete 的规矩）——
 *     防的是"拿别的字符串去拼文件路径"；目录名还要再过 encodeSegment。
 *  2. 新增记录的 id / createdAt 一律 **host 发**（crypto.randomUUID），不信客户端；
 *     客户端给的 id 会被丢弃。字段长度封顶（正文 2000 / 上下文 120），颜色只认三种。
 *  3. 删不存在的 id 如实回 `removed:false`，不报错也不装成功。
 */
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile, appendFile, mkdir as mkdirDir } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const PLUGIN = 'dsh-highlight-plugin'
const HTTP_PORT = Number(process.env.DSH_HIGHLIGHT_PORT || 3205)
/** 会话 id 形态：session-<uuid>。只接受这种（同 dsh-session-delete-plugin 的规矩）。 */
const SESSION_ID_RE = /^session-[0-9a-fA-F-]{8,64}$/
/** 字段封顶：防的是手滑选中一整页 / 恶意大包把磁盘写爆。
 * ⚠️ 上下文上限必须与 client 半的 CTX_CHARS(160) 一致——2026-11-09 实测两边不一致
 * （host 120 / client 160）导致所有 POST 都被 400 拒掉、标记永远不落盘。 */
const MAX_TEXT = 2000
const MAX_CONTEXT = 160
/** 颜色只认这三种（client 半的取色 pill 也只有这三个）。 */
const COLORS = new Set(['yellow', 'green', 'blue'])

/** 启动探针：把 host 半的装载轨迹落到 host-boot.log——端点没起来时用它区分"没被装配"还是"装配了没启动"。 */
async function bootLog(msg) {
	try {
		const root = await resolveStorageRoot()
		await mkdirDir(root, { recursive: true })
		await appendFile(join(root, 'host-boot.log'), `${new Date().toISOString()} ${msg}\n`, 'utf8')
	} catch {
		/* 探针写不了不影响功能 */
	}
}

/** 客户端提交内容不合法（区别于服务端/磁盘故障：前者 400，后者 500）。 */
class ValidationError extends Error {}

/** 框架的路径编码（照抄 dsh-session-persistence-jsonl 的 encodeSegment，session-delete 同款）。 */
export function encodeSegment(raw) {
	if (raw.length === 0) throw new Error('cannot encode an empty path segment')
	if (raw === '.') return '~002E'
	if (raw === '..') return '~002E~002E'
	let out = ''
	for (let i = 0; i < raw.length; i++) {
		const ch = String.fromCharCode(raw.charCodeAt(i))
		if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) out += ch
		else out += '~' + raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0')
	}
	return out
}

/** 存储根：框架解析器优先（尊重 $DSH_HOME），拿不到才退化到 ~/.dsh/highlights。 */
export async function resolveStorageRoot() {
	try {
		const hp = await import('@deepseek-ai/dsh-home-paths')
		const mod = hp.default ? hp.default : hp
		const home = mod.resolveDshHome ? mod.resolveDshHome() : undefined
		if (home && typeof home === 'string') return join(home.replace(/[\\/]+$/, ''), 'highlights')
	} catch {
		/* 解析器不可用：走退化路径 */
	}
	const os = await import('node:os')
	return join(os.homedir(), '.dsh', 'highlights')
}

function sessionFile(root, sessionId) {
	return join(root, encodeSegment(sessionId) + '.json')
}

async function readSessionFile(root, sessionId) {
	try {
		const raw = await readFile(sessionFile(root, sessionId), 'utf8')
		const data = JSON.parse(raw)
		if (data && Array.isArray(data.highlights)) return data
	} catch {
		/* 没有文件 / 坏 JSON 都按"没有标记"处理（坏 JSON 不覆盖，只在下次写时换掉） */
	}
	return { highlights: [] }
}

async function writeSessionFile(root, sessionId, data) {
	await mkdir(root, { recursive: true })
	await writeFile(sessionFile(root, sessionId), JSON.stringify(data, null, 2), 'utf8')
}

/**
 * 校验并清洗一条客户端提交的标记：颜色只认三种、文本非空封顶 2000、上下文封顶 120。
 * id / createdAt 一律 host 发，客户端给的丢弃。
 * @returns 清洗后的 `{ text, prefix, suffix, color }`；不合法抛错（端点回 400）。
 */
export function sanitizeHighlightInput(input) {
	if (!input || typeof input !== 'object') throw new ValidationError('highlight 必须是对象')
	const text = String(input.text || '')
	if (!text.trim()) throw new ValidationError('text 不能为空')
	if (text.length > MAX_TEXT) throw new ValidationError(`text 超长（> ${MAX_TEXT}）`)
	const prefix = String(input.prefix || '')
	const suffix = String(input.suffix || '')
	if (prefix.length > MAX_CONTEXT) throw new ValidationError(`prefix 超长（> ${MAX_CONTEXT}）`)
	if (suffix.length > MAX_CONTEXT) throw new ValidationError(`suffix 超长（> ${MAX_CONTEXT}）`)
	const color = input.color === undefined ? 'yellow' : String(input.color)
	if (!COLORS.has(color)) throw new ValidationError(`颜色只认 yellow/green/blue，收到：${color}`)
	return { text, prefix, suffix, color }
}

/** 列一个会话的全部标记。 */
export async function listHighlights(root, sessionId) {
	const data = await readSessionFile(root, sessionId)
	return data.highlights
}

/**
 * 新增一条标记（host 发 id 与 createdAt）。同正文+上下文+颜色的完全重复**不拒收**也**不合并**：
 * 判重是 client 半的事（它有全文可查），host 只当个可靠的账本。
 */
export async function addHighlight(root, sessionId, input) {
	const clean = sanitizeHighlightInput(input)
	const record = {
		id: 'hl-' + randomUUID(),
		...clean,
		createdAt: Date.now(),
	}
	const data = await readSessionFile(root, sessionId)
	data.highlights.push(record)
	await writeSessionFile(root, sessionId, data)
	return record
}

/**
 * 按 id 删一条标记。id 不存在时 `{ removed: false }`（幂等，不报错）。
 */
export async function removeHighlight(root, sessionId, id) {
	if (typeof id !== 'string' || !id) throw new Error('id 不能为空')
	const data = await readSessionFile(root, sessionId)
	const before = data.highlights.length
	data.highlights = data.highlights.filter((h) => h && h.id !== id)
	const removed = data.highlights.length < before
	if (removed) await writeSessionFile(root, sessionId, data)
	return { removed, highlights: data.highlights }
}

function sendJson(res, status, value) {
	res.statusCode = status
	res.setHeader('Content-Type', 'application/json; charset=utf-8')
	res.end(JSON.stringify(value))
}

/** CORS + 预检：页面在 3080，端点在 3205，属于跨源，POST JSON 会先发 OPTIONS。 */
function cors(res) {
	res.setHeader('Access-Control-Allow-Origin', '*')
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
	res.setHeader('Access-Control-Allow-Headers', 'content-type')
	res.setHeader('Cache-Control', 'no-store')
}

async function readBody(req) {
	const chunks = []
	let size = 0
	for await (const chunk of req) {
		size += chunk.length
		if (size > 256 * 1024) throw new Error('请求体过大')
		chunks.push(chunk)
	}
	const text = Buffer.concat(chunks).toString('utf8').trim()
	if (!text) return {}
	return JSON.parse(text)
}

function validSid(sessionId) {
	return typeof sessionId === 'string' && SESSION_ID_RE.test(sessionId)
}

/** 供自检直接调用的请求处理器（不起真端口也能测逻辑）。root 可显式传（临时目录）。 */
export function createHandler(ctx, rootOverride) {
	return async function handler(req, res) {
		cors(res)
		const url = String(req.url || '')
		if (req.method === 'OPTIONS') {
			res.statusCode = 204
			res.end()
			return
		}
		try {
			const root = rootOverride || (await resolveStorageRoot())
			if (url.startsWith('/highlights/delete') && req.method === 'POST') {
				const body = await readBody(req)
				if (!validSid(body.sessionId)) {
					sendJson(res, 400, { ok: false, error: `不是合法的会话 id：${String(body.sessionId)}` })
					return
				}
				const result = await removeHighlight(root, body.sessionId, body.id)
				sendJson(res, 200, { ok: true, ...result })
				return
			}
			if (url.startsWith('/highlights') && req.method === 'GET') {
				const q = new URL(url, 'http://x').searchParams
				const sessionId = q.get('sessionId') || ''
				if (!validSid(sessionId)) {
					sendJson(res, 400, { ok: false, error: `不是合法的会话 id：${String(sessionId)}` })
					return
				}
				const highlights = await listHighlights(root, sessionId)
				sendJson(res, 200, { ok: true, sessionId, highlights })
				return
			}
			if (url.startsWith('/highlights') && req.method === 'POST') {
				const body = await readBody(req)
				if (!validSid(body.sessionId)) {
					sendJson(res, 400, { ok: false, error: `不是合法的会话 id：${String(body.sessionId)}` })
					return
				}
				let record
				try {
					record = await addHighlight(root, body.sessionId, body.highlight)
				} catch (err) {
					// 提交内容不合法是调用方的错（400），不是服务端坏了（500）
					if (err instanceof ValidationError) {
						sendJson(res, 400, { ok: false, error: String(err.message) })
						return
					}
					throw err
				}
				console.log(`[${PLUGIN}] 新增标记 ${record.id} → ${body.sessionId}（${record.color}）`)
				sendJson(res, 200, { ok: true, record })
				return
			}
			sendJson(res, 404, { ok: false, error: `未知端点：${req.method} ${url}` })
		} catch (err) {
			const message = String((err && err.message) || err)
			console.log(`[${PLUGIN}] 请求失败：${message}`)
			sendJson(res, 500, { ok: false, error: message })
		}
	}
}

let httpServer = null

export function apply(ctx) {
	bootLog(`apply 被调用（pid ${process.pid}）`)
	if (httpServer) return
	const handler = createHandler(ctx)
	try {
		httpServer = createServer((req, res) => {
			handler(req, res).catch((err) => {
				try {
					sendJson(res, 500, { ok: false, error: String((err && err.message) || err) })
				} catch {
					/* 头都发出去了就算了 */
				}
			})
		})
		httpServer.on('error', (err) => {
			// 端口被占不该拖垮宿主：标色会报"保存失败"，标记仍在本轮会话内存里有效
			console.log(`[${PLUGIN}] 端点未启动（${HTTP_PORT}）：${String((err && err.message) || err)}`)
			bootLog(`listen error 事件：${(err && err.code) || ''} ${String((err && err.message) || err)}`)
			httpServer = null
		})
		httpServer.on('listening', () => bootLog('listening 事件'))
		httpServer.on('close', () => bootLog('close 事件'))
		bootLog(`准备 listen 127.0.0.1:${HTTP_PORT}`)
		httpServer.listen(HTTP_PORT, '127.0.0.1', () => {
			bootLog('listen 回调触发')
			resolveStorageRoot()
				.then((root) =>
					console.log(`[${PLUGIN}] 已加载：端点 http://127.0.0.1:${HTTP_PORT}/highlights（存储 ${root}）`),
				)
				.catch((err) => console.log(`[${PLUGIN}] 存储根解析失败：${String((err && err.message) || err)}`))
		})
		bootLog('listen() 已发起')
		/**
		 * ⚠️ cordis 的 effect 契约：传入的 fn 在**激活时立即执行**，其**返回值**才是卸载器。
		 * 2026-11-09 真凶：把"关闭函数"直接传了进去 → 激活瞬间执行 → 刚 listen 完就被自己
		 * 关掉 → close 事件 → 3205 永远不在（netstat 空白、POST REFUSED 的根源）。
		 * 正确写法（对齐 archive/input-history）：外层返回内层卸载器。
		 */
		ctx.effect(() => () => {
			bootLog('cleanup 被调用')
			try {
				httpServer?.close()
			} catch {
				/* ignore */
			}
			httpServer = null
		}, 'highlight: http endpoint')
	} catch (err) {
		console.log(`[${PLUGIN}] 端点启动失败：${String((err && err.message) || err)}`)
		bootLog(`apply 内异常：${String((err && err.message) || err)}`)
	}
}

export const name = PLUGIN

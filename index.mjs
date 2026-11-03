/**
 * handoff —— 长期交接（Aurabot 扩展模块）v0.3.0
 *
 * 会话快到上限时：
 *   1. 让她用【自己的口吻】写 3–5 条笔记（第一人称，带情绪和判断），逐条写进记忆库
 *   2. 把「笔记 + 最后 N 条原话」一起存下来，并记下旧会话 id
 *   3. 归档旧会话
 *   4. 新会话开场把这两样都注入 → 不断档
 *   5. 她可以随时用 recall_history 按关键词翻旧章节原文
 *
 * 安装：整个文件夹放到 ~/.dsh/plugins-data/aurabot/modules/handoff/
 * 手动触发：主人在 QQ 里发 /交接   查看：/交接状态   自检：/交接自检
 */

import { readFile, writeFile, rename, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const DAY = 86400_000
const FRESH_MS = 6 * 3600_000 // 交接后 6 小时内连原话一起注入，之后只注入便条

// 交接提示语：不进对话缓冲区，免得下一张便条里写进"我换了个新本子"这种废话
const NOTICE_TEXT = '稍等我一下，脑子要装满了，我去倒点水出来。'
const HANDOFF_NOTICE = NOTICE_TEXT
const COMMAND_NOTICE = NOTICE_TEXT
const NOTICES = new Set([NOTICE_TEXT])

const DEFAULT_HINT = '用第一人称写，用「我」和「他」；像写给自己看的备忘录，带上你当时的情绪和判断，不要写成客观档案。最后几轮说了什么必须写清楚。'

export default {
  id: 'handoff',
  name: '长期交接',
  version: '0.3.0',
  api: 1,
  description: '会话快满时用她自己的口吻写交接便条、归档并开新会话，把最近原话一起带过去，不断档',
  defaults: {
    enabled: true,
    maxTokens: 100000,
    maxDays: 30,
    notify: true,
    recentLines: 40,
    hint: DEFAULT_HINT,
  },
  settings: [
    { key: 'enabled', label: '启用', type: 'boolean' },
    { key: 'maxTokens', label: '累计多少 token 后交接（10万 ≈ 十几天；50万 ≈ 半年）', type: 'number' },
    { key: 'maxDays', label: '最长多少天交接一次', type: 'number' },
    { key: 'recentLines', label: '交接时带走多少条最近原话', type: 'number' },
    { key: 'notify', label: '交接后跟主人说一句', type: 'boolean' },
    { key: 'hint', label: '交接便条的要求', type: 'text' },
  ],

  setup(api) {
    const stateFile = () => join(api.dataDir(), 'state.json')
    let state = { chats: {}, buffers: {} }
    let loaded = false
    const busy = new Set()

    const load = async () => {
      if (loaded) return
      loaded = true
      try {
        const parsed = JSON.parse(await readFile(stateFile(), 'utf8'))
        if (parsed && typeof parsed === 'object') {
          state = { chats: parsed.chats || {}, buffers: parsed.buffers || {} }
        }
      } catch {
        state = { chats: {}, buffers: {} }
      }
    }

    const save = async () => {
      const f = stateFile()
      const tmp = f + '.tmp'
      try {
        await writeFile(tmp, JSON.stringify(state, null, 2), 'utf8')
        await rename(tmp, f)
      } catch (error) {
        api.log.warn('交接状态保存失败：', error.message)
      }
    }

    const entry = (chatId) => {
      if (!state.chats[chatId]) {
        state.chats[chatId] = {
          count: 0, tokens: 0, since: Date.now(), lastHandoff: 0,
          lastSummary: '', lastSummaryAt: 0, lastLines: [], history: [],
        }
      }
      return state.chats[chatId]
    }

    /** 环形缓冲：她说的和对方说的都留，交接时带走 */
    const pushLine = (chatId, who, text) => {
      const t = String(text || '').replace(/\s+/g, ' ').trim()
      if (!t || NOTICES.has(t)) return
      const cap = Math.max(6, Math.min(80, Number(api.settings().recentLines) || 24))
      const buf = state.buffers[chatId] || (state.buffers[chatId] = [])
      buf.push({ who, text: t.slice(0, 300) })
      while (buf.length > cap) buf.shift()
      // 累计这个聊天的上下文估算（中文约 1.4 字 ≈ 1 token）
      const e = entry(chatId)
      e.tokens = (Number(e.tokens) || 0) + Math.ceil(t.length / 1.4)
    }

    /** 写交接便条：她自己的口吻 */
    const writeSummary = async (chatId, e) => {
      // 空字符串不能当成"用户想清空"，否则默认的第一人称要求会被无声覆盖
      const hint = String(api.settings().hint || '').trim() || DEFAULT_HINT
      const recent = (state.buffers[chatId] || [])
        .map((x) => `${x.who === 'me' ? '我' : '他'}：${x.text}`)
        .join('\n')

      // 从记忆库捞几条相关的，让便条有更长的纵深（不只最近这几十句）
      let memo = ''
      try {
        const memory = api.use('memory')
        if (memory && typeof memory.recall === 'function') {
          const hits = await memory.recall('最近在聊的事、约定、他的近况', { limit: 8 })
          memo = (Array.isArray(hits) ? hits : [])
            .map((x) => (typeof x === 'string' ? x : (x && x.text) || ''))
            .filter(Boolean)
            .slice(0, 8)
            .join('\n')
        }
      } catch (error) {
        api.log.debug('记忆召回失败：', error.message)
      }

      const prompt = [
        '现在你要把这段对话交给"明天的你"。明天的你看不到原话，只能读你写的这几条笔记——所以用你自己的口吻写，像在给自己留话。',
        '要求：',
        '1) 第一人称，用「我」和「他」，可以带情绪、带判断，不要写成档案或报告；',
        '2) 写 3–5 条，每条一句话、独立成条（方便以后单独翻到）：一条写最后在聊什么、一条写已经说定的事、一条写还没落地的事，有别的要紧事再加；',
        '3) 只输出 JSON 数组，不要任何解释、不要代码块标记，格式：',
        '[{"text":"……","importance":0.9},{"text":"……","importance":0.7}]',
        'importance 取 0–1，越是要紧的越高。',
        hint ? `额外要求：${hint}` : '',
        memo ? `\n（这是你记忆库里相关的几条，供你写笔记时参考更早的事）\n${memo}` : '',
        recent ? `\n（这是最近的对话原话，供你写笔记时对照，不要把原文抄进去）\n${recent}` : '',
      ].filter(Boolean).join('\n')

      let text = ''
      try {
        // 用 ask 而不是 think：think 会建一个 system:ext-handoff 会话（多出一个窗口），
        // ask 直接问一次模型、不进会话。上下文由下面的 recent 原话提供。
        text = await api.ask({ text: prompt, maxTokens: 900 })
      } catch (error) {
        api.log.warn(`交接便条生成失败（${chatId}）：${error.message}`)
      }
      text = String(text || '').trim()
      if (!text) return ''

      // 解析成 3–5 条独立笔记；模型不听话给了整段就整段当一条
      let items = []
      try {
        const m = text.match(/\[[\s\S]*\]/)
        if (m) items = JSON.parse(m[0])
      } catch { /* 忽略，走退化分支 */ }
      if (!Array.isArray(items) || !items.length) items = [{ text, importance: 0.9 }]
      items = items.filter((x) => x && x.text).slice(0, 6)
      if (!items.length) return ''

      // 逐条写进记忆库：每条能被单独检索到，比一条大便条更容易被想起
      const memory = api.use('memory')
      for (const it of items) {
        try {
          if (memory && typeof memory.add === 'function') {
            await memory.add({
              text: `【旧章节】${String(it.text).trim().slice(0, 300)}`,
              about: chatId,
              aboutName: '',
              importance: Math.max(0.5, Math.min(1, Number(it.importance) || 0.85)),
              tags: ['交接', '旧章节'],
              source: 'handoff',
              chatId,
            })
          }
        } catch (error) {
          api.log.warn('旧章节写记忆失败：', error.message)
        }
      }

      e.lastSummary = items.map((x) => `· ${String(x.text).trim()}`).join('\n')
      e.lastSummaryAt = Date.now()
      return e.lastSummary
    }

    const handoff = async (chatId, reason, opts = {}) => {
      if (busy.has(chatId)) return false
      const chat = (api.core.hub.sessions?.() || {})[chatId]
      if (!chat) return false

      busy.add(chatId)
      try {
        api.log.info(`开始交接 ${chatId}（${reason}）`)
        const e = entry(chatId)
        // 先把当前会话 id 记下来，以后"翻旧账"要靠它定位文件
        const curSid = ((api.core.hub.sessions?.() || {})[chatId] || {}).sessionId
        if (curSid) {
          const h = Array.isArray(e.history) ? e.history : (e.history = [])
          h.push({ id: curSid, at: Date.now(), reason })
          while (h.length > 500) h.shift() // 指针几乎不占地方，留够几年
        }
        const summary = await writeSummary(chatId, e)

        // 最近原话一并带走
        e.lastLines = (state.buffers[chatId] || []).slice(-Math.max(6, Number(api.settings().recentLines) || 24))

        // 归档 + 解绑：下条消息进来会新建会话
        const ok = api.core.hub.resetChat(chatId)
        e.count = 0
        e.tokens = 0
        e.since = Date.now()
        e.lastHandoff = Date.now()
        await save()

        const shouldNotify = opts.notify !== undefined ? opts.notify : api.settings().notify
        if (ok && shouldNotify) {
          try {
            await api.sendText(chatId, HANDOFF_NOTICE)
          } catch (error) {
            api.log.debug('交接提示发送失败：', error.message)
          }
        }
        api.log.info(`交接完成 ${chatId}：便条 ${summary.length} 字，带走原话 ${e.lastLines.length} 条`)
        return true
      } catch (error) {
        api.log.error(`交接失败 ${chatId}：${error.message}`)
        return false
      } finally {
        busy.delete(chatId)
      }
    }

    // 记录对方说的话 + 计数
    api.on('message', async (msg) => {
      try {
        await load()
        if (!msg || !msg.chatId) return false
        pushLine(msg.chatId, 'them', msg.text || msg.summary || '')
        if (api.settings().enabled) {
          const e = entry(msg.chatId)
          e.count += 1
          await save()
        }
      } catch (error) {
        api.log.debug('记录失败：', error.message)
      }
      return false
    })

    // 记录她自己发出去的话（最终消息段）
    api.on('send', async (message, meta) => {
      try {
        await load()
        const chatId = meta && meta.chatId
        if (!chatId) return undefined
        const segs = Array.isArray(message) ? message : [message]
        const text = segs
          .map((s) => (s && s.type === 'text' ? (s.data?.text || s.text || '') : ''))
          .filter(Boolean)
          .join(' ')
        if (text) pushLine(chatId, 'me', text)
      } catch (error) {
        api.log.debug('记录回复失败：', error.message)
      }
      return undefined
    })

    // 定期检查是否该交接
    api.every(60_000, async () => {
      try {
        await load()
        const cfg = api.settings()
        if (!cfg.enabled) return
        const maxTokens = Math.max(10000, Number(cfg.maxTokens) || 500000)
        const maxDays = Math.max(1, Number(cfg.maxDays) || 30)
        const now = Date.now()
        for (const [chatId, e] of Object.entries(state.chats || {})) {
          if (!e || busy.has(chatId)) continue
          const tooBig = (Number(e.tokens) || 0) >= maxTokens
          const tooOld = e.lastHandoff && now - e.lastHandoff >= maxDays * DAY
          if (tooBig || tooOld) {
            await handoff(chatId, tooBig ? `上下文约 ${Math.round((e.tokens || 0) / 1000)}k token` : `超过 ${maxDays} 天`)
          }
        }
      } catch (error) {
        api.log.warn('交接检查失败：', error.message)
      }
    }, '交接检查')

    // 新会话开场：便条 + 最近原话，一起注入
    api.context(({ chat }) => {
      if (!chat || !chat.chatId) return ''
      const e = (state.chats || {})[chat.chatId]
      if (!e || !e.lastSummary) return ''
      const fresh = Date.now() - (e.lastSummaryAt || 0) <= FRESH_MS

      const parts = [`【上一章·我自己写的交接便条】\n${e.lastSummary}`]
      if (fresh && Array.isArray(e.lastLines) && e.lastLines.length) {
        const lines = e.lastLines.map((x) => `${x.who === 'me' ? '我' : '他'}：${x.text}`).join('\n')
        parts.push(`【换本子前的最后几轮原话（接着这个聊，不要问他"我们刚才说到哪"）】\n${lines}`)
      }
      return parts.join('\n\n')
    })

    // ---------- 翻旧账：她自己回头翻以前的章节 ----------
    const sessionsRoot = join(homedir(), '.dsh', 'sessions')

    const findSessionFile = async (sessionId) => {
      try {
        const dirs = await readdir(sessionsRoot, { withFileTypes: true })
        for (const d of dirs) {
          if (!d.isDirectory()) continue
          const p = join(sessionsRoot, d.name, sessionId, 'session.v4.jsonl.zstd')
          try {
            const st = await stat(p)
            if (st.isFile()) return p
          } catch { /* 不在这个工作区，继续找 */ }
        }
      } catch (error) {
        api.log.debug('搜索会话目录失败：', error.message)
      }
      return null
    }

    const searchSession = async (file, kws, limit) => {
      const out = []
      const raw = zstdDecompressSync(await readFile(file)).toString('utf8')
      for (const line of raw.split('\n')) {
        if (!line) continue
        let o
        try { o = JSON.parse(line) } catch { continue }
        let who = ''
        let content = ''
        if (o.type === 'user/message') {
          who = '他'
          content = (o.data?.content || []).map((c) => c?.text || '').join('')
        } else if (o.type === 'assistant/message') {
          who = '我'
          content = (o.data?.message?.content || []).filter((c) => c?.type === 'text').map((c) => c?.text || '').join('')
        } else {
          continue
        }
        content = String(content || '').trim()
        if (!content || content.startsWith('【系统提醒')) continue
        const low = content.toLowerCase()
        if (!kws.some((k) => low.includes(k))) continue
        out.push({ t: o.time || 0, who, text: content.slice(0, 260) })
        if (out.length >= limit) break
      }
      return out
    }

    api.tool(({ chat }) => {
      if (!chat || chat.kind === 'system') return []
      return api.defineTool({
        name: 'recall_history',
        description: '想不起以前聊过的具体内容时，按关键词翻自己以前的聊天记录（已经换过本子的旧章节）。只读，不会打扰对方。',
        properties: {
          query: { type: 'string', description: '要找的关键词，比如「那个游戏」「搬家」「答应他的事」' },
          limit: { type: 'number', description: '最多返回几条，默认 6' },
        },
        required: ['query'],
        execute: async ({ query, limit }) => {
          await load()
          const kws = String(query || '').toLowerCase().split(/[\s,，。、]+/).filter(Boolean)
          if (!kws.length) return { ok: false, message: '给我个关键词我才好翻。' }
          const want = Math.max(1, Math.min(20, Number(limit) || 6))
          const hits = []
          // 护栏：一次最多翻 80 个旧章节，避免搜一次卡十几秒
          let scanned = 0
          outer:
          for (const e of Object.values(state.chats || {})) {
            for (const h of (e.history || []).slice().reverse()) {
              if (!h || !h.id) continue
              if (++scanned > 80) break outer
              const file = await findSessionFile(h.id)
              if (!file) continue
              try {
                hits.push(...(await searchSession(file, kws, want)))
              } catch (error) {
                api.log.debug('读旧会话失败：', error.message)
              }
              if (hits.length >= want) break outer
            }
          }
          if (!hits.length) return { ok: true, message: '翻过了，没找到相关的话。' }
          const text = hits.slice(0, want).map((h) => {
            const d = h.t ? new Date(h.t) : null
            const when = d
              ? `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
              : '某天'
            return `[${when}] ${h.who}：${h.text}`
          }).join('\n')
          return { ok: true, message: text }
        },
      })
    })

    api.rule(() => '你能翻自己以前的聊天记录：想不起具体内容时，用 recall_history 按关键词查旧章节（只读）。翻到了就用你自己的话说出来，别报工具名。')

    api.command({
      name: '交接',
      desc: '立刻交接一次：用自己的口吻写便条、归档当前会话、开新的一章',
      async run(arg, msg) {
        await load()
        const ownerQQ = String((api.config() || {}).ownerQQ || '')
        // 哪个聊天发的就交接哪个（群里发也能交接群）
        const chatId = (msg && msg.chatId) || `private:${ownerQQ}`
        const ok = await handoff(chatId, '主人手动', { notify: false })
        return ok ? COMMAND_NOTICE : '现在交接不了（会话没在跑或正在交接中）。'
      },
    })

    api.command({
      name: '交接自检',
      desc: '检查交接模块健康度：开关、阈值、便条、历史可翻、计数是否在涨',
      async run() {
        await load()
        const cfg = api.settings()
        const lines = []
        lines.push(`开关 ${cfg.enabled ? '开' : '关'}｜阈值 ${Math.round((Number(cfg.maxTokens) || 500000) / 1000)}k token 或 ${cfg.maxDays || 30} 天`)
        lines.push(`记忆召回 ${(api.config().memory || {}).recallCount ?? '?'} 条/轮｜带走原话 ${cfg.recentLines} 条`)

        let okHist = 0
        let badHist = 0
        for (const [chatId, e] of Object.entries(state.chats || {})) {
          const k = Math.round((Number(e.tokens) || 0) / 1000)
          const buf = (state.buffers[chatId] || []).length
          lines.push(`\n${chatId}：${k}k token，${e.count || 0} 条消息，缓冲 ${buf} 条`)
          const s = String(e.lastSummary || '').trim()
          lines.push(`  便条：${s ? s.split('\n').length + ' 条，例如「' + s.split('\n')[0].slice(0, 30) + '…」' : '（还没有）'}`)
          for (const h of (e.history || []).slice(-5)) {
            const f = await findSessionFile(h.id)
            if (f) okHist += 1
            else badHist += 1
          }
        }
        lines.push(`\n历史会话：${okHist} 个能读到，${badHist} 个找不到`)
        lines.push(badHist ? '⚠️ 有历史定位不到，可能是工作区换了或会话被删' : '✅ 翻旧账可用')
        return lines.join('\n')
      },
    })

    api.command({
      name: '交接状态',
      desc: '看看每个聊天攒了多少条、上次交接什么时候',
      async run() {
        await load()
        const cfg = api.settings()
        const lines = Object.entries(state.chats || {}).map(([id, e]) => {
          const days = e.lastHandoff ? ((Date.now() - e.lastHandoff) / DAY).toFixed(1) : '—'
          const buf = (state.buffers[id] || []).length
          const k = Math.round((Number(e.tokens) || 0) / 1000)
          const lim = Math.round((Number(cfg.maxTokens) || 500000) / 1000)
          return `${id}：约 ${k}k / ${lim}k token（${e.count || 0} 条，缓冲 ${buf} 条），上次交接 ${days} 天前`
        })
        return lines.length ? lines.join('\n') : '还没有记录。'
      },
    })

    api.log.info('长期交接模块已加载 v0.3.0（便条拆条 + 翻旧账 + 10万token）')
    return {}
  },
}

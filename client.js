window.__ModuleLoader__.load({
  id: '@qiniu/dsh-agentapi',
  factory(require) {
    const React = require('react')
    const { rankByName, Menu, IconChevronDownOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const { useState, useEffect } = React
    const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
    const cloudPath = 'M6.5 18a4.5 4.5 0 0 1-.4-9 6.2 6.2 0 0 1 11.8-.7A4.9 4.9 0 1 1 18 18Z'
    const CloudIcon = ({ size = 16, ...props }) => h('svg', { ...props, width: size, height: size,
      viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, 'aria-hidden': true }, h('path', { d: cloudPath }))
    // Desktop 0.2.2 exposes the catalog footer as a slot, but owns the rows and breadcrumb.
    // Decorate only identified cloud children. Navigation, focus and the status dots remain native.
    function installCatalog(sessions, call) {
      const glyph = encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="none" stroke="black" stroke-width="1.6" d="' + cloudPath + '"/></svg>')
      const css = document.createElement('style')
      css.textContent = `
        [data-xa-cloud-title],[data-xa-cloud-state],[data-xa-cloud-tokens]{font-size:0!important}
        [data-xa-cloud-title]::before{content:"";display:inline-block;width:15px;height:15px;margin-right:5px;vertical-align:-2px;background:currentColor;mask:url("data:image/svg+xml,${glyph}") center/contain no-repeat}
        [data-xa-cloud-title]::after{content:attr(data-xa-cloud-title);font-size:13px}
        [data-subagent-action] button>[data-xa-cloud-title]::after{font-size:14px}
        [data-xa-cloud-state]::after{content:attr(data-xa-cloud-state);font-size:12px}
        [data-xa-cloud-tokens]::after{content:attr(data-xa-cloud-tokens);font-size:12px;font-variant-numeric:tabular-nums}
        [data-xa-cloud-chat] [data-composer-card] input[type="file"] + div button:has(>[class$="_triggerLabel"]){display:none}
        .xa-catalog-voice{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
      `
      document.head.append(css)
      const cache = new Map()
      const activities = new Map()
      const originalTitles = new WeakMap()
      const control = new AbortController()
      const region = '[data-subagent-action],[data-subagent-panel],[data-conversation-session]'
      let frame = 0, timer, request
      function setTitle(el, value) {
        if (!originalTitles.has(el)) originalTitles.set(el, el.getAttribute('title'))
        el.title = value
      }
      function paint(row, entry, data) {
        const content = row.querySelector(':scope > div > span:nth-child(2)')
        const title = content?.firstElementChild, name = content?.lastElementChild
        if (!title || title === name || title.textContent !== entry.label || name.textContent !== entry.name) return
        title.dataset.xaCloudTitle = entry.label.replace(/^云端 · /, '')
        title.setAttribute('aria-hidden', 'true')
        const state = data?.label || '读取状态中'
        name.dataset.xaCloudState = state
        name.setAttribute('aria-hidden', 'true')
        setTitle(name, data?.reason || entry.name)
        const tokens = data?.usage?.totalTokens
        const token = content.nextElementSibling?.querySelector('span:first-child')
        const metric = tokens == null ? '— tok' : compact.format(tokens).replace('K', 'k') + ' tok'
        if (token && /\btok\b/.test(token.textContent)) {
          token.dataset.xaCloudTokens = metric
          token.setAttribute('aria-hidden', 'true')
          setTitle(token, tokens == null ? '云端用量尚未返回' : tokens.toLocaleString('en-US') + ' tok（云端累计，含缓存）')
        }
        let voice = row.querySelector(':scope > .xa-catalog-voice')
        if (!voice) {
          voice = document.createElement('span')
          voice.className = 'xa-catalog-voice'
          voice.id = 'xa-cloud-' + crypto.randomUUID()
          row.append(voice)
          row.setAttribute('aria-labelledby', voice.id)
        }
        const speech = [entry.label, state, tokens == null ? '用量待回传' : metric,
          token?.nextElementSibling?.textContent].filter(Boolean).join('，')
        if (voice.textContent !== speech) voice.textContent = speech
      }
      function scan() {
        frame = 0
        if (control.signal.aborted) return
        clearTimeout(timer)
        const rows = document.querySelectorAll('[data-subagent-panel] [role="treeitem"]')
        const switches = document.querySelectorAll('[data-subagent-action] button[aria-haspopup="dialog"] > span:first-child')
        const known = new Map()
        const list = sessions.list.getSnapshot()
        for (const projection of Object.values(list.projectionsBySession)) {
          for (const e of projection.values?.subagentCatalog || []) {
            if (e.mode === 'continuable' && e.name === 'cloud-' + e.id.slice(0, 8) && e.label.startsWith('云端 · ')) known.set(e.name, e)
          }
        }
        const cloudIds = new Set([...known.values()].map(e => e.id))
        for (const chat of document.querySelectorAll('[data-conversation-session]')) {
          const id = chat.dataset.conversationSession
          const cloud = cloudIds.has(id) || sessions.binding(id)?.eventSource.getSnapshot().entries.some(
            ({ event }) => event.type === 'subagent/descriptor' && event.data.provider === 'agentapi-cloud')
          chat.toggleAttribute('data-xa-cloud-chat', !!cloud)
        }
        const labels = new Set([...known.values()].map(e => e.label))
        for (const el of switches) {
          if (labels.has(el.textContent)) el.dataset.xaCloudTitle = el.textContent.replace(/^云端 · /, '')
          else delete el.dataset.xaCloudTitle
        }
        const due = new Set()
        let next = Infinity
        for (const row of rows) {
          const entry = known.get(row.querySelector(':scope > div > span:nth-child(2) > span:last-child')?.textContent)
          if (!entry) continue
          const cached = cache.get(entry.id)
          const running = list.byId[entry.id]?.running === true
          if (activities.has(entry.id) && activities.get(entry.id) !== running && cached) cached.expires = 0
          activities.set(entry.id, running)
          paint(row, entry, cached?.data)
          const delay = (cached?.expires || 0) - Date.now()
          if (delay <= 0) due.add(entry.id)
          else next = Math.min(next, delay)
        }
        if (due.size && !request) {
          const ids = [...due].slice(0, 100)
          request = call('catalog', { ids }, control.signal).then(items => {
            const found = new Map(items.map(item => [item.id, item]))
            for (const id of ids) {
              const data = found.get(id)
              cache.set(id, { data: data ?? { label: '状态暂不可用' }, expires: Date.now() + (data && ['completed','cancelled','failed'].includes(data.status) ? 5000 : 1500) })
            }
          }).catch(() => {
            for (const id of ids) cache.set(id, { data: cache.get(id)?.data ?? { label: '状态暂不可用' }, expires: Date.now() + 5000 })
          }).finally(() => { request = null; schedule() })
        } else if (Number.isFinite(next)) timer = setTimeout(schedule, next)
      }
      function schedule() {
        if (!frame && !control.signal.aborted) frame = requestAnimationFrame(scan)
      }
      const observer = new MutationObserver(records => {
        if (records.some(r => r.target.parentElement?.closest(region) || r.target.closest?.(region) ||
          [...r.addedNodes, ...r.removedNodes].some(n => n.matches?.(region) || n.querySelector?.(region)))) schedule()
      })
      observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['aria-label'] })
      const off = sessions.list.subscribe(schedule)
      schedule()
      return () => {
        control.abort(); observer.disconnect(); off(); cancelAnimationFrame(frame); clearTimeout(timer); css.remove()
        for (const el of document.querySelectorAll('[data-xa-cloud-title],[data-xa-cloud-state],[data-xa-cloud-tokens]')) {
          if (el.closest('[role="treeitem"]')) el.removeAttribute('aria-hidden')
          delete el.dataset.xaCloudTitle; delete el.dataset.xaCloudState; delete el.dataset.xaCloudTokens
          if (originalTitles.has(el)) {
            const prior = originalTitles.get(el)
            if (prior === null) el.removeAttribute('title')
            else el.title = prior
          }
        }
        for (const el of document.querySelectorAll('[data-xa-cloud-chat]')) el.removeAttribute('data-xa-cloud-chat')
        for (const el of document.querySelectorAll('.xa-catalog-voice')) {
          el.parentElement?.removeAttribute('aria-labelledby'); el.remove()
        }
      }
    }
    const css = `
      .xa{--line:var(--dsw-alias-border-l2,rgba(128,128,128,.25));--muted:var(--dsw-alias-label-secondary,#717780);--accent:var(--dsw-alias-brand-primary,#4562ad);font-family:inherit;color:inherit;line-height:1.55}
      .xa *{box-sizing:border-box}.xa h2,.xa h3,.xa p{margin:0}.xa h2{font-size:22px;line-height:1.3;font-weight:650}.xa h3{font-size:15px}
      .xa-page{width:min(100%,680px);padding:6px 8px 20px 0;display:grid;gap:20px}.xa-head,.xa-row{display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap}
      .xa-sub,.xa small{color:var(--muted);font-size:12px}.xa-box{border:1px solid var(--line);border-radius:12px;padding:16px 18px;display:grid;gap:12px}
      .xa label{font-weight:550;font-size:13px;display:grid;gap:6px}.xa input{width:100%;min-width:0;font:inherit;font-size:13px;color:inherit;background:var(--dsw-alias-bg-base,transparent);border:1px solid var(--line);border-radius:7px;padding:8px 10px}
      .xa :focus-visible{outline:2px solid var(--accent);outline-offset:2px}.xa a{font-size:13px;color:var(--accent);text-decoration:underline;text-underline-offset:3px}
      .xa-cols{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(190px,100%),1fr));gap:12px}
      .xa button{font:inherit;font-size:13px;color:inherit;background:transparent;border:1px solid var(--line);padding:6px 11px;border-radius:7px;cursor:pointer}.xa button:disabled{opacity:.55;cursor:default}
      .xa button.xa-save{color:white;background:#405ead;border-color:#405ead;font-weight:550;padding:8px 16px}.xa summary{cursor:pointer;font-weight:550}.xa details[open]>summary{margin-bottom:10px}
      .xa-field{min-width:0;display:grid;gap:6px;font-size:13px;font-weight:550}.xa-field>*{min-width:0;max-width:100%}.xa button.xa-picker{width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px}.xa-picker>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.xa-picker svg{flex:none;color:var(--muted)}
      .xa-note{font-size:13px;color:var(--muted)}.xa-error{color:var(--dsw-alias-label-error,#b94b48)}.xa-status{font-size:12px;display:inline-flex;align-items:center;gap:6px}.xa-dot{width:7px;height:7px;background:currentColor;border-radius:50%}.xa-good{color:var(--dsw-alias-label-success,#268667)}
    `
    const style = () => h('style', null, css)
    const link = (url, label) => h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, label + ' ↗')
    function Picker({ label, value, items, disabled, onChange }) {
      const [open, setOpen] = useState(false)
      const current = items.find(item => item.id === value)?.label ?? value
      return h('div', { className: 'xa-field' }, h('span', null, label),
        h(Menu, { open: open && !disabled, items, selectedId: value, side: 'bottom',
          onClose: () => setOpen(false), onSelect: id => { setOpen(false); onChange(id) },
          anchor: h('button', { type: 'button', className: 'xa-picker', disabled,
            'aria-label': label + ' · ' + current, 'aria-haspopup': 'menu', 'aria-expanded': open && !disabled,
            onClick: () => setOpen(!open) }, h('span', null, current), h(IconChevronDownOutlineRegular, { size: 14 })),
        }))
    }
    const status = (label, good) => h('span', { className: 'xa-status' + (good ? ' xa-good' : '') }, h('i', { className: 'xa-dot' }), label)
    return {
      inject: ['slots', 'connection', 'sessions', 'inputTriggers', 'uiConversation'],
      apply(ctx) {
        // DSH settles an entire assistant step on any appended assistant/message.
        // Remote tool-call envelopes belong to history. Their tool/call and
        // tool/result events already drive the native cards in the transcript.
        ctx.uiConversation.events.register({
          kind: 'agentapi-cloud-tool-envelope', target: 'chat',
          match: { 'assistant/message'(event) {
            const { source, content } = event.data.message
            return event.surfaceOp === 'append' && source?.provider === 'agentapi-cloud' &&
              content.length === 1 && content[0].type === 'tool-call' && content[0].id.startsWith('cloud-')
              ? { id: String(event.seq), role: 'start', exclusive: true } : null
          } },
          start: () => null, update: () => null, buildViewNode: () => null,
        })
        // A menu pick inserts a routing cue into the normal composer, keeping its files and history.
        const cloud = { name: 'cloud', label: '云端智能体', icon: CloudIcon }
        ctx.effect(() => ctx.inputTriggers.registerSource({
          name: 'managed-cloud', trigger: '/', order: 1, showGroupTitle: false,
          async candidates(session, { query, position }) {
            if (position !== 'leading' || ctx.sessions.subagentAddress(session.sessionId)) return []
            return rankByName([cloud], query)
          },
          onPick() { return { text: '/cloud ' } },
        }))
        const guidance = 'Your final answer is delivered automatically if your parent is still online. Include the result and relevant evidence in that answer; the parent does not receive your full transcript, tool output, or reasoning. If your last action is a message to your parent, the completion notice omits your final answer; include the result and relevant evidence in that message.'
        ctx.uiConversation.userText.register({
          id: 'cloud-delivery-guidance', order: 30,
          match(text, from) {
            const start = text.length - guidance.length
            if (start < from || !text.endsWith(guidance)) return
            return { id: 'cloud-delivery-guidance', start, end: text.length, data: { prompt: text.slice(0, start) } }
          },
        })
        ctx.slots.inject('conversation.user.text.node', () => ctx.slots.register({
          name: 'conversation.user.text.node', key: 'cloud-delivery-guidance', priority: 100,
          inject: sessionId => ({ cloudLaunchNote(prompt) {
            const events = ctx.sessions.binding(sessionId)?.eventSource.getSnapshot().entries
            if (!events?.some(({ event }) => event.type === 'subagent/descriptor' && event.data.provider === 'agentapi-cloud')) return false
            const first = events.find(({ event }) => event.type === 'user/message' && event.data.source?.kind === 'user')
            const blocks = first?.event.data.content
            return blocks?.length === 2 && blocks[0].text === prompt && blocks[1].text === guidance
          } }),
        }, ({ node, raw, cloudLaunchNote }) => cloudLaunchNote(node.data.prompt) ? null : raw))

        // A cold-opened cloud chat needs its owning ordinary Session for continuation admission.
        function CloudOwner({ sessionId, useSession, useSessions }) {
          const parentId = useSession(s => s.subagent?.address.parentSessionId)
          const rootId = useSessions(s => {
            const catalog = s.projectionsBySession[parentId]?.values?.subagentCatalog
            if (!catalog?.some(e => e.id === sessionId && e.name === 'cloud-' + sessionId.slice(0, 8))) return null
            let root = parentId
            const seen = new Set()
            while (s.byId[root]?.origin === 'subagent') {
              if (seen.has(root)) return null
              seen.add(root)
              root = s.byId[root].parentId
            }
            return root
          })
          useEffect(() => {
            if (!rootId) return
            const ref = ctx.sessions.retain(rootId, { source: 'cloudConversation' })
            ref.ready.catch(() => {})
            return () => ref.release()
          }, [rootId])
          return null
        }
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
          name: 'conversation.session.header.actions', id: 'cloud-owner', order: 11,
        }, CloudOwner))

        async function call(method, data = {}, signal) {
          const reply = await ctx.connection.rpc.call('/api', 'agentapi-cloud.' + method, data, signal || AbortSignal.timeout(60000))
          if (!reply.ok) throw new Error(reply.error?.message || '无法连接 Harness')
          return reply.value
        }
        ctx.effect(() => installCatalog(ctx.sessions, call))
        function Settings() {
          const [info, setInfo] = useState(null), [draft, setDraft] = useState(null), [key, setKey] = useState('')
          const [resources, setResources] = useState(null), [busy, setBusy] = useState(false)
          const [advanced, setAdvanced] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
          const accept = value => { setInfo(value); setDraft(value.settings) }
          useEffect(() => {
            const control = new AbortController()
            call('settings', {}, control.signal).then(accept).catch(e => { if (!control.signal.aborted) setError(e.message) })
            return () => control.abort()
          }, [])
          useEffect(() => {
            if (!info?.configured || (!advanced && !draft?.agentId && !draft?.environmentId)) return
            const control = new AbortController()
            call('resources', {}, control.signal).then(setResources).catch(e => { if (!control.signal.aborted) setError(e.message) })
            return () => control.abort()
          }, [advanced, info])
          const update = patch => { setDraft({ ...draft, ...patch }); setNotice(''); setError('') }
          async function save(event) {
            event.preventDefault()
            setBusy(true); setError(''); setNotice('')
            try {
              accept(await call('save', { key, settings: draft }))
              setKey(''); setNotice('已连接 AgentAPI，设置已保存。')
            } catch (e) { setError(e.message) } finally { setBusy(false) }
          }
          if (!draft) return h('p', { role: 'status' }, error || '正在读取 AgentAPI 设置…')
          const selected = resources?.agents.find(row => row.id === draft.agentId)
          const resourceSelect = (label, field, items) => h(Picker, { label, value: draft[field],
            disabled: !info.configured || !!key || !items, onChange: id => update({ [field]: id }),
            items: [{ id: '', label: '自动创建或复用' }, ...(items || []).map(r => ({ id: r.id, label: r.name }))] })
          return h('form', { className: 'xa xa-page', onSubmit: save }, style(),
            h('header', { className: 'xa-head' }, h('div', null, h('h2', null, '云端智能体'), h('p', { className: 'xa-sub' }, 'AgentAPI')), link(info.portal, '打开 Portal')),
            h('section', { className: 'xa-box' }, h('div', { className: 'xa-row' }, h('h3', null, '账号连接'), status(info.configured ? '已保存凭证' : '未连接', info.configured)),
              h('label', null, 'API Key', h('input', { type: 'password', autoComplete: 'off', spellCheck: false, value: key,
                placeholder: info.configured ? '已保存，可输入新 Key 替换' : '输入 AgentAPI Key',
                onChange: e => { setKey(e.target.value); setNotice(''); setError('') } })),
              h('div', { className: 'xa-row' }, h('small', null, '凭证由 DeepSeek Harness 保存。'), link(info.portal + '/settings', '获取 API Key'))),
            h('section', { className: 'xa-box' }, h('h3', null, '执行配置'),
              h('div', { className: 'xa-cols' },
                h(Picker, { label: '运行时', value: selected?.runtime || draft.runtime, disabled: !!draft.agentId,
                  items: Object.entries(info.runtimes).map(([id, label]) => ({ id, label })),
                  onChange: runtime => update({ runtime, model: info.models[runtime][0] }) }),
                h(Picker, { label: '模型', value: selected?.model || draft.model, disabled: !!draft.agentId,
                  items: (selected ? [selected.model] : info.models[draft.runtime]).map(id => ({ id, label: id })),
                  onChange: model => update({ model }) })),
              h('p', { className: 'xa-note' }, draft.agentId ? (selected?.description || '沿用所选 Agent 的运行时和模型。') : '首次派发时准备默认 Agent 和云环境。每项任务使用独立 Session。'),
              h('details', { onToggle: e => setAdvanced(e.currentTarget.open) }, h('summary', null, '高级设置'),
                h('div', { className: 'xa-cols' }, resourceSelect('Agent', 'agentId', resources?.agents), resourceSelect('云环境', 'environmentId', resources?.environments)),
                h('small', null, info.configured ? '连接地址 · ' + info.endpoint : '先保存并连接，即可选择已有资源。'))),
            h('div', { className: 'xa-row' }, h('span', { role: 'status', className: error ? 'xa-error' : 'xa-sub' }, error || notice),
              h('button', { className: 'xa-save', disabled: busy || (!info.configured && !key.trim()), type: 'submit' }, busy ? '正在连接…' : '保存并连接')))
        }
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'xgrowthlab-agentapi', order: 64, label: '云端智能体' }, Settings))
        ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
          name: 'settings.section.icon', id: 'xgrowthlab-agentapi',
        }, ({ size }) => h(CloudIcon, { size })))
      },
    }
  },
})

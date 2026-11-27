import { setTimeout as sleep } from 'node:timers/promises'
import { endpoint } from './agentapi.js'

// The server replays committed events before live previews on every connection.
export async function* sseEvents(stream) {
  let buffer = ''
  const decoder = new TextDecoder()
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true })
    let boundary
    while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
      const frame = buffer.slice(0, boundary.index)
      buffer = buffer.slice(boundary.index + boundary[0].length)
      const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n')
      if (data && data !== '[DONE]') yield JSON.parse(data)
    }
    if (buffer.length > 16 * 1024 * 1024) throw new Error('事件超过单帧大小上限')
  }
}

// On disconnect, replay this turn's committed records. The consumer deduplicates by sequence.
export async function* liveEvents(api, task, signal, polling) {
  const control = new AbortController()
  try {
    const url = endpoint + '/v1/sessions/' + encodeURIComponent(task.sessionId) + '/events/stream?event_deltas[]=agent.message'
    const response = await api.fetcher(url, {
      headers: { 'x-api-key': api.key, accept: 'text/event-stream' }, redirect: 'error',
      signal: AbortSignal.any([signal, control.signal, ...(polling ? [polling] : [])]),
    })
    if (response.ok) {
      // DSH's network inspector can hold a clone open. Release our reader on
      // turn end so the finally below can abort the fetch for both readers.
      yield* sseEvents(response.body.values({ preventCancel: true }))
    }
  } catch {
    signal.throwIfAborted()
  } finally { control.abort() }

  let cursor = task.inputSeq == null ? undefined : task.inputId
  let failures = 0, shownError
  while (true) {
    signal.throwIfAborted()
    if (task.interruptError && task.interruptError !== shownError) {
      shownError = task.interruptError
      yield { type: 'cloud.interrupt_error', attempt: shownError, message: task.reason }
    }
    const query = new URLSearchParams({ order: 'asc', limit: '100' })
    if (cursor) query.set('page', cursor)
    let page
    try {
      page = await api.request('sessions/' + task.sessionId + '/events?' + query, { signal })
      failures = 0
    } catch (error) {
      if (signal.aborted || [400, 401, 403, 404].includes(error.status)) throw error
      await sleep(Math.min(30000, 1000 * 2 ** Math.min(++failures, 5)), undefined, { signal })
      continue
    }
    for (const e of page.data) {
      if (e.processed_at == null) break
      cursor = e.id
      yield e
    }
    if (!page.next_page || page.data.at(-1)?.id !== cursor) await sleep(1400, undefined, { signal })
  }
}

export function textChunks() {
  let current, index = 0
  function* end() {
    if (!current) return
    yield { type: 'block-end', index, block: { type: 'text', text: current.text } }
    current = undefined
    index++
  }
  function* add(id, text) {
    if (!text) return
    if (!current || current.id !== id) {
      yield* end()
      current = { id, text: '' }
      yield { type: 'block-start', index, blockType: 'text' }
    }
    current.text += text
    yield { type: 'text-delta', index, text }
  }
  return { add, end, *complete(id, text) {
    if (current?.id === id) {
      if (text.startsWith(current.text)) yield* add(id, text.slice(current.text.length))
      else current.text = text // The committed block is authoritative.
    } else yield* add(id, text)
    yield* end()
  } }
}

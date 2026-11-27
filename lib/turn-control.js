// Keep the DSH turn open until AgentAPI reports how the remote turn actually ended.
export function cloudTurnControl(local, task, api, { pause, persist, replaying = false }) {
  const original = local.cancel
  const polling = new AbortController()
  let request, cause, cancelOptions, steer = false, closed = false
  const settled = Promise.withResolvers()
  function send() {
    if (closed || replaying || !task.inputId || request || (!cause && !steer) || ['collecting', 'completed', 'failed', 'cancelled'].includes(task.status)) return
    task.status = 'cancelling'
    task.reason = ''
    delete task.interruptError
    void persist().catch(() => {})
    request = api.send(task.sessionId, [{ type: 'user.interrupt' }])
    polling.abort()
    void request.catch(error => {
      if (closed) return
      request = undefined
      task.interruptError = Date.now()
      task.reason = '中断请求未确认，可再次点击停止。' + error.message
      void persist().catch(() => {})
    })
  }
  function cancel(reason, options) {
    if (!['user', 'parent'].includes(reason.kind)) return original.call(local, reason, options)
    pause(reason.kind)
    if (!task.sending) return original.call(local, reason, options)
    cause = reason
    cancelOptions = options
    send()
  }
  local.cancel = cancel
  return {
    polling: polling.signal, settled: settled.promise, send,
    caughtUp() { replaying = false; send() },
    steer() { steer = true; send() },
    get steering() { return steer && !cause },
    confirm() {
      if (task.status === 'cancelled' && cause) original.call(local, cause, cancelOptions)
    },
    close() {
      closed = true
      delete task.interruptError
      if (local.cancel === cancel) {
        if (Object.getPrototypeOf(local).cancel === original) delete local.cancel
        else local.cancel = original
      }
      settled.resolve()
    },
  }
}

export function lastHumanId(agent) {
  return agent?.session.deriveMessages().findLast(m => m.role === 'user' && m.source?.kind === 'user')?.id ?? null
}

export function pausedForParent(task, parent) {
  return Object.hasOwn(task, 'pausedAtParentMessage') && (!parent || lastHumanId(parent) === task.pausedAtParentMessage)
}

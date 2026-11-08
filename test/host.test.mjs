import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'

import { apply, __testing } from '../index.js'

const ENTRY = __testing.ENDPOINT

function text(role, value) {
  return { role, content: [{ type: 'text', text: value }] }
}

function toolCall(id, name, args) {
  return { role: 'assistant', content: [{ type: 'tool-call', id, name, arguments: JSON.stringify(args) }] }
}

function toolResult(callId, value, isError = false) {
  return { role: 'tool', toolCallId: callId, isError, content: [{ type: 'text', text: value }] }
}

const SONNET_MODEL = {
  reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }, { id: 'max' }] },
}

function makeSession(messages, options = {}) {
  return {
    seq: options.seq ?? 1,
    requestHeader: () => (options.route === null ? undefined : { config: options.route ?? { provider: 'claude2', model: 'claude-sonnet-5-5' } }),
    deriveMessages: () => messages,
  }
}

function makeHarness(options = {}) {
  const routes = new Map()
  const sessions = new Map()
  const llmCalls = []
  const listCalls = []
  const disposers = []
  let reply = options.reply ?? 'ok'
  let finish = options.finish ?? { kind: 'stop' }
  let failing = options.fail === true
  const catalog = options.catalog ?? { claude2: ['claude-opus-5-5', 'claude-sonnet-5-5'], 'deepseek-zcode': ['deepseek-flash'] }

  const llm = {
    async listProviders() {
      return Object.keys(catalog).map((id) => ({ id, name: id }))
    },
    async listModels(provider) {
      listCalls.push(provider)
      if (catalog[provider] === undefined) throw new Error('unknown provider')
      return catalog[provider].map((id) => ({ provider, id, name: id }))
    },
    async prepareCall(config, _signal, configure) {
      const model = options.model ?? SONNET_MODEL
      const controls = configure === undefined ? { ...config } : configure({ ...config }, model)
      return {
        config: { ...config, ...controls },
        async *stream(request) {
          llmCalls.push({ config, controls, request })
          if (failing) throw new Error('model exploded')
          const chunks = typeof reply === 'function' ? reply(request) : [{ type: 'text-delta', text: reply }]
          for await (const chunk of chunks) yield chunk
          yield { type: 'finish', reason: finish }
        },
      }
    },
  }

  const ctx = {
    effect(fn) {
      const dispose = fn()
      if (dispose) disposers.push(dispose)
      return () => dispose?.()
    },
    webServer: {
      register(route) {
        routes.set(route.path, route)
        return () => routes.delete(route.path)
      },
    },
    sessions: { get: (id) => sessions.get(id) },
    connection: { admit: options.admit ?? (() => ({ peer: { principal: { kind: 'owner' } } })) },
    llm,
    get: (key) => (key === 'agentDefaultModel' ? options.fallbackModel : undefined),
  }

  apply(ctx, options.config)
  return {
    routes,
    sessions,
    llmCalls,
    listCalls,
    dispose: () => disposers.reverse().forEach((fn) => fn()),
    setReply(value) {
      reply = value
    },
    setFinish(value) {
      finish = value
    },
    setFail(value) {
      failing = value
    },
  }
}

function makeRequest(body, { method = 'POST', contentType = 'application/json' } = {}) {
  const request = new EventEmitter()
  request.method = method
  request.headers = contentType === null ? {} : { 'content-type': contentType }
  request.destroy = () => {}
  setImmediate(() => {
    if (body !== undefined) request.emit('data', Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)))
    request.emit('end')
  })
  return request
}

function makeResponse() {
  const response = new EventEmitter()
  response.writableEnded = false
  response.status = 0
  response.headers = {}
  response.chunks = []
  response.writeHead = (status, headers) => {
    response.status = status
    response.headers = headers ?? {}
  }
  response.flushHeaders = () => {}
  response.write = (chunk) => {
    response.chunks.push(String(chunk))
    return true
  }
  response.end = (chunk) => {
    if (chunk !== undefined) response.chunks.push(String(chunk))
    response.writableEnded = true
    response.emit('finish')
  }
  return response
}

function callRoute(harness, body, request) {
  const route = harness.routes.get(ENTRY)
  const response = makeResponse()
  const settled = new Promise((resolve) => response.once('finish', () => resolve(response)))
  route.handler(request ?? makeRequest(body), response)
  return settled
}

function sseEvents(response) {
  return response.chunks
    .join('')
    .split('\n\n')
    .filter((frame) => frame.trim() !== '')
    .map((frame) => JSON.parse(frame.replace(/^data: /, '').trim()))
}

function jsonBody(response) {
  return JSON.parse(response.chunks.join(''))
}

const CONVERSATION = [
  text('user', 'The build is failing on the new test.'),
  text('assistant', 'The failure is in test/parser.test.ts; the fixture expects a trailing newline.'),
]

test('registers one exact streaming route and removes it on dispose', () => {
  const harness = makeHarness()
  assert.equal(harness.routes.size, 1)
  assert.equal(harness.routes.get(ENTRY).kind, 'exact')
  harness.dispose()
  assert.equal(harness.routes.size, 0)
})

test('next mode streams, returns cleaned candidates, and reports the route and seq', async () => {
  const harness = makeHarness({ reply: '- Run the test again\n- Show me the failing assertion\n"Commit the fix"' })
  harness.sessions.set('s1', makeSession(CONVERSATION, { seq: 7 }))

  const response = await callRoute(harness, { sessionId: 's1' })
  assert.equal(response.status, 200)
  assert.match(response.headers['content-type'], /text\/event-stream/)
  const events = sseEvents(response)
  assert.deepEqual(events[0], { type: 'meta', mode: 'next', seq: 7 })
  const done = events.at(-1)
  assert.equal(done.type, 'done')
  assert.deepEqual(done.items, ['Run the test again', 'Show me the failing assertion', 'Commit the fix'])
  assert.deepEqual(done.route, { provider: 'claude2', model: 'claude-sonnet-5-5' })
  assert.equal(done.seq, 7)
  assert.equal(done.cached, false)
  assert.equal(typeof done.ms, 'number')
  assert.match(harness.llmCalls[0].request.system, /follow-up suggestion engine/)
  assert.match(harness.llmCalls[0].request.messages[0].content[0].text, /Conversation tail/)
})

test('results are cached by session sequence, mode and draft', async () => {
  const harness = makeHarness({ reply: 'Run it again' })
  const session = makeSession(CONVERSATION)
  harness.sessions.set('s1', session)

  await callRoute(harness, { sessionId: 's1' })
  const cached = sseEvents(await callRoute(harness, { sessionId: 's1' })).at(-1)
  assert.equal(cached.cached, true)
  assert.deepEqual(cached.route, { provider: 'claude2', model: 'claude-sonnet-5-5' })
  assert.equal(harness.llmCalls.length, 1, 'an unchanged session sequence must not call the model twice')

  session.seq = 2
  await callRoute(harness, { sessionId: 's1' })
  assert.equal(harness.llmCalls.length, 2, 'a new turn must invalidate the cached suggestion')

  await callRoute(harness, { sessionId: 's1', mode: 'continue', draft: 'Can you also' })
  await callRoute(harness, { sessionId: 's1', mode: 'continue', draft: 'Can you also' })
  assert.equal(harness.llmCalls.length, 3, 'identical drafts share one call')
  await callRoute(harness, { sessionId: 's1', mode: 'continue', draft: 'Can you also add' })
  assert.equal(harness.llmCalls.length, 4, 'a different draft is a different request')
})

test('continue mode sends the draft and keeps the leading separator', async () => {
  const harness = makeHarness({ reply: ' update the README\nrun the full suite' })
  harness.sessions.set('s1', makeSession(CONVERSATION))

  const events = sseEvents(await callRoute(harness, { sessionId: 's1', mode: 'continue', draft: 'Can you also' }))
  const done = events.at(-1)
  assert.deepEqual(done.items, [' update the README', 'run the full suite'])
  const prompt = harness.llmCalls[0].request.messages[0].content[0].text
  assert.match(prompt, /Draft text ending at the caret/)
  assert.match(prompt, /"Can you also"/)
  assert.match(prompt, /Write only the continuation text\./)
  assert.match(harness.llmCalls[0].request.system, /complete the message a USER is drafting/)
})

test('continue mode strips a restated draft prefix', async () => {
  const harness = makeHarness({ reply: 'Can you also update the README' })
  harness.sessions.set('s1', makeSession(CONVERSATION))
  const done = sseEvents(await callRoute(harness, { sessionId: 's1', mode: 'continue', draft: 'Can you also' })).at(-1)
  assert.deepEqual(done.items, [' update the README'])
})

test('a configured model is used even when the Session runs on another model, at the lowest effort and with no temperature', async () => {
  const harness = makeHarness({ reply: 'ok then', config: { model: 'claude-sonnet-5-5' }, fallbackModel: { currentSelection: () => ({ provider: 'deepseek-zcode', model: 'deepseek-flash' }) } })
  // The Session runs on another model; the suggestion must still go to Sonnet.
  harness.sessions.set('s1', makeSession(CONVERSATION, { route: { provider: 'deepseek-zcode', model: 'deepseek-flash' } }))

  await callRoute(harness, { sessionId: 's1' })
  const call = harness.llmCalls[0]
  assert.equal(call.config.provider, 'claude2')
  assert.equal(call.config.model, 'claude-sonnet-5-5')
  assert.equal(call.config.maxTokens, 1024)
  assert.equal(call.controls.reasoningEffort, 'low')
  assert.equal('temperature' in call.controls, false)
  assert.equal(call.request.reasoningEffort ?? 'low', 'low')
})

test('the pinned model is looked up once and remembered', async () => {
  const harness = makeHarness({ reply: 'go', config: { model: 'claude-sonnet-5-5' } })
  const session = makeSession(CONVERSATION, { route: { provider: 'deepseek-zcode', model: 'deepseek-flash' } })
  harness.sessions.set('s1', session)
  await callRoute(harness, { sessionId: 's1' })
  const lookups = harness.listCalls.length
  assert.ok(lookups >= 1)
  session.seq = 2
  await callRoute(harness, { sessionId: 's1' })
  assert.equal(harness.listCalls.length, lookups, 'the resolved provider is reused for later requests')
})

test('an unavailable pinned model reports model-unavailable instead of using another model', async () => {
  const harness = makeHarness({ config: { model: 'claude-sonnet-5-5' }, catalog: { 'deepseek-zcode': ['deepseek-flash'] } })
  harness.sessions.set('s1', makeSession(CONVERSATION, { route: { provider: 'deepseek-zcode', model: 'deepseek-flash' } }))
  const events = sseEvents(await callRoute(harness, { sessionId: 's1' }))
  assert.equal(events.at(-1).type, 'error')
  assert.equal(events.at(-1).reason, 'model-unavailable')
  assert.equal(harness.llmCalls.length, 0, 'no model call may be made on a different model')
})

test('a configured provider and model pair is used as given', async () => {
  const harness = makeHarness({ reply: 'go', config: { provider: 'claude-zcode', model: 'claude-sonnet-5-5' } })
  harness.sessions.set('s1', makeSession(CONVERSATION))
  await callRoute(harness, { sessionId: 's1' })
  assert.equal(harness.llmCalls[0].config.provider, 'claude-zcode')
  assert.equal(harness.listCalls.length, 0, 'an explicit pair needs no catalog lookup')
})

test('by default the Session route answers, with no catalog lookup', async () => {
  const harness = makeHarness({ reply: 'go' })
  harness.sessions.set('s1', makeSession(CONVERSATION, { route: { provider: 'deepseek-zcode', model: 'deepseek-flash' } }))
  await callRoute(harness, { sessionId: 's1' })
  assert.equal(harness.llmCalls[0].config.provider, 'deepseek-zcode')
  assert.equal(harness.llmCalls[0].config.model, 'deepseek-flash')
  assert.equal(harness.listCalls.length, 0)
})

test('with no Session route and no default model there is no route to ask', async () => {
  const harness = makeHarness({ reply: 'go' })
  harness.sessions.set('s1', makeSession(CONVERSATION, { route: null }))
  const events = sseEvents(await callRoute(harness, { sessionId: 's1' }))
  assert.equal(events.at(-1).reason, 'no-route')
  assert.equal(harness.llmCalls.length, 0)
})

test('effort selection prefers the configured id, then the lowest advertised', () => {
  const { selectEffort } = __testing
  assert.equal(selectEffort(SONNET_MODEL, 'low'), 'low')
  assert.equal(selectEffort(SONNET_MODEL, 'high'), 'high')
  assert.equal(selectEffort(SONNET_MODEL, 'nonsense'), 'low')
  assert.equal(selectEffort(SONNET_MODEL, ''), 'low')
  assert.equal(selectEffort({}, 'low'), undefined)
  assert.equal(selectEffort({ reasoning: { efforts: [] } }, 'low'), undefined)
})

test('a model without selectable efforts leaves the provider default alone', async () => {
  const harness = makeHarness({ reply: 'go', model: {} })
  harness.sessions.set('s1', makeSession(CONVERSATION))
  await callRoute(harness, { sessionId: 's1' })
  assert.equal('reasoningEffort' in harness.llmCalls[0].controls, false)
})

test('continue mode sees the same conversation context as next mode', async () => {
  const long = []
  for (let index = 0; index < 20; index += 1) {
    long.push(text('user', `question ${index}`))
    long.push(text('assistant', `answer ${index} ${'x'.repeat(400)}`))
  }
  const harness = makeHarness({ reply: 'go' })
  harness.sessions.set('s1', makeSession(long))
  await callRoute(harness, { sessionId: 's1' })
  await callRoute(harness, { sessionId: 's1', mode: 'continue', draft: 'and then' })
  const nextPrompt = harness.llmCalls[0].request.messages[0].content[0].text
  const continuePrompt = harness.llmCalls[1].request.messages[0].content[0].text
  for (const prompt of [nextPrompt, continuePrompt]) {
    assert.match(prompt, /answer 19/)
    assert.match(prompt, /answer 15/)
    assert.doesNotMatch(prompt, /answer 12/)
  }
  assert.match(continuePrompt, /"and then"/)
})

test('prompt includes recent tool activity and marks failures', async () => {
  const harness = makeHarness({ reply: 'go' })
  harness.sessions.set('s1', makeSession([
    text('user', 'fix it'),
    toolCall('c1', 'bash', { command: 'npm test' }),
    toolResult('c1', 'ENOENT: no such file', true),
    text('assistant', 'The test script is missing.'),
  ]))
  await callRoute(harness, { sessionId: 's1' })
  const prompt = harness.llmCalls[0].request.messages[0].content[0].text
  assert.match(prompt, /Recent tool activity/)
  assert.match(prompt, /bash\(.*npm test.*\) -> failed/)
})

test('next mode declines when the agent has not replied yet', async () => {
  const harness = makeHarness()
  harness.sessions.set('s1', makeSession([text('user', 'still working?')]))
  const events = sseEvents(await callRoute(harness, { sessionId: 's1' }))
  assert.equal(events.at(-1).type, 'error')
  assert.equal(events.at(-1).reason, 'no-conversation')
  assert.equal(harness.llmCalls.length, 0)
})

test('NONE and echoed instructions produce no suggestion', async () => {
  const harness = makeHarness({ reply: 'NONE' })
  harness.sessions.set('s1', makeSession(CONVERSATION))
  assert.equal(sseEvents(await callRoute(harness, { sessionId: 's1' })).at(-1).reason, 'empty')
  harness.setReply("Predict the user's next message.\nConversation tail (oldest first):")
  const session = harness.sessions.get('s1')
  session.seq = 2
  assert.equal(sseEvents(await callRoute(harness, { sessionId: 's1' })).at(-1).reason, 'empty')
})

test('a max-tokens finish keeps whole lines and drops the cut-off one', async () => {
  const harness = makeHarness({ reply: 'first option\nsecond opt', finish: { kind: 'max-tokens' } })
  harness.sessions.set('s1', makeSession(CONVERSATION))
  const done = sseEvents(await callRoute(harness, { sessionId: 's1' })).at(-1)
  assert.deepEqual(done.items, ['first option'])
})

test('a failed model call reports a short reason and is not cached', async () => {
  const harness = makeHarness({ fail: true })
  harness.sessions.set('s1', makeSession(CONVERSATION))
  const events = sseEvents(await callRoute(harness, { sessionId: 's1' }))
  assert.equal(events.at(-1).type, 'error')
  assert.match(events.at(-1).reason, /model exploded/)

  harness.setFail(false)
  harness.setReply('recovered')
  const done = sseEvents(await callRoute(harness, { sessionId: 's1' })).at(-1)
  assert.deepEqual(done.items, ['recovered'])
})

test('a provider failure finish chunk surfaces its message', async () => {
  const harness = makeHarness({ finish: { kind: 'error', failure: { message: 'relay returned 529', code: 'overloaded' } } })
  harness.sessions.set('s1', makeSession(CONVERSATION))
  const events = sseEvents(await callRoute(harness, { sessionId: 's1' }))
  assert.equal(events.at(-1).reason, 'relay returned 529')
})

test('a model call that times out aborts and reports an error', async () => {
  const harness = makeHarness({
    config: { timeoutMs: 1000 },
    // A real adapter observes the request signal; the fake does the same.
    reply: async function* (request) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 5000)
        request.signal.addEventListener('abort', () => {
          clearTimeout(timer)
          resolve()
        }, { once: true })
      })
      yield { type: 'text-delta', text: 'late' }
    },
  })
  harness.sessions.set('s1', makeSession(CONVERSATION))
  const started = Date.now()
  const events = sseEvents(await callRoute(harness, { sessionId: 's1' }))
  assert.ok(Date.now() - started < 4000)
  assert.equal(events.at(-1).type, 'error')
})

test('requests are validated before any model call', async () => {
  const harness = makeHarness()
  harness.sessions.set('s1', makeSession(CONVERSATION))

  const missing = await callRoute(harness, { mode: 'next' })
  assert.equal(missing.status, 400)
  assert.equal(jsonBody(missing).reason, 'missing-session')

  const badMode = await callRoute(harness, { sessionId: 's1', mode: 'rewrite' })
  assert.equal(badMode.status, 400)

  const notLive = await callRoute(harness, { sessionId: 'nope' })
  assert.equal(jsonBody(notLive).reason, 'session-not-live')

  const noDraft = await callRoute(harness, { sessionId: 's1', mode: 'continue', draft: '   ' })
  assert.equal(jsonBody(noDraft).reason, 'no-draft')

  const badJson = await callRoute(harness, undefined, makeRequest('{not json'))
  assert.equal(badJson.status, 400)

  const wrongType = await callRoute(harness, undefined, makeRequest({ sessionId: 's1' }, { contentType: 'text/plain' }))
  assert.equal(wrongType.status, 415)

  const wrongMethod = await callRoute(harness, undefined, makeRequest(undefined, { method: 'GET' }))
  assert.equal(wrongMethod.status, 405)

  const huge = await callRoute(harness, undefined, makeRequest({ sessionId: 's1', mode: 'continue', draft: 'x'.repeat(100_000) }))
  assert.equal(huge.status, 400)

  assert.equal(harness.llmCalls.length, 0)
})

test('only an admitted owner may ask', async () => {
  const unauthorized = makeHarness({ admit: () => ({ rejection: 401 }) })
  unauthorized.sessions.set('s1', makeSession(CONVERSATION))
  const first = await callRoute(unauthorized, { sessionId: 's1' })
  assert.equal(first.status, 401)
  assert.equal(unauthorized.llmCalls.length, 0)

  const forbidden = makeHarness({ admit: () => ({ rejection: 403 }) })
  assert.equal((await callRoute(forbidden, { sessionId: 's1' })).status, 403)

  const guest = makeHarness({ admit: () => ({ peer: { principal: { kind: 'guest' } } }) })
  guest.sessions.set('s1', makeSession(CONVERSATION))
  const denied = await callRoute(guest, { sessionId: 's1' })
  assert.equal(denied.status, 403)
  assert.equal(guest.llmCalls.length, 0)
})

test('a client that disconnects mid-stream cancels the model call', async () => {
  let aborted = false
  const harness = makeHarness({
    reply: async function* (request) {
      yield { type: 'text-delta', text: 'partial' }
      await new Promise((resolve) => {
        request.signal.addEventListener('abort', () => {
          aborted = true
          resolve()
        }, { once: true })
        setTimeout(resolve, 3000)
      })
    },
  })
  harness.sessions.set('s1', makeSession(CONVERSATION))
  const route = harness.routes.get(ENTRY)
  const response = makeResponse()
  route.handler(makeRequest({ sessionId: 's1' }), response)
  await new Promise((resolve) => setTimeout(resolve, 100))
  response.emit('close')
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(aborted, true)
})

test('option bounds fall back to defaults for invalid values', () => {
  const { resolveOptions } = __testing
  const defaults = resolveOptions(undefined)
  assert.equal(defaults.model, '')
  assert.equal(defaults.reasoningEffort, 'low')
  assert.equal(defaults.provider, '')
  const bad = resolveOptions({ maxOutputTokens: 1, timeoutMs: 'x', maxSuggestions: 99, model: 5, reasoningEffort: 7 })
  assert.equal(bad.maxOutputTokens, defaults.maxOutputTokens)
  assert.equal(bad.timeoutMs, defaults.timeoutMs)
  assert.equal(bad.maxSuggestions, defaults.maxSuggestions)
  assert.equal(bad.model, '')
  assert.equal(bad.reasoningEffort, 'low')
  assert.equal(resolveOptions({ model: ' claude-sonnet-5-5 ' }).model, 'claude-sonnet-5-5')
})

test('candidates are bounded, de-duplicated and stripped of list markers', () => {
  const { normalizeCandidates } = __testing
  const items = normalizeCandidates('1. Do it\n2) do it\n* Another\nUser: third\n' + 'w '.repeat(200), 5, '', '')
  assert.deepEqual(items.slice(0, 3), ['Do it', 'Another', 'third'])
  assert.ok(items.every((item) => item.length <= 240))
})

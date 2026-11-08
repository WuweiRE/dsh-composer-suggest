import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { readFile } from 'node:fs/promises'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')


/** Objects built inside the vm sandbox have another realm's prototypes; compare their data. */
function same(actual, expected) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected)
}

const ENDPOINT = '/composer-suggest/stream'
const PREFERENCE_KEY = 'dsh-composer-suggest.prefs'

function sse(...events) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
}

function streamResponse(body, init = {}) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream' }, ...init },
  )
}

/**
 * Load the browser half the way the Harness module loader does, with a fake
 * React whose hooks run synchronously, so the component logic can be driven
 * without a DOM.
 */
function load({ prefs, fetch, storageBlocked = false } = {}) {
  let definition
  let index = 0
  let state = []
  let request
  const effects = []
  const layouts = []
  // Several effects may listen to the same document event; fire all of them in registration order.
  const handlers = new Map()
  const listeners = {
    get: (name) => (event) => { for (const fn of handlers.get(name) ?? []) fn(event) },
    clear: () => handlers.clear(),
  }
  const windowListeners = new Map()
  // Refs, effects and callbacks live across renders like in React: an effect re-runs only when
  // its dependencies changed. State is re-seeded by every render() call.
  const refs = []
  let refIndex = 0
  const effectSlots = []
  let effectIndex = 0
  const callbackSlots = []
  let callbackIndex = 0
  const depsChanged = (previous, next) =>
    previous === undefined || next === undefined || previous.length !== next.length || next.some((value, i) => !Object.is(value, previous[i]))
  const scheduleEffect = (list, fn, deps) => {
    const slot = effectSlots[effectIndex] ?? (effectSlots[effectIndex] = {})
    effectIndex += 1
    if (!depsChanged(slot.deps, deps)) return
    slot.deps = deps
    list.push(() => {
      slot.cleanup?.()
      const cleanup = fn()
      slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined
    })
  }
  const timers = []
  const warnings = []
  const inserted = []
  const fetchCalls = []
  const registered = {}
  const dictionaries = {}
  const view = { draft: '', prefix: undefined, tail: '', caretOffset: 100, width: 600, insert: true, focusInEditor: true }

  const editor = { contains: (node) => (node === document.activeElement ? view.focusInEditor : true), getBoundingClientRect: () => ({ width: view.width, height: 100 }) }
  const card = {
    contains: () => true,
    querySelector: () => editor,
    getBoundingClientRect: () => ({ left: 0, top: 0, right: view.width, width: view.width, height: 100 }),
  }
  const document = {
    activeElement: editor,
    hidden: false,
    createRange: () => {
      let part = 'prefix'
      return {
        selectNodeContents() {},
        setEnd() { part = 'prefix' },
        setStart() { part = 'tail' },
        toString: () => (part === 'tail' ? view.tail : (view.prefix ?? view.draft)),
      }
    },
    addEventListener: (name, fn) => {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
    },
    removeEventListener: (name, fn) => {
      handlers.set(name, (handlers.get(name) ?? []).filter((candidate) => candidate !== fn))
    },
  }
  const localStorage = storageBlocked
    ? { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
    : { getItem: () => (prefs === undefined ? null : JSON.stringify(prefs)), setItem: (_key, value) => { localStorage.saved = value } }
  const window = {
    localStorage,
    __ModuleLoader__: { load: (value) => { definition = value } },
    getSelection: () => ({
      rangeCount: 1,
      getRangeAt: () => ({
        collapsed: true,
        startContainer: {},
        startOffset: view.draft.length,
        getBoundingClientRect: () => ({ left: view.caretOffset, top: 10, width: 0, height: 24 }),
      }),
    }),
    getComputedStyle: () => ({ lineHeight: '24px' }),
    addEventListener: (name, fn) => windowListeners.set(name, fn),
    removeEventListener() {},
  }
  const react = {
    Fragment: 'fragment',
    createElement: (type, props, ...children) => {
      const element = { type, props, children }
      // React assigns refs before effects; the harness does the same so the
      // overlay can locate the composer card that owns it.
      if (props && props.ref && typeof props.ref === 'object') props.ref.current = element
      if (props && props['data-composer-suggest-anchor'] !== undefined) {
        element.isConnected = true
        element.closest = (selector) => (selector === '[data-composer-card]' ? card : null)
      }
      return element
    },
    useState: () => {
      const i = index++
      return [state[i], (value) => { state[i] = typeof value === 'function' ? value(state[i]) : value }]
    },
    useRef: (initial) => {
      const i = refIndex++
      if (refs[i] === undefined) refs[i] = { current: initial ?? null }
      return refs[i]
    },
    useCallback: (fn, deps) => {
      const slot = callbackSlots[callbackIndex] ?? (callbackSlots[callbackIndex] = {})
      callbackIndex += 1
      if (depsChanged(slot.deps, deps)) {
        slot.deps = deps
        slot.fn = fn
      }
      request = slot.fn
      return slot.fn
    },
    useEffect: (fn, deps) => scheduleEffect(effects, fn, deps),
    useLayoutEffect: (fn, deps) => scheduleEffect(layouts, fn, deps),
    useSyncExternalStore: (_subscribe, read) => read(),
  }
  const context = {
    window,
    document,
    fetch: async (url, init) => {
      fetchCalls.push({ url, init })
      if (fetch === undefined) return streamResponse('')
      return fetch(url, init)
    },
    console: { warn: (...args) => warnings.push(args.join(' ')) },
    AbortController,
    TextDecoder,
    ReadableStream,
    Response,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length },
    clearTimeout() {},
  }
  vm.runInNewContext(source, context)
  const module = definition.factory((id) => {
    if (id !== 'react') throw new Error(`unexpected require: ${id}`)
    return react
  })
  module.apply({
    locale: {
      bind: () => (key) => dictionaries.value?.en?.[key] ?? key,
      register: (_ns, value) => { dictionaries.value = value; return () => {} },
    },
    effect: (fn) => fn(),
    slots: {
      inject: (_name, fn) => fn(),
      register: (spec, component) => { registered[spec.name] = { spec, component } },
    },
  })

  const inputActions = {
    captureInsertion: () => ({}),
    insertText: (value) => { inserted.push(value); return view.insert },
    setDraft: () => { throw new Error('Must never replace the draft') },
  }

  function render({ draft = '', ghost, box, running = false } = {}) {
    view.draft = draft
    index = 0
    refIndex = 0
    effectIndex = 0
    callbackIndex = 0
    effects.length = 0
    layouts.length = 0
    timers.length = 0
    const mode = ghost?.mode ?? (draft === '' ? 'next' : 'continue')
    state = [
      { mode, items: [], index: 0, stream: '', active: false, seq: null, notice: null, ...ghost },
      box === undefined ? { left: 100, top: 10, maxWidth: 400, height: 24 } : box,
      0,
    ]
    const wrapper = registered['conversation.input.overlay'].component({
      sessionId: 's1',
      useInput: (select) => select({ draft }),
      useSessionStatus: (select) => select(new Map([['s1', { running }]])),
      inputActions,
    })
    const tree = wrapper.type(wrapper.props)
    return { tree, state, effects, layouts, listeners, request, timers }
  }

  return { module, registered, render, view, inserted, fetchCalls, warnings, windowListeners, localStorage, dictionaries, effects, layouts, listeners, timers }
}

function keyEvent(key, extra = {}) {
  return {
    key,
    prevented: false,
    defaultPrevented: false,
    preventDefault() { this.prevented = true; this.defaultPrevented = true },
    stopPropagation() {},
    ...extra,
  }
}

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms))

function runEffects(rendered) {
  for (const effect of rendered.effects) effect()
}

test('registers the overlay and the General settings row, and loads no Harness client package', () => {
  const app = load()
  same(app.module.inject, ['slots', 'locale'])
  assert.ok(app.registered['conversation.input.overlay'])
  assert.equal(app.registered['conversation.input.overlay'].spec.id, 'composer-suggest')
  assert.ok(app.registered['settings.general.item'])
  assert.equal(app.registered['settings.general.item'].spec.id, 'composer-suggest')
  assert.equal(typeof app.dictionaries.value.en.next, 'string')
  assert.equal(typeof app.dictionaries.value.zh.next, 'string')
})

test('both modes are on by default and toggle independently', () => {
  const app = load()
  const { readPrefs, setPref } = app.module.__testing
  same(readPrefs(), { next: true, continue: true })
  setPref('continue', false)
  same(readPrefs(), { next: true, continue: false })
  same(JSON.parse(app.localStorage.saved), { next: true, continue: false })
  setPref('next', false)
  same(readPrefs(), { next: false, continue: false })
})

test('saved preferences are restored, and blocked storage still works for the window', () => {
  const restored = load({ prefs: { next: false, continue: true } })
  same(restored.module.__testing.readPrefs(), { next: false, continue: true })

  const blocked = load({ storageBlocked: true })
  same(blocked.module.__testing.readPrefs(), { next: true, continue: true })
  assert.doesNotThrow(() => blocked.module.__testing.setPref('next', false))
  assert.equal(blocked.module.__testing.readPrefs().next, false)
})

test('another window changing the preference is picked up through the storage event', () => {
  const app = load()
  const onStorage = app.windowListeners.get('storage')
  onStorage({ key: 'something-else', newValue: '{"next":false}' })
  same(app.module.__testing.readPrefs(), { next: true, continue: true })
  onStorage({ key: PREFERENCE_KEY, newValue: JSON.stringify({ next: false, continue: true }) })
  same(app.module.__testing.readPrefs(), { next: false, continue: true })
  onStorage({ key: PREFERENCE_KEY, newValue: null })
  same(app.module.__testing.readPrefs(), { next: true, continue: true })
})

test('the settings row has one switch per mode, a cost note, and a status line', () => {
  const app = load()
  const element = app.registered['settings.general.item'].component()
  const row = element.type(element.props)
  const toggles = row.children.filter((child) => child && child.props && 'checked' in child.props)
  same(toggles.map((toggle) => toggle.props.title), ['Suggest my next message', 'Continue my draft with Tab'])
  assert.ok(toggles.every((toggle) => toggle.props.checked === true))
  toggles[1].props.onChange(false)
  same(app.module.__testing.readPrefs(), { next: true, continue: false })
  const status = row.children.find((child) => child && child.type && child.type.name === 'StatusLine')
  assert.ok(status, 'the row ends with the status line')
})

test('the status line shows idle, success, cache hits and failures', () => {
  const app = load()
  const { reportStatus } = app.module.__testing
  const element = app.registered['settings.general.item'].component()
  const row = element.type(element.props)
  const statusElement = row.children.find((child) => child && child.type && child.type.name === 'StatusLine')
  const text = () => statusElement.type(statusElement.props).children[0]

  assert.equal(text(), 'No suggestion requested yet.')
  reportStatus({ state: 'ok', route: 'claude2 / claude-sonnet-5-5', ms: 1840 })
  assert.equal(text(), 'Last suggestion: claude2 / claude-sonnet-5-5 · 1840 ms')
  reportStatus({ state: 'cached', route: 'claude2 / claude-sonnet-5-5' })
  assert.equal(text(), 'Last suggestion: claude2 / claude-sonnet-5-5 · cached')
  reportStatus({ state: 'error', reason: 'model-unavailable' })
  assert.equal(text(), 'Last suggestion failed: model-unavailable')
})

test('a repeated failure is logged once; a success re-arms the log', () => {
  const app = load()
  const { reportStatus } = app.module.__testing
  reportStatus({ state: 'error', reason: 'model-unavailable' })
  reportStatus({ state: 'error', reason: 'model-unavailable' })
  same(app.warnings, ['[composer-suggest] model-unavailable'])
  reportStatus({ state: 'error', reason: 'HTTP 500' })
  assert.equal(app.warnings.length, 2)
  reportStatus({ state: 'ok', route: 'r', ms: 1 })
  reportStatus({ state: 'error', reason: 'HTTP 500' })
  assert.equal(app.warnings.length, 3)
})

test('next mode asks after the settle delay, and typing never schedules a request', () => {
  const app = load()
  const idle = app.render({ draft: '' })
  runEffects(idle)
  same(idle.timers.map((timer) => timer.ms), [600])

  const typing = app.render({ draft: 'Can you also' })
  runEffects(typing)
  same(typing.timers, [], 'continuation is manual: no timer')
})

test('nothing is requested while the agent is running', () => {
  const app = load()
  const rendered = app.render({ draft: '', running: true })
  runEffects(rendered)
  same(rendered.timers, [])
})

test('Tab at the end of a draft asks the model to continue it, and the composer is marked as working at once', async () => {
  const app = load({ fetch: async () => streamResponse(sse({ type: 'done', items: [' update the README'], route: { provider: 'claude2', model: 'claude-sonnet-5-5' }, ms: 900, seq: 4 })) })
  const rendered = app.render({ draft: 'Can you also' })
  runEffects(rendered)
  const tab = keyEvent('Tab')
  rendered.listeners.get('keydown')(tab)
  assert.equal(tab.prevented, true)
  assert.equal(app.fetchCalls.length, 1)
  assert.equal(app.fetchCalls[0].url, ENDPOINT)
  same(JSON.parse(app.fetchCalls[0].init.body), { sessionId: 's1', mode: 'continue', draft: 'Can you also' })
  // The request is in flight before the first byte arrives, so "Continuing…" can show immediately.
  assert.equal(rendered.state[0].mode, 'continue')
  assert.equal(rendered.state[0].active, true)
  await tick()
  same(rendered.state[0].items, [' update the README'])
  assert.equal(rendered.state[0].active, false)
})

test('Tab keeps its usual job when there is nothing to continue', () => {
  const cases = [
    ['an empty composer', { draft: '' }],
    ['a blank draft', { draft: '   ' }],
    ['a slash command', { draft: '/comp' }],
    ['an @ reference', { draft: 'look at @src/ind' }],
    ['a caret before the end', { draft: 'Can you also add', tail: ' the tests' }],
    ['Shift+Tab', { draft: 'Can you also', event: { shiftKey: true } }],
    ['Ctrl+Tab', { draft: 'Can you also', event: { ctrlKey: true } }],
    ['focus outside the editor', { draft: 'Can you also', focusInEditor: false }],
    ['IME composition', { draft: 'Can you also', composing: true }],
    ['continuation switched off', { draft: 'Can you also', prefs: { next: true, continue: false } }],
  ]
  for (const [label, options] of cases) {
    const app = load({ prefs: options.prefs })
    if (options.tail !== undefined) app.view.tail = options.tail
    if (options.focusInEditor === false) app.view.focusInEditor = false
    const rendered = app.render({ draft: options.draft })
    runEffects(rendered)
    if (options.composing) rendered.listeners.get('compositionstart')()
    const tab = keyEvent('Tab', options.event)
    rendered.listeners.get('keydown')(tab)
    assert.equal(tab.prevented, false, `${label}: Tab is left alone`)
    assert.equal(app.fetchCalls.length, 0, `${label}: nothing is asked`)
  }
})

test('a multi-paragraph draft counts as ended when only blanks follow the caret', () => {
  const app = load()
  // The DOM joins paragraphs without a newline, so its text can never equal the draft string.
  app.view.prefix = 'First lineSecond line'
  app.view.tail = ' \u200b\n'
  const rendered = app.render({ draft: 'First line\nSecond line' })
  runEffects(rendered)
  const tab = keyEvent('Tab')
  rendered.listeners.get('keydown')(tab)
  assert.equal(tab.prevented, true)
  assert.equal(JSON.parse(app.fetchCalls[0].init.body).mode, 'continue')
})

test('any non-blank draft can be continued, however short or in whatever script', () => {
  for (const draft of ['a', 'hi', '你好', '帮我写']) {
    const app = load()
    const rendered = app.render({ draft })
    runEffects(rendered)
    const tab = keyEvent('Tab')
    rendered.listeners.get('keydown')(tab)
    assert.equal(tab.prevented, true, JSON.stringify(draft))
    assert.equal(app.fetchCalls.length, 1, JSON.stringify(draft))
  }
})

test('each mode obeys its own switch', () => {
  const nextOff = load({ prefs: { next: false, continue: true } })
  const a = nextOff.render({ draft: '' })
  runEffects(a)
  same(a.timers, [], 'next off: no next request')
  const b = nextOff.render({ draft: 'Can you also' })
  runEffects(b)
  const tab = keyEvent('Tab')
  b.listeners.get('keydown')(tab)
  assert.equal(tab.prevented, true, 'next off: Tab still continues a draft')

  const continueOff = load({ prefs: { next: true, continue: false } })
  const c = continueOff.render({ draft: '' })
  runEffects(c)
  same(c.timers.map((timer) => timer.ms), [600], 'continue off: next still works')
})

test('Tab is swallowed while the model is working, so focus does not jump and nothing is asked twice', () => {
  const app = load()
  const rendered = app.render({ draft: 'Can you also', ghost: { mode: 'continue', active: true } })
  runEffects(rendered)
  const tab = keyEvent('Tab')
  rendered.listeners.get('keydown')(tab)
  assert.equal(tab.prevented, true)
  assert.equal(app.fetchCalls.length, 0)
  same(app.inserted, [])
})

test('Tab asks, Tab accepts, and continuations can be chained', async () => {
  const app = load({ fetch: async () => streamResponse(sse({ type: 'done', items: [' update the README'], route: { provider: 'claude2', model: 'claude-sonnet-5-5' }, ms: 900, seq: 4 })) })
  const first = app.render({ draft: 'Can you also' })
  runEffects(first)
  first.listeners.get('keydown')(keyEvent('Tab'))
  await tick()

  // The composer re-renders with the finished suggestion; the next Tab accepts it.
  const second = app.render({ draft: 'Can you also', ghost: first.state[0] })
  runEffects(second)
  const accept = keyEvent('Tab')
  second.listeners.get('keydown')(accept)
  assert.equal(accept.prevented, true)
  same(app.inserted, [' update the README'])
  assert.equal(app.fetchCalls.length, 1, 'accepting does not ask again')

  // The accepted text is an ordinary draft: Tab at its end asks for the next piece.
  const third = app.render({ draft: 'Can you also update the README' })
  runEffects(third)
  const again = keyEvent('Tab')
  third.listeners.get('keydown')(again)
  assert.equal(again.prevented, true)
  assert.equal(app.fetchCalls.length, 2)
  assert.equal(JSON.parse(app.fetchCalls[1].init.body).draft, 'Can you also update the README')
})

test('Escape cancels a continuation in flight, and Tab passes through for that draft until it changes', () => {
  const app = load()
  const working = app.render({ draft: 'Can you also', ghost: { mode: 'continue', active: true } })
  runEffects(working)
  const escape = keyEvent('Escape')
  working.listeners.get('keydown')(escape)
  assert.equal(escape.prevented, true)

  const sameDraft = app.render({ draft: 'Can you also' })
  runEffects(sameDraft)
  const passed = keyEvent('Tab')
  sameDraft.listeners.get('keydown')(passed)
  assert.equal(passed.prevented, false, 'dismissed: Tab keeps its usual job')
  assert.equal(app.fetchCalls.length, 0)

  const edited = app.render({ draft: 'Can you also add' })
  runEffects(edited)
  const asked = keyEvent('Tab')
  edited.listeners.get('keydown')(asked)
  assert.equal(asked.prevented, true, 'editing the draft re-arms Tab')
  assert.equal(app.fetchCalls.length, 1)
})

test('a continuation that ends without text leaves Tab alone for that draft and says why', async () => {
  const outcomes = [
    ['an empty answer', () => streamResponse(sse({ type: 'error', reason: 'empty' })), { key: 'noteEmpty' }],
    ['an HTTP error', () => new Response('', { status: 500 }), { key: 'noticeFailed', reason: 'HTTP 500' }],
  ]
  for (const [label, response, notice] of outcomes) {
    const app = load({ fetch: async () => response() })
    const first = app.render({ draft: 'Can you also' })
    runEffects(first)
    first.listeners.get('keydown')(keyEvent('Tab'))
    await tick()
    same(first.state[0].notice, notice)
    assert.equal(first.state[0].mode, 'continue')

    const again = app.render({ draft: 'Can you also' })
    runEffects(again)
    const tab = keyEvent('Tab')
    again.listeners.get('keydown')(tab)
    assert.equal(tab.prevented, false, `${label}: Tab is not captured again`)
    assert.equal(app.fetchCalls.length, 1, `${label}: no second request`)
  }
})

test('a successful answer fills the ghost and reports the route and latency', async () => {
  const app = load({ fetch: async () => streamResponse(sse(
    { type: 'meta', mode: 'next', seq: 7 },
    { type: 'delta', text: 'Run the test' },
    { type: 'done', items: ['Run the test again', 'Show the assertion'], route: { provider: 'claude2', model: 'claude-sonnet-5-5' }, ms: 1234, seq: 7, cached: false },
  )) })
  const rendered = app.render({ draft: '' })
  await rendered.request('next', '')
  same(rendered.state[0], { mode: 'next', items: ['Run the test again', 'Show the assertion'], index: 0, stream: '', active: false, seq: 7, notice: null })
  same({ ...app.module.__testing.readStatus() }, { state: 'ok', route: 'claude2 / claude-sonnet-5-5', ms: 1234 })
})

test('a cache hit is reported as cached', async () => {
  const app = load({ fetch: async () => streamResponse(sse({ type: 'done', items: ['x'], cached: true, ms: 0, route: { provider: 'claude2', model: 'claude-sonnet-5-5' }, seq: 1 })) })
  const rendered = app.render({ draft: '' })
  await rendered.request('next', '')
  assert.equal(app.module.__testing.readStatus().state, 'cached')
})

test('"nothing to suggest" replies are silent, an empty answer is explained, real failures are reported', async () => {
  for (const reason of ['no-conversation', 'session-not-live', 'no-draft']) {
    const app = load({ fetch: async () => streamResponse(sse({ type: 'error', reason })) })
    const rendered = app.render({ draft: '' })
    await rendered.request('next', '')
    assert.equal(app.module.__testing.readStatus().state, 'idle', `${reason} is not a failure`)
    assert.equal(rendered.state[0].items.length, 0)
  }
  const empty = load({ fetch: async () => streamResponse(sse({ type: 'error', reason: 'empty' })) })
  const emptyView = empty.render({ draft: 'Can you also' })
  await emptyView.request('continue', 'Can you also')
  assert.deepEqual({ ...empty.module.__testing.readStatus() }, { state: 'note', key: 'noteEmpty' })
  assert.equal(emptyView.state[0].items.length, 0)

  const failing = load({ fetch: async () => streamResponse(sse({ type: 'error', reason: 'model-unavailable' })) })
  const rendered = failing.render({ draft: '' })
  await rendered.request('next', '')
  assert.deepEqual({ ...failing.module.__testing.readStatus() }, { state: 'error', reason: 'model-unavailable' })
  assert.equal(rendered.state[0].items.length, 0)
})

test('the status line explains an empty answer', () => {
  const app = load()
  const element = app.registered['settings.general.item'].component()
  const row = element.type(element.props)
  const statusElement = row.children.find((child) => child && child.type && child.type.name === 'StatusLine')
  app.module.__testing.reportStatus({ state: 'note', key: 'noteEmpty' })
  assert.equal(statusElement.type(statusElement.props).children[0], 'The model had nothing to suggest.')
})

test('HTTP errors, network errors and truncated streams are reported', async () => {
  const http = load({ fetch: async () => new Response('', { status: 500 }) })
  await http.render({ draft: '' }).request('next', '')
  assert.equal(http.module.__testing.readStatus().reason, 'HTTP 500')

  const network = load({ fetch: async () => { throw new Error('offline') } })
  await network.render({ draft: '' }).request('next', '')
  assert.equal(network.module.__testing.readStatus().reason, 'network')

  const truncated = load({ fetch: async () => streamResponse(sse({ type: 'delta', text: 'partial text' })) })
  const rendered = truncated.render({ draft: 'Can you also' })
  await rendered.request('continue', 'Can you also')
  assert.equal(truncated.module.__testing.readStatus().reason, 'stream-ended')
  assert.equal(rendered.state[0].active, false)
  assert.equal(rendered.state[0].stream, '')
  assert.equal(rendered.state[0].items.length, 0)
})

test('a plain JSON reply from the Host is read as a reason, not a stream', async () => {
  const quiet = load({ fetch: async () => new Response(JSON.stringify({ items: [], reason: 'session-not-live' }), { headers: { 'content-type': 'application/json' } }) })
  await quiet.render({ draft: '' }).request('next', '')
  assert.equal(quiet.module.__testing.readStatus().state, 'idle')

  const broken = load({ fetch: async () => new Response(JSON.stringify({ items: [], reason: 'forbidden' }), { status: 200, headers: { 'content-type': 'application/json' } }) })
  await broken.render({ draft: '' }).request('next', '')
  assert.equal(broken.module.__testing.readStatus().reason, 'forbidden')
})

test('Escape withdraws the offer for the rest of the turn, even after the session is reopened', async () => {
  const app = load({ fetch: async () => streamResponse(sse({ type: 'done', items: ['Run it again'], seq: 7, cached: true, route: { provider: 'p', model: 'm' } })) })
  const shown = app.render({ draft: '', ghost: { mode: 'next', items: ['Run it again'], seq: 7 } })
  runEffects(shown)
  const escape = keyEvent('Escape')
  shown.listeners.get('keydown')(escape)
  assert.equal(escape.prevented, true)
  assert.equal(app.module.__testing.dismissedSeqs.get('s1'), 7)

  // Reopening the session asks again; the Host's cached answer is for the same turn.
  const reopened = app.render({ draft: '' })
  await reopened.request('next', '')
  assert.equal(reopened.state[0].items.length, 0, 'the dismissed turn is not offered again')

  // A new turn (new seq) is offered normally.
  const nextTurn = load({ fetch: async () => streamResponse(sse({ type: 'done', items: ['Next thing'], seq: 8, route: { provider: 'p', model: 'm' } })) })
  nextTurn.module.__testing.dismissedSeqs.set('s1', 7)
  const fresh = nextTurn.render({ draft: '' })
  await fresh.request('next', '')
  same(fresh.state[0].items, ['Next thing'])
})

test('Tab never accepts a streaming preview, and accepts only final text', () => {
  const nextPreview = load()
  const streamingNext = nextPreview.render({ draft: '', ghost: { mode: 'next', active: true, stream: 'Run the test again' } })
  runEffects(streamingNext)
  const early = keyEvent('Tab')
  streamingNext.listeners.get('keydown')(early)
  assert.equal(early.prevented, false)
  same(nextPreview.inserted, [])

  const continuePreview = load()
  const streamingContinue = continuePreview.render({ draft: 'Can you also', ghost: { mode: 'continue', active: true, stream: 'Can you also update the README' } })
  runEffects(streamingContinue)
  const swallowed = keyEvent('Tab')
  streamingContinue.listeners.get('keydown')(swallowed)
  assert.equal(swallowed.prevented, true)
  same(continuePreview.inserted, [])

  const ready = load()
  const final = ready.render({ draft: 'Can you also', ghost: { mode: 'continue', items: [' update the README'] } })
  runEffects(final)
  const tab = keyEvent('Tab')
  final.listeners.get('keydown')(tab)
  assert.equal(tab.prevented, true)
  same(ready.inserted, [' update the README'])
  assert.equal(ready.fetchCalls.length, 0, 'accepting does not ask again')
})

test('Alt+Down and Alt+Up cycle candidates', () => {
  const app = load()
  const rendered = app.render({ draft: '', ghost: { mode: 'next', items: ['one', 'two', 'three'] } })
  runEffects(rendered)
  // The draft effect clears the ghost on mount; restore the state a finished answer leaves behind.
  rendered.state[0] = { mode: 'next', items: ['one', 'two', 'three'], index: 0, stream: '', active: false, seq: null }
  const down = keyEvent('ArrowDown', { altKey: true })
  rendered.listeners.get('keydown')(down)
  assert.equal(down.prevented, true)
  assert.equal(rendered.state[0].index, 1)
  const up = keyEvent('ArrowUp', { altKey: true })
  rendered.listeners.get('keydown')(up)
  assert.equal(rendered.state[0].index, 0)
  rendered.listeners.get('keydown')(keyEvent('ArrowUp', { altKey: true }))
  assert.equal(rendered.state[0].index, 2, 'cycling wraps around')
})

test('a refused insertion never replaces the existing draft', () => {
  const app = load()
  app.view.insert = false
  const rendered = app.render({ draft: 'Can you also', ghost: { mode: 'continue', items: [' update'] } })
  runEffects(rendered)
  assert.doesNotThrow(() => rendered.listeners.get('keydown')(keyEvent('Tab')))
  assert.equal(rendered.state[0].items.length, 0)
  assert.equal(rendered.state[1], null)
})

test('ending IME composition re-arms the timers', () => {
  const app = load()
  const rendered = app.render({ draft: 'Can you also', ghost: { mode: 'continue', items: [' x'] } })
  runEffects(rendered)
  rendered.listeners.get('compositionstart')()
  assert.equal(rendered.state[0].items.length, 0)
  rendered.listeners.get('compositionend')()
  assert.equal(rendered.state[2], 1)
})

test('the ghost is shown only for an enabled mode', () => {
  const both = load()
  assert.equal(both.render({ draft: '', ghost: { mode: 'next', items: ['x'] } }).tree.type, 'fragment')
  assert.equal(both.render({ draft: 'Can you', ghost: { mode: 'continue', items: [' x'] } }).tree.type, 'fragment')

  const nextOff = load({ prefs: { next: false, continue: true } })
  assert.equal(nextOff.render({ draft: '', ghost: { mode: 'next', items: ['x'] } }).tree.type, 'span', 'next ghost hidden')
  assert.equal(nextOff.render({ draft: 'Can you', ghost: { mode: 'continue', items: [' x'] } }).tree.type, 'fragment')

  const continueOff = load({ prefs: { next: true, continue: false } })
  assert.equal(continueOff.render({ draft: 'Can you', ghost: { mode: 'continue', items: [' x'] } }).tree.type, 'span', 'continuation ghost hidden')
})

test('the right edge hides the continuation ghost instead of moving it over the draft', () => {
  const edge = load()
  edge.view.caretOffset = 590
  const hidden = edge.render({ draft: 'Can you also', ghost: { mode: 'continue', items: [' x'] } })
  for (const layout of hidden.layouts) layout()
  assert.equal(hidden.state[1], null)

  const fits = load()
  fits.view.caretOffset = 400
  const shown = fits.render({ draft: 'Can you also', ghost: { mode: 'continue', items: [' x'] } })
  for (const layout of shown.layouts) layout()
  assert.equal(shown.state[1].left, 400)
  assert.equal(shown.state[1].maxWidth, 184)
})

test('final suggestions are announced, previews are not, and the ghost carries the shared marker', () => {
  const app = load()
  const ready = app.render({ draft: '', ghost: { mode: 'next', items: ['Run it again'] } }).tree
  assert.equal(ready.children[0].props.role, 'status')
  assert.equal(ready.children[0].props['aria-live'], 'polite')
  assert.equal(ready.children[1].props['data-composer-ghost'], 'dsh-composer-suggest')
  assert.equal(ready.children[1].props['data-composer-suggest'], 'next')
  const preview = app.render({ draft: '', ghost: { mode: 'next', active: true, items: [], stream: 'preview text' } }).tree
  assert.equal(preview.children[0].children[0], '')
})

test('the composer shows that the model is continuing, then the text, then the Tab hint', () => {
  const app = load()

  const waiting = app.render({ draft: 'Can you also', ghost: { mode: 'continue', active: true } }).tree
  assert.equal(waiting.type, 'fragment')
  assert.equal(waiting.children[0].children[0], 'Continuing…', 'announced to screen readers')
  const chip = waiting.children[1]
  assert.equal(chip.props['data-composer-suggest-state'], 'pending')
  assert.equal(chip.children[0].props.className, 'cs-spin')
  assert.equal(chip.children[1].children[0], 'Continuing…')
  assert.equal(chip.children[2].children[0], 'Esc')

  const streaming = app.render({ draft: 'Can you also', ghost: { mode: 'continue', active: true, stream: 'update the README' } }).tree
  const streamingChip = streaming.children[1]
  assert.equal(streamingChip.props['data-composer-suggest-state'], 'pending')
  assert.equal(streamingChip.children[0].children[0], ' update the README')
  assert.equal(streamingChip.children[1].props.className, 'cs-spin')
  assert.ok(!streamingChip.children.some((child) => child && child.type === 'kbd'), 'no Tab hint until the text is final')

  const done = app.render({ draft: 'Can you also', ghost: { mode: 'continue', items: [' update the README', ' add tests'] } }).tree
  const doneChip = done.children[1]
  assert.equal(doneChip.props['data-composer-suggest-state'], 'ready')
  assert.equal(doneChip.children[0].children[0], ' update the README')
  assert.equal(doneChip.children[2].children[0], '1/2')
  assert.equal(doneChip.children[3].children[0], 'Tab')
})

test('a failed or empty continuation shows a short notice that clears itself', () => {
  const app = load()
  const notice = { key: 'noticeFailed', reason: 'HTTP 500' }
  const rendered = app.render({ draft: 'Can you also', ghost: { mode: 'continue', notice } })
  assert.equal(rendered.tree.children[1].props['data-composer-suggest-state'], 'notice')
  assert.equal(rendered.tree.children[1].children[0].children[0], 'Continuation failed: HTTP 500')
  assert.equal(rendered.tree.children[0].children[0], 'Continuation failed: HTTP 500')

  runEffects(rendered)
  const timer = rendered.timers.find((entry) => entry.ms === 2600)
  assert.ok(timer, 'the notice has a timeout')
  // The mount-time draft effect cleared the seeded ghost; put the notice back before the timer fires.
  rendered.state[0] = { mode: 'continue', items: [], index: 0, stream: '', active: false, seq: null, notice }
  timer.fn()
  assert.equal(rendered.state[0].notice, null)
})

test('continuation joining only separates real words', () => {
  const { joinContinuation } = load().module.__testing
  assert.equal(joinContinuation('Can you also', 'add the tests'), ' add the tests')
  assert.equal(joinContinuation('Can you also ', 'add the tests'), 'add the tests')
  assert.equal(joinContinuation('Can you also ', ' add the tests'), 'add the tests')
  assert.equal(joinContinuation('Can you also', ' add the tests'), ' add the tests')
  assert.equal(joinContinuation('', 'text'), 'text')
  assert.equal(joinContinuation('Use (', 'x)'), 'x)')
  assert.equal(joinContinuation('Run it,', 'then check'), ' then check')
  assert.equal(joinContinuation('请你', '继续'), '继续')
})

test('SSE text and streaming candidates are parsed defensively', () => {
  const { parseSseText, streamingCandidate } = load().module.__testing
  same(parseSseText('data: {"type":"done","items":["a"]}\n\ndata: nope\n\ndata: {"type":"delta","text":"x"}\n\n'), [
    { type: 'done', items: ['a'] },
    { type: 'delta', text: 'x' },
  ])
  assert.equal(streamingCandidate('- first option'), 'first option')
  assert.equal(streamingCandidate('NONE'), '')
  assert.equal(streamingCandidate(''), '')
})

test('stream consumption requires a terminal event and handles split UTF-8 frames', async () => {
  const { consumeStream } = load().module.__testing
  const bytes = new TextEncoder().encode('data: {"type":"delta","text":"继续"}\n\ndata: {"type":"done","items":["继续"]}\n\n')
  const events = []
  const stream = new ReadableStream({ start(controller) {
    for (let i = 0; i < bytes.length; i++) controller.enqueue(bytes.slice(i, i + 1))
    controller.close()
  } })
  assert.equal(await consumeStream(stream, new AbortController().signal, (event) => events.push(event)), true)
  assert.equal(events[0].text, '继续')
  assert.equal(stream.locked, false)
  const incomplete = new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: {"type":"delta","text":"unfinished"}\n\n'))
    controller.close()
  } })
  assert.equal(await consumeStream(incomplete, new AbortController().signal, () => {}), false)
})

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
  const view = { draft: '', prefix: undefined, tail: '', caretOffset: 100, width: 600, insert: true, focusInEditor: true, scrollBottom: 100, ghostBottom: 0, hasScroll: true, caretHeight: 24, computed: { lineHeight: '24px' }, attachmentIds: [], images: [], imageBytes: 4 }

  // The Host wraps the editor in a scroll element (data-input-scroll); a margin set on it moves the toolbar.
  const scroll = { style: { marginBottom: '' }, getBoundingClientRect: () => ({ bottom: view.scrollBottom }) }
  const editor = { closest: (selector) => (selector === '[data-input-scroll]' && view.hasScroll ? scroll : null), contains: (node) => (node === document.activeElement ? view.focusInEditor : true), getBoundingClientRect: () => ({ left: 0, top: 0, right: view.width - 4, width: view.width, height: 100 }) }
  const card = {
    contains: () => true,
    querySelector: () => editor,
    // The Host's attachment rail renders one <img> per pasted picture.
    querySelectorAll: (selector) => (selector === 'img' ? view.images : []),
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
    createElement: (tag) => {
      if (tag !== 'canvas') throw new Error(`unexpected element: ${tag}`)
      // No 2d context: the encoder falls back to the source bytes, which is what these tests check.
      return { width: 0, height: 0, getContext: () => null, toDataURL: () => 'data:image/jpeg;base64,AAAA' }
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
        getBoundingClientRect: () => ({ left: view.caretOffset, top: 10, width: 0, height: view.caretHeight }),
      }),
    }),
    getComputedStyle: () => view.computed,
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
      // A real DOM node can always be measured: the ghost reaches down to view.ghostBottom.
      if (props && props['data-composer-ghost'] !== undefined) element.getBoundingClientRect = () => ({ bottom: view.ghostBottom })
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
  const imageFetches = []
  const context = {
    window,
    document,
    FileReader: class {
      readAsDataURL(blob) {
        blob.arrayBuffer().then((buffer) => {
          this.result = `data:${blob.type || 'image/png'};base64,${Buffer.from(buffer).toString('base64')}`
          this.onload?.()
        })
      }
    },
    createImageBitmap: async (blob) => ({ width: 40, height: 30, close() {} }),
    fetch: async (url, init) => {
      // A composer thumbnail is fetched from its blob: URL; the prediction goes to the endpoint.
      if (String(url).startsWith('blob:') || String(url).startsWith('data:')) {
        imageFetches.push({ url, init })
        if (view.imageUnreadable === true) return new Response('nope', { status: 404 })
        return new Response(new Uint8Array(view.imageBytes).fill(7), { headers: { 'content-type': 'image/png' } })
      }
      fetchCalls.push({ url, init })
      if (fetch === undefined) return streamResponse('')
      return fetch(url, init)
    },
    console: { warn: (...args) => warnings.push(args.join(' ')) },
    AbortController,
    TextDecoder,
    Buffer,
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

  function render({ draft = '', ghost, box, running = false, reserve = 0, attachments } = {}) {
    view.draft = draft
    if (attachments !== undefined) view.attachmentIds = attachments
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
      reserve,
    ]
    const wrapper = registered['conversation.input.overlay'].component({
      sessionId: 's1',
      useInput: (select) => select({ draft, attachmentIds: view.attachmentIds }),
      useSessionStatus: (select) => select(new Map([['s1', { running }]])),
      inputActions,
    })
    const tree = wrapper.type(wrapper.props)
    return { tree, state, effects, layouts, listeners, request, timers }
  }

  return { module, registered, render, view, scroll, inserted, fetchCalls, imageFetches, warnings, windowListeners, localStorage, dictionaries, effects, layouts, listeners, timers }
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
  same(readPrefs(), { next: true, continue: true, model: '' })
  setPref('continue', false)
  same(readPrefs(), { next: true, continue: false, model: '' })
  same(JSON.parse(app.localStorage.saved), { next: true, continue: false, model: '' })
  setPref('next', false)
  same(readPrefs(), { next: false, continue: false, model: '' })
})

test('saved preferences are restored, and blocked storage still works for the window', () => {
  const restored = load({ prefs: { next: false, continue: true, model: ' claude-sonnet-5-5 ' } })
  same(restored.module.__testing.readPrefs(), { next: false, continue: true, model: 'claude-sonnet-5-5' })

  // Older saved preferences have no model: the Session's model answers.
  const older = load({ prefs: { next: true, continue: false } })
  same(older.module.__testing.readPrefs(), { next: true, continue: false, model: '' })

  const blocked = load({ storageBlocked: true })
  same(blocked.module.__testing.readPrefs(), { next: true, continue: true, model: '' })
  assert.doesNotThrow(() => blocked.module.__testing.setPref('next', false))
  assert.equal(blocked.module.__testing.readPrefs().next, false)
})

test('another window changing the preference is picked up through the storage event', () => {
  const app = load()
  const onStorage = app.windowListeners.get('storage')
  onStorage({ key: 'something-else', newValue: '{"next":false}' })
  same(app.module.__testing.readPrefs(), { next: true, continue: true, model: '' })
  onStorage({ key: PREFERENCE_KEY, newValue: JSON.stringify({ next: false, continue: true, model: 'claude-sonnet-5-5' }) })
  same(app.module.__testing.readPrefs(), { next: false, continue: true, model: 'claude-sonnet-5-5' })
  onStorage({ key: PREFERENCE_KEY, newValue: null })
  same(app.module.__testing.readPrefs(), { next: true, continue: true, model: '' })
})

test('the settings row has one switch per mode, a model field, a cost note, and a status line', () => {
  const app = load()
  const element = app.registered['settings.general.item'].component()
  const row = element.type(element.props)
  const toggles = row.children.filter((child) => child && child.props && 'checked' in child.props)
  same(toggles.map((toggle) => toggle.props.title), ['Suggest my next message', 'Continue my draft with Tab'])
  assert.ok(toggles.every((toggle) => toggle.props.checked === true))
  toggles[1].props.onChange(false)
  same(app.module.__testing.readPrefs(), { next: true, continue: false, model: '' })
  const status = row.children.find((child) => child && child.type && child.type.name === 'StatusLine')
  assert.ok(status, 'the row ends with the status line')
  const field = row.children.find((child) => child && child.type && child.type.name === 'ModelField')
  assert.ok(field, 'the row has the model field')
  assert.equal(field.props.title, 'Model for suggestions')
  assert.equal(field.props.placeholder, 'Same as the session')
})

function modelInput(app) {
  const element = app.registered['settings.general.item'].component()
  const row = element.type(element.props)
  const field = row.children.find((child) => child && child.type && child.type.name === 'ModelField')
  return field.type(field.props).children.find((child) => child && child.type === 'input')
}

test('a model typed in Settings is saved when the box loses focus, trimmed, and empty means follow the session', () => {
  const app = load()
  assert.equal(modelInput(app).props.defaultValue, '')
  modelInput(app).props.onBlur({ target: { value: '  claude-sonnet-5-5 ' } })
  assert.equal(app.module.__testing.readPrefs().model, 'claude-sonnet-5-5')
  same(JSON.parse(app.localStorage.saved), { next: true, continue: true, model: 'claude-sonnet-5-5' })
  // The box shows the saved value and is reloaded when it changes elsewhere.
  assert.equal(modelInput(app).props.defaultValue, 'claude-sonnet-5-5')
  assert.equal(modelInput(app).props.key, 'claude-sonnet-5-5')
  assert.equal(modelInput(app).props.maxLength, 200)

  modelInput(app).props.onBlur({ target: { value: '   ' } })
  assert.equal(app.module.__testing.readPrefs().model, '', 'blank goes back to following the session')
})

test('leaving the model box unchanged saves nothing, and Enter finishes editing', () => {
  const app = load({ prefs: { next: true, continue: true, model: 'claude-sonnet-5-5' } })
  modelInput(app).props.onBlur({ target: { value: 'claude-sonnet-5-5' } })
  assert.equal(app.localStorage.saved, undefined, 'no write for an unchanged value')

  let blurred = 0
  const target = { blur: () => { blurred += 1 } }
  modelInput(app).props.onKeyDown({ key: 'Enter', isComposing: false, target })
  assert.equal(blurred, 1)
  modelInput(app).props.onKeyDown({ key: 'Enter', isComposing: true, target })
  modelInput(app).props.onKeyDown({ key: 'a', target })
  assert.equal(blurred, 1, 'an IME Enter and other keys do not finish editing')
})

test('the model from Settings goes with every request, and is left out when empty', async () => {
  const withModel = load({ prefs: { next: true, continue: true, model: 'claude-sonnet-5-5' }, fetch: async () => streamResponse(sse({ type: 'done', items: ['x'], seq: 1 })) })
  await withModel.render({ draft: 'Can you also' }).request('continue', 'Can you also')
  await withModel.render({ draft: '' }).request('next', '')
  same(JSON.parse(withModel.fetchCalls[0].init.body), { sessionId: 's1', mode: 'continue', draft: 'Can you also', model: 'claude-sonnet-5-5' })
  same(JSON.parse(withModel.fetchCalls[1].init.body), { sessionId: 's1', mode: 'next', draft: '', model: 'claude-sonnet-5-5' })

  const without = load({ fetch: async () => streamResponse(sse({ type: 'done', items: ['x'], seq: 1 })) })
  await without.render({ draft: '' }).request('next', '')
  same(JSON.parse(without.fetchCalls[0].init.body), { sessionId: 's1', mode: 'next', draft: '' })
  assert.ok(!('model' in JSON.parse(without.fetchCalls[0].init.body)))

  // A change made in Settings applies to the next request without reloading the page.
  without.module.__testing.setPref('model', 'deepseek-flash')
  await without.render({ draft: '' }).request('next', '')
  assert.equal(JSON.parse(without.fetchCalls[1].init.body).model, 'deepseek-flash')
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

test('Tab continues from an attached image alone, and the request carries that image', async () => {
  const app = load({ fetch: async () => streamResponse(sse({ type: 'done', items: ['What is this error?'], seq: 4, images: 'used' })) })
  app.view.images = [{ src: 'blob:shot', alt: 'shot.png', closest: () => null }]
  const rendered = app.render({ draft: '', attachments: ['a1'] })
  runEffects(rendered)
  const tab = keyEvent('Tab')
  rendered.listeners.get('keydown')(tab)
  assert.equal(tab.prevented, true, 'Tab is taken for the continuation')
  await tick()

  assert.equal(app.imageFetches.length, 1, 'the thumbnail is read')
  assert.equal(app.fetchCalls.length, 1)
  const body = JSON.parse(app.fetchCalls[0].init.body)
  same(body, { sessionId: 's1', mode: 'continue', draft: '', images: [{ mediaType: 'image/png', data: 'BwcHBw==', name: 'shot.png' }] })
  // The finished suggestion is accepted by the next Tab like any other continuation.
  const accepted = app.render({ draft: '', attachments: ['a1'], ghost: rendered.state[0] })
  runEffects(accepted)
  accepted.listeners.get('keydown')(keyEvent('Tab'))
  same(app.inserted, ['What is this error?'])
})

test('text and images travel together, and text still has to end at the caret', async () => {
  const app = load({ fetch: async () => streamResponse(sse({ type: 'done', items: [' the cause'], seq: 4 })) })
  app.view.images = [{ src: 'blob:shot', closest: () => null }]
  const atEnd = app.render({ draft: 'Find', attachments: ['a1'] })
  runEffects(atEnd)
  atEnd.listeners.get('keydown')(keyEvent('Tab'))
  await tick()
  const body = JSON.parse(app.fetchCalls[0].init.body)
  assert.equal(body.draft, 'Find')
  assert.equal(body.images.length, 1)

  const midDraft = load({ fetch: async () => streamResponse(sse({ type: 'done', items: ['x'], seq: 4 })) })
  midDraft.view.images = [{ src: 'blob:shot', closest: () => null }]
  midDraft.view.tail = 'rest of the draft'
  const mid = midDraft.render({ draft: 'Find the cause', attachments: ['a1'] })
  runEffects(mid)
  const tab = keyEvent('Tab')
  mid.listeners.get('keydown')(tab)
  assert.equal(tab.prevented, false, 'Tab keeps its normal job away from the end')
  assert.equal(midDraft.fetchCalls.length, 0)
})

test('an attached picture suppresses the next-message offer, and removing it brings the offer back', () => {
  const withImage = load()
  const rendered = withImage.render({ draft: '', attachments: ['a1'] })
  runEffects(rendered)
  assert.equal(rendered.timers.length, 0, 'no next-message prediction while a picture is attached')
  assert.equal(rendered.tree.props['data-composer-suggest-anchor'] !== undefined, true, 'only the anchor renders')

  const empty = load()
  const cleared = empty.render({ draft: '', attachments: [] })
  runEffects(cleared)
  same(cleared.timers.map((timer) => timer.ms), [600])
})

test('an image-only continuation is drawn in the text column, since there is no caret line to follow', () => {
  const app = load()
  const ghost = { mode: 'continue', items: [' 看图说一句'] }
  const rendered = app.render({ draft: '', attachments: ['a1'], ghost })
  for (const layout of rendered.layouts) layout()
  const box = rendered.state[1]
  assert.ok(box !== null, 'the ghost has a place to go')
  assert.equal(box.left, 14, 'the editor left inset')
  assert.equal(box.columnLeft, 14)
  assert.equal(box.lineBreak, false)
  const shown = app.render({ draft: '', attachments: ['a1'], ghost, box })
  assert.equal(shown.tree.children[1].props.style.textIndent, 0)
  assert.equal(shown.tree.children[1].props.style.left, 14)
})

test('an unreadable picture with no text says so instead of asking the model', async () => {
  const app = load({ fetch: async () => streamResponse(sse({ type: 'done', items: ['x'], seq: 4 })) })
  app.view.imageUnreadable = true
  app.view.images = [{ src: 'blob:shot', closest: () => null }]
  const rendered = app.render({ draft: '', attachments: ['a1'] })
  runEffects(rendered)
  rendered.listeners.get('keydown')(keyEvent('Tab'))
  await tick()
  assert.equal(app.fetchCalls.length, 0, 'nothing is asked')
  assert.deepEqual({ ...app.module.__testing.readStatus() }, { state: 'note', key: 'imagesUnread' })
})

test('adding or removing a picture re-arms Tab after Escape', async () => {
  const app = load({ fetch: async () => streamResponse(sse({ type: 'done', items: [' more'], seq: 4 })) })
  app.view.images = [{ src: 'blob:shot', closest: () => null }]
  const first = app.render({ draft: 'Add', attachments: ['a1'] })
  runEffects(first)
  first.listeners.get('keydown')(keyEvent('Tab'))
  await tick()
  const finished = app.render({ draft: 'Add', attachments: ['a1'], ghost: first.state[0] })
  runEffects(finished)
  finished.listeners.get('keydown')(keyEvent('Escape'))
  const dismissed = app.render({ draft: 'Add', attachments: ['a1'] })
  runEffects(dismissed)
  const blocked = keyEvent('Tab')
  dismissed.listeners.get('keydown')(blocked)
  assert.equal(blocked.prevented, false, 'dismissed for this draft')

  const changed = app.render({ draft: 'Add', attachments: ['a1', 'a2'] })
  runEffects(changed)
  const again = keyEvent('Tab')
  changed.listeners.get('keydown')(again)
  assert.equal(again.prevented, true, 'another picture is another draft')
  await tick()
  assert.equal(app.fetchCalls.length, 2)
})

test('the status line says when the model could not see the pictures', () => {
  const app = load()
  const { reportStatus } = app.module.__testing
  const element = app.registered['settings.general.item'].component()
  const row = element.type(element.props)
  const statusElement = row.children.find((child) => child && child.type && child.type.name === 'StatusLine')
  const text = () => statusElement.type(statusElement.props).children[0]

  reportStatus({ state: 'ok', route: 'claude-suggest / claude-sonnet-5-5', ms: 900, images: 'used' })
  assert.equal(text(), 'Last suggestion: claude-suggest / claude-sonnet-5-5 · 900 ms')
  reportStatus({ state: 'ok', route: 'claude-suggest / claude-sonnet-5-5', ms: 900, images: 'skipped' })
  assert.equal(text(), 'Last suggestion: claude-suggest / claude-sonnet-5-5 · 900 ms The model could not see the attached images.')
})

test('the composer thumbnails are read from the card only, never from elsewhere', () => {
  const { collectComposerImages } = load().module.__testing
  const make = (src, extra = {}) => ({ src, closest: () => null, ...extra })
  const card = {
    querySelectorAll: () => [
      make('blob:a'),
      make('blob:a'),
      make('data:image/png;base64,AAAA'),
      make('data:image/svg+xml;base64,AAAA'),
      make('https://example.com/avatar.png'),
      make(''),
      make('blob:b', { closest: () => ({}) }),
      make('blob:c', { alt: 'screen.png' }),
    ],
  }
  same(collectComposerImages(card), [{ src: 'blob:a' }, { src: 'data:image/png;base64,AAAA' }, { src: 'blob:c', name: 'screen.png' }])
  same(collectComposerImages(null), [])
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

test('with no room left after the caret the continuation starts on the next line, never over the draft', () => {
  const edge = load()
  edge.view.caretOffset = 590
  const cramped = edge.render({ draft: 'Can you also', ghost: { mode: 'continue', items: [' x'] } })
  for (const layout of cramped.layouts) layout()
  assert.notEqual(cramped.state[1], null, 'it is still shown')
  assert.equal(cramped.state[1].lineBreak, true)
  const placed = edge.render({ draft: 'Can you also', ghost: { mode: 'continue', items: [' x'] }, box: cramped.state[1] }).tree.children[1].props.style
  assert.equal(placed.top, cramped.state[1].top + cramped.state[1].height, 'one line below the caret line')
  assert.equal(placed.textIndent, 0)

  const fits = load()
  fits.view.caretOffset = 400
  const roomy = fits.render({ draft: 'Can you also', ghost: { mode: 'continue', items: [' x'] } })
  for (const layout of roomy.layouts) layout()
  assert.equal(roomy.state[1].left, 400)
  assert.equal(roomy.state[1].maxWidth, 184)
  assert.equal(roomy.state[1].lineBreak, false)
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

// The ghost is a block that wraps at the editor's column, like the text it stands for.
const ghostStyle = (tree) => tree.children[1].props.style

test('a continuation wraps in place: it spans the text column and its first line starts at the caret', () => {
  const app = load()
  const ghost = { mode: 'continue', items: [' 把 README 里的用法示例也更新成带时区参数的写法，再补一个无效时区的测试'] }
  const box = { top: 30, left: 420, maxWidth: 164, height: 24, columnLeft: 14, right: 12, lineBreak: false }
  const style = ghostStyle(app.render({ draft: '理一下目前的流程', ghost, box }).tree)
  assert.equal(style.position, 'absolute')
  assert.equal(style.whiteSpace, 'pre-wrap', 'wraps like the editor')
  assert.equal(style.overflowWrap, 'anywhere')
  assert.equal(style.left, 14, 'wrapped lines return to the left edge of the text column')
  assert.equal(style.right, 12)
  assert.equal(style.top, 30)
  assert.equal(style.textIndent, 406, 'the first line starts where the caret is')
  assert.equal(style.overflow, undefined, 'never clipped')
  assert.equal(style.textOverflow, undefined, 'no ellipsis')
  assert.equal(style.background, undefined, 'the block does not hide the draft before the caret')
})

test('only the text itself masks what is behind a continuation, and it is the whole text, not a cut-off part', () => {
  const app = load()
  const long = ' 把 README 里的用法示例也更新成带时区参数的写法，再补一个无效时区的测试'
  const tree = app.render({ draft: '理一下', ghost: { mode: 'continue', items: [long] } }).tree
  const text = tree.children[1].children[0]
  assert.equal(text.children[0], long)
  assert.equal(text.props.style.background, 'var(--dsw-specific-input-major)')
  assert.equal(text.props.style.boxDecorationBreak, 'clone', 'the mask follows every wrapped line')
  assert.equal(text.props.style.textOverflow, undefined)
})

test('a next-message suggestion also wraps in the text column instead of being cut off', () => {
  const app = load()
  const long = 'Please run the full test suite, then compare the output against the previous run and tell me which tests changed'
  const tree = app.render({ draft: '', ghost: { mode: 'next', items: [long] }, box: { top: 4, left: 14, right: 12, height: 24, maxWidth: 400 } }).tree
  const style = ghostStyle(tree)
  assert.equal(style.whiteSpace, 'pre-wrap')
  assert.equal(style.left, 14)
  assert.equal(style.right, 12)
  assert.equal(style.minHeight, 24)
  assert.equal(style.background, 'var(--dsw-specific-input-major)', 'covers the placeholder')
  assert.equal(tree.children[1].children[0].children[0], long)
})

test('the first-line indent stays on the text: the count, the Tab hint and the spinner do not inherit it', () => {
  const app = load()
  const box = { top: 30, left: 420, maxWidth: 164, height: 24, columnLeft: 14, right: 12, lineBreak: false }
  const tree = app.render({ draft: '理一下', ghost: { mode: 'continue', items: [' 更新一下', ' 再改一下'] }, box }).tree
  const chip = tree.children[1]
  assert.equal(chip.props.style.textIndent, 406, 'the block indents its first line to the caret')
  const [, , badge, keycap] = chip.children
  assert.equal(badge.props.style.textIndent, 0, 'text-indent is inherited, so the small pieces reset it')
  assert.equal(keycap.props.style.textIndent, 0)
  assert.equal(keycap.props.style.whiteSpace, 'nowrap', 'the Tab hint never splits over two lines')
  assert.equal(badge.props.style.whiteSpace, 'nowrap')
  const css = tree.children.find((child) => child && child.type === 'style').children[0]
  assert.match(css, /\.cs-spin\{[^}]*text-indent:0/)
})

test('the ghost is set in the editor\'s own font, size and line spacing', () => {
  const app = load()
  app.view.computed = { lineHeight: '27.2px', fontSize: '17px', fontFamily: 'PingFang SC, sans-serif', fontWeight: '400', letterSpacing: '0.2px' }
  const cont = app.render({ draft: '理一下', ghost: { mode: 'continue', items: [' 更新一下'] } })
  for (const layout of cont.layouts) layout()
  assert.deepEqual(JSON.parse(JSON.stringify(cont.state[1].font)), { fontFamily: 'PingFang SC, sans-serif', fontSize: '17px', fontWeight: '400', letterSpacing: '0.2px', lineHeight: '27.2px' })
  const style = app.render({ draft: '理一下', ghost: { mode: 'continue', items: [' 更新一下'] }, box: cont.state[1] }).tree.children[1].props.style
  assert.equal(style.fontSize, '17px')
  assert.equal(style.lineHeight, '27.2px', 'wrapped lines are spaced exactly like the draft')
  assert.equal(style.fontFamily, 'PingFang SC, sans-serif')
  assert.equal(style.letterSpacing, '0.2px')

  // `normal` and empty values are not copied: the ghost keeps inheriting those.
  app.view.computed = { lineHeight: 'normal', fontSize: '', fontFamily: 'sans-serif', letterSpacing: 'normal' }
  const plain = app.render({ draft: '', ghost: { mode: 'next', items: ['Run it again'] } })
  for (const layout of plain.layouts) layout()
  assert.deepEqual(JSON.parse(JSON.stringify(plain.state[1].font)), { fontFamily: 'sans-serif' })
})

test('the next-message ghost uses the editor\'s type settings too', () => {
  const app = load()
  app.view.computed = { lineHeight: '27px', fontSize: '17px' }
  const rendered = app.render({ draft: '', ghost: { mode: 'next', items: ['Run it again'] } })
  for (const layout of rendered.layouts) layout()
  const style = app.render({ draft: '', ghost: { mode: 'next', items: ['Run it again'] }, box: rendered.state[1] }).tree.children[1].props.style
  assert.equal(style.fontSize, '17px')
  assert.equal(style.lineHeight, '27px')
})

test('the first line of a continuation sits on the draft\'s own line, not lower by the line spacing', () => {
  // The caret rectangle is the glyph box (20px); the draft's line box is 28px tall. The ghost's
  // first line is a 28px box too, so it must start 4px higher than the caret rectangle does.
  const app = load()
  app.view.caretHeight = 20
  app.view.computed = { lineHeight: '28px' }
  const rendered = app.render({ draft: '理一下', ghost: { mode: 'continue', items: [' 更新一下'] } })
  for (const layout of rendered.layouts) layout()
  assert.equal(rendered.state[1].top, 10 - 4)
  assert.equal(rendered.state[1].height, 28, 'the line pitch is the editor\'s line height')

  // When both are the same height nothing moves.
  const same = load()
  same.view.caretHeight = 24
  same.view.computed = { lineHeight: '24px' }
  const flat = same.render({ draft: '理一下', ghost: { mode: 'continue', items: [' 更新一下'] } })
  for (const layout of flat.layouts) layout()
  assert.equal(flat.state[1].top, 10)
})

test('the text, the candidate count and the Tab hint flow together after the text', () => {
  const app = load()
  const chip = app.render({ draft: 'Can you also', ghost: { mode: 'continue', items: [' run the tests', ' add a test'] } }).tree.children[1]
  assert.deepEqual(chip.children.map((child) => child && (child.type === 'kbd' ? 'kbd' : child.type)), ['span', null, 'span', 'kbd'])
  assert.equal(chip.children[3].props.style.display, 'inline-block')
  assert.equal(chip.children[2].props.style.display, 'inline-block')
})

test('a ghost taller than the editor pushes the toolbar down by exactly the overflow, and gives it back', () => {
  const app = load()
  const ghost = { mode: 'continue', items: [' 一段很长很长的续写内容'] }
  // The wrapped ghost reaches 160px; the Host's scroll element, which holds the editor, ends at 100px.
  app.view.scrollBottom = 100
  app.view.ghostBottom = 160
  const shown = app.render({ draft: '理一下', ghost })
  for (const layout of shown.layouts) layout()
  assert.equal(shown.state[3], 60, 'the overflow is measured')

  const pushed = app.render({ draft: '理一下', ghost, reserve: 60 })
  for (const layout of pushed.layouts) layout()
  assert.equal(app.scroll.style.marginBottom, '60px', 'the toolbar row is moved down')

  const gone = app.render({ draft: '理一下', ghost, reserve: 0 })
  for (const layout of gone.layouts) layout()
  assert.equal(app.scroll.style.marginBottom, '', 'the margin is removed again')
})

test('a margin the Host already had is restored, not erased', () => {
  const app = load()
  app.scroll.style.marginBottom = '4px'
  const ghost = { mode: 'continue', items: [' 更新一下'] }
  const pushed = app.render({ draft: '顺便帮我', ghost, reserve: 40 })
  for (const layout of pushed.layouts) layout()
  assert.equal(app.scroll.style.marginBottom, '40px')
  const gone = app.render({ draft: '顺便帮我', ghost, reserve: 0 })
  for (const layout of gone.layouts) layout()
  assert.equal(app.scroll.style.marginBottom, '4px')
})

test('nothing is reserved when the ghost fits, when it is hidden, or when the Host markup is not found', () => {
  const ghost = { mode: 'continue', items: [' 更新一下'] }
  const fit = load()
  fit.view.scrollBottom = 100
  fit.view.ghostBottom = 90
  const a = fit.render({ draft: '顺便帮我', ghost })
  for (const layout of a.layouts) layout()
  assert.equal(a.state[3], 0, 'inside the editor: no space needed')

  const missing = load()
  missing.view.hasScroll = false
  missing.view.ghostBottom = 400
  const b = missing.render({ draft: '顺便帮我', ghost })
  for (const layout of b.layouts) layout()
  assert.equal(b.state[3], 0, 'without the Host element nothing is changed')
  assert.equal(missing.scroll.style.marginBottom, '')

  const hidden = load()
  hidden.view.ghostBottom = 400
  const c = hidden.render({ draft: '顺便帮我', ghost: { mode: 'continue', items: [] } })
  for (const layout of c.layouts) layout()
  assert.equal(c.state[3], 0, 'no suggestion: no space')
})

test('the reserved space is capped so a runaway suggestion cannot swallow the screen', () => {
  const app = load()
  app.view.scrollBottom = 100
  app.view.ghostBottom = 5000
  const shown = app.render({ draft: '理一下', ghost: { mode: 'continue', items: [' 很长'] } })
  for (const layout of shown.layouts) layout()
  assert.equal(shown.state[3], 240)
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

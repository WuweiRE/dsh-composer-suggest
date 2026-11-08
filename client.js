/**
 * Browser half of composer suggestions.
 *
 * Two modes share one overlay:
 * - `next`: after a turn settles and the composer is empty, the Host streams
 *   candidate follow-up messages as ghost text over the placeholder.
 * - `continue`: while the user pauses mid-draft with the caret at the end, the
 *   Host streams continuations of that draft and the ghost follows the caret.
 *
 * Tab accepts the current candidate as an editable draft, Alt+Down / Alt+Up
 * cycle between candidates, Escape dismisses one. Typing aborts in-flight work
 * and hides the ghost; nothing is ever sent to the agent by accepting.
 * Each mode has its own switch in Settings → General, and the same row shows
 * which model route answered last (or why a request failed).
 *
 * The overlay seat is anchored to the composer card, so the ghost measures the
 * resident editor and follows its padding, line height, and scroll position.
 *
 * Derived from MIT-licensed dsh-composer-predictions (Stijnus) and
 * dsh-composer-prediction (Amir Bazylkhanov); see THIRD_PARTY_NOTICES.md.
 */

window.__ModuleLoader__.load({
  id: 'dsh-composer-suggest',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /**
     * Local switch button. The host's own switch is a harness Client package,
     * which a bundle must not load: it can change without notice, and a throw
     * would take the whole plugin down. This reproduces its markup, CSS and
     * behaviour with plugin-owned classes and theme tokens only.
     */
    const SWITCH_CSS = [
      '.cs-switch{box-sizing:border-box;position:relative;flex:0 0 auto;width:36px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-border-l2)}',
      '.cs-switch{cursor:pointer}',
      '.cs-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}',
      '.cs-switch:disabled{cursor:default;opacity:.5}',
      '.cs-switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.cs-switch__thumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .12s}',
      '.cs-switch[aria-checked="true"] .cs-switch__thumb{transform:translate(16px)}',
      '.cs-input{box-sizing:border-box;flex:0 0 auto;width:220px;height:28px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
      '.cs-input::placeholder{color:var(--dsw-alias-label-secondary)}',
      '.cs-input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
    ].join('')

    function Switch({ checked, label, onChange, disabled }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': checked === true ? 'true' : 'false',
          'aria-label': label,
          className: 'cs-switch',
          disabled: disabled === true,
          onClick: () => onChange(checked !== true),
        },
        h('span', { className: 'cs-switch__thumb', 'aria-hidden': 'true' }),
      )
    }

    /** Small spinner shown while the model is continuing; slower under reduced motion. */
    const SPIN_CSS = '.cs-spin{box-sizing:border-box;flex:none;width:10px;height:10px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:cs-spin .8s linear infinite}@keyframes cs-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.cs-spin{animation-duration:2.4s}}'

    const NS = 'composer-suggest'
    const ENDPOINT = '/composer-suggest/stream'
    const SLOT = 'conversation.input.overlay'

    /** Wait for the settled UI before asking, so a fresh turn is fully committed. */
    const SETTLE_MS = 600
    /** Longest model id the Settings field keeps; the Host refuses longer ones. */
    const MAX_MODEL_CHARS = 200
    /** How long a "nothing to continue" notice stays in the composer. */
    const NOTICE_MS = 2600
    /** The Host bounds the draft too; this keeps the request body small. */
    const MAX_DRAFT_CHARS = 4_000
    /** Ignore the first characters of a streaming answer to avoid flicker. */
    const STREAM_MIN_CHARS = 3

    /** Editor text insets from the resident composer styles. */
    const EDITOR_INSET_TOP = 4
    const EDITOR_INSET_LEFT = 14
    const EDITOR_INSET_RIGHT = 8
    /** The editable scroll container's right margin, outside the text column. */
    const EDITOR_SCROLL_MARGIN = 4
    const FALLBACK_LINE_HEIGHT = 24

    /** Host replies that mean "nothing to suggest", not "something broke". */
    const BENIGN_REASONS = new Set(['no-conversation', 'session-not-live', 'no-draft', 'empty'])

    const DICTIONARIES = {
      en: {
        label: 'Composer suggestion',
        accept: 'Press Tab to accept this suggestion',
        cancel: 'Press Esc to cancel',
        more: 'Alt+Down for the next suggestion',
        next: 'Suggest my next message',
        nextHint: 'After a reply, show the message you are most likely to send next.',
        continue: 'Continue my draft with Tab',
        continueHint: 'With text in the composer and the caret at its end, press Tab. The model continues it using the conversation above; press Tab again to accept. Nothing is asked until you press Tab, and Tab keeps its usual job anywhere else.',
        model: 'Model for suggestions',
        modelHint: 'Leave empty to use the current session\'s model, or enter a model id such as claude-sonnet-5-5 to use that one instead. If no provider offers it, the status line below says so.',
        modelPlaceholder: 'Same as the session',
        cost: 'Every suggestion is a model call and uses tokens. Saved in this browser on this device.',
        pending: 'Continuing…',
        statusIdle: 'No suggestion requested yet.',
        statusOk: 'Last suggestion: {route} · {ms} ms',
        statusCached: 'Last suggestion: {route} · cached',
        statusError: 'Last suggestion failed: {reason}',
        noteEmpty: 'The model had nothing to suggest.',
        noticeFailed: 'Continuation failed: {reason}',
        ready: 'Suggestion: {text}. Press Tab to accept. Alt+Down or Alt+Up changes candidates. Escape dismisses.',
      },
      zh: {
        label: '输入建议',
        accept: '按 Tab 采纳该建议',
        cancel: '按 Esc 取消',
        more: '按 Alt+↓ 查看下一条建议',
        next: '建议下一条消息',
        nextHint: '回复结束后，显示你最可能接着发送的消息。',
        continue: '用 Tab 续写我的草稿',
        continueHint: '输入框里有内容且光标在末尾时按 Tab，模型会结合上面的对话续写，再按一次 Tab 采纳。不按 Tab 就不会请求模型，其他情况下 Tab 照常使用。',
        model: '建议使用的模型',
        modelHint: '留空则使用当前会话的模型；填写模型 ID（如 claude-sonnet-5-5）则改用该模型。找不到时，下方状态行会提示。',
        modelPlaceholder: '与会话相同',
        cost: '每次建议都会调用一次模型并消耗 token。设置保存在当前设备的浏览器中。',
        pending: '正在续写…',
        statusIdle: '尚未请求过建议。',
        statusOk: '上次建议：{route} · {ms} ms',
        statusCached: '上次建议：{route} · 命中缓存',
        statusError: '上次建议失败：{reason}',
        noteEmpty: '模型没有给出建议。',
        noticeFailed: '续写失败：{reason}',
        ready: '建议：{text}。按 Tab 采纳，Alt+↓ 或 Alt+↑ 切换，Escape 关闭。',
      },
    }

    const PREFERENCE_KEY = 'dsh-composer-suggest.prefs'
    /** Both modes are on, and the Session's own model answers, until the user says otherwise. */
    const DEFAULT_PREFS = { next: true, continue: true, model: '' }
    function parsePrefs(stored) {
      if (stored === null || typeof stored !== 'object') return DEFAULT_PREFS
      const model = typeof stored.model === 'string' ? stored.model.trim().slice(0, MAX_MODEL_CHARS) : ''
      return { next: stored.next !== false, continue: stored.continue !== false, model }
    }
    let prefs = DEFAULT_PREFS
    try {
      prefs = parsePrefs(JSON.parse(window.localStorage.getItem(PREFERENCE_KEY) || 'null'))
    } catch {
      // Restricted storage keeps the preference in memory for this window.
    }
    const preferenceListeners = new Set()
    const subscribePreference = (listener) => {
      preferenceListeners.add(listener)
      return () => preferenceListeners.delete(listener)
    }
    const readPrefs = () => prefs
    function setPref(key, value) {
      prefs = { ...prefs, [key]: value }
      try {
        window.localStorage.setItem(PREFERENCE_KEY, JSON.stringify(prefs))
      } catch {
        // The switch still works for this window when storage is unavailable.
      }
      for (const listener of preferenceListeners) listener()
    }
    function usePrefs() {
      return React.useSyncExternalStore(subscribePreference, readPrefs, readPrefs)
    }

    /** Last request outcome, shown in the settings row. Plain value, replaced on change. */
    let status = { state: 'idle' }
    const statusListeners = new Set()
    const subscribeStatus = (listener) => {
      statusListeners.add(listener)
      return () => statusListeners.delete(listener)
    }
    const readStatus = () => status
    let warnedReason = ''
    function reportStatus(next) {
      status = next
      if (next.state === 'error') {
        // One console line per distinct failure, so a broken route is findable without spam.
        if (next.reason !== warnedReason && typeof console !== 'undefined') {
          console.warn('[composer-suggest] ' + next.reason)
        }
        warnedReason = next.reason
      } else {
        warnedReason = ''
      }
      for (const listener of statusListeners) listener()
    }
    function useStatus() {
      return React.useSyncExternalStore(subscribeStatus, readStatus, readStatus)
    }

    function describeRoute(route) {
      if (route === null || typeof route !== 'object') return ''
      const model = typeof route.model === 'string' ? route.model : ''
      const provider = typeof route.provider === 'string' ? route.provider : ''
      return provider !== '' && model !== '' ? provider + ' / ' + model : model || provider
    }

    function StatusLine({ t }) {
      const current = useStatus()
      let text = t('statusIdle')
      let color = 'var(--dsw-alias-label-secondary)'
      if (current.state === 'ok') {
        text = t('statusOk').replace('{route}', current.route).replace('{ms}', String(current.ms))
      } else if (current.state === 'cached') {
        text = t('statusCached').replace('{route}', current.route)
      } else if (current.state === 'note') {
        text = t(current.key)
      } else if (current.state === 'error') {
        text = t('statusError').replace('{reason}', current.reason)
        color = 'var(--dsw-alias-state-error-primary)'
      }
      return h('div', { role: 'status', 'aria-live': 'polite', style: { fontSize: 12, lineHeight: '18px', marginTop: 8, color, wordBreak: 'break-word' } }, text)
    }

    function SettingRow({ title, hint, checked, onChange }) {
      return h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, padding: '12px 0' } },
        h('div', null,
          h('div', { style: { fontSize: 14, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' } }, title),
          h('div', { style: { fontSize: 12, lineHeight: '18px', marginTop: 2, color: 'var(--dsw-alias-label-secondary)' } }, hint),
        ),
        h(Switch, { checked, label: title, onChange }),
      )
    }

    /** One text setting. Uncontrolled so typing is never interrupted; saved when the box loses focus. */
    function ModelField({ title, hint, placeholder, value, onCommit }) {
      return h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, padding: '12px 0' } },
        h('div', null,
          h('div', { style: { fontSize: 14, lineHeight: '20px', color: 'var(--dsw-alias-label-primary)' } }, title),
          h('div', { style: { fontSize: 12, lineHeight: '18px', marginTop: 2, color: 'var(--dsw-alias-label-secondary)' } }, hint),
        ),
        h('input', {
          // The key reloads the box when the saved value changes somewhere else (another window).
          key: value,
          className: 'cs-input',
          type: 'text',
          defaultValue: value,
          placeholder,
          maxLength: MAX_MODEL_CHARS,
          spellCheck: false,
          autoCapitalize: 'off',
          autoCorrect: 'off',
          'aria-label': title,
          onBlur: (event) => onCommit(event.target.value.trim()),
          onKeyDown: (event) => {
            // Enter finishes editing; an IME candidate window keeps its own Enter.
            if (event.key === 'Enter' && event.isComposing !== true) event.target.blur()
          },
        }),
      )
    }

    function SuggestionSetting({ t }) {
      const current = usePrefs()
      return h('div', { style: { padding: '4px 0 12px', borderBottom: '0.5px solid var(--dsw-alias-border-l1)' } },
        h('style', null, SWITCH_CSS),
        h(SettingRow, { title: t('next'), hint: t('nextHint'), checked: current.next, onChange: (value) => setPref('next', value) }),
        h(SettingRow, { title: t('continue'), hint: t('continueHint'), checked: current.continue, onChange: (value) => setPref('continue', value) }),
        h(ModelField, {
          title: t('model'),
          hint: t('modelHint'),
          placeholder: t('modelPlaceholder'),
          value: current.model,
          onCommit: (value) => { if (value !== current.model) setPref('model', value) },
        }),
        h('div', { style: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' } }, t('cost')),
        h(StatusLine, { t }),
      )
    }

    const NO_GHOST = { mode: 'next', items: [], index: 0, stream: '', active: false, seq: null, notice: null }

    /** Per Session: the turn (Session seq) whose next-message offer was dismissed with Escape. */
    const dismissedSeqs = new Map()

    const NEXT_GHOST_STYLE = {
      position: 'absolute',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      boxSizing: 'border-box',
      fontFamily: 'inherit',
      fontSize: 'inherit',
      lineHeight: 'inherit',
      color: 'var(--dsw-alias-label-caption)',
      background: 'var(--dsw-specific-input-major)',
      overflow: 'hidden',
      whiteSpace: 'nowrap',
      pointerEvents: 'none',
      userSelect: 'none',
      zIndex: 2,
    }

    /** The continuation ghost hugs its text and sits where the caret is. */
    const CONTINUE_GHOST_STYLE = {
      ...NEXT_GHOST_STYLE,
      gap: '6px',
      padding: '0 4px',
      borderRadius: '4px',
      zIndex: 3,
    }

    const TEXT_STYLE = {
      flex: '1 1 auto',
      minWidth: 0,
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
      opacity: 0.9,
    }

    const CONTINUE_TEXT_STYLE = {
      ...TEXT_STYLE,
      flex: '0 1 auto',
    }

    const KEYCAP_STYLE = {
      flex: 'none',
      fontSize: '11px',
      lineHeight: '16px',
      padding: '0 5px',
      borderRadius: '4px',
      border: '1px solid var(--dsw-alias-border-l2)',
      color: 'var(--dsw-alias-label-tertiary)',
      background: 'transparent',
    }

    const BADGE_STYLE = {
      flex: 'none',
      fontSize: '10px',
      lineHeight: '14px',
      color: 'var(--dsw-alias-label-tertiary)',
      opacity: 0.8,
    }

    /**
     * Locate the composer card this overlay actually belongs to.
     *
     * The seat is rendered inside the resident composer card, so the anchor node
     * is an ancestor-scoped key: a global `querySelector` would pick whichever
     * card happens to be first in the document and paint that conversation's
     * ghost over another one.
     */
    function composerElementsNear(anchor) {
      if (typeof document === 'undefined') return null
      if (anchor === null || anchor === undefined || !anchor.isConnected) return null
      const card = anchor.closest('[data-composer-card]')
      if (card === null) return null
      const editor = card.querySelector('[contenteditable="true"]') || card.querySelector('[role="textbox"]')
      return editor === null ? null : { card, editor }
    }

    /** The collapsed selection inside the editor, when it is there at all. */
    function readCaret(editor) {
      if (typeof window === 'undefined' || typeof document === 'undefined') return null
      const selection = window.getSelection()
      if (selection === null || selection.rangeCount === 0) return null
      const range = selection.getRangeAt(0)
      if (range === null || !range.collapsed) return null
      if (!editor.contains(range.startContainer)) return null

      const prefixRange = document.createRange()
      prefixRange.selectNodeContents(editor)
      prefixRange.setEnd(range.startContainer, range.startOffset)
      const prefix = prefixRange.toString()

      // What follows the caret decides "at the end"; the draft text cannot be compared
      // with the DOM text, which has no newline between paragraphs and may hold chips.
      const tailRange = document.createRange()
      tailRange.selectNodeContents(editor)
      tailRange.setStart(range.startContainer, range.startOffset)
      const tail = tailRange.toString()

      const rect = caretRect(range)
      if (rect === null) return null
      return { prefix, tail, left: rect.left, top: rect.top, height: rect.height }
    }

    function caretRect(range) {
      let rect = range.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) {
        const rects = range.getClientRects()
        if (rects.length > 0) rect = rects[0]
      }
      if ((rect.width === 0 && rect.height === 0) || rect.top === 0 && rect.left === 0) {
        const fallback = rectBeforeCaret(range)
        if (fallback !== null) return fallback
      }
      if (rect.width === 0 && rect.height === 0) return null
      return { left: rect.left, top: rect.top, height: rect.height }
    }

    /** Measure the character before the caret when the collapsed range is empty. */
    function rectBeforeCaret(range) {
      const node = range.startContainer
      const offset = range.startOffset
      if (typeof Node === 'undefined' || node === null || node.nodeType !== Node.TEXT_NODE || offset <= 0) return null
      const probe = document.createRange()
      probe.setStart(node, offset - 1)
      probe.setEnd(node, offset)
      const rect = probe.getBoundingClientRect()
      if (rect.width === 0 && rect.height === 0) return null
      return { left: rect.right, top: rect.top, height: rect.height }
    }

    /** Whether the caret is at the effective end of the draft: text before it, only blanks after it. */
    function caretAtEnd(editor) {
      const caret = readCaret(editor)
      if (caret === null) return null
      if (stripBlanks(caret.prefix) === '') return null
      return stripBlanks(caret.tail) === '' ? caret : null
    }

    /** Remove whitespace and the zero-width characters an editor leaves at line ends. */
    function stripBlanks(text) {
      return text.replace(/[\s\u200b-\u200d\u2060\ufeff]+/gu, '')
    }

    /** A half-typed `/command` or `@reference` is not a message continuation. */
    function isTriggerToken(draft) {
      return /(?:^|\s)\/[^\s]*$/u.test(draft) || /(?:^|\s)@"?[^\s]*$/u.test(draft)
    }

    /** Show the model's first line while it is still streaming. */
    function streamingCandidate(stream) {
      if (stream.trim().length < STREAM_MIN_CHARS) return ''
      for (const raw of stream.split(/\r?\n/u)) {
        let line = raw.trim()
        if (line === '') continue
        if (/^none$/iu.test(line)) return ''
        line = cleanLine(line)
        if (line === '') continue
        return line.length > 240 ? line.slice(0, 240) : line
      }
      return ''
    }

    function cleanLine(line) {
      return line
        .replace(/^(?:[-*•]|\d+[.)])\s+/u, '')
        .replace(/^["'`\u201c\u201d]+|["'`\u201c\u201d]+$/gu, '')
        .replace(/\s+/gu, ' ')
        .trim()
    }

    /**
     * Join a continuation onto the draft without gluing words together.
     * Avoid repeating a separator already present in the exact draft.
     */
    function joinContinuation(draft, value) {
      if (draft === '' || value === '') return value
      if (/\s$/u.test(draft)) return value.replace(/^\s+/u, '')
      if (/^\s/u.test(value)) return value
      const last = draft.slice(-1)
      const first = value.slice(0, 1)
      // CJK text does not use a word separator; never invent one there.
      if (isCjk(last) || isCjk(first)) return value
      if (/[([{/\-—"'`]$/u.test(last)) return value
      if (/^[,.;:!?)\]}%]/u.test(first)) return value
      return ` ${value}`
    }

    function isCjk(character) {
      return /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/u.test(character)
    }

    function sameBox(left, right) {
      return (
        left !== null &&
        left !== undefined &&
        left.top === right.top &&
        left.left === right.left &&
        left.height === right.height &&
        left.right === right.right &&
        left.maxWidth === right.maxWidth
      )
    }

    /** Parse a fully buffered SSE body, for shells that cannot stream fetch bodies. */
    function parseSseText(text) {
      const events = []
      for (const frame of text.split('\n\n')) {
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue
          const payload = line.slice(5).trim()
          if (payload === '') continue
          try {
            events.push(JSON.parse(payload))
          } catch {
            // Ignore a malformed frame.
          }
        }
      }
      return events
    }

    /** Read one SSE body and hand every `data:` payload to the callback. */
    async function consumeStream(body, signal, onEvent) {
      const reader = body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      let terminal = false
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (signal.aborted) break
          buffer += decoder.decode(value, { stream: true })
          let boundary = buffer.indexOf('\n\n')
          while (boundary >= 0) {
            const frame = buffer.slice(0, boundary)
            buffer = buffer.slice(boundary + 2)
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue
              const payload = line.slice(5).trim()
              if (payload === '') continue
              try {
                const event = JSON.parse(payload)
                if (event.type === 'done' || event.type === 'error') terminal = true
                onEvent(event)
              } catch {
                // A malformed frame is ignored; the draft keeps working.
              }
            }
            boundary = buffer.indexOf('\n\n')
          }
        }
        return terminal
      } finally {
        if (signal.aborted) {
          try {
            await reader.cancel()
          } catch {
            // Cancelling a finished stream is harmless.
          }
        }
        reader.releaseLock()
      }
    }

    function ComposerSuggest(props) {
      const { sessionId, useInput, useSessionStatus, inputActions, t } = props
      const enabledPrefs = usePrefs()
      const nextEnabled = enabledPrefs.next
      const continueEnabled = enabledPrefs.continue
      const draft = useInput((state) => (state === undefined ? '' : state.draft || ''))
      const running = useSessionStatus((state) => (state === undefined ? false : state.get(sessionId)?.running === true))
      const [ghost, setGhost] = React.useState(NO_GHOST)
      const [box, setBox] = React.useState(null)
      const [compositionEnd, setCompositionEnd] = React.useState(0)

      const anchorRef = React.useRef(null)
      const elements = () => composerElementsNear(anchorRef.current)
      const abortRef = React.useRef(null)
      const composingRef = React.useRef(false)
      const dismissedRef = React.useRef(null)
      const acceptRef = React.useRef(null)
      const cycleRef = React.useRef(null)
      const ghostRef = React.useRef(NO_GHOST)
      const visibleRef = React.useRef(false)
      const currentRef = React.useRef('')

      const request = React.useCallback(
        async (mode, draftText) => {
          if (sessionId === undefined || sessionId === null) return
          if (typeof document !== 'undefined' && document.hidden) return
          abortRef.current?.abort()
          const controller = new AbortController()
          abortRef.current = controller
          setGhost({ mode, items: [], index: 0, stream: '', active: true, seq: null, notice: null })

          // A manual continuation that ends without text says so in the composer.
          const settle = (items, seq, notice = null) => {
            if (controller.signal.aborted) return
            if (mode === 'continue' && items.length === 0) dismissedRef.current = { draft: draftText }
            // Escape withdrew this turn's offer; the Host cache would otherwise hand it back.
            const dismissedTurn = mode === 'next' && typeof seq === 'number' && dismissedSeqs.get(sessionId) === seq
            setGhost((previous) => {
              if (previous.mode !== mode) return previous
              if (items.length === 0 || dismissedTurn) {
                return notice !== null && mode === 'continue' ? { ...NO_GHOST, mode, notice } : NO_GHOST
              }
              return { mode, items, index: 0, stream: '', active: false, seq: typeof seq === 'number' ? seq : null, notice: null }
            })
          }
          const fail = (reason) => {
            if (controller.signal.aborted) return
            reportStatus({ state: 'error', reason })
            settle([], null, { key: 'noticeFailed', reason })
          }
          const finish = (event) => {
            if (event.type === 'error') {
              if (event.reason === 'empty') {
                if (!controller.signal.aborted) reportStatus({ state: 'note', key: 'noteEmpty' })
                settle([], null, { key: 'noteEmpty' })
              } else if (BENIGN_REASONS.has(event.reason)) settle([], null)
              else fail(typeof event.reason === 'string' && event.reason !== '' ? event.reason : 'error')
              return
            }
            const items = Array.isArray(event.items)
              ? event.items.filter((item) => typeof item === 'string' && item !== '')
              : []
            if (items.length > 0 && !controller.signal.aborted) {
              const route = describeRoute(event.route)
              reportStatus(event.cached === true ? { state: 'cached', route } : { state: 'ok', route, ms: Number(event.ms) || 0 })
            }
            settle(items, event.seq)
          }

          try {
            const response = await fetch(ENDPOINT, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
              // A model typed in Settings wins over the Host configuration; empty means not set.
              body: JSON.stringify(
                prefs.model === ''
                  ? { sessionId, mode, draft: draftText }
                  : { sessionId, mode, draft: draftText, model: prefs.model },
              ),
              signal: controller.signal,
            })
            if (controller.signal.aborted) return
            if (!response.ok) {
              fail('HTTP ' + response.status)
              return
            }

            const contentType = response.headers.get('content-type') || ''
            if (!contentType.includes('text/event-stream')) {
              // The Host answers plain JSON when there is nothing to stream.
              const payload = await response.json().catch(() => null)
              const reason = typeof payload?.reason === 'string' ? payload.reason : ''
              if (reason !== '' && !BENIGN_REASONS.has(reason)) fail(reason)
              else settle([], null)
              return
            }

            if (response.body === null) {
              // Some desktop shells buffer the fetch body; parse the whole stream.
              const text = await response.text().catch(() => '')
              const last = parseSseText(text).find((event) => event.type === 'done' || event.type === 'error')
              if (last === undefined) fail('stream-ended')
              else finish(last)
              return
            }

            const terminal = await consumeStream(response.body, controller.signal, (event) => {
              if (controller.signal.aborted) return
              if (event.type === 'delta' && typeof event.text === 'string') {
                setGhost((previous) =>
                  previous.active && previous.mode === mode
                    ? { ...previous, stream: previous.stream + event.text }
                    : previous,
                )
              } else if (event.type === 'done' || event.type === 'error') {
                finish(event)
              }
            })
            if (!terminal) fail('stream-ended')
          } catch {
            // An aborted prediction is silent; a real failure is reported once.
            if (!controller.signal.aborted) fail('network')
          }
        },
        [sessionId],
      )

      React.useEffect(() => {
        // Switching off the mode that owns the visible or pending ghost clears it.
        if (ghost.mode === 'continue' ? continueEnabled : nextEnabled) return
        abortRef.current?.abort()
        setGhost(NO_GHOST)
        setBox(null)
      }, [nextEnabled, continueEnabled])

      // IME composition owns the draft until it commits: no prediction work.
      React.useEffect(() => {
        const onCompositionStart = () => {
          composingRef.current = true
          abortRef.current?.abort()
          setGhost(NO_GHOST)
          setBox(null)
        }
        const onCompositionEnd = () => {
          composingRef.current = false
          setCompositionEnd(value => value + 1)
        }
        document.addEventListener('compositionstart', onCompositionStart, true)
        document.addEventListener('compositionend', onCompositionEnd, true)
        return () => {
          document.removeEventListener('compositionstart', onCompositionStart, true)
          document.removeEventListener('compositionend', onCompositionEnd, true)
        }
      }, [])

      // A different Session starts from a clean slate.
      React.useEffect(() => {
        dismissedRef.current = null
        abortRef.current?.abort()
        setGhost(NO_GHOST)
        setBox(null)
        return () => abortRef.current?.abort()
      }, [sessionId])

      // Typing invalidates what was predicted for the previous text.
      React.useEffect(() => {
        abortRef.current?.abort()
        setGhost(NO_GHOST)
        if (dismissedRef.current !== null && dismissedRef.current.draft !== draft) {
          dismissedRef.current = null
        }
      }, [draft])

      // A starting turn drops the ghost and re-arms a dismissed prediction.
      React.useEffect(() => {
        if (!running) return
        abortRef.current?.abort()
        setGhost(NO_GHOST)
        dismissedRef.current = null
      }, [running])

      // `next`: ask once the turn has settled and the composer is empty.
      React.useEffect(() => {
        if (sessionId === undefined || sessionId === null) return undefined
        if (!nextEnabled || running || draft !== '') return undefined
        if (dismissedRef.current !== null && dismissedRef.current.draft === draft) return undefined
        const timer = setTimeout(() => {
          if (composingRef.current) return
          void request('next', '')
        }, SETTLE_MS)
        return () => clearTimeout(timer)
      }, [sessionId, running, draft, request, nextEnabled, compositionEnd])

      // A short notice (nothing to continue, failure) clears itself.
      React.useEffect(() => {
        if (ghost.notice === null || ghost.notice === undefined) return undefined
        const timer = setTimeout(() => {
          setGhost((previous) => (previous.notice === null || previous.notice === undefined ? previous : NO_GHOST))
        }, NOTICE_MS)
        return () => clearTimeout(timer)
      }, [ghost.notice])

      // `continue` is manual: with text in the composer and the caret at its end, Tab asks the
      // model to continue the draft using the conversation above. Tab then accepts the result.
      // Everywhere else Tab keeps its normal job, so focus can still leave the editor.
      React.useEffect(() => {
        if (!continueEnabled || sessionId === undefined || sessionId === null) return undefined
        const onKeyDown = (event) => {
          if (event.defaultPrevented) return
          // An IME candidate window owns the keyboard while composing.
          if (event.isComposing === true || event.keyCode === 229 || composingRef.current) return
          if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return
          const found = elements()
          // Only the composer that has the keyboard answers.
          if (found === null || !found.editor.contains(document.activeElement)) return
          const shown = ghostRef.current
          // The model is working: Tab neither moves focus nor asks again.
          if (shown.mode === 'continue' && shown.active) {
            event.preventDefault()
            event.stopPropagation()
            return
          }
          // A finished suggestion is accepted by the other handler.
          if (visibleRef.current && currentRef.current !== '' && !shown.active) return
          if (draft.trim() === '' || isTriggerToken(draft)) return
          if (dismissedRef.current !== null && dismissedRef.current.draft === draft) return
          if (caretAtEnd(found.editor) === null) return
          event.preventDefault()
          event.stopPropagation()
          void request('continue', draft.slice(-MAX_DRAFT_CHARS))
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [continueEnabled, sessionId, draft, request])

      // A prediction skipped while the page was hidden is retried on return.
      React.useEffect(() => {
        const onVisibility = () => {
          if (!nextEnabled || document.hidden) return
          if (draft !== '' || running) return
          if (currentRef.current !== '' || dismissedRef.current !== null) return
          if (sessionId === undefined || sessionId === null) return
          void request('next', '')
        }
        document.addEventListener('visibilitychange', onVisibility)
        return () => document.removeEventListener('visibilitychange', onVisibility)
      }, [draft, running, sessionId, request, nextEnabled])

      const rawCandidate = ghost.items.length > 0
        ? ghost.items[Math.min(ghost.index, ghost.items.length - 1)] ?? ''
        : streamingCandidate(ghost.stream)
      const current = ghost.mode === 'continue' ? joinContinuation(draft, rawCandidate) : rawCandidate
      currentRef.current = current
      const pending = ghost.mode === 'continue' && ghost.active
      const hasNotice = ghost.notice !== null && ghost.notice !== undefined
      const hasGhost = current !== '' || pending || hasNotice

      const visible =
        (hasNotice || ghost.mode === 'continue' ? continueEnabled : nextEnabled) &&
        hasGhost &&
        box !== null &&
        (ghost.mode === 'next'
          ? draft === '' && (hasNotice || !running)
          : draft.trim() !== '' && (hasNotice || !isTriggerToken(draft)))
      ghostRef.current = ghost
      visibleRef.current = visible && box !== null

      // `next` ghost spans the editor's text column.
      React.useLayoutEffect(() => {
        if (ghost.mode !== 'next') return undefined
        const measure = () => {
          const found = elements()
          if (found === null) {
            setBox((previous) => (previous === null ? previous : null))
            return
          }
          const cardRect = found.card.getBoundingClientRect()
          const editorRect = found.editor.getBoundingClientRect()
          if (editorRect.width <= 0 || editorRect.height <= 0) {
            setBox((previous) => (previous === null ? previous : null))
            return
          }
          const computed = window.getComputedStyle(found.editor)
          const lineHeight = Number.parseFloat(computed.lineHeight)
          const paddingTop = Number.parseFloat(computed.paddingTop)
          const paddingLeft = Number.parseFloat(computed.paddingLeft)
          const topInset = Number.isFinite(paddingTop) ? paddingTop : EDITOR_INSET_TOP
          const leftInset = Number.isFinite(paddingLeft) ? paddingLeft : EDITOR_INSET_LEFT
          const next = {
            top: Math.max(0, Math.round(editorRect.top - cardRect.top + topInset)),
            left: Math.max(0, Math.round(editorRect.left - cardRect.left + leftInset)),
            right: Math.max(EDITOR_INSET_RIGHT, Math.round(cardRect.right - editorRect.right + EDITOR_SCROLL_MARGIN)),
            height: Number.isFinite(lineHeight) && lineHeight > 0 ? Math.round(lineHeight) : FALLBACK_LINE_HEIGHT,
          }
          setBox((previous) => (sameBox(previous, next) ? previous : next))
        }
        measure()
        const found = elements()
        let observer
        if (found !== null && typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(measure)
          observer.observe(found.card)
          observer.observe(found.editor)
        }
        window.addEventListener('resize', measure)
        return () => {
          observer?.disconnect()
          window.removeEventListener('resize', measure)
        }
      }, [ghost.mode, draft, sessionId, running, hasGhost])

      // `continue` ghost follows the caret.
      React.useLayoutEffect(() => {
        if (ghost.mode !== 'continue') return undefined
        let frame = 0
        const measure = () => {
          frame = 0
          const found = elements()
          if (found === null) {
            setBox((previous) => (previous === null ? previous : null))
            return
          }
          const caret = caretAtEnd(found.editor)
          if (caret === null) {
            setBox((previous) => (previous === null ? previous : null))
            return
          }
          const editorRect = found.editor.getBoundingClientRect()
          if (editorRect.width <= 0 || editorRect.height <= 0) {
            setBox((previous) => (previous === null ? previous : null))
            return
          }
          const cardRect = found.card.getBoundingClientRect()
          const computed = window.getComputedStyle(found.editor)
          const lineHeight = Number.parseFloat(computed.lineHeight)
          const height =
            Number.isFinite(caret.height) && caret.height > 0
              ? Math.round(caret.height)
              : Number.isFinite(lineHeight) && lineHeight > 0
                ? Math.round(lineHeight)
                : FALLBACK_LINE_HEIGHT
          const desired = caret.left - cardRect.left
          const left = Math.max(0, desired)
          const maxWidth = cardRect.right - (cardRect.left + left) - 16
          if (maxWidth < 48) {
            setBox((previous) => (previous === null ? previous : null))
            return
          }
          const top = caret.top - cardRect.top
          // A caret scrolled above or below the card has no honest place to draw.
          if (top < 0 || top > cardRect.height - 8) {
            setBox((previous) => (previous === null ? previous : null))
            return
          }
          const next = {
            top: Math.round(top),
            left: Math.round(left),
            maxWidth: Math.round(maxWidth),
            height,
          }
          setBox((previous) => (sameBox(previous, next) ? previous : next))
        }
        const schedule = () => {
          if (frame === 0) frame = requestAnimationFrame(measure)
        }
        measure()
        document.addEventListener('selectionchange', schedule)
        document.addEventListener('scroll', schedule, true)
        const found = elements()
        window.addEventListener('resize', schedule)
        let observer
        if (found !== null && typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(schedule)
          observer.observe(found.card)
          observer.observe(found.editor)
        }
        return () => {
          if (frame !== 0) cancelAnimationFrame(frame)
          document.removeEventListener('selectionchange', schedule)
          document.removeEventListener('scroll', schedule, true)
          window.removeEventListener('resize', schedule)
          observer?.disconnect()
        }
      }, [ghost.mode, draft, sessionId, running, hasGhost, hasNotice])

      const accept = () => {
        const value = currentRef.current
        if (value === '' || ghost.active) return
        // A next-message offer is not asked again for the text it produced; a continuation can be chained.
        if (ghost.mode === 'next') dismissedRef.current = { draft: value }
        abortRef.current?.abort()
        setGhost(NO_GHOST)
        setBox(null)
        try {
          // A refused insertion must never be bypassed by replacing the draft.
          if (inputActions.insertText(value, inputActions.captureInsertion()) !== true) return
        } catch {
          return
        }
        // Accepting leaves an editable draft: hand the keyboard back to the editor.
        try {
          const found = elements()
          if (found !== null && !found.card.contains(document.activeElement)) found.editor.focus()
        } catch {
          // Focus is a courtesy, never a failure.
        }
      }
      acceptRef.current = accept

      const cycle = (delta) => {
        setGhost((previous) => {
          if (previous.items.length <= 1) return previous
          const index = (previous.index + delta + previous.items.length) % previous.items.length
          return { ...previous, index }
        })
      }
      cycleRef.current = cycle

      React.useEffect(() => {
        if (!visible) return undefined
        const onKeyDown = (event) => {
          if (event.defaultPrevented) return
          // An IME candidate window owns the keyboard while composing.
          if (event.isComposing === true || event.keyCode === 229) return
          const found = elements()
          if (found === null) return
          const target = typeof Node !== 'undefined' && event.target instanceof Node ? event.target : null
          const inEditor = found.editor.contains(document.activeElement)
          const inCard =
            found.card.contains(document.activeElement) || (target !== null && found.card.contains(target))
          if (!inCard) return
          if (event.key === 'Escape') {
            // Dismiss only this suggestion: keep the gesture away from the
            // composer's own Escape handling (the Esc-Esc stop sequence).
            event.preventDefault()
            event.stopPropagation()
            dismissedRef.current = { draft }
            if (ghost.mode === 'next' && typeof ghost.seq === 'number') dismissedSeqs.set(sessionId, ghost.seq)
            abortRef.current?.abort()
            setGhost(NO_GHOST)
            setBox(null)
            return
          }
          if (event.altKey && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
            if (ghost.items.length <= 1) return
            event.preventDefault()
            event.stopPropagation()
            cycleRef.current?.(event.key === 'ArrowDown' ? 1 : -1)
            return
          }
          if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) return
          // Tab belongs to the editor only; on composer controls it must keep
          // its normal focus-traversal behavior.
          if (!inEditor || ghost.active) return
          if (ghost.mode === 'continue' && caretAtEnd(found.editor) === null) return
          event.preventDefault()
          event.stopPropagation()
          acceptRef.current?.()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [visible, draft, sessionId, ghost.items.length, ghost.active, ghost.mode, ghost.seq])

      const anchor = h('span', {
        ref: anchorRef,
        'data-composer-suggest-anchor': '',
        'aria-hidden': 'true',
        style: { display: 'none' },
      })

      if (!visible || box === null) return anchor

      const continuation = ghost.mode === 'continue'
      const style = continuation ? CONTINUE_GHOST_STYLE : NEXT_GHOST_STYLE
      const textStyle = continuation ? CONTINUE_TEXT_STYLE : TEXT_STYLE
      const room = box.maxWidth ?? 0
      const noticeText = hasNotice ? t(ghost.notice.key).replace('{reason}', ghost.notice.reason ?? '') : ''
      const failed = hasNotice && ghost.notice.reason !== undefined
      const spinner = h('span', { className: 'cs-spin', 'aria-hidden': 'true' })

      let content
      if (hasNotice) {
        content = [h('span', { style: failed ? { ...textStyle, color: 'var(--dsw-alias-state-error-primary)' } : textStyle }, noticeText)]
      } else if (current === '') {
        // The model is working and has not produced text yet.
        content = [spinner, h('span', { style: textStyle }, t('pending')), room >= 140 ? h('kbd', { style: KEYCAP_STYLE, title: t('cancel') }, 'Esc') : null]
      } else {
        content = [
          h('span', { style: textStyle }, current),
          pending ? spinner : null,
          ghost.items.length > 1 ? h('span', { style: BADGE_STYLE, title: t('more') }, `${ghost.index + 1}/${ghost.items.length}`) : null,
          !ghost.active && (!continuation || room >= 96) ? h('kbd', { style: KEYCAP_STYLE, title: t('accept') }, 'Tab') : null,
        ]
      }
      const announcement = hasNotice
        ? noticeText
        : pending
          ? (current === '' ? t('pending') : '')
          : ghost.active ? '' : t('ready').replace('{text}', current)

      return h(React.Fragment, null,
        h('span', { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true', style: { position: 'absolute', width: 1, height: 1, padding: 0, margin: -1, overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap' } }, announcement),
        h('div',
          {
            style: { ...style, ...box },
            'aria-hidden': 'true',
            'data-composer-suggest': ghost.mode,
            'data-composer-ghost': 'dsh-composer-suggest',
            'data-composer-suggest-state': hasNotice ? 'notice' : pending ? 'pending' : 'ready',
            title: current || noticeText || t('pending'),
          },
          ...content,
        ),
        anchor,
        h('style', null, SPIN_CSS),
      )
    }


    return {
      inject: ['slots', 'locale'],
      __testing: { caretAtEnd, joinContinuation, parseSseText, streamingCandidate, cleanLine, consumeStream, setPref, readPrefs, readStatus, reportStatus, describeRoute, dismissedSeqs },
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, DICTIONARIES))
        ctx.effect(() => {
          const onStorage = (event) => {
            if (event.key !== PREFERENCE_KEY && event.key !== null) return
            try {
              prefs = parsePrefs(JSON.parse(event.newValue || 'null'))
            } catch {
              return
            }
            for (const listener of preferenceListeners) listener()
          }
          window.addEventListener('storage', onStorage)
          return () => window.removeEventListener('storage', onStorage)
        })
        ctx.slots.inject('settings.general.item', () => ctx.slots.register(
          { name: 'settings.general.item', id: 'composer-suggest', order: 50, label: () => t('next') },
          () => h(SuggestionSetting, { t }),
        ))
        ctx.slots.inject(SLOT, () =>
          ctx.slots.register(
            { name: SLOT, id: 'composer-suggest', order: 10, label: () => t('label') },
            (slotProps) => h(ComposerSuggest, { ...slotProps, t }),
          ),
        )
      },
    }
  },
})

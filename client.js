/**
 * Browser half of composer suggestions.
 *
 * Besides the two suggestion modes below, a toolbar button (or Alt+T) tidies the whole
 * draft: the Host rewrites it into clear, ordered points, the draft is replaced in place,
 * and a line under the composer offers to restore the original and names any concrete
 * token the rewrite lost or added. See the "Tidy" section near the end of this file.
 *
 * Two suggestion modes share one overlay:
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
    const SPIN_CSS = '.cs-spin{display:inline-block;vertical-align:middle;margin:0 6px 0 2px;text-indent:0;box-sizing:border-box;flex:none;width:10px;height:10px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:cs-spin .8s linear infinite}@keyframes cs-spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.cs-spin{animation-duration:2.4s}}'

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
    /** At most this many composer images ride along with a continuation. */
    const MAX_IMAGES = 3
    const MAX_IMAGE_EDGE = 1024
    const MAX_IMAGE_BYTES = 800_000
    const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])
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
        cancel: 'Press Esc to cancel',
        more: 'Alt+Down for the next suggestion',
        next: 'Suggest my next message',
        nextHint: 'After a reply, show the message you are most likely to send next.',
        continue: 'Continue my draft with Tab',
        continueHint: 'With text at the caret, or with an attached image, press Tab. The model continues from the conversation, the draft, and those images; press Tab again to accept. Nothing is asked until you press Tab.',
        model: 'Model for suggestions',
        modelHint: 'Leave empty to use the current session\'s model, or enter a model id such as claude-sonnet-5-5 to use that one instead. If no provider offers it, the status line below says so.',
        modelPlaceholder: 'Same as the session',
        cost: 'Every suggestion and every tidy is a model call and uses tokens. Images attached to a continuation are sent with it. Saved in this browser on this device.',
        pending: 'Continuing…',
        statusIdle: 'No suggestion requested yet.',
        statusOk: 'Last suggestion: {route} · {ms} ms',
        statusCached: 'Last suggestion: {route} · cached',
        statusError: 'Last suggestion failed: {reason}',
        statusNoVision: 'The model could not see the attached images.',
        noteEmpty: 'The model had nothing to suggest.',
        noticeFailed: 'Continuation failed: {reason}',
        imagesUnread: 'Could not read the attached images.',
        imagesUnseen: 'This model cannot see images; type some text to continue.',
        imagesUnavailable: 'The images could not be sent to the model.',
        ready: 'Suggestion: {text}. Press Tab to accept. Alt+Down or Alt+Up changes candidates. Escape dismisses.',
        tidy: 'Tidy',
        tidySetting: 'Tidy my draft',
        tidyHint: 'A Tidy button appears in the composer toolbar once the draft is long enough; {key} does the same. The model rewrites the draft into clear, ordered points without changing what it says, and the draft is replaced in place, so read it before sending. Restore brings your original back. A draft with @ references cannot be tidied.',
        tidyTooltip: 'Tidy this draft into clear points ({key})',
        tidyWorking: 'Tidying…',
        tidyEscCancel: 'to cancel',
        tidyCancelTooltip: 'Tidying the draft. Click or press Esc to cancel.',
        tidyRestore: 'Restore',
        tidyRestoreTooltip: 'Restore the draft from before tidying',
        tidyRestoreKeyTooltip: 'Restore the draft from before tidying ({key})',
        tidyDone: 'Tidied. Check it before sending.',
        tidyEmptied: 'The draft is empty. Your text from before tidying is still kept.',
        tidyMissing: 'May be missing: {list}',
        tidyAdded: 'Added, not in your original: {list}',
        tidyDismiss: 'Dismiss',
        tidyShort: 'This draft is short enough already.',
        tidyChips: 'Tidying would drop the @ references in this draft, so it was left as it is.',
        tidyTooLong: 'This draft is too long to tidy (over {max} characters).',
        tidyStale: 'The draft changed while it was being tidied, so it was left as it is.',
        tidySame: 'Nothing to tidy: the draft is already clear.',
        tidyFailed: 'Tidying failed: {reason}. Your draft was not changed.',
        tidyWhyTruncated: 'the result was cut off',
        tidyWhyOffTrack: 'the model did not return a rewrite',
        tidyWhyEmpty: 'the model returned nothing',
        tidyWhyNetwork: 'the connection was lost',
        tidyWhyModel: 'no model is available for it',
        tidyWhyLocked: 'the composer cannot be edited right now',
      },
      zh: {
        label: '输入建议',
        cancel: '按 Esc 取消',
        more: '按 Alt+↓ 查看下一条建议',
        next: '建议下一条消息',
        nextHint: '回复结束后，显示你最可能接着发送的消息。',
        continue: '用 Tab 续写我的草稿',
        continueHint: '输入框里有文字且光标在末尾，或附上了图片时，按 Tab。模型会结合对话、草稿和这些图片续写，再按一次 Tab 采纳。不按 Tab 就不会请求模型。',
        model: '建议使用的模型',
        modelHint: '留空则使用当前会话的模型；填写模型 ID（如 claude-sonnet-5-5）则改用该模型。找不到时，下方状态行会提示。',
        modelPlaceholder: '与会话相同',
        cost: '每次建议和每次整理都会调用一次模型并消耗 token。续写时会把附上的图片一并发送。设置保存在当前设备的浏览器中。',
        pending: '正在续写…',
        statusIdle: '尚未请求过建议。',
        statusOk: '上次建议：{route} · {ms} ms',
        statusCached: '上次建议：{route} · 命中缓存',
        statusError: '上次建议失败：{reason}',
        statusNoVision: '模型看不到附上的图片。',
        noteEmpty: '模型没有给出建议。',
        noticeFailed: '续写失败：{reason}',
        imagesUnread: '无法读取附上的图片。',
        imagesUnseen: '当前模型看不到图片，请先输入文字再续写。',
        imagesUnavailable: '图片未能发给模型。',
        ready: '建议：{text}。按 Tab 采纳，Alt+↓ 或 Alt+↑ 切换，Escape 关闭。',
        tidy: '整理',
        tidySetting: '整理我的草稿',
        tidyHint: '草稿够长时，输入框工具栏会出现“整理”按钮，按 {key} 也可以。模型把草稿改写成清楚、有顺序的要点，不改变原意，并直接替换草稿，发送前请核对；点“还原”可以回到原文。带 @ 引用的草稿不能整理。',
        tidyTooltip: '把这段草稿整理成清楚的要点（{key}）',
        tidyWorking: '整理中…',
        tidyEscCancel: '取消',
        tidyCancelTooltip: '正在整理草稿，点击或按 Esc 取消。',
        tidyRestore: '还原',
        tidyRestoreTooltip: '还原整理前的草稿',
        tidyRestoreKeyTooltip: '还原整理前的草稿（{key}）',
        tidyDone: '已整理，发送前请核对。',
        tidyEmptied: '草稿已清空，整理前的原文还保留着。',
        tidyMissing: '可能遗漏：{list}',
        tidyAdded: '新增（原文没有）：{list}',
        tidyDismiss: '关闭',
        tidyShort: '草稿已经够短，不需要整理。',
        tidyChips: '整理会丢掉草稿里的 @ 引用，所以没有改动。',
        tidyTooLong: '草稿太长，无法整理（超过 {max} 字）。',
        tidyStale: '整理期间草稿有改动，所以没有替换。',
        tidySame: '草稿已经很清楚，没有改动。',
        tidyFailed: '整理失败：{reason}。草稿未改动。',
        tidyWhyTruncated: '结果被截断',
        tidyWhyOffTrack: '模型没有按要求改写',
        tidyWhyEmpty: '模型没有返回内容',
        tidyWhyNetwork: '连接中断',
        tidyWhyModel: '没有可用的模型',
        tidyWhyLocked: '输入框当前不能修改',
      },
    }

    const PREFERENCE_KEY = 'dsh-composer-suggest.prefs'
    /** Every feature is on, and the Session's own model answers, until the user says otherwise. */
    const DEFAULT_PREFS = { next: true, continue: true, tidy: true, model: '' }
    function parsePrefs(stored) {
      if (stored === null || typeof stored !== 'object') return DEFAULT_PREFS
      const model = typeof stored.model === 'string' ? stored.model.trim().slice(0, MAX_MODEL_CHARS) : ''
      return { next: stored.next !== false, continue: stored.continue !== false, tidy: stored.tidy !== false, model }
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
        if (current.images === 'skipped' || current.images === 'unavailable' || current.images === 'refused') text = text + ' ' + t('statusNoVision')
      } else if (current.state === 'cached') {
        text = t('statusCached').replace('{route}', current.route)
        if (current.images === 'skipped' || current.images === 'unavailable' || current.images === 'refused') text = text + ' ' + t('statusNoVision')
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
        h(SettingRow, { title: t('tidySetting'), hint: t('tidyHint').replace('{key}', TIDY_KEY_LABEL), checked: current.tidy, onChange: (value) => setPref('tidy', value) }),
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

    /**
     * The ghost is laid out like the text it stands for: it wraps at the editor's column the way
     * the accepted text would. While it is taller than the editor, the Host's scroll element gets
     * a bottom margin so the toolbar row is pushed down instead of being covered.
     */
    const GHOST_BASE_STYLE = {
      position: 'absolute',
      display: 'block',
      boxSizing: 'border-box',
      fontFamily: 'inherit',
      fontSize: 'inherit',
      lineHeight: 'inherit',
      color: 'var(--dsw-alias-label-caption)',
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      overflowWrap: 'anywhere',
      pointerEvents: 'none',
      userSelect: 'none',
    }

    /** `next` has no draft under it, so the whole block can mask the empty composer's placeholder. */
    const NEXT_GHOST_STYLE = {
      ...GHOST_BASE_STYLE,
      background: 'var(--dsw-specific-input-major)',
      zIndex: 2,
    }

    /** `continue` starts at the caret; only the text itself is masked, never the draft before it. */
    const CONTINUE_GHOST_STYLE = {
      ...GHOST_BASE_STYLE,
      zIndex: 3,
    }

    const TEXT_STYLE = {
      opacity: 0.9,
    }

    const CONTINUE_TEXT_STYLE = {
      ...TEXT_STYLE,
      background: 'var(--dsw-specific-input-major)',
      boxDecorationBreak: 'clone',
      WebkitBoxDecorationBreak: 'clone',
    }

    /** Most extra height, in px, the ghost may ask the composer to make room for. */
    const MAX_RESERVE = 240

    const KEYCAP_STYLE = {
      display: 'inline-block',
      verticalAlign: 'middle',
      marginLeft: '6px',
      // text-indent is inherited, and an inline-block applies it to its own first line.
      textIndent: 0,
      whiteSpace: 'nowrap',
      fontSize: '11px',
      lineHeight: '16px',
      padding: '0 5px',
      borderRadius: '4px',
      border: '1px solid var(--dsw-alias-border-l2)',
      color: 'var(--dsw-alias-label-tertiary)',
      background: 'var(--dsw-specific-input-major)',
    }

    const BADGE_STYLE = {
      display: 'inline-block',
      verticalAlign: 'middle',
      marginLeft: '6px',
      textIndent: 0,
      whiteSpace: 'nowrap',
      fontSize: '10px',
      lineHeight: '14px',
      color: 'var(--dsw-alias-label-tertiary)',
      background: 'var(--dsw-specific-input-major)',
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

    /**
     * Images currently shown in this composer card. The Host's attachment rail
     * renders each pasted picture as an <img> whose src is a blob: (or data:) URL.
     * Avatars and the ghost itself are outside that rail; we still skip anything
     * inside the ghost, and ignore ordinary https: sources.
     */
    function collectComposerImages(card) {
      if (card === null || card === undefined || typeof card.querySelectorAll !== 'function') return []
      const seen = new Set()
      const images = []
      for (const node of card.querySelectorAll('img')) {
        if (images.length >= MAX_IMAGES) break
        if (typeof node.closest === 'function' && node.closest('[data-composer-ghost]') !== null) continue
        const src = typeof node.src === 'string' ? node.src : ''
        if (src === '' || seen.has(src)) continue
        if (!src.startsWith('blob:') && !src.startsWith('data:image/')) continue
        if (src.startsWith('data:image/svg')) continue
        seen.add(src)
        const name = typeof node.alt === 'string' ? node.alt.slice(0, 80) : ''
        images.push(name === '' ? { src } : { src, name })
      }
      return images
    }

    function dataUrlParts(url) {
      const match = /^data:([^;,]+)(?:;charset=[^;,]+)?;base64,(.+)$/u.exec(url)
      if (match === null) return null
      const mediaType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1]
      if (!IMAGE_TYPES.has(mediaType)) return null
      const data = match[2].replace(/\s+/gu, '')
      return data === '' ? null : { mediaType, data }
    }

    function blobToDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
        reader.onerror = () => reject(reader.error ?? new Error('read-failed'))
        reader.readAsDataURL(blob)
      })
    }

    /** Fetch one composer thumbnail, shrink it, and return a JPEG the Host will accept. */
    async function encodeComposerImage(source, signal) {
      const response = await fetch(source.src, { signal })
      if (!response.ok) return null
      const blob = await response.blob()
      if (signal?.aborted === true) return null
      const named = (image) => (source.name ? { ...image, name: source.name } : image)
      if (typeof createImageBitmap === 'function' && typeof document !== 'undefined' && typeof document.createElement === 'function') {
        try {
          const bitmap = await createImageBitmap(blob)
          const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height, 1))
          const width = Math.max(1, Math.round(bitmap.width * scale))
          const height = Math.max(1, Math.round(bitmap.height * scale))
          const canvas = document.createElement('canvas')
          canvas.width = width
          canvas.height = height
          const context = canvas.getContext('2d')
          if (context !== null) {
            context.fillStyle = '#fff'
            context.fillRect(0, 0, width, height)
            context.drawImage(bitmap, 0, 0, width, height)
            if (typeof bitmap.close === 'function') bitmap.close()
            if (typeof canvas.toDataURL === 'function') {
              const parts = dataUrlParts(canvas.toDataURL('image/jpeg', 0.82))
              if (parts !== null && Math.floor((parts.data.length * 3) / 4) <= MAX_IMAGE_BYTES) return named(parts)
            }
          }
        } catch {
          // The original bytes are tried next.
        }
      }
      if (blob.size > MAX_IMAGE_BYTES) return null
      const parts = dataUrlParts(await blobToDataUrl(blob))
      return parts === null ? null : named(parts)
    }

    async function encodeComposerImages(sources, signal) {
      const images = []
      for (const source of sources.slice(0, MAX_IMAGES)) {
        if (signal?.aborted === true) break
        const encoded = await encodeComposerImage(source, signal)
        if (encoded !== null) images.push(encoded)
      }
      return images
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

    /** The editor's type settings, so the ghost is set exactly like the draft it continues. */
    function typographyOf(computed) {
      const pick = (value) => (typeof value === 'string' && value !== '' && value !== 'normal' ? value : undefined)
      const lineHeight = Number.parseFloat(computed.lineHeight)
      const font = {
        fontFamily: pick(computed.fontFamily),
        fontSize: pick(computed.fontSize),
        fontWeight: pick(computed.fontWeight),
        letterSpacing: pick(computed.letterSpacing),
        lineHeight: Number.isFinite(lineHeight) && lineHeight > 0 ? `${lineHeight}px` : undefined,
      }
      for (const key of Object.keys(font)) if (font[key] === undefined) delete font[key]
      return font
    }

    function sameBox(left, right) {
      return (
        left !== null &&
        left !== undefined &&
        left.top === right.top &&
        left.left === right.left &&
        left.height === right.height &&
        left.right === right.right &&
        left.maxWidth === right.maxWidth &&
        left.columnLeft === right.columnLeft &&
        left.lineBreak === right.lineBreak &&
        left.typo === right.typo
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
      // A joined string, not a new array, so the selector stays referentially stable.
      const attachmentIds = useInput((state) => (state === undefined || !Array.isArray(state.attachmentIds) ? '' : state.attachmentIds.join('\0')))
      const hasAttachments = attachmentIds !== ''
      const running = useSessionStatus((state) => (state === undefined ? false : state.get(sessionId)?.running === true))
      const [ghost, setGhost] = React.useState(NO_GHOST)
      const [box, setBox] = React.useState(null)
      const [compositionEnd, setCompositionEnd] = React.useState(0)
      // Extra height, in px, the wrapped ghost needs below the editor; the toolbar row is pushed down by it.
      const [reserve, setReserve] = React.useState(0)

      const anchorRef = React.useRef(null)
      const elements = () => composerElementsNear(anchorRef.current)
      const abortRef = React.useRef(null)
      const composingRef = React.useRef(false)
      const dismissedRef = React.useRef(null)
      const acceptRef = React.useRef(null)
      const cycleRef = React.useRef(null)
      const ghostNodeRef = React.useRef(null)
      const ghostRef = React.useRef(NO_GHOST)
      const visibleRef = React.useRef(false)
      const currentRef = React.useRef('')

      const request = React.useCallback(
        async (mode, draftText, sources = []) => {
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
          const IMAGE_NOTES = { 'images-unread': 'imagesUnread', 'images-unseen': 'imagesUnseen', 'images-unavailable': 'imagesUnavailable' }
          const fail = (reason) => {
            if (controller.signal.aborted) return
            const note = IMAGE_NOTES[reason]
            if (note !== undefined) {
              reportStatus({ state: 'note', key: note })
              settle([], null, { key: note })
              return
            }
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
              const images = typeof event.images === 'string' ? event.images : undefined
              reportStatus(event.cached === true
                ? { state: 'cached', route, ...(images === undefined ? {} : { images }) }
                : { state: 'ok', route, ms: Number(event.ms) || 0, ...(images === undefined ? {} : { images }) })
            }
            settle(items, event.seq)
          }

          try {
            let images = []
            if (mode === 'continue' && sources.length > 0) {
              images = await encodeComposerImages(sources, controller.signal)
              if (controller.signal.aborted) return
              if (images.length === 0 && draftText.trim() === '') {
                fail('images-unread')
                return
              }
            }
            const payload = prefs.model === ''
              ? { sessionId, mode, draft: draftText }
              : { sessionId, mode, draft: draftText, model: prefs.model }
            if (images.length > 0) payload.images = images
            const response = await fetch(ENDPOINT, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
              body: JSON.stringify(payload),
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

      // Adding or removing a picture is a new draft, even when the text did not change.
      React.useEffect(() => {
        abortRef.current?.abort()
        setGhost(NO_GHOST)
        dismissedRef.current = null
      }, [attachmentIds])

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
        if (!nextEnabled || running || draft !== '' || hasAttachments) return undefined
        if (dismissedRef.current !== null && dismissedRef.current.draft === draft) return undefined
        const timer = setTimeout(() => {
          if (composingRef.current) return
          void request('next', '')
        }, SETTLE_MS)
        return () => clearTimeout(timer)
      }, [sessionId, running, draft, hasAttachments, request, nextEnabled, compositionEnd])

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
          const sources = collectComposerImages(found.card)
          if ((draft.trim() === '' && sources.length === 0) || isTriggerToken(draft)) return
          if (dismissedRef.current !== null && dismissedRef.current.draft === draft) return
          if (draft.trim() !== '' && caretAtEnd(found.editor) === null) return
          event.preventDefault()
          event.stopPropagation()
          void request('continue', draft.slice(-MAX_DRAFT_CHARS), sources)
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
          ? draft === '' && !hasAttachments && (hasNotice || !running)
          : (draft.trim() !== '' || hasAttachments) && (hasNotice || !isTriggerToken(draft)))
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
          // The text column ends at the editor's right padding, which is where accepted text wraps.
          const paddingRight = Number.parseFloat(computed.paddingRight)
          const rightInset = Number.isFinite(paddingRight) ? paddingRight : EDITOR_INSET_RIGHT
          const font = typographyOf(computed)
          const next = {
            font,
            typo: JSON.stringify(font),
            top: Math.max(0, Math.round(editorRect.top - cardRect.top + topInset)),
            left: Math.max(0, Math.round(editorRect.left - cardRect.left + leftInset)),
            right: Number.isFinite(editorRect.right)
              ? Math.max(EDITOR_INSET_RIGHT, Math.round(cardRect.right - editorRect.right + rightInset))
              : EDITOR_INSET_RIGHT + EDITOR_SCROLL_MARGIN,
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
          const editorRect = found.editor.getBoundingClientRect()
          if (editorRect.width <= 0 || editorRect.height <= 0) {
            setBox((previous) => (previous === null ? previous : null))
            return
          }
          const cardRect = found.card.getBoundingClientRect()
          const computed = window.getComputedStyle(found.editor)
          const caret = caretAtEnd(found.editor)
          if (caret === null) {
            if (draft.trim() !== '' || !hasAttachments) {
              setBox((previous) => (previous === null ? previous : null))
              return
            }
            // Image-only: there is no caret line to follow, so the ghost sits in the text column.
            const lineHeight = Number.parseFloat(computed.lineHeight)
            const paddingTop = Number.parseFloat(computed.paddingTop)
            const paddingLeft = Number.parseFloat(computed.paddingLeft)
            const paddingRight = Number.parseFloat(computed.paddingRight)
            const topInset = Number.isFinite(paddingTop) ? paddingTop : EDITOR_INSET_TOP
            const leftInset = Number.isFinite(paddingLeft) ? paddingLeft : EDITOR_INSET_LEFT
            const rightInset = Number.isFinite(paddingRight) ? paddingRight : EDITOR_INSET_RIGHT
            const font = typographyOf(computed)
            const left = Math.max(0, Math.round(editorRect.left - cardRect.left + leftInset))
            const next = {
              font,
              typo: JSON.stringify(font),
              top: Math.max(0, Math.round(editorRect.top - cardRect.top + topInset)),
              left,
              right: Number.isFinite(editorRect.right)
                ? Math.max(EDITOR_INSET_RIGHT, Math.round(cardRect.right - editorRect.right + rightInset))
                : EDITOR_INSET_RIGHT + EDITOR_SCROLL_MARGIN,
              height: Number.isFinite(lineHeight) && lineHeight > 0 ? Math.round(lineHeight) : FALLBACK_LINE_HEIGHT,
              columnLeft: left,
              lineBreak: false,
            }
            setBox((previous) => (sameBox(previous, next) ? previous : next))
            return
          }
          const lineHeight = Number.parseFloat(computed.lineHeight)
          // The caret rectangle is the glyph box; the draft's line box is taller by the line spacing.
          // The ghost's own first line box must land on the draft's, so half the difference moves up.
          const lineBox = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : FALLBACK_LINE_HEIGHT
          const glyphBox = Number.isFinite(caret.height) && caret.height > 0 ? caret.height : lineBox
          const height = Math.round(lineBox)
          const font = typographyOf(computed)
          const desired = caret.left - cardRect.left
          const left = Math.max(0, desired)
          const maxWidth = cardRect.right - (cardRect.left + left) - 16
          // Almost no room after the caret: the continuation starts on the next line instead.
          const lineBreak = maxWidth < 48
          const paddingLeft = Number.parseFloat(computed.paddingLeft)
          const paddingRight = Number.parseFloat(computed.paddingRight)
          const columnLeft = Number.isFinite(editorRect.left)
            ? Math.max(0, Math.round(editorRect.left - cardRect.left + (Number.isFinite(paddingLeft) ? paddingLeft : EDITOR_INSET_LEFT)))
            : EDITOR_INSET_LEFT
          const columnRight = Number.isFinite(editorRect.right)
            ? Math.max(EDITOR_INSET_RIGHT, Math.round(cardRect.right - editorRect.right + (Number.isFinite(paddingRight) ? paddingRight : EDITOR_INSET_RIGHT)))
            : EDITOR_INSET_RIGHT + EDITOR_SCROLL_MARGIN
          const top = caret.top - cardRect.top - (lineBox - glyphBox) / 2
          // A caret scrolled above or below the card has no honest place to draw.
          if (top < 0 || top > cardRect.height - 8) {
            setBox((previous) => (previous === null ? previous : null))
            return
          }
          const next = {
            font,
            typo: JSON.stringify(font),
            top: Math.round(top),
            left: Math.round(left),
            maxWidth: Math.round(maxWidth),
            height,
            columnLeft,
            right: columnRight,
            lineBreak,
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
      }, [ghost.mode, draft, sessionId, running, hasGhost, hasNotice, hasAttachments])

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
          if (ghost.mode === 'continue' && draft.trim() !== '' && caretAtEnd(found.editor) === null) return
          event.preventDefault()
          event.stopPropagation()
          acceptRef.current?.()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [visible, draft, sessionId, ghost.items.length, ghost.active, ghost.mode, ghost.seq])

      // How far the wrapped ghost reaches below the Host's scroll element, which holds the editor.
      // The Host's own attribute names it; without it nothing is reserved and the toolbar may be covered.
      React.useLayoutEffect(() => {
        const node = ghostNodeRef.current
        let next = 0
        if (visible && node !== null && node !== undefined) {
          const found = elements()
          const scroll = found === null ? null : found.editor.closest('[data-input-scroll]')
          if (scroll !== null && scroll !== undefined) {
            const overflow = node.getBoundingClientRect().bottom - scroll.getBoundingClientRect().bottom
            next = overflow > 0 ? Math.min(Math.ceil(overflow), MAX_RESERVE) : 0
          }
        }
        setReserve((previous) => (previous === next ? previous : next))
      }, [visible, box, current, hasNotice, pending, ghost.index, ghost.stream])

      // Push the toolbar down by that much while the ghost is there, and put it back afterwards.
      React.useLayoutEffect(() => {
        if (reserve <= 0) return undefined
        const found = elements()
        const scroll = found === null ? null : found.editor.closest('[data-input-scroll]')
        if (scroll === null || scroll === undefined) return undefined
        const previous = scroll.style.marginBottom
        scroll.style.marginBottom = `${reserve}px`
        return () => {
          scroll.style.marginBottom = previous
        }
      }, [reserve])

      const anchor = h('span', {
        ref: anchorRef,
        'data-composer-suggest-anchor': '',
        'aria-hidden': 'true',
        style: { display: 'none' },
      })

      if (!visible || box === null) return anchor

      const continuation = ghost.mode === 'continue'
      const textStyle = continuation ? CONTINUE_TEXT_STYLE : TEXT_STYLE
      const noticeText = hasNotice ? t(ghost.notice.key).replace('{reason}', ghost.notice.reason ?? '') : ''
      const failed = hasNotice && ghost.notice.reason !== undefined
      const spinner = h('span', { className: 'cs-spin', 'aria-hidden': 'true' })

      // The block spans the editor's text column and wraps there. A continuation's first line is
      // indented to the caret; with no room left on that line it starts on the next one.
      const columnLeft = box.columnLeft ?? EDITOR_INSET_LEFT
      const columnRight = box.right ?? EDITOR_INSET_RIGHT + EDITOR_SCROLL_MARGIN
      const placement = continuation
        ? {
            top: box.top + (box.lineBreak === true ? box.height : 0),
            left: columnLeft,
            right: columnRight,
            textIndent: box.lineBreak === true ? 0 : Math.max(0, box.left - columnLeft),
          }
        : { top: box.top, left: box.left, right: columnRight, minHeight: box.height }

      let content
      if (hasNotice) {
        content = [h('span', { style: failed ? { ...textStyle, color: 'var(--dsw-alias-state-error-primary)' } : textStyle }, noticeText)]
      } else if (current === '') {
        // The model is working and has not produced text yet.
        content = [spinner, h('span', { style: textStyle }, t('pending')), h('kbd', { style: KEYCAP_STYLE, title: t('cancel') }, 'Esc')]
      } else {
        content = [
          h('span', { style: textStyle }, current),
          pending ? spinner : null,
          ghost.items.length > 1 ? h('span', { style: BADGE_STYLE, title: t('more') }, `${ghost.index + 1}/${ghost.items.length}`) : null,
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
            ref: ghostNodeRef,
            style: { ...(continuation ? CONTINUE_GHOST_STYLE : NEXT_GHOST_STYLE), ...(box.font ?? {}), ...placement },
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

    /**
     * Tidy: rewrite the whole draft in place, and keep the original for one restore.
     *
     * State lives outside React, one record per Session, because two seats show it: the button
     * in the composer toolbar and the line under the composer card.
     *   idle     nothing in flight; `notice` holds a short message that clears itself
     *   working  the Host is rewriting `draft`; `controller` cancels it, and `previous` is the
     *            finished result that cancelling goes back to, when there was one
     *   done     the composer holds `tidied`; `original` is what Restore puts back, `missing`
     *            and `added` are the concrete tokens the Host could not match, and `emptied`
     *            marks that the composer was emptied since (by Undo, most likely)
     *
     * The line's seat exists only in an ongoing conversation. A new Session's composer has the
     * toolbar seat alone, so when no line is mounted the button's seat shows the same status.
     */
    const TIDY_RIGHT_SLOT = 'conversation.input.right'
    const TIDY_DOCK_SLOT = 'conversation.composer.dock'
    /** Below this a draft has nothing to reorganize; the button also stays hidden until twice this. */
    const TIDY_MIN_CHARS = 20
    const TIDY_SHOW_CHARS = 40
    /** The Host refuses a longer draft: it rewrites the draft whole and never clips it. */
    const TIDY_MAX_CHARS = 4_000
    /** A refusal is read once and leaves; a failure stays a little longer. */
    const TIDY_NOTICE_MS = 6_000
    const TIDY_ERROR_MS = 12_000
    /** A double click must not start a rewrite and cancel it in one gesture. */
    const TIDY_CLICK_GUARD_MS = 400
    const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/u.test(String(navigator.platform || navigator.userAgent || ''))
    const TIDY_KEY_LABEL = IS_MAC ? '⌥T' : 'Alt+T'

    /** Sizes and weights follow the Host's own toolbar selectors and the meter under the composer. */
    const TIDY_CSS = [
      '.cs-tidy{display:inline-flex;align-items:center;gap:4px;flex:none;height:30px;padding:0 8px;border:none;border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;font-weight:500;line-height:20px;white-space:nowrap;cursor:pointer}',
      '.cs-tidy:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2));color:var(--dsw-alias-label-primary)}',
      '.cs-tidy:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));outline-offset:1px}',
      '.cs-tidy svg{flex:none}',
      '.cs-tidy .cs-spin{margin:0 2px}',
      '@container (max-width:560px){.cs-tidy__label{display:none}}',
      '.cs-tidy-line{display:flex;flex-wrap:wrap;align-items:center;justify-content:center;gap:2px 8px;max-width:100%;font-size:var(--dsh-content-font-size-secondary,13px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));color:var(--dsw-alias-label-secondary)}',
      '.cs-tidy-inline{display:inline-flex;align-items:center;gap:6px;flex:0 1 auto;min-width:0;max-width:340px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);white-space:nowrap}',
      '.cs-tidy-inline>span{min-width:0;overflow:hidden;text-overflow:ellipsis}',
      // Text needs the label shade of the warning colour; the primary shade is for fills.
      '.cs-tidy-status__warn{color:var(--dsw-alias-state-warn-label,var(--dsw-alias-state-warn-primary));overflow-wrap:anywhere}',
      '.cs-tidy-status__error{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere}',
      // The Host's action colour; its brand token resolves to ink in the composer.
      '.cs-tidy-status__act{flex:none;padding:0 6px;border:none;border-radius:4px;background:transparent;color:var(--dsw-alias-state-business-primary,var(--dsw-alias-label-primary));font:inherit;cursor:pointer}',
      '.cs-tidy-status__act:hover{text-decoration:underline}',
      '.cs-tidy-status__act:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,var(--dsw-alias-brand-primary));outline-offset:1px}',
      '.cs-tidy-status__x{color:var(--dsw-alias-label-secondary)}',
    ].join('')

    const IDLE_TIDY = Object.freeze({ phase: 'idle' })
    const tidyStates = new Map()
    const tidyListeners = new Set()
    const subscribeTidy = (listener) => {
      tidyListeners.add(listener)
      return () => tidyListeners.delete(listener)
    }
    const notifyTidy = () => {
      for (const listener of tidyListeners) listener()
    }
    const readTidy = (sessionId) => tidyStates.get(sessionId) ?? IDLE_TIDY
    function setTidy(sessionId, next) {
      if (next.phase === 'idle' && next.notice === undefined) tidyStates.delete(sessionId)
      else tidyStates.set(sessionId, next)
      notifyTidy()
    }
    function useTidy(sessionId) {
      const read = () => readTidy(sessionId)
      return React.useSyncExternalStore(subscribeTidy, read, read)
    }

    /** How many lines are mounted for a Session: none in a new Session's composer. */
    const tidyLines = new Map()
    function mountTidyLine(sessionId) {
      tidyLines.set(sessionId, (tidyLines.get(sessionId) ?? 0) + 1)
      notifyTidy()
      return () => {
        const left = (tidyLines.get(sessionId) ?? 1) - 1
        if (left > 0) tidyLines.set(sessionId, left)
        else tidyLines.delete(sessionId)
        notifyTidy()
      }
    }
    function useTidyLineMounted(sessionId) {
      const read = () => tidyLines.has(sessionId)
      return React.useSyncExternalStore(subscribeTidy, read, read)
    }

    /** The editor may hand back other line endings or trailing blanks than it was given. */
    const sameDraft = (left, right) =>
      typeof left === 'string' && typeof right === 'string' && left.replace(/\r\n?/gu, '\n').trim() === right.replace(/\r\n?/gu, '\n').trim()

    const tokenList = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item !== '').slice(0, 6) : [])

    /**
     * Ask the Host to rewrite the draft and put the answer in the composer.
     * @param input - `{ draft, chips, phase, readDraft }`: the draft as it is now, how many
     *   reference chips it holds, the composer's submit phase, and a reader for the draft at
     *   the moment the answer arrives.
     */
    async function runTidy(sessionId, input, inputActions) {
      if (sessionId === undefined || sessionId === null) return
      if (readTidy(sessionId).phase === 'working') return
      // While a message is being sent the editor is read-only.
      if (input.phase !== undefined && input.phase !== 'plain') return
      const draft = input.draft
      const note = (key, extra = {}) => setTidy(sessionId, { phase: 'idle', notice: { key, ...extra } })
      if (draft.trim() === '') return
      // The only way to write a rewrite back replaces the whole draft as plain text.
      if (input.chips > 0) return note('tidyChips')
      if (draft.trim().length < TIDY_MIN_CHARS) return note('tidyShort')
      if (draft.length > TIDY_MAX_CHARS) return note('tidyTooLong')

      const controller = new AbortController()
      // Tidying again after editing a tidied draft: a cancel must not cost the earlier Restore.
      const before = readTidy(sessionId)
      setTidy(sessionId, { phase: 'working', controller, draft, startedAt: Date.now(), previous: before.phase === 'done' ? before : undefined })
      const fail = (reason) => {
        if (controller.signal.aborted) return
        if (reason === 'draft-too-long') return note('tidyTooLong')
        reportStatus({ state: 'error', reason })
        note('tidyFailed', { reason, level: 'error' })
      }
      try {
        const payload = prefs.model === '' ? { sessionId, mode: 'tidy', draft } : { sessionId, mode: 'tidy', draft, model: prefs.model }
        const response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        })
        if (controller.signal.aborted) return
        if (!response.ok) return fail('HTTP ' + response.status)
        if (!(response.headers.get('content-type') || '').includes('text/event-stream')) {
          const refused = await response.json().catch(() => null)
          return fail(typeof refused?.reason === 'string' && refused.reason !== '' ? refused.reason : 'error')
        }
        let last
        if (response.body === null) {
          last = parseSseText(await response.text().catch(() => '')).find((event) => event.type === 'done' || event.type === 'error')
        } else {
          await consumeStream(response.body, controller.signal, (event) => {
            if (event.type === 'done' || event.type === 'error') last = event
          })
        }
        if (controller.signal.aborted) return
        if (last === undefined) return fail('stream-ended')
        if (last.type === 'error') return fail(typeof last.reason === 'string' && last.reason !== '' ? last.reason : 'error')
        const tidied = typeof last.text === 'string' ? last.text : ''
        if (tidied.trim() === '') return fail('empty')
        // The user kept typing: their newer text wins over a rewrite of the older one.
        if (input.readDraft() !== draft) return note('tidyStale')
        if (sameDraft(tidied, draft)) return note('tidySame')
        try {
          inputActions.setDraft(tidied)
        } catch {
          return fail('replace-refused')
        }
        const route = describeRoute(last.route)
        reportStatus(last.cached === true ? { state: 'cached', route } : { state: 'ok', route, ms: Number(last.ms) || 0 })
        setTidy(sessionId, { phase: 'done', original: draft, tidied, missing: tokenList(last.missing), added: tokenList(last.added) })
      } catch {
        fail('network')
      }
    }

    function cancelTidy(sessionId) {
      const current = readTidy(sessionId)
      if (current.phase !== 'working') return
      current.controller.abort()
      setTidy(sessionId, current.previous ?? IDLE_TIDY)
    }

    /** Put the pre-tidy draft back. The original is dropped only once it is back in the editor. */
    function restoreTidy(sessionId, inputActions) {
      const current = readTidy(sessionId)
      if (current.phase !== 'done') return false
      try {
        inputActions.setDraft(current.original)
      } catch {
        return false
      }
      setTidy(sessionId, IDLE_TIDY)
      return true
    }

    /** Drop a finished result or a notice, but only the one the caller saw. */
    function dismissTidy(sessionId, seen) {
      const current = readTidy(sessionId)
      if (current.phase === 'working') return
      if (seen !== undefined && seen !== current) return
      setTidy(sessionId, IDLE_TIDY)
    }

    /** Whether the main button, and Alt+T, would restore right now instead of tidying. */
    const tidyRestores = (state, draft) => state.phase === 'done' && (sameDraft(draft, state.tidied) || draft.trim() === '')

    /** The Host's reason codes, said the way a person would; an unknown one is shown as it is. */
    const TIDY_REASONS = {
      'tidy-truncated': 'tidyWhyTruncated',
      'tidy-off-track': 'tidyWhyOffTrack',
      empty: 'tidyWhyEmpty',
      'stream-ended': 'tidyWhyNetwork',
      network: 'tidyWhyNetwork',
      'no-route': 'tidyWhyModel',
      'model-unavailable': 'tidyWhyModel',
      'replace-refused': 'tidyWhyLocked',
    }
    function tidyNoticeText(notice, t) {
      const key = TIDY_REASONS[notice.reason]
      const reason = key === undefined ? notice.reason ?? '' : t(key)
      return t(notice.key).replace('{reason}', reason).replace('{max}', String(TIDY_MAX_CHARS))
    }

    /**
     * What both seats say about the current state, as elements; `null` when there is nothing to say.
     * @param inline - the toolbar copy: the button next to it already shows that work is in flight.
     */
    function tidyStatus(sessionId, tidy, inputActions, t, inline) {
      const keep = (event) => event.preventDefault()
      if (tidy.phase === 'working') {
        if (inline) return null
        return [h('span', null, t('tidyWorking')), h('kbd', { style: { ...KEYCAP_STYLE, marginLeft: 0 } }, 'Esc'), h('span', null, t('tidyEscCancel'))]
      }
      if (tidy.phase === 'done') {
        return [
          h('span', null, t(tidy.emptied === true ? 'tidyEmptied' : 'tidyDone')),
          tidy.missing.length > 0 ? h('span', { className: 'cs-tidy-status__warn' }, t('tidyMissing').replace('{list}', tidy.missing.join('、'))) : null,
          tidy.added.length > 0 ? h('span', { className: 'cs-tidy-status__warn' }, t('tidyAdded').replace('{list}', tidy.added.join('、'))) : null,
          h('button', { type: 'button', className: 'cs-tidy-status__act', title: t('tidyRestoreTooltip'), onMouseDown: keep, onClick: () => restoreTidy(sessionId, inputActions) }, t('tidyRestore')),
          h('button', { type: 'button', className: 'cs-tidy-status__act cs-tidy-status__x', 'aria-label': t('tidyDismiss'), title: t('tidyDismiss'), onMouseDown: keep, onClick: () => dismissTidy(sessionId, tidy) }, '×'),
        ]
      }
      if (tidy.notice === undefined) return null
      const text = tidyNoticeText(tidy.notice, t)
      return [h('span', { className: tidy.notice.level === 'error' ? 'cs-tidy-status__error' : undefined, title: inline ? text : undefined }, text)]
    }

    const TIDY_ICON = h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true' },
      h('path', { d: 'M2.5 4h1.2M2.5 8h1.2M2.5 12h1.2M6 4h7.5M6 8h7.5M6 12h5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }))
    const RESTORE_ICON = h('svg', { viewBox: '0 0 16 16', width: 14, height: 14, 'aria-hidden': 'true' },
      h('path', { d: 'M5.5 3.5 3 6l2.5 2.5M3.2 6h6.3a3.5 3.5 0 0 1 0 7H6.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round' }))

    /**
     * Toolbar seat: the button, the keyboard (Alt+T to tidy or restore, Esc to cancel), the
     * state's own housekeeping, and the status itself wherever no line is mounted to show it.
     */
    function TidyButton(props) {
      const { sessionId, useInput, inputActions, t } = props
      const enabled = usePrefs().tidy
      const draft = useInput((state) => (state === undefined ? '' : state.draft || ''))
      const chips = useInput((state) => (state === undefined || !Array.isArray(state.occurrences) ? 0 : state.occurrences.length))
      const phase = useInput((state) => (state === undefined || typeof state.phase !== 'string' ? 'plain' : state.phase))
      const tidy = useTidy(sessionId)
      const lineMounted = useTidyLineMounted(sessionId)
      const anchorRef = React.useRef(null)
      const draftRef = React.useRef(draft)
      draftRef.current = draft

      // Reached while working only by a click: the keyboard cancels with Escape instead.
      const act = () => {
        const current = readTidy(sessionId)
        if (current.phase === 'working') {
          if (Date.now() - current.startedAt < TIDY_CLICK_GUARD_MS) return
          cancelTidy(sessionId)
        } else if (tidyRestores(current, draftRef.current)) restoreTidy(sessionId, inputActions)
        else void runTidy(sessionId, { draft: draftRef.current, chips, phase, readDraft: () => draftRef.current }, inputActions)
      }
      const actRef = React.useRef(act)
      actRef.current = act

      // A message on its way out takes the draft with it: there is nothing left to restore over.
      React.useEffect(() => {
        if (tidy.phase === 'done' && phase !== 'plain') dismissTidy(sessionId, tidy)
      }, [sessionId, phase, tidy])

      // An emptied composer keeps the original. The Host folds the replacement into the edit
      // before it, so one Undo can empty the composer, and Redo only brings the tidied text back.
      // The offer ends once the user starts a different draft.
      React.useEffect(() => {
        if (tidy.phase !== 'done') return
        const empty = draft.trim() === ''
        if (empty && tidy.emptied !== true) setTidy(sessionId, { ...tidy, emptied: true })
        else if (!empty && tidy.emptied === true) {
          if (sameDraft(draft, tidy.tidied)) setTidy(sessionId, { ...tidy, emptied: undefined })
          else dismissTidy(sessionId, tidy)
        }
      }, [sessionId, draft, tidy])

      // A refusal or failure is read once; it then leaves.
      React.useEffect(() => {
        if (tidy.phase !== 'idle' || tidy.notice === undefined) return undefined
        const timer = setTimeout(() => dismissTidy(sessionId, tidy), tidy.notice.level === 'error' ? TIDY_ERROR_MS : TIDY_NOTICE_MS)
        return () => clearTimeout(timer)
      }, [sessionId, tidy])

      // A composer that goes away must not have its draft replaced later.
      React.useEffect(() => () => cancelTidy(sessionId), [sessionId])

      React.useEffect(() => {
        if (!enabled || sessionId === undefined || sessionId === null) return undefined
        const onKeyDown = (event) => {
          if (event.defaultPrevented) return
          if (event.isComposing === true || event.keyCode === 229) return
          const found = composerElementsNear(anchorRef.current)
          if (found === null || !found.card.contains(document.activeElement)) return
          const current = readTidy(sessionId)
          if (event.key === 'Escape') {
            if (current.phase !== 'working') return
            // Cancel only the rewrite; the composer's own Escape handling is not for this press.
            event.preventDefault()
            event.stopPropagation()
            cancelTidy(sessionId)
            return
          }
          // Option+T types a dagger on macOS, so the physical key decides.
          const isT = event.code === 'KeyT' || (event.code === undefined && typeof event.key === 'string' && event.key.toLowerCase() === 't')
          if (!isT || !event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
          if (current.phase === 'idle' && draftRef.current.trim() === '') return
          event.preventDefault()
          event.stopPropagation()
          if (current.phase === 'working') return
          actRef.current()
        }
        document.addEventListener('keydown', onKeyDown, true)
        return () => document.removeEventListener('keydown', onKeyDown, true)
      }, [enabled, sessionId])

      const anchor = h('span', { ref: anchorRef, 'data-composer-suggest-anchor': 'tidy', 'aria-hidden': 'true', style: { display: 'none' } })
      if (!enabled) return anchor
      const working = tidy.phase === 'working'
      const status = lineMounted ? null : tidyStatus(sessionId, tidy, inputActions, t, true)
      // The button is offered once there is enough text to reorganize, and stays while it has something to undo or cancel.
      const shown = working || tidy.phase === 'done' || draft.trim().length >= TIDY_SHOW_CHARS
      if (!shown && status === null) return anchor

      const restores = tidyRestores(tidy, draft)
      const label = working ? t('tidyWorking') : restores ? t('tidyRestore') : t('tidy')
      const tooltip = working
        ? t('tidyCancelTooltip')
        : (restores ? t('tidyRestoreKeyTooltip') : t('tidyTooltip')).replace('{key}', TIDY_KEY_LABEL)
      return h(React.Fragment, null,
        anchor,
        h('style', null, TIDY_CSS + SPIN_CSS),
        status === null ? null : h('span', { className: 'cs-tidy-inline', role: 'status', 'aria-live': 'polite', 'data-composer-tidy-status': tidy.phase === 'idle' ? 'notice' : tidy.phase }, ...status),
        shown
          ? h('button',
              {
                type: 'button',
                className: 'cs-tidy',
                title: tooltip,
                // The visible word first, so the name still reads when the label is collapsed.
                'aria-label': `${label}. ${tooltip}`,
                'aria-busy': working ? 'true' : undefined,
                'data-composer-tidy': working ? 'working' : restores ? 'restore' : 'tidy',
                // Keep the caret in the editor, like the Host's own toolbar buttons do.
                onMouseDown: (event) => event.preventDefault(),
                onClick: act,
              },
              working ? h('span', { className: 'cs-spin', 'aria-hidden': 'true' }) : restores ? RESTORE_ICON : TIDY_ICON,
              h('span', { className: 'cs-tidy__label' }, label),
            )
          : null,
      )
    }

    /** Dock seat, under the composer card: what just happened, and the way back. */
    function TidyLine(props) {
      const { sessionId, inputActions, t } = props
      const enabled = usePrefs().tidy
      const tidy = useTidy(sessionId)

      // While this line is mounted the toolbar seat leaves the status to it.
      React.useEffect(() => mountTidyLine(sessionId), [sessionId])

      const status = enabled ? tidyStatus(sessionId, tidy, inputActions, t, false) : null
      if (status === null) return null
      return h('div', { className: 'cs-tidy-line', role: 'status', 'aria-live': 'polite', 'data-composer-tidy-status': tidy.phase === 'idle' ? 'notice' : tidy.phase },
        h('style', null, TIDY_CSS),
        ...status,
      )
    }


    return {
      inject: ['slots', 'locale'],
      __testing: { caretAtEnd, joinContinuation, parseSseText, streamingCandidate, cleanLine, consumeStream, setPref, readPrefs, readStatus, reportStatus, describeRoute, dismissedSeqs, collectComposerImages, encodeComposerImages, dataUrlParts, tidy: { run: runTidy, cancel: cancelTidy, restore: restoreTidy, dismiss: dismissTidy, read: readTidy, sameDraft, keyLabel: TIDY_KEY_LABEL, clickGuardMs: TIDY_CLICK_GUARD_MS } },
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
        // Tidy: the button sits before the other compact controls, its result line under the card.
        ctx.slots.inject(TIDY_RIGHT_SLOT, () =>
          ctx.slots.register(
            { name: TIDY_RIGHT_SLOT, id: 'composer-suggest-tidy', order: -20, label: () => t('tidy') },
            (slotProps) => h(TidyButton, { ...slotProps, t }),
          ),
        )
        ctx.slots.inject(TIDY_DOCK_SLOT, () =>
          ctx.slots.register(
            { name: TIDY_DOCK_SLOT, id: 'composer-suggest-tidy', order: -10, label: () => t('tidy') },
            (slotProps) => h(TidyLine, { ...slotProps, t }),
          ),
        )
      },
    }
  },
})

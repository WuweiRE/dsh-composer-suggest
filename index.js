/**
 * Host half of composer suggestions.
 *
 * One streaming endpoint serves two modes over the same prediction engine:
 * - `next`     once a turn has settled and the composer is empty, predict the
 *              message the user is most likely to send next;
 * - `continue` while the user pauses mid-draft, continue the text before the caret.
 *
 * Every request is one small auxiliary model call over the Session tail plus a
 * short list of recent tool activity. By default the model is the one the Session
 * already uses, at its lowest reasoning effort. A `model` in config pins another one,
 * which is looked up among the providers actually mounted in the running profile.
 * Nothing is written to the Session.
 *
 * Derived from MIT-licensed dsh-composer-predictions (Stijnus) and
 * dsh-composer-prediction (Amir Bazylkhanov); see THIRD_PARTY_NOTICES.md.
 */

import { createHash } from 'node:crypto'

export const name = 'composer-suggest'

export const inject = ['connection', 'llm', 'sessions', 'webServer']

/** Same-origin streaming endpoint the Client half posts to (SSE: meta, delta, done, error). */
const ENDPOINT = '/composer-suggest/stream'

/** One request carries a session id, a mode, a bounded draft, and up to three small images. */
const MAX_BODY_BYTES = 4 * 1024 * 1024

/** Upper bound for the draft the Client may send for continuation mode. */
const MAX_DRAFT_CHARS = 4_000

/** Images the composer holds can ride along with a continuation; these bound them. */
const MAX_IMAGES = 3
const MAX_IMAGE_BYTES = 800_000
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

const DEFAULTS = {
  // Sonnet 5.5 uses adaptive thinking; even at the lowest effort a little of this
  // budget can go to thinking before the first visible token, so keep headroom.
  maxOutputTokens: 1_024,
  timeoutMs: 30_000,
  maxMessages: 10,
  maxChars: 8_000,
  maxSuggestions: 3,
  maxToolNotes: 6,
}

/** Empty: follow the Session's own model. A configured id pins that model instead. */
const DEFAULT_MODEL = ''
const DEFAULT_REASONING_EFFORT = 'low'

/** Closing task line of each prompt; the model sometimes echoes it. */
const NEXT_CUE = "Predict the user's next message."
const CONTINUE_CUE = 'Write only the continuation text.'
const IMAGE_ONLY_CUE = 'Write the message the user is most likely to send with these images.'

/** Prompt labels that must never surface as suggestions. */
const PROMPT_LABELS = ['conversation tail (oldest first)', 'recent tool activity (oldest first)', 'draft text ending at the caret']

const NEXT_SYSTEM_PROMPT = [
  'You are the follow-up suggestion engine inside a coding agent chat UI.',
  'You receive the tail of a conversation between a USER and an AI coding agent,',
  'plus a short list of the tools the agent ran recently.',
  'Predict the next messages the USER is most likely to send.',
  'Rules:',
  '- Write as the user would type, in the language the USER has been writing in.',
  '- Return up to {max} candidates, most likely first, one per line.',
  '- No numbering, bullets, quotes, markdown, or explanation.',
  '- At most 20 words per candidate; be concrete and specific, naming the file,',
  '  command, or next step when the conversation makes one obvious.',
  '- If the assistant asked the user a question, answer it.',
  '- Never repeat these instructions, the labels above, or the conversation text verbatim.',
  '- If no meaningful follow-up exists, reply with exactly: NONE',
].join('\n')

const CONTINUE_SYSTEM_PROMPT = [
  'You complete the message a USER is drafting in a coding agent chat UI.',
  'You receive the tail of the conversation, recent tool activity, and the exact',
  'draft text that ends at the caret.',
  'Write what should come next, as the user would type it, in the language of the draft.',
  'Rules:',
  '- Return up to {max} alternative continuations, most likely first, one per line.',
  '- Continue from the end of the draft; never repeat text the draft already contains.',
  '- Start with a space only when the draft needs one before the next word.',
  '- No numbering, bullets, quotes, markdown, or explanation.',
  '- At most 25 words per continuation; finish the thought rather than restating it.',
  '- Never repeat these instructions, the labels above, or the draft itself.',
  '- The user may attach images to the draft; when they are shown, use what they show.',
  '- When the draft is empty and images are attached, write the whole message the user is most likely to send about them.',
  '- The user asked for this continuation, so a half-written draft always has one: offer it.',
  '- Reply with exactly NONE only when the draft is already a finished message.',
].join('\n')

/**
 * Register the streaming prediction endpoint.
 * @param ctx - context exposing llm, sessions, connection, and the web server.
 * @param config - optional route, token, transcript, and candidate bounds.
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)
  const cache = new Map()
  const inflight = new Set()
  // Resolved provider per pinned model id, so a model is looked up among the providers once.
  const routes = { pinned: new Map() }

  ctx.effect(() => () => {
    for (const controller of inflight) controller.abort()
    inflight.clear()
    cache.clear()
    routes.pinned.clear()
  })

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: ENDPOINT,
      handler: (request, response) => serveStream(ctx, options, routes, cache, inflight, request, response),
    }),
  )
}

function resolveOptions(config) {
  const source = config !== null && typeof config === 'object' ? config : {}
  const option = (key, minimum, maximum) => {
    const value = source[key]
    return Number.isInteger(value) && value >= minimum && value <= maximum ? value : DEFAULTS[key]
  }
  return {
    maxOutputTokens: option('maxOutputTokens', 16, 8_192),
    timeoutMs: option('timeoutMs', 1_000, 120_000),
    maxMessages: option('maxMessages', 2, 40),
    maxChars: option('maxChars', 500, 40_000),
    maxSuggestions: option('maxSuggestions', 1, 5),
    maxToolNotes: option('maxToolNotes', 0, 20),
    // A pinned model without a provider is resolved against the mounted providers.
    // An empty `model` opts out of pinning: the Session's own route is used instead.
    provider: textOption(source.provider, 200),
    model: typeof source.model === 'string' ? textOption(source.model, 200) : DEFAULT_MODEL,
    reasoningEffort:
      typeof source.reasoningEffort === 'string' && source.reasoningEffort.length <= 40
        ? source.reasoningEffort.trim()
        : DEFAULT_REASONING_EFFORT,
  }
}

function textOption(value, maximum) {
  return typeof value === 'string' && value.length <= maximum ? value.trim() : ''
}

async function serveStream(ctx, options, routes, cache, inflight, request, response) {
  try {
    const plan = await planRequest(ctx, options, request, response)
    if (plan === null) return
    if (plan.error !== undefined) {
      respond(response, plan.status, { items: [], reason: plan.error })
      return
    }

    const disconnect = watchDisconnect(response)
    openStream(response)
    try {
      sendEvent(response, { type: 'meta', mode: plan.mode, seq: plan.seq })
      const result = await runPrediction(ctx, plan.options, routes, cache, inflight, plan, [disconnect.signal], (text) => {
        if (!disconnect.signal.aborted) sendEvent(response, { type: 'delta', text })
      })
      if (disconnect.signal.aborted) return
      if (result.reason !== undefined && result.items.length === 0) {
        sendEvent(response, { type: 'error', reason: result.reason, route: result.route })
      } else {
        sendEvent(response, {
          type: 'done',
          items: result.items,
          cached: result.cached === true,
          route: result.route,
          ms: result.ms,
          seq: plan.seq,
          images: result.images ?? 'none',
        })
      }
    } catch (error) {
      if (disconnect.signal.aborted) return
      sendEvent(response, { type: 'error', reason: describeError(error) })
    } finally {
      closeStream(response)
    }
  } catch (error) {
    if (response.headersSent === true) closeStream(response)
    else respond(response, 500, { items: [], reason: describeError(error) })
  }
}

/** Short, safe reason text for a client that only displays nothing. */
function describeError(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.length > 120 ? `${message.slice(0, 120)}…` : message
}

/**
 * Read and validate one request body, resolving the live Session it names.
 * @returns `null` when the response was already written, a plan, or an error.
 */
async function planRequest(ctx, baseOptions, request, response) {
  const admission = ctx.connection.admit(request)
  if ('rejection' in admission) {
    return { status: admission.rejection, error: admission.rejection === 401 ? 'unauthorized' : 'forbidden' }
  }
  // Predictions read the owner's sessions and spend the owner's model tokens.
  if (admission.peer.principal.kind !== 'owner') return { status: 403, error: 'forbidden' }

  if (request.method !== 'POST') {
    respond(response, 405, { items: [], reason: 'method-not-allowed' })
    return null
  }

  if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    return { status: 415, error: 'unsupported-media-type' }
  }

  let body
  try {
    body = await readJsonBody(request)
  } catch {
    return { status: 400, error: 'invalid-body' }
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { status: 400, error: 'invalid-body' }
  if (body.mode !== undefined && body.mode !== 'next' && body.mode !== 'continue') return { status: 400, error: 'invalid-mode' }

  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : ''
  if (sessionId === '') return { status: 400, error: 'missing-session' }

  const session = ctx.sessions.get(sessionId)
  if (session === undefined) return { status: 200, error: 'session-not-live' }

  const mode = body.mode === 'continue' ? 'continue' : 'next'
  const draft = mode === 'continue' && typeof body.draft === 'string' ? body.draft.slice(-MAX_DRAFT_CHARS) : ''
  // Images belong to a continuation; with them an empty draft is a message to start, not nothing.
  const images = mode === 'continue' ? parseImages(body.images) : []
  if (images === null) return { status: 400, error: 'invalid-images' }
  if (mode === 'continue' && draft.trim() === '' && images.length === 0) return { status: 200, error: 'no-draft' }

  // The Client may name the model for this request (its Settings field); that wins over the
  // configuration. A model with no provider is looked up among the mounted providers.
  const asked = typeof body.model === 'string' ? body.model.trim() : ''
  const askedProvider = typeof body.provider === 'string' ? body.provider.trim() : ''
  if (asked.length > 200 || askedProvider.length > 200) return { status: 400, error: 'invalid-model' }
  // Naming the model the configuration already pins keeps its provider (and so its credential);
  // any other model is looked up, or taken with the provider the request names.
  const sameRoute = asked === baseOptions.model && (askedProvider === '' || askedProvider === baseOptions.provider)
  const options = asked === '' || sameRoute ? baseOptions : { ...baseOptions, model: asked, provider: askedProvider }

  const seq = Number(session.seq)
  const key = JSON.stringify([sessionId, seq, mode, draft, options.provider, options.model, images.map(fingerprint)])

  return { sessionId, session, mode, draft, images, seq, key, options }
}

/**
 * Run one prediction, serving from or filling the bounded result cache.
 * @returns `{ items, reason, route, ms, cached }`.
 */
async function runPrediction(ctx, options, routes, cache, inflight, plan, signals, onDelta) {
  const remembered = cache.get(plan.key)
  if (remembered !== undefined) {
    return { items: remembered.items, reason: undefined, cached: true, route: remembered.route, ms: 0, images: remembered.images }
  }

  // Each view owns its cancellation; an identical request must not cancel it.
  const controller = new AbortController()
  inflight.add(controller)
  try {
    const result = await predict(ctx, options, routes, plan.session, plan.mode, plan.draft, plan.images, joinSignals([controller.signal, ...signals]), onDelta)
    if (result.items.length > 0 && !controller.signal.aborted && !signals.some(signal => signal.aborted)) {
      remember(cache, plan.key, { items: result.items, route: result.route, images: result.images })
    }
    return result
  } finally {
    inflight.delete(controller)
  }
}

/**
 * Run one auxiliary model call over the transcript tail and tool activity.
 * @returns `{ items, route, ms }` on success or `{ items: [], reason }` when none is usable.
 */
async function predict(ctx, options, routes, session, mode, draft, images, signal, onDelta) {
  let prompt = buildPrompt(session, options, mode, draft, { count: images.length, visible: true })
  if (prompt === null) return { items: [], reason: 'no-conversation' }
  const imageOnly = mode === 'continue' && draft.trim() === '' && images.length > 0

  const route = await resolveRoute(ctx, routes, session, options, signal)
  if (route === undefined) return { items: [], reason: options.model !== '' ? 'model-unavailable' : 'no-route' }

  const label = { provider: route.provider, model: route.model }
  const system = (mode === 'continue' ? CONTINUE_SYSTEM_PROMPT : NEXT_SYSTEM_PROMPT).replace(
    '{max}',
    String(options.maxSuggestions),
  )
  const deadline = timedSignal(signal, options.timeoutMs)
  const started = Date.now()
  let text = ''
  let finish
  // none: no images asked; used: the model was shown them; skipped / unavailable / refused: it was not.
  let imagesUsed = images.length === 0 ? 'none' : 'skipped'
  try {
    deadline.signal.throwIfAborted()
    const call = await ctx.llm.prepareCall(
      { provider: route.provider, model: route.model, maxTokens: options.maxOutputTokens },
      deadline.signal,
      (controls, model) => {
        const effort = selectEffort(model, options.reasoningEffort)
        return effort === undefined ? controls : { ...controls, reasoningEffort: effort }
      },
    )
    let content = [{ type: 'text', text: prompt }]
    if (images.length > 0) {
      const sees = modelSeesImages(call)
      const admitted = sees ? await admitImages(ctx, images) : { skipped: 'skipped' }
      if (admitted.refs !== undefined) {
        content = buildUserContent(prompt, admitted.refs)
        imagesUsed = 'used'
      } else {
        imagesUsed = admitted.skipped
        // With nothing typed, the images were the whole request: there is nothing honest to offer.
        if (imageOnly) return { items: [], reason: sees ? 'images-unavailable' : 'images-unseen', route: label, images: imagesUsed }
        // A draft can still be continued from its text; the prompt says the images were not seen.
        prompt = buildPrompt(session, options, mode, draft, { count: images.length, visible: false })
        content = [{ type: 'text', text: prompt }]
      }
    }
    const messages = [{ role: 'user', content }]
    for await (const chunk of call.stream({ ...call.config, messages, system, signal: deadline.signal })) {
      deadline.signal.throwIfAborted()
      if (chunk.type === 'text-delta') {
        text += chunk.text
        onDelta?.(chunk.text)
      } else if (chunk.type === 'finish') {
        finish = chunk.reason
      }
    }
    deadline.signal.throwIfAborted()
  } catch (error) {
    // A pinned route that stops working must be resolved again next time.
    if (!signal.aborted) routes.pinned.delete(options.model)
    throw error
  } finally {
    deadline.dispose()
  }

  // A truncated answer still carries usable whole lines; every other terminal
  // outcome reports its own failure instead of looking like a missing stream.
  const failure = finishFailure(finish)
  if (failure !== undefined) return { items: [], reason: failure, route: label }
  if (finish.kind === 'max-tokens') text = text.slice(0, text.lastIndexOf('\n') + 1)

  const cue = mode === 'continue' ? (imageOnly ? IMAGE_ONLY_CUE : CONTINUE_CUE) : NEXT_CUE
  const items = normalizeCandidates(text, options.maxSuggestions, mode === 'continue' ? draft : '', cue)
  const ms = Date.now() - started
  return items.length === 0
    ? { items: [], reason: 'empty', route: label, ms, images: imagesUsed }
    : { items, route: label, ms, images: imagesUsed }
}

/**
 * The llm service ends a failed or cancelled stream with a `finish` chunk whose
 * reason carries the normalized failure; only a missing terminal chunk is
 * genuinely "unfinished".
 */
function finishFailure(finish) {
  if (finish === undefined) return 'unfinished'
  if (finish.kind === 'stop' || finish.kind === 'max-tokens') return undefined
  const failure = finish.failure
  if (typeof failure?.message === 'string' && failure.message !== '') return shortReason(failure.message)
  if (typeof failure?.code === 'string' && failure.code !== '') return failure.code
  return typeof finish.kind === 'string' ? finish.kind : 'unfinished'
}

function shortReason(text) {
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/**
 * Pick the requested effort when the model advertises it, else the lowest.
 * Returns `undefined` for a model without selectable efforts (provider default).
 */
function selectEffort(model, requested) {
  const efforts = model?.reasoning?.efforts
  if (!Array.isArray(efforts) || efforts.length === 0) return undefined
  const ids = efforts.map((effort) => effort?.id).filter((id) => typeof id === 'string' && id !== '')
  if (ids.length === 0) return undefined
  return requested !== '' && ids.includes(requested) ? requested : ids[0]
}

function remember(cache, key, entry) {
  cache.delete(key)
  cache.set(key, entry)
  if (cache.size <= 200) return
  const oldest = cache.keys().next()
  if (!oldest.done) cache.delete(oldest.value)
}

/**
 * Resolve the model route for one prediction.
 *
 * A configured provider+model pair wins outright. A configured model alone
 * (the default) is looked up among the mounted providers, preferring the one
 * the Session already uses, then the default selection, then any other that
 * advertises it. An empty model follows the Session route.
 * @returns `{ provider, model }`, or `undefined` when nothing can serve it.
 */
async function resolveRoute(ctx, routes, session, options, signal) {
  if (options.model === '') return sessionRoute(ctx, session)
  if (options.provider !== '') return { provider: options.provider, model: options.model }
  if (routes.pinned.has(options.model)) return routes.pinned.get(options.model)

  const preferred = []
  const used = session.requestHeader?.()?.config
  if (typeof used?.provider === 'string') preferred.push(used.provider)
  const fallback = ctx.get?.('agentDefaultModel')?.currentSelection?.()
  if (typeof fallback?.provider === 'string') preferred.push(fallback.provider)

  let listed = []
  try {
    listed = (await ctx.llm.listProviders?.()) ?? []
  } catch {
    listed = []
  }
  const candidates = [...new Set([...preferred, ...listed.map((entry) => entry?.id).filter((id) => typeof id === 'string')])]
  for (const provider of candidates) {
    if (signal?.aborted) return undefined
    try {
      const models = await ctx.llm.listModels(provider)
      if (models.some((entry) => entry?.id === options.model)) {
        const found = { provider, model: options.model }
        routes.pinned.set(options.model, found)
        return found
      }
    } catch {
      // A provider that cannot list its models is skipped.
    }
  }
  return undefined
}

/** The route the Session already used, else the default model selection. */
function sessionRoute(ctx, session) {
  const route = session.requestHeader?.()?.config
  if (typeof route?.provider === 'string' && typeof route.model === 'string') {
    return { provider: route.provider, model: route.model }
  }
  const fallback = ctx.get?.('agentDefaultModel')?.currentSelection?.()
  if (typeof fallback?.provider === 'string' && typeof fallback.model === 'string') {
    return { provider: fallback.provider, model: fallback.model }
  }
  return undefined
}

/**
 * Render the conversation tail, recent tool activity, and (in continuation
 * mode) the draft as one bounded prompt.
 * @returns `null` when `next` mode has no completed assistant reply to follow.
 */
function buildPrompt(session, options, mode, draft, images = { count: 0, visible: true }) {
  const limits = { messages: options.maxMessages, chars: options.maxChars, notes: options.maxToolNotes }
  const picked = []
  const notes = []
  const callsById = new Map()

  for (const message of session.deriveMessages()) {
    if (message === null || typeof message !== 'object') continue
    const blocks = Array.isArray(message.content) ? message.content : []

    if (message.role === 'user' || message.role === 'assistant') {
      const text = plainText(blocks)
      if (text !== '') {
        picked.push({ role: message.role, text: clip(text, 1_500) })
      }
      if (message.role === 'assistant' && limits.notes > 0) {
        for (const block of blocks) {
          if (block === null || typeof block !== 'object' || block.type !== 'tool-call') continue
          const note = {
            name: typeof block.name === 'string' ? block.name : 'tool',
            input: clip(typeof block.arguments === 'string' ? block.arguments : '', 400),
            result: '',
            failed: false,
          }
          notes.push(note)
          if (typeof block.id === 'string') callsById.set(block.id, note)
        }
      }
      continue
    }

    if (message.role === 'tool' && limits.notes > 0) {
      const text = clip(plainText(blocks), 500)
      const callId = typeof message.toolCallId === 'string' ? message.toolCallId : ''
      const note = callId !== '' ? callsById.get(callId) : undefined
      if (note !== undefined) {
        note.result = text
        note.failed = message.isError === true
      } else {
        notes.push({ name: 'tool', input: '', result: text, failed: message.isError === true })
      }
    }
  }

  // The next-message prediction follows the agent's latest reply; a trailing user
  // message (even when a tool-call-only assistant message follows it) means the
  // turn never produced a reply to follow up on.
  if (mode === 'next' && (picked.length === 0 || picked.at(-1)?.role !== 'assistant')) return null

  const tail = picked.slice(-limits.messages)
  const kept = []
  let budget = limits.chars
  for (let index = tail.length - 1; index >= 0; index -= 1) {
    const message = tail[index]
    if (message.text.length > budget) {
      if (budget > 200) kept.unshift({ role: message.role, text: `…${message.text.slice(-budget)}` })
      break
    }
    budget -= message.text.length
    kept.unshift(message)
  }

  const lines = ['Conversation tail (oldest first):', JSON.stringify(kept)]
  const recent = limits.notes > 0 ? notes.slice(-limits.notes) : []
  if (recent.length > 0) {
    lines.push('', 'Recent tool activity (oldest first):')
    for (const note of recent) {
      const status = note.failed ? 'failed' : 'ok'
      const result = note.result === '' ? '' : ` result=${JSON.stringify(clip(note.result, 320))}`
      lines.push(`- ${note.name}(${clip(note.input, 320)}) -> ${status}${result}`)
    }
  }

  if (mode === 'continue') {
    if (images.count > 0) {
      const noun = images.count === 1 ? 'image' : 'images'
      lines.push('', images.visible
        ? `The user attached ${images.count} ${noun} to this message; they are shown above.`
        : `The user attached ${images.count} ${noun} that you cannot see; rely on the text alone.`)
    }
    if (draft.trim() === '' && images.count > 0) lines.push('', 'The draft is empty.', '', IMAGE_ONLY_CUE)
    else lines.push('', 'Draft text ending at the caret:', JSON.stringify(draft), '', CONTINUE_CUE)
  } else {
    lines.push('', NEXT_CUE)
  }
  return lines.join('\n')
}

/**
 * Read the images a continuation may carry: base64 of at most three small images of an
 * accepted type. Anything malformed refuses the whole request instead of dropping parts.
 * @returns the images, or `null` when the field is not acceptable.
 */
function parseImages(value) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > MAX_IMAGES) return null
  const images = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') return null
    const mediaType = typeof entry.mediaType === 'string' ? entry.mediaType : ''
    const data = typeof entry.data === 'string' ? entry.data.replace(/\s+/gu, '') : ''
    if (!IMAGE_TYPES.has(mediaType) || !/^[A-Za-z0-9+/]+={0,2}$/u.test(data)) return null
    const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
    const bytes = Math.floor((data.length * 3) / 4) - padding
    if (bytes < 1 || bytes > MAX_IMAGE_BYTES) return null
    const name = typeof entry.name === 'string' ? entry.name.slice(0, 80) : ''
    images.push(name === '' ? { data, mediaType } : { data, mediaType, name })
  }
  return images
}

/** A short digest of one image, so the result cache tells one set of pictures from another. */
function fingerprint(image) {
  return createHash('sha256').update(image.mediaType).update(':').update(image.data).digest('hex').slice(0, 16)
}

/** Whether the model behind this prepared call takes images; an unknown capability is tried. */
function modelSeesImages(call) {
  const modalities = call.inputModalities
  return !Array.isArray(modalities) || modalities.includes('image')
}

/**
 * Store the images as attachments, which is the form a model request cites. Storage is
 * content-addressed and independent of any Session, and nothing is appended to the log.
 * @returns `{ refs }`, or `{ skipped }` naming why the model cannot be shown them.
 */
async function admitImages(ctx, images) {
  const store = ctx.get?.('attachments')
  if (store === undefined || store === null || typeof store.saveImages !== 'function') return { skipped: 'unavailable' }
  try {
    const refs = await store.saveImages(
      images.map((image) => ({
        data: Buffer.from(image.data, 'base64'),
        mediaType: image.mediaType,
        ...(image.name === undefined ? {} : { name: image.name }),
      })),
    )
    return Array.isArray(refs) && refs.length === images.length ? { refs } : { skipped: 'unavailable' }
  } catch {
    return { skipped: 'refused' }
  }
}

/** One user message: the images first, then the prompt text. */
function buildUserContent(prompt, refs) {
  return [...refs.map((attachment) => ({ type: 'image', attachment })), { type: 'text', text: prompt }]
}

function plainText(blocks) {
  return blocks
    .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

function clip(text, maximum) {
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text
}

/** Shortest piece, in characters, a packed line may be split into. */
const MIN_PACKED_PIECE = 4

/**
 * Some models write every candidate on one line, separated only by a space, in
 * languages that put no spaces inside a sentence ("把A改一下 把B也改一下"). Split such
 * a line where a blank sits between two Chinese or Japanese characters, or after
 * their sentence-final punctuation. Anything uncertain stays one candidate: Latin
 * text, Korean (which spaces its words), and lines with a piece shorter than
 * {@link MIN_PACKED_PIECE}.
 */
function unpackLine(raw) {
  const pieces = raw.split(/(?<=[\u3040-\u30ff\u3400-\u9fff。！？；…])[ \t\u3000]+(?=[\u3040-\u30ff\u3400-\u9fff])/u)
  if (pieces.length < 2) return [raw]
  return pieces.every((piece) => piece.trim().length >= MIN_PACKED_PIECE) ? pieces : [raw]
}

/** Split model output into clean, de-duplicated, bounded candidates. */
function normalizeCandidates(text, maximum, draft, cue = '') {
  const items = []
  const seen = new Set()
  const prefix = draft === '' ? '' : draft.trimEnd()
  const prefixLower = prefix.toLocaleLowerCase()
  const cueIdentity = identityOf(cue)

  for (const raw of text.split(/\r?\n/).flatMap((line) => unpackLine(line))) {
    // Keep whether the line began with whitespace: for a continuation the model
    // uses a leading space to say "the draft needs a separator here".
    const hadLeadingSpace = /^\s/u.test(raw)
    const line = raw
      .replace(/^(?:[-*•]|\d+[.)])\s+/u, '')
      .replace(/^user\s*:\s*/iu, '')
      .trim()
    if (line === '') continue

    let body = line
      .replace(/^["'`\u201c\u201d]+|["'`\u201c\u201d]+$/gu, '')
      .replace(/\s+/gu, ' ')
    if (body === '' || /^none$/iu.test(body)) continue

    if (prefixLower !== '' && body.toLocaleLowerCase().startsWith(prefixLower)) {
      // The model sometimes restates the draft before continuing it.
      body = body.slice(prefix.length).replace(/^\s+/u, ' ')
    } else if (draft !== '' && hadLeadingSpace && !/^\s/u.test(body)) {
      body = ` ${body}`
    }

    body = draft === '' ? body.trim() : body.replace(/\s+$/u, '')
    if (body.trim() === '') continue
    body = boundSuggestion(body)
    if (body === '') continue

    const identity = identityOf(body)
    if (isInstructionEcho(identity, cueIdentity)) continue
    if (seen.has(identity)) continue
    seen.add(identity)
    items.push(body)
    if (items.length >= maximum) break
  }
  return items
}

/** Normalize a line for echo comparison: lowercase, no trailing punctuation. */
function identityOf(text) {
  return text.replace(/[.:!?]+$/u, '').trim().toLocaleLowerCase()
}

/** Drop the prompt's own labels and task line when the model echoes them. */
function isInstructionEcho(identity, cueIdentity) {
  if (identity === '') return true
  if (cueIdentity !== '' && (identity === cueIdentity || identity.startsWith(`${cueIdentity} `))) return true
  return PROMPT_LABELS.some((label) => identity === label || identity.startsWith(`${label} `))
}

function boundSuggestion(line) {
  if (line.length <= 240) return line
  const cut = line.slice(0, 240)
  const space = cut.lastIndexOf(' ')
  return space > 120 ? cut.slice(0, space) : cut
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      // Stop reading but leave the socket able to carry the error response.
      request.resume?.()
      reject(error)
    }
    request.on('data', (chunk) => {
      if (settled) return
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        fail(new Error('body-too-large'))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (settled) return
      settled = true
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', fail)
    request.on('aborted', () => fail(new Error('request-aborted')))
    request.on('close', () => fail(new Error('request-closed')))
  })
}

function openStream(response) {
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store, no-transform',
    'x-accel-buffering': 'no',
  })
  response.flushHeaders?.()
}

function sendEvent(response, event) {
  if (response.writableEnded || response.destroyed) return
  response.write(`data: ${JSON.stringify(event)}\n\n`)
}

function closeStream(response) {
  if (response.writableEnded || response.destroyed) return
  response.end()
}

function watchDisconnect(response) {
  const controller = new AbortController()
  response.on('close', () => {
    if (!response.writableEnded) controller.abort()
  })
  return controller
}

function respond(response, status, payload) {
  if (response.writableEnded || response.headersSent === true) return
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(payload))
}

function joinSignals(signals) {
  if (typeof AbortSignal.any === 'function') return AbortSignal.any(signals)
  const controller = new AbortController()
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort()
      break
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  return controller.signal
}

function timedSignal(signal, timeoutMs) {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal.aborted) controller.abort()
  else signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(abort, timeoutMs)
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    },
  }
}

/** Pure helpers exposed for the unit tests only. */
export const __testing = { ENDPOINT, resolveOptions, resolveRoute, finishFailure, selectEffort, buildPrompt, normalizeCandidates, parseImages }

# dsh-composer-suggest

Composer suggestions for the DeepSeek Harness Web UI.

- **Next message**: after the agent replies, the empty composer shows the message you
  are most likely to send next.
- **Draft continuation**: with text in the composer and the caret at its end, press
  **Tab**. The composer shows "Continuing…" with a spinner while the model works from
  the conversation above and your draft; press **Tab** again to accept the result, or
  **Esc** to cancel. Nothing is asked until you press Tab, and Tab keeps its usual job
  anywhere else (empty composer, caret mid-draft, a `/` command or `@` reference).
- **Pasted images**: an image attached to the composer counts as draft content, so Tab
  works with nothing typed and the model writes the message you are likely to send about
  it. Up to three images ride along with a continuation, taken from the composer's own
  thumbnails and shrunk to 1024px before they are sent. A model that cannot see images
  continues the text instead and the status line says the images were not seen; with
  nothing typed, the composer says so rather than guessing.
- **Tab** accepts a suggestion as an editable draft (nothing is sent),
  **Alt+Down / Alt+Up** cycle up to three candidates, **Esc** withdraws the offer, and
  typing discards it.
- A suggestion longer than what is left of the line wraps in place, at the same column
  the accepted text would, and the toolbar row below is pushed down to make room.
  To do that the plugin sets a temporary bottom margin on the composer's scroll element
  (the one marked `data-input-scroll`) and removes it when the suggestion goes away. If
  a Harness update renames that element, the suggestion still shows but may cover the
  toolbar until the selector in `client.js` is updated.
- **Tidy a draft**: once a draft is about 40 characters long, a **Tidy** button appears in
  the composer toolbar; **Alt+T** (Option+T on a Mac) does the same from 20 characters on.
  The model rewrites the draft into clear, ordered points without changing what it says,
  and the result replaces the draft in place. A line under the composer then says to read
  it before sending, offers **Restore**, and names any file name, number or other concrete
  token that is in one text and not in the other. In a new Session, where the Harness has
  no place under the composer, the same status sits in the toolbar next to the button.
  - **Restore**: the button turns into Restore while the tidied text is untouched, and
    Alt+T then restores too. After you edit the tidied text the button tidies again, and
    Restore stays in the status line. Sending the message ends the offer.
  - **Undo**: the Harness folds the replacement into the edit before it, so Ctrl/Cmd+Z may
    empty the composer instead of bringing your text back. The original is kept through
    that: use Restore.
  - **Cancel**: Esc, or a click on the button once it has been working for a moment.
  - If you typed while it ran, your newer text is kept and nothing is replaced.
  - A draft with `@` references is left alone and the status says why: the only way to
    write the result back turns the draft into plain text.
- **Settings → General** has one switch per feature, and a status line that shows which
  model route answered last, how long it took, or why a request failed.

Every suggestion and every tidy is one model call and uses tokens. It is not written to
the Session log and does not show in the token meter.

## What the model is shown

- The last five turns: what you typed and the agent's final reply to it. The latest reply
  is sent nearly whole (up to 3200 characters, keeping its ending when it must be cut);
  older turns are shortened to their first and last few hundred characters.
- The tool calls of the latest turn, up to six, each with a clipped result.
- Up to five of your earlier messages from the same Session, 140 characters each, so the
  suggestions match how you write.
- In continuation mode, your draft and up to three attached images.

Context the Harness adds for the agent (workspace instructions, runtime and time
snapshots, the skill catalog, reminders, background-job and teammate notices) is left
out, as is the agent's narration between tool calls.

Tidying sends the draft and nothing else: no conversation, no tool calls, no images. A
draft of up to 4000 characters is sent whole; a longer one is refused.

The candidates are asked to be different moves, not three wordings of one: for example
approving, picking the other option, reporting what happened when you tried it, or asking
about one claim. The prompts were tuned on deepseek-flash by replaying real sessions and
comparing against what was actually typed next.

## How far to trust a tidied draft

Read it before you send it. On 22 long, run-on messages from real sessions, tidied by
deepseek-flash at low effort and graded by a second model, 20 kept everything, one lost a
word ("just now") and one gained a detail that was not in the original; none became
harder to follow. The line under the composer compares only concrete tokens (paths, dotted
names, numbers of two or more digits, and Latin words inside Chinese or Japanese text), so
it would not have caught either of those two. It is there for the cheaper mistake of a
dropped file name or a changed number.

The Host refuses a result that was cut off by the output limit, is empty, is more than
three times the draft's length (an answer, not a rewrite) or less than a quarter of it.

## Install

From a checkout:

```sh
git clone https://github.com/WuweiRE/dsh-composer-suggest.git
dsh plugin --profile <name> add ./dsh-composer-suggest
```

Not yet published to npm. The registry has no `dsh-composer-suggest` package yet
(`npm view dsh-composer-suggest` returns 404), so install from the checkout above. This
paragraph becomes the one-line registry install once the first release is published:

```sh
dsh plugin --profile <name> add dsh-composer-suggest
```

Restart the Harness afterwards, then refresh the Web page. Developed and tested against
DeepSeek Harness 0.2.2-rc.1 and 0.2.2-rc.3. It needs a Harness that provides
`conversation.input.overlay`, `settings.general.item`, `connection.admit()`, `ctx.llm` and
`session.deriveMessages()`. Tidy additionally uses the `conversation.input.right` and
`conversation.composer.dock` slots, `inputActions.setDraft()` and the `occurrences` and
`phase` fields of the composer's input state.
Images additionally use the `attachments` service (`saveImages`) and the composer's
attachment thumbnails, which the Host renders as `<img>` elements with `blob:` sources
inside the composer card. Without them a continuation still works from text alone.

## Model

By default a suggestion is answered by the model the Session already uses, at that
model's lowest reasoning effort, with no temperature set.

To use another model, type its id (for example `claude-sonnet-5-5`) in
**Settings → General → Model for suggestions** and press Enter. Leave it empty to follow
the Session again. It is saved in the browser you typed it in, and the status line under
it reports which route answered last or why a request failed.

To set the model for every browser instead, override the row in your profile's
`cordis.patch.yml`. Any option you leave out keeps its default, and a model typed in
Settings wins over this:

```yaml
- id: composer-suggest
  name: dsh-composer-suggest
  config:
    model: claude-sonnet-5-5
```

Without a `provider`, the model is looked up among the providers mounted in your
profile, trying the Session's provider first. If none offers it, the request fails with
`model-unavailable` instead of silently using another model. Set `provider` and `model`
together in the configuration to name the route exactly. See `cordis.patch.yml` for every
option.

## Credits and licenses

This plugin is a combination of ideas and code from two MIT-licensed DeepSeek Harness
plugins. Their license texts are kept in this repository, and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists what comes from where.

| Project | Author | License | Used here |
|---|---|---|---|
| [dsh-composer-predictions](https://github.com/Stijnus/dsh-composer-predictions) | Stijnus | MIT, [LICENSE.stijnus](LICENSE.stijnus) | Code adapted: the streaming Host endpoint and owner check, prompt construction, candidate normalization, caret measurement, ghost positioning, SSE parsing and the keyboard handling. |
| [dsh-composer-prediction](https://www.npmjs.com/package/dsh-composer-prediction) | Amir Bazylkhanov | MIT, [LICENSE.bazylkhanov](LICENSE.bazylkhanov) | Behaviour reimplemented from its documentation and source: withdrawing a dismissed offer for the rest of the turn, IME handling, reporting a failed request in Settings, and using the model's cheapest advertised reasoning effort. |

What this project adds: continuation is triggered by Tab instead of running on every
typing pause, a visible "Continuing…" state with cancel, separate switches for each
feature, a model setting that follows the Session or names a model, a status line in
Settings, short on-screen notices for empty or failed continuations, and tidying a draft
in place with restore.

This project is released under the MIT License, Copyright (c) 2026 WuweiRE, see
[LICENSE](LICENSE). It is not affiliated with DeepSeek or with the authors above.

## Test

```sh
node --test
```

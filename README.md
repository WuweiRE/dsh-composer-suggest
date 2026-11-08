# dsh-composer-suggest

Composer suggestions for the DeepSeek Harness Web UI.

- **Next message**: after the agent replies, the empty composer shows the message you
  are most likely to send next.
- **Draft continuation**: with text in the composer and the caret at its end, press
  **Tab**. The composer shows "Continuing…" with a spinner while the model works from
  the conversation above and your draft; press **Tab** again to accept the result, or
  **Esc** to cancel. Nothing is asked until you press Tab, and Tab keeps its usual job
  anywhere else (empty composer, caret mid-draft, a `/` command or `@` reference).
- **Tab** accepts a suggestion as an editable draft (nothing is sent),
  **Alt+Down / Alt+Up** cycle up to three candidates, **Esc** withdraws the offer, and
  typing discards it.
- **Settings → General** has one switch per mode, and a status line that shows which
  model route answered last, how long it took, or why a request failed.

Every suggestion is one model call and uses tokens. It is not written to the Session
log and does not show in the token meter.

## Install

From a checkout:

```sh
git clone https://github.com/WuweiRE/dsh-composer-suggest.git
dsh plugin --profile <name> add ./dsh-composer-suggest
```

From npm, once a release is published there:

```sh
dsh plugin --profile <name> add dsh-composer-suggest
```

Restart the Harness afterwards, then refresh the Web page. Developed and tested against
DeepSeek Harness 0.2.2-rc.1. It needs a Harness that provides `conversation.input.overlay`,
`settings.general.item`, `connection.admit()`, `ctx.llm` and `session.deriveMessages()`.

## Model

By default a suggestion is answered by the model the Session already uses, at that
model's lowest reasoning effort, with no temperature set.

To answer with a specific model instead, override the row in your profile's
`cordis.patch.yml`. Any option you leave out keeps its default:

```yaml
- id: composer-suggest
  name: dsh-composer-suggest
  config:
    model: claude-sonnet-5-5
```

Without a `provider`, the model is looked up among the providers mounted in your
profile, trying the Session's provider first. If none offers it, the request fails with
`model-unavailable` instead of silently using another model. Set `provider` and `model`
together to name the route exactly. See `cordis.patch.yml` for every option.

## Credits and licenses

This plugin is a combination of ideas and code from two MIT-licensed DeepSeek Harness
plugins. Their license texts are kept in this repository, and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists what comes from where.

| Project | Author | License | Used here |
|---|---|---|---|
| [dsh-composer-predictions](https://github.com/Stijnus/dsh-composer-predictions) | Stijnus | MIT, [LICENSE.stijnus](LICENSE.stijnus) | Code adapted: the streaming Host endpoint and owner check, prompt construction, candidate normalization, caret measurement, ghost positioning, SSE parsing and the keyboard handling. |
| [dsh-composer-prediction](https://www.npmjs.com/package/dsh-composer-prediction) | Amir Bazylkhanov | MIT, [LICENSE.bazylkhanov](LICENSE.bazylkhanov) | Behaviour reimplemented from its documentation and source: withdrawing a dismissed offer for the rest of the turn, IME handling, reporting a failed request in Settings, and using the model's cheapest advertised reasoning effort. |

What this project adds: continuation is triggered by Tab instead of running on every
typing pause, a visible "Continuing…" state with cancel, separate switches for the two
modes, model selection that follows the Session or pins a model, a status line in
Settings, and short on-screen notices for empty or failed continuations.

This project is released under the MIT License, Copyright (c) 2026 WuweiRE, see
[LICENSE](LICENSE). It is not affiliated with DeepSeek or with the authors above.

## Test

```sh
node --test
```

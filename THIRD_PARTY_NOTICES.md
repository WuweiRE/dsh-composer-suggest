# Third-party notices

dsh-composer-suggest combines code and ideas from two MIT-licensed plugins. Each
license text is kept unchanged in this repository, as the MIT License requires.

## dsh-composer-predictions

- Repository: https://github.com/Stijnus/dsh-composer-predictions
- Copyright (c) 2026 dsh-composer-predictions contributors
- License: MIT, see [LICENSE.stijnus](LICENSE.stijnus)
- What was adapted into `index.js` and `client.js`: the streaming Host endpoint and its
  owner admission check, prompt construction, candidate normalization, caret
  measurement, ghost positioning, SSE parsing, the switch component and the keyboard
  handling for accepting and cycling candidates.

## dsh-composer-prediction

- Package: https://www.npmjs.com/package/dsh-composer-prediction
- Copyright (c) 2026 Amir Bazylkhanov
- License: MIT, see [LICENSE.bazylkhanov](LICENSE.bazylkhanov)
- What was reimplemented from its documented behaviour and source: withdrawing a
  dismissed offer for the rest of the turn, IME composition handling, reporting a failed
  request in Settings, and using the model's cheapest advertised reasoning effort.

# Korean IME on UE 5.3

`EnableIME` defaults to true. `KeyboardInput` must also be enabled. This fork
uses a real browser textarea as a composition target after the streamed video
is clicked. Its candidate window follows the click position. It does not
rely on the newer engine-only desktop `onScreenKeyboard` focus notifications.

Standard composition stays in the browser until commit. Text is sent through UE5.3's
existing `KeyPress` (62, uint16 little endian) messages. No UE/engine patch,
TextboxEntry replacement, or additional signalling protocol is required.
The composing preedit is not mirrored into UE; completed syllables appear at
the remote Slate text caret. Click an actual UE editable text widget first.

Some native/remote IME paths produce only `input` replacement events without
composition events. The browser text buffer is retained instead of cleared on
each event; the changed UTF-16 suffix is synchronized using backspace and text
messages. This also avoids accumulating intermediate jamo/syllables. Ordinary
navigation resets the local tracking anchor while the original key messages
move the remote caret. This fallback may display intermediate preedit in UE.

Browser text inputs, textareas and contenteditable controls outside this
composition target do not send their keys into UE. Plain Latin input uses the
textarea input path exactly once; composition events do not also send raw
physical keys. Blur and disconnect cancel uncommitted input and release held
keys. The composition target and event handlers are removed when keyboard
input is unregistered. Paste inserts text; remote clipboard copying is not
implemented by this change.

The primary target is desktop Chrome/Edge in hovering mouse mode. Mobile OS
keyboards and locked-pointer IME behavior require separate acceptance. Set
`EnableIME=false` to retain the legacy keyboard path. Switching modes should
be done before connecting or followed by a reconnect.

From `Frontend/library`, build and test with `npm ci`, `npm test -- --runInBand --coverage=false`,
`npm run compile`, and `npm run build`. Built UMD/ESM and declarations are generated locally and are not tracked in
Infrastructure. The stock frontend continues to consume the existing vendor tgz.
Automated composition tests are not a substitute for Microsoft IME tests
against actual streamed UE widgets.

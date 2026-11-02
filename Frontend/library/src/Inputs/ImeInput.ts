// Copyright Epic Games, Inc. All Rights Reserved.

/** Browser-owned IME buffer with committed-text and input-only replacement paths. */
export class ImeInput {
    readonly element: HTMLTextAreaElement;
    private composing = false;
    private syncedValue = '';
    private disposed = false;
    private readonly cleanups: Array<() => void> = [];

    constructor(
        private video: HTMLVideoElement,
        private enabled: () => boolean,
        private sendText: (text: string) => void,
        private releaseKeys: () => void
    ) {
        const input = document.createElement('textarea');
        this.element = input;
        input.className = 'pixelstreaming-ime-input';
        input.setAttribute('aria-label', 'Remote 3D IME input');
        input.setAttribute('autocomplete', 'off');
        input.setAttribute('autocorrect', 'off');
        input.spellcheck = false;
        input.tabIndex = -1;
        Object.assign(input.style, {
            position: 'absolute', width: '1px', height: '1px', padding: '0',
            border: '0', opacity: '0', pointerEvents: 'none', resize: 'none',
            overflow: 'hidden', zIndex: '2', left: '0', top: '0'
        });
        video.parentElement?.appendChild(input);
        this.listen(video, 'pointerdown', () => this.reset());
        this.listen(video, 'pointerup', (event: PointerEvent) => {
            if (!this.enabled() || event.button !== 0 || this.disposed) return;
            const rect = video.parentElement?.getBoundingClientRect();
            if (rect) {
                input.style.left = Math.max(0, Math.min(rect.width - 1, event.clientX - rect.left)) + 'px';
                input.style.top = Math.max(0, Math.min(rect.height - 1, event.clientY - rect.top)) + 'px';
            }
            // Let the normal mouse-up handler reach UE before browser IME owns focus.
            queueMicrotask(() => {
                if (!this.disposed && this.enabled()) input.focus({ preventScroll: true });
            });
        });
        this.listen(input, 'compositionstart', () => {
            this.releaseKeys(); this.composing = true;
        });
        this.listen(input, 'compositionend', () => {
            if (!this.composing) return;
            this.composing = false;
            if (this.enabled()) this.synchronize();
        });
        this.listen(input, 'input', (event: InputEvent) => {
            if (!this.enabled() || this.composing || event.isComposing) return;
            if (event.inputType === 'insertLineBreak' || event.inputType === 'insertParagraph') {
                this.clearBuffer(); return;
            }
            if (event.inputType === 'insertFromPaste') this.releaseKeys();
            this.synchronize();
        });
        this.listen(input, 'blur', () => this.reset());
        this.listen(window, 'blur', () => { this.reset(); input.blur(); });
    }

    private synchronize() {
        const value = this.element.value;
        let prefix = 0;
        while (prefix < value.length && prefix < this.syncedValue.length && value[prefix] === this.syncedValue[prefix]) prefix++;
        // Some native/remote IMEs emit replacement input events without composition events.
        // Preserve their browser buffer and replace only the changed suffix in UE.
        this.sendText('\b'.repeat(this.syncedValue.length - prefix) + value.slice(prefix));
        this.syncedValue = value;
    }

    private listen(target: EventTarget, name: string, callback: (event: any) => void) {
        target.addEventListener(name, callback);
        this.cleanups.push(() => target.removeEventListener(name, callback));
    }

    ownsFocus(): boolean { return document.activeElement === this.element; }
    isComposing(event: KeyboardEvent): boolean {
        return this.composing || event.isComposing || event.keyCode === 229 || event.key === 'Process';
    }
    noteDelete(down: boolean) {
        if (!down) return;
        const start = this.element.selectionStart;
        const end = this.element.selectionEnd;
        // KeyboardController already forwards this physical backspace once.
        this.syncedValue = this.syncedValue.slice(0, start === end ? Math.max(0, start - 1) : start) + this.syncedValue.slice(end);
    }
    clearBuffer() { this.element.value = ''; this.syncedValue = ''; }
    private reset() {
        this.composing = false; this.clearBuffer(); this.releaseKeys();
    }
    dispose() {
        this.disposed = true; this.reset();
        this.cleanups.forEach(cleanup => cleanup());
        this.element.remove();
    }
}

import { KeyboardController } from './KeyboardController';
import { ActiveKeys } from './InputClassesFactory';
import { Config } from '../Config/Config';
import { StreamMessageController } from '../UeInstanceMessage/StreamMessageController';

describe('physical movement keys during IME composition', () => {
    let keyboard: KeyboardController;
    let input: HTMLTextAreaElement;
    let video: HTMLVideoElement;
    let activeKeys: ActiveKeys;
    let packets: Array<{ type: string, values: Array<number | string> }>;

    beforeEach(async () => {
        Object.defineProperty(globalThis, 'RTCRtpReceiver', { configurable: true, value: {
            getCapabilities: () => ({ codecs: [{ mimeType: 'video/H264' }] })
        } });
        document.body.innerHTML = '<div><video></video></div><input id="local" />';
        video = document.querySelector('video');
        packets = [];
        activeKeys = new ActiveKeys();
        const protocol = new StreamMessageController();
        protocol.populateDefaultProtocol();
        for (const type of ['KeyDown', 'KeyUp', 'KeyPress']) {
            protocol.toStreamerHandlers.set(type, values => packets.push({ type, values }));
        }
        keyboard = new KeyboardController(protocol, new Config({ useUrlParams: false }), activeKeys, video);
        keyboard.registerKeyBoardEvents();
        input = document.querySelector('textarea');
        video.dispatchEvent(new MouseEvent('pointerup', { button: 0 }));
        await Promise.resolve();
    });
    afterEach(() => keyboard.unregisterKeyBoardEvents());

    const key = (type: string, code: string, options: KeyboardEventInit = {}) => {
        input.dispatchEvent(new KeyboardEvent(type, {
            code, key: 'Process', keyCode: 229, isComposing: true, bubbles: true, ...options
        }));
    };
    const composition = (type: string) => input.dispatchEvent(new CompositionEvent(type, { bubbles: true }));
    const text = () => packets.filter(packet => packet.type === 'KeyPress')
        .map(packet => String.fromCharCode(Number(packet.values[0]))).join('');

    it.each([['KeyW', 87], ['KeyA', 65], ['KeyS', 83], ['KeyD', 68], ['KeyQ', 81], ['KeyE', 69], ['KeyZ', 90], ['Digit0', 48], ['Digit9', 57]])(
        'forwards composing %s down and up without a character', (code: string, value: number) => {
            key('keydown', code);
            key('keyup', code);
            expect(packets).toEqual([
                { type: 'KeyDown', values: [value, 0] }, { type: 'KeyUp', values: [value] }
            ]);
            expect(activeKeys.getActiveKeys()).toEqual([]);
        });
    it('keeps a composing physical key held through compositionstart and repeat', () => {
        key('keydown', 'KeyW');
        composition('compositionstart');
        key('keydown', 'KeyW', { repeat: true });
        key('keypress', 'KeyW', { charCode: 119 });
        expect(packets).toEqual([
            { type: 'KeyDown', values: [87, 0] }, { type: 'KeyDown', values: [87, 1] }
        ]);
        key('keyup', 'KeyW');
        expect(packets[2]).toEqual({ type: 'KeyUp', values: [87] });
        expect(activeKeys.getActiveKeys()).toEqual([]);
    });
    it('releases only earlier Latin keys when composition starts', () => {
        key('keydown', 'KeyA', { key: 'a', keyCode: 65, isComposing: false });
        key('keydown', 'KeyW');
        composition('compositionstart');
        expect(packets).toEqual([
            { type: 'KeyDown', values: [65, 0] }, { type: 'KeyDown', values: [87, 0] },
            { type: 'KeyUp', values: [65] }
        ]);
        expect(activeKeys.getActiveKeys()).toEqual([87]);
    });
    it.each(['input blur', 'window blur', 'pointerdown', 'disconnect'])('releases composing keys on %s', cause => {
        key('keydown', 'KeyW');
        key('keydown', 'KeyA');
        if (cause === 'input blur') input.blur();
        if (cause === 'window blur') window.dispatchEvent(new Event('blur'));
        if (cause === 'pointerdown') video.dispatchEvent(new MouseEvent('pointerdown'));
        if (cause === 'disconnect') keyboard.unregisterKeyBoardEvents();
        expect(packets.filter(packet => packet.type === 'KeyUp')).toEqual([
            { type: 'KeyUp', values: [87] }, { type: 'KeyUp', values: [65] }
        ]);
        expect(activeKeys.getActiveKeys()).toEqual([]);
        key('keyup', 'KeyW');
        expect(packets.filter(packet => packet.type === 'KeyUp')).toHaveLength(2);
    });
    it('matches physical keyup after composition flags disappear or code is absent', () => {
        key('keydown', 'KeyW');
        key('keyup', 'KeyW', { isComposing: false, key: 'w', keyCode: 87 });
        key('keydown', 'KeyA');
        key('keyup', '', { isComposing: false, key: 'a', keyCode: 65 });
        expect(packets.filter(packet => packet.type === 'KeyUp').map(packet => packet.values)).toEqual([[87], [65]]);
        expect(activeKeys.getActiveKeys()).toEqual([]);
    });
    it('commits Hangul once and preserves one Backspace after composing physical input', () => {
        key('keydown', 'KeyG');
        composition('compositionstart');
        key('keypress', 'KeyG', { charCode: 103 });
        input.value = '한글';
        input.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', isComposing: true, bubbles: true }));
        key('keydown', 'Backspace');
        key('keyup', 'Backspace');
        expect(text()).toBe('');
        composition('compositionend');
        input.dispatchEvent(new InputEvent('input', { inputType: 'insertText', data: '한글', bubbles: true }));
        key('keyup', 'KeyG');
        expect(text()).toBe('한글');
        input.setSelectionRange(2, 2);
        key('keydown', 'Backspace', { keyCode: 8, key: 'Backspace', isComposing: false });
        input.value = '한';
        input.dispatchEvent(new InputEvent('input', { inputType: 'deleteContentBackward', bubbles: true }));
        key('keyup', 'Backspace', { keyCode: 8, key: 'Backspace', isComposing: false });
        expect(text()).toBe('한글\b');
    });
    it('keeps local HTML editors isolated from composing physical keys', () => {
        const local = document.getElementById('local');
        local.focus();
        local.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', keyCode: 229, isComposing: true, bubbles: true }));
        expect(packets).toEqual([]);
    });
});

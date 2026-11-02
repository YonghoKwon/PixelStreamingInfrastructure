import { KeyboardController } from './KeyboardController';
import { ActiveKeys } from './InputClassesFactory';
import { Config, Flags } from '../Config/Config';
import { StreamMessageController } from '../UeInstanceMessage/StreamMessageController';
import { SettingOption } from '../Config/SettingOption';

describe('IME text on the UE5.3 keyboard protocol', () => {
    let keyboard: KeyboardController;
    let video: HTMLVideoElement;
    let input: HTMLTextAreaElement;
    let packets: Array<{ type: string, values: Array<number | string> }>;
    let config: Config;
    let compositionBase: string;
    let finalData: string | null;

    beforeEach(async () => {
        (globalThis as any).RTCRtpReceiver = { getCapabilities: () => ({ codecs: [{ mimeType: 'video/H264' }] }) };
        document.body.innerHTML = '<div><video></video></div><input id="local" />';
        video = document.querySelector('video');
        config = new Config({ useUrlParams: false });
        packets = [];
        compositionBase = ''; finalData = null;
        const protocol = new StreamMessageController(); protocol.populateDefaultProtocol();
        for (const type of ['KeyDown', 'KeyUp', 'KeyPress']) protocol.toStreamerHandlers.set(type, values => packets.push({ type, values }));
        keyboard = new KeyboardController(protocol, config, new ActiveKeys(), video);
        keyboard.registerKeyBoardEvents();
        input = document.querySelector('textarea');
        video.dispatchEvent(new MouseEvent('pointerup', { button: 0, clientX: 30, clientY: 40 }));
        await Promise.resolve();
    });
    afterEach(() => keyboard.unregisterKeyBoardEvents());
    const composition = (type: string, data = '') => {
        const input = document.querySelector('textarea');
        if (type === 'compositionstart') { compositionBase = input.value; finalData = null; }
        if (type === 'compositionend') { input.value = compositionBase + data; finalData = data; }
        input.dispatchEvent(new CompositionEvent(type, { data, bubbles: true }));
    };
    const text = (data: string, inputType = 'insertText', isComposing = false) => {
        const input = document.querySelector('textarea');
        if (isComposing) input.value = compositionBase + (data || '');
        else if (data === finalData) finalData = null;
        else if (inputType === 'deleteContentBackward') input.value = input.value.slice(0, -1);
        else if (inputType.startsWith('insert') && data) input.value += data;
        input.dispatchEvent(new InputEvent('input', { data, inputType, isComposing, bubbles: true }));
    };
    const key = (type: string, code: number, isComposing = false) => document.activeElement.dispatchEvent(new KeyboardEvent(type, { keyCode: code, charCode: code, isComposing, bubbles: true }));
    const received = () => packets.filter(p => p.type === 'KeyPress').map(p => String.fromCharCode(p.values[0] as number)).join('');
    const rendered = () => [...received()].reduce((value, char) => char === '\b' ? value.slice(0, -1) : value + char, '');

    it('focuses a real editable composition target after a viewport click', () => {
        expect(document.activeElement).toBe(input); expect(input.hasAttribute('maxlength')).toBe(false);
    });
    it.each(['insertText', 'insertFromComposition', 'insertCompositionText'])('sends only committed Hangul once with final %s event', finalType => {
        composition('compositionstart'); key('keydown', 229, true);
        text('ㅎ', 'insertCompositionText', true); text('한', 'insertCompositionText', true);
        expect(packets).toEqual([]);
        composition('compositionend', '한'); text('한', finalType);
        expect(received()).toBe('한'); expect(packets[0].values).toEqual([0xd55c]);
    });
    it('handles final input before compositionend and repeated equal syllables', () => {
        for (let i = 0; i < 2; i++) { composition('compositionstart'); text('한', 'insertText'); composition('compositionend', '한'); }
        expect(received()).toBe('한한');
    });
    it('routes Latin and paste text via input, without duplicate keypress', () => {
        key('keydown', 65); key('keypress', 65); text('A'); key('keyup', 65);
        text(' 한글 123', 'insertFromPaste'); expect(received()).toBe('A 한글 123');
    });
    it('keeps edits local during composition and forwards one normal backspace', () => {
        composition('compositionstart'); key('keydown', 8, true); text('', 'deleteContentBackward', true);
        expect(packets).toEqual([]); composition('compositionend', '각');
        key('keydown', 8); text('', 'deleteContentBackward'); key('keyup', 8);
        expect(received()).toBe('각\b');
    });
    it('forwards Enter once after composition is committed', () => {
        text('A'); key('keydown', 13); text(null, 'insertLineBreak'); key('keyup', 13);
        expect(received()).toBe('A\r');
    });
    it('does not forward keys from ordinary HTML text fields', () => {
        (document.getElementById('local') as HTMLInputElement).focus();
        key('keydown', 65); key('keypress', 65); key('keyup', 65); expect(packets).toEqual([]);
    });
    it('replaces preedit updates from native IMEs that do not emit composition events', () => {
        for (const value of ['ㅎ', '하', '한', '한ㄱ', '한그', '한글', '한글 ']) {
            input.value = value;
            input.dispatchEvent(new InputEvent('input', { data: value.slice(-1), inputType: 'insertText', bubbles: true }));
            expect(rendered()).toBe(value);
        }
    });
    it('does not erase the browser composition buffer after a commit', () => {
        composition('compositionstart'); text('한', 'insertCompositionText', true); composition('compositionend', '한'); text('한');
        expect(input.value).toBe('한'); expect(rendered()).toBe('한');
    });
    it('releases held physical keys when IME takes over', () => {
        key('keydown', 87); composition('compositionstart');
        expect(packets.map(p => p.type)).toEqual(['KeyDown', 'KeyUp']);
    });
    it('does not release held movement keys for ordinary Latin input', () => {
        key('keydown', 87); text('w');
        expect(packets.map(p => p.type)).toEqual(['KeyDown', 'KeyPress']);
        key('keyup', 87); expect(packets.at(-1)?.type).toBe('KeyUp');
    });
    it('cancels uncommitted text on blur and removes its DOM on disconnect', () => {
        composition('compositionstart'); text('한', 'insertCompositionText', true);
        input.blur(); composition('compositionend', '한'); expect(received()).toBe('');
        keyboard.unregisterKeyBoardEvents(); expect(document.querySelector('textarea')).toBeNull();
    });
    it('does not focus an IME target when explicitly disabled', async () => {
        input.blur(); config.setFlagEnabled(Flags.EnableIME, false);
        video.dispatchEvent(new MouseEvent('pointerup', { button: 0 })); await Promise.resolve();
        expect(document.activeElement).not.toBe(input);
    });
    it('ignores unavailable codec selection values', () => {
        const option = new SettingOption('PreferredCodec', '', '', 'H264', ['H264'], false);
        for (const value of [undefined, null, '']) option.selected = value;
        expect(option.selected).toBe('H264');
    });
});

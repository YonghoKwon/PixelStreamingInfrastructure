import { Config, OptionParameters, TextParameters } from '../Config/Config';
import { Logger } from '../Logger/Logger';
import { PixelStreaming } from '../PixelStreaming/PixelStreaming';
import { mockRTCRtpReceiver, unmockRTCRtpReceiver } from '../__test__/mockRTCRtpReceiver';
import { mockRTCPeerConnection, unmockRTCPeerConnection } from '../__test__/mockRTCPeerConnection';
import { mockHTMLMediaElement, mockMediaStream, unmockMediaStream } from '../__test__/mockMediaStream';
import { mockWebSocket, MockWebSocketTriggerFunctions, unmockWebSocket } from '../__test__/mockWebSocket';
import { MessageRecvTypes } from './MessageReceive';

describe('3Finex addUser subscription', () => {
    const parentDescriptor = Object.getOwnPropertyDescriptor(window, 'parent');
    const iframeUuid = 'qa-iframe-uuid-private';
    const parentUuid = 'qa-parent-uuid-private';
    const employee = 731492;
    const userName = 'qa-user-name-private';
    let config: Config;
    let stream: PixelStreaming;
    let send: jest.Mock;
    let triggers: MockWebSocketTriggerFunctions;
    let consoleSpies: jest.SpyInstance[];
    let verbosity: number;

    const setParent = (value: unknown) => {
        Object.defineProperty(window, 'parent', { configurable: true, value });
    };
    const makeParent = () => ({
        uuid: parentUuid,
        getUserFromSessionByKey: jest.fn((key: string) =>
            key === 'user_emp_no' ? employee : userName)
    });
    const messages = () => send.mock.calls.map(([data]) => JSON.parse(data));
    const subscribe = () => {
        config = new Config({ initialSettings: { AutoConnect: true } });
        stream = new PixelStreaming(config);
        triggers.triggerOnOpen();
        triggers.triggerOnMessage({ type: MessageRecvTypes.CONFIG, peerConnectionOptions: {} });
        send.mockClear();
        triggers.triggerOnMessage({ type: MessageRecvTypes.STREAMER_LIST, ids: ['qa-streamer'] });
    };

    beforeEach(() => {
        mockRTCRtpReceiver();
        mockMediaStream();
        mockRTCPeerConnection();
        mockHTMLMediaElement({ ableToPlay: true });
        const [spies, triggerFunctions] = mockWebSocket();
        send = spies.sendSpy as jest.Mock;
        triggers = triggerFunctions;
        jest.useFakeTimers();
        verbosity = Logger.verboseLogLevel;
        Logger.SetLoggerVerbosity(6);
        consoleSpies = ['log', 'warn', 'error', 'info'].map((method: 'log' | 'warn' | 'error' | 'info') =>
            jest.spyOn(console, method).mockImplementation(() => undefined));
        window.uuid = iframeUuid;
        setParent(makeParent());
    });

    afterEach(() => {
        stream?.disconnect();
        stream = undefined;
        jest.clearAllTimers();
        jest.useRealTimers();
        Logger.SetLoggerVerbosity(verbosity);
        delete window.uuid;
        delete window.getUserFromSessionByKey;
        Object.defineProperty(window, 'parent', parentDescriptor);
        unmockRTCRtpReceiver();
        unmockMediaStream();
        unmockRTCPeerConnection();
        unmockWebSocket();
        jest.restoreAllMocks();
    });

    it('sends exactly one addUser immediately after subscribe with the exact JSON fields', () => {
        const parent = makeParent();
        setParent(parent);
        subscribe();
        expect(messages()).toEqual([
            { type: 'subscribe', streamerId: 'qa-streamer' },
            { type: 'addUser', streamerId: 'qa-streamer', uuid: iframeUuid, userEmpNo: employee, userName }
        ]);
        expect(parent.getUserFromSessionByKey.mock.calls).toEqual([['user_emp_no'], ['user_name']]);
        triggers.triggerOnMessage({ type: MessageRecvTypes.STREAMER_LIST, ids: ['qa-streamer'] });
        expect(messages()).toHaveLength(2);
    });

    it('sends addUser again immediately after a new subscription', () => {
        subscribe();
        send.mockClear();
        config.setOptionSettingOptions(OptionParameters.StreamerId, ['qa-streamer', 'qa-streamer-next']);
        config.setOptionSettingValue(OptionParameters.StreamerId, 'qa-streamer-next');
        expect(messages()).toEqual([
            { type: 'subscribe', streamerId: 'qa-streamer-next' },
            { type: 'addUser', streamerId: 'qa-streamer-next', uuid: iframeUuid, userEmpNo: employee, userName }
        ]);
    });

    it('keeps standalone subscribe working even when the top window has the parent function', () => {
        setParent(window);
        window.getUserFromSessionByKey = jest.fn();
        expect(subscribe).not.toThrow();
        expect(messages()).toEqual([{ type: 'subscribe', streamerId: 'qa-streamer' }]);
        expect(window.getUserFromSessionByKey).not.toHaveBeenCalled();
    });

    it.each([undefined, 'not-a-function'])('skips addUser when the iframe parent function is %s', (getUserFromSessionByKey) => {
        setParent({ getUserFromSessionByKey });
        expect(subscribe).not.toThrow();
        expect(messages()).toEqual([{ type: 'subscribe', streamerId: 'qa-streamer' }]);
    });

    it.each(['parent', 'function access', 'employee call', 'name call'])('contains exceptions from %s and logs only a fixed one-line warning', (failure) => {
        const error = new DOMException(`${iframeUuid} ${employee} ${userName}`, 'SecurityError');
        const parent = makeParent();
        if (failure === 'parent') {
            Object.defineProperty(window, 'parent', { configurable: true, get: () => { throw error; } });
        } else if (failure === 'function access') {
            Object.defineProperty(parent, 'getUserFromSessionByKey', { get: () => { throw error; } });
            setParent(parent);
        } else {
            parent.getUserFromSessionByKey.mockImplementation((key) => {
                if (key === (failure === 'employee call' ? 'user_emp_no' : 'user_name')) throw error;
                return employee;
            });
            setParent(parent);
        }
        expect(subscribe).not.toThrow();
        expect(messages()).toEqual([{ type: 'subscribe', streamerId: 'qa-streamer' }]);
        expect(console.warn).toHaveBeenCalledTimes(1);
        expect(console.warn).toHaveBeenCalledWith('addUser skipped: parent user information unavailable.');
        const logs = JSON.stringify(consoleSpies.map((spy) => spy.mock.calls));
        for (const value of [iframeUuid, parentUuid, String(employee), userName]) expect(logs).not.toContain(value);
    });

    it.each([undefined, null])('falls back to parent uuid when window uuid is %s', (uuid) => {
        window.uuid = uuid;
        subscribe();
        expect(messages()[1].uuid).toBe(parentUuid);
    });

    it.each(['', 0])('preserves an available window uuid value %s without coercion', (uuid) => {
        window.uuid = uuid;
        subscribe();
        expect(messages()[1].uuid).toBe(uuid);
    });

    it('never logs user information at verbosity 6 while preserving the wire values', () => {
        subscribe();
        expect(messages()[1]).toMatchObject({ uuid: iframeUuid, userEmpNo: employee, userName });
        const logs = JSON.stringify(consoleSpies.map((spy) => spy.mock.calls));
        expect(logs).toContain('addUser');
        for (const value of [iframeUuid, parentUuid, String(employee), userName]) expect(logs).not.toContain(value);
    });

    it('confirms undefined ss overwrites the default, so an absent window.url must omit ss', () => {
        const defaultConfig = new Config();
        const invalidConfig = new Config({ initialSettings: { ss: undefined } });
        expect(defaultConfig.getTextSettingValue(TextParameters.SignallingServerUrl)).toBe('ws://localhost');
        expect(invalidConfig.getTextSettingValue(TextParameters.SignallingServerUrl)).toBeUndefined();
    });
});

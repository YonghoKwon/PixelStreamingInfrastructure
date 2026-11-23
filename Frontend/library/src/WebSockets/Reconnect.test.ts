import { Config, OptionParameters } from '../Config/Config';
import { Logger } from '../Logger/Logger';
import { PixelStreaming } from '../PixelStreaming/PixelStreaming';
import { WebRtcPlayerController } from '../WebRtcPlayer/WebRtcPlayerController';
import { mockRTCRtpReceiver, unmockRTCRtpReceiver } from '../__test__/mockRTCRtpReceiver';
import { mockRTCPeerConnection, unmockRTCPeerConnection } from '../__test__/mockRTCPeerConnection';
import { mockHTMLMediaElement, mockMediaStream, unmockMediaStream } from '../__test__/mockMediaStream';
import { mockWebSocket, MockWebSocketTriggerFunctions, unmockWebSocket } from '../__test__/mockWebSocket';
import { MessageRecvTypes } from './MessageReceive';

describe('signalling reconnect subscription lifecycle', () => {
    const parentDescriptor = Object.getOwnPropertyDescriptor(window, 'parent');
    let config: Config;
    let stream: PixelStreaming;
    let send: jest.Mock;
    let socketCreated: jest.Mock;
    let peerCreated: jest.Mock;
    let triggers: MockWebSocketTriggerFunctions;
    let verbosity: number;

    const controller = () => (stream as unknown as { _webRtcController: WebRtcPlayerController })._webRtcController;
    const serverClose = () => controller().webSocketController.webSocket.close(4000, 'QA reconnect');
    const messages = (type: string) => send.mock.calls
        .map(([data]) => JSON.parse(data))
        .filter((message) => message.type === type);
    const streamerList = (ids = ['qa-streamer']) =>
        triggers.triggerOnMessage({ type: MessageRecvTypes.STREAMER_LIST, ids });
    const openSession = (ids = ['qa-streamer']) => {
        triggers.triggerOnOpen();
        triggers.triggerOnMessage({ type: MessageRecvTypes.CONFIG, peerConnectionOptions: {} });
        streamerList(ids);
    };
    const connect = () => {
        config = new Config({ initialSettings: { AutoConnect: true, MaxReconnectAttempts: 5 } });
        stream = new PixelStreaming(config);
        openSession();
    };

    beforeEach(() => {
        jest.useFakeTimers();
        mockRTCRtpReceiver();
        mockMediaStream();
        const [peerSpies] = mockRTCPeerConnection();
        peerCreated = peerSpies.constructorSpy as jest.Mock;
        mockHTMLMediaElement({ ableToPlay: true });
        const [socketSpies, triggerFunctions] = mockWebSocket();
        send = socketSpies.sendSpy as jest.Mock;
        socketCreated = socketSpies.constructorSpy as jest.Mock;
        triggers = triggerFunctions;
        verbosity = Logger.verboseLogLevel;
        Logger.SetLoggerVerbosity(0);
        Object.defineProperty(window, 'parent', { configurable: true, value: window });
    });

    afterEach(() => {
        stream?.disconnect();
        stream = undefined;
        jest.clearAllTimers();
        jest.useRealTimers();
        Logger.SetLoggerVerbosity(verbosity);
        Object.defineProperty(window, 'parent', parentDescriptor);
        unmockRTCRtpReceiver();
        unmockMediaStream();
        unmockRTCPeerConnection();
        unmockWebSocket();
        jest.restoreAllMocks();
    });

    it('subscribes once on first connect and ignores duplicate selections on the same connection', () => {
        connect();
        const count = peerCreated.mock.calls.length;
        streamerList();
        config.setOptionSettingValue(OptionParameters.StreamerId, 'qa-streamer');
        expect(messages('subscribe')).toEqual([{ type: 'subscribe', streamerId: 'qa-streamer' }]);
        expect(messages('addUser')).toHaveLength(0);
        expect(peerCreated).toHaveBeenCalledTimes(count);
    });

    it('resubscribes exactly once on each fresh WebSocket after close 4000', () => {
        connect();
        for (let attempt = 1; attempt <= 2; attempt++) {
            // close() in the mock delivers a remote-style close event and marks the socket CLOSED.
            serverClose();
            jest.advanceTimersByTime(2000);
            expect(socketCreated).toHaveBeenCalledTimes(attempt + 1);
            openSession();
            const count = peerCreated.mock.calls.length;
            streamerList();
            expect(messages('subscribe')).toHaveLength(attempt + 1);
            expect(messages('listStreamers')).toHaveLength(attempt + 1);
            expect(peerCreated).toHaveBeenCalledTimes(count);
        }
    });

    it('sends one iframe addUser immediately after the fresh subscription', () => {
        Object.defineProperty(window, 'parent', { configurable: true, value: {
            uuid: 'qa-reconnect-uuid',
            getUserFromSessionByKey: (key: string) => key === 'user_emp_no' ? 'qa-employee' : 'qa-name'
        } });
        connect();
        serverClose();
        jest.advanceTimersByTime(2000);
        send.mockClear();
        openSession();
        streamerList();
        expect(send.mock.calls.map(([data]) => JSON.parse(data))).toEqual([
            { type: 'listStreamers' },
            { type: 'subscribe', streamerId: 'qa-streamer' },
            { type: 'addUser', streamerId: 'qa-streamer', uuid: 'qa-reconnect-uuid', userEmpNo: 'qa-employee', userName: 'qa-name' }
        ]);
    });

    it('retains the previous streamer preference when several streamers are available after reconnect', () => {
        connect();
        serverClose();
        jest.advanceTimersByTime(2000);
        openSession(['qa-other-streamer', 'qa-streamer']);
        expect(messages('subscribe')).toEqual([
            { type: 'subscribe', streamerId: 'qa-streamer' },
            { type: 'subscribe', streamerId: 'qa-streamer' }
        ]);
    });

    it('closes the old peer when signalling closes before creating a new session', () => {
        connect();
        const oldPeer = controller().peerConnectionController.peerConnection;
        serverClose();
        expect(oldPeer.connectionState).toBe('closed');
    });

    it.each(['reconnect delay', 'before config'])('defers a changed streamer selection during %s and subscribes once when ready', (phase) => {
        Object.defineProperty(window, 'parent', { configurable: true, value: {
            uuid: 'qa-reconnect-uuid',
            getUserFromSessionByKey: (key: string) => key === 'user_emp_no' ? 'qa-employee' : 'qa-name'
        } });
        connect();
        streamerList(['qa-streamer', 'qa-other-streamer']);
        serverClose();
        if (phase === 'before config') {
            jest.advanceTimersByTime(2000);
            triggers.triggerOnOpen();
        }
        send.mockClear();
        const count = peerCreated.mock.calls.length;
        expect(() => config.setOptionSettingValue(OptionParameters.StreamerId, 'qa-other-streamer')).not.toThrow();
        expect(send).not.toHaveBeenCalled();
        expect(peerCreated).toHaveBeenCalledTimes(count);
        if (phase === 'reconnect delay') {
            jest.advanceTimersByTime(2000);
            triggers.triggerOnOpen();
        }
        triggers.triggerOnMessage({ type: MessageRecvTypes.CONFIG, peerConnectionOptions: {} });
        streamerList(['qa-streamer', 'qa-other-streamer']);
        const subscribedPeerCount = peerCreated.mock.calls.length;
        streamerList(['qa-streamer', 'qa-other-streamer']);
        expect(messages('subscribe')).toEqual([{ type: 'subscribe', streamerId: 'qa-other-streamer' }]);
        expect(messages('addUser')).toEqual([{
            type: 'addUser', streamerId: 'qa-other-streamer', uuid: 'qa-reconnect-uuid', userEmpNo: 'qa-employee', userName: 'qa-name'
        }]);
        expect(peerCreated).toHaveBeenCalledTimes(subscribedPeerCount);
    });

    it('does not reconnect or resubscribe after an explicit disconnect', () => {
        connect();
        stream.disconnect();
        jest.advanceTimersByTime(10000);
        expect(socketCreated).toHaveBeenCalledTimes(1);
        expect(messages('subscribe')).toHaveLength(1);
    });

    it('honors disconnect while a server-close reconnect delay is pending', () => {
        connect();
        serverClose();
        stream.disconnect();
        jest.advanceTimersByTime(10000);
        expect(socketCreated).toHaveBeenCalledTimes(1);
        expect(messages('subscribe')).toHaveLength(1);
    });
});

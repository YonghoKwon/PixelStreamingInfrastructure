// Copyright Epic Games, Inc. All Rights Reserved.

export * from '@epicgames-ps/lib-pixelstreamingfrontend-ue5.3';
export * from '@epicgames-ps/lib-pixelstreamingfrontend-ui-ue5.3';
import { Config, PixelStreaming } from '@epicgames-ps/lib-pixelstreamingfrontend-ue5.3';
import { Application, PixelStreamingApplicationStyle, UIElementCreationMode } from '@epicgames-ps/lib-pixelstreamingfrontend-ui-ue5.3';
const PixelStreamingApplicationStyles =
    new PixelStreamingApplicationStyle({
        customStyles: {
            '#uiFeatures #controls': {
                top: '50%',
                transform: 'translateY(-50%)'
            },
            '#uiFeatures #controls #fullscreen-btn': {
                width: '1.5rem',
                height: '1.5rem',
                lineHeight: '0.875rem',
                // Override the default fullscreen padding, which is also important.
                padding: '0.25rem !important'
            },
            '#uiFeatures #controls #fullscreen-btn svg': {
                width: '100%',
                height: '100%'
            }
        }
    });
PixelStreamingApplicationStyles.applyStyleSheet();

// Install local overlay hooks on a normally constructed Application (no native-class inheritance).
function installConnectingMessage(application: Application): void {
    const stream = application.stream;
    const original = {
        showTextOverlay: application.showTextOverlay.bind(application),
        showDisconnectOverlay: application.showDisconnectOverlay.bind(application),
        showErrorOverlay: application.showErrorOverlay.bind(application),
        onDisconnect: application.onDisconnect.bind(application),
        onPlayStream: application.onPlayStream.bind(application),
        showPlayOverlay: application.showPlayOverlay.bind(application),
        onPlayStreamError: application.onPlayStreamError.bind(application),
        showAfkOverlay: application.showAfkOverlay.bind(application)
    };
    let connectingSince: number | undefined;
    let connectingTimer: number | undefined;
    let intentionallyDisconnected = false;

    const showConnectingMessage = (): void => {
        const seconds = Math.floor((performance.now() - connectingSince) / 1000);
        const delayed = seconds >= 30 ? '<br>연결이 지연되고 있습니다' : '';
        original.showTextOverlay('<div style="text-align: center">화면 연결 중입니다. ' + seconds + '초' + delayed + '</div>');
    };
    const startConnecting = (reset = false): void => {
        if (connectingSince !== undefined && !reset) return;
        window.clearInterval(connectingTimer);
        connectingSince = performance.now();
        showConnectingMessage();
        connectingTimer = window.setInterval(showConnectingMessage, 1000);
    };
    const stopConnecting = (): void => {
        window.clearInterval(connectingTimer);
        connectingTimer = undefined;
        connectingSince = undefined;
        if (application.currentOverlay === application.infoOverlay) application.hideCurrentOverlay();
    };

    application.showTextOverlay = (text: string): void => {
        if (connectingSince !== undefined) showConnectingMessage();
        else original.showTextOverlay(text);
    };
    application.showDisconnectOverlay = (text: string): void => {
        // A later server push can still connect after streamer-list retries give up.
        if (connectingSince !== undefined) showConnectingMessage();
        else original.showDisconnectOverlay(text);
    };
    application.showErrorOverlay = (text: string): void => {
        if (connectingSince !== undefined) showConnectingMessage();
        else original.showErrorOverlay(text);
    };
    application.onWebRtcAutoConnect = (): void => startConnecting();
    application.onWebRtcConnecting = (): void => startConnecting();
    application.onDisconnect = (eventString: string, allowClickToReconnect: boolean): void => {
        if (!allowClickToReconnect && !intentionallyDisconnected) {
            startConnecting(true);
            application.statsPanel?.onDisconnect();
        } else {
            stopConnecting();
            original.onDisconnect(eventString, allowClickToReconnect);
        }
    };
    application.onPlayStream = (): void => {
        // playStream and videoInitialized precede video.play(); wait for actual playing.
        if (connectingSince === undefined) original.onPlayStream();
    };
    application.showPlayOverlay = (): void => {
        stopConnecting();
        original.showPlayOverlay();
    };
    application.onPlayStreamError = (message: string): void => {
        stopConnecting();
        original.onPlayStreamError(message);
    };
    application.showAfkOverlay = (countDown: number, dismissAfk: () => void): void => {
        stopConnecting();
        original.showAfkOverlay(countDown, dismissAfk);
    };

    stream.videoElementParent.querySelector('video')?.addEventListener('playing', stopConnecting);
    stream.addEventListener('streamConnect', () => {
        intentionallyDisconnected = false;
        startConnecting(true);
    });
    stream.addEventListener('streamReconnect', () => {
        intentionallyDisconnected = false;
        startConnecting(true);
    });
    stream.addEventListener('streamDisconnect', () => {
        intentionallyDisconnected = true;
        stopConnecting();
    });
    stream.addEventListener('afkTimedOut', () => {
        intentionallyDisconnected = true;
        stopConnecting();
    });
    // PixelStreaming starts AutoConnect before Application and these hooks exist.
    startConnecting();
}

document.body.onload = function() {
	// Example of how to set the logger level
	// Logger.SetLoggerVerbosity(10);

	// Create a config object
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const signallingUrl = (window as any).url;
	const initialSettings = {
		AutoPlayVideo: true,
		AutoConnect: true,
		...(typeof signallingUrl === 'string' && signallingUrl.trim() !== '' ? { ss: signallingUrl } : {}),
		StartVideoMuted: true,
		HoveringMouse: true,
		WaitForStreamer: true,
		KeyboardInput: true
	};
	console.log("initialSettings : " + JSON.stringify(initialSettings));
	const config = new Config({ initialSettings, useUrlParams: true });
	try {
		console.log("config : " + JSON.stringify(config));
	} catch {
		console.warn('Config logging skipped: configuration could not be serialized.');
	}
	config.setFlagEnabled("AutoConnect", true);
	config.setFlagEnabled("MatchViewportRes", true);
	config.setFlagEnabled("HoveringMouse", true);
	config.setFlagEnabled("FakeMouseWithTouches", true);
	config.setFlagEnabled("MouseInput", true);
	// config.setFlagEnabled("KeyboardInput", false);
	try {
		console.log("config : " + JSON.stringify(config));
	} catch {
		console.warn('Config logging skipped: configuration could not be serialized.');
	}

	// Create a Native DOM delegate instance that implements the Delegate interface class
	const stream = new PixelStreaming(config);

	const application = new Application({
		stream,
		settingsPanelConfig: {
			isEnabled: false,
			visibilityButtonConfig: { creationMode: UIElementCreationMode.Disable }
		},
		statsPanelConfig: {
			isEnabled: false,
			visibilityButtonConfig: { creationMode: UIElementCreationMode.Disable }
		},
		xrControlsConfig: { creationMode: UIElementCreationMode.Disable },
		onColorModeChanged: (isLightMode) => PixelStreamingApplicationStyles.setColorMode(isLightMode)
	});
	installConnectingMessage(application);
	// document.getElementById("centrebox").appendChild(application.rootElement);
	document.body.appendChild(application.rootElement);
}

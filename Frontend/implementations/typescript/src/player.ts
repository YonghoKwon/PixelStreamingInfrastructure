// Copyright Epic Games, Inc. All Rights Reserved.

export * from '@epicgames-ps/lib-pixelstreamingfrontend-ue5.3';
export * from '@epicgames-ps/lib-pixelstreamingfrontend-ui-ue5.3';
import { Config, PixelStreaming } from '@epicgames-ps/lib-pixelstreamingfrontend-ue5.3';
import { Application, PixelStreamingApplicationStyle } from '@epicgames-ps/lib-pixelstreamingfrontend-ui-ue5.3';
const PixelStreamingApplicationStyles =
    new PixelStreamingApplicationStyle();
PixelStreamingApplicationStyles.applyStyleSheet();

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
		onColorModeChanged: (isLightMode) => PixelStreamingApplicationStyles.setColorMode(isLightMode)
	});
	// document.getElementById("centrebox").appendChild(application.rootElement);
	document.body.appendChild(application.rootElement);
}

// Copyright Epic Games, Inc. All Rights Reserved.

// v3 Codex: v2 lifecycle fixes plus redacted logs, certificate paths,
// explicit HTTP modes/readiness, and bounded owned-launcher execution.
//-- Server side logic. Serves pixel streaming WebRTC-based page, proxies data back to Streamer --//

var express = require('express');
var app = express();

const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const querystring = require('querystring');
const bodyParser = require('body-parser');
const logging = require('./modules/logging.js');
logging.RegisterConsoleLogger();
const v3 = require('./modules/cirrus-v3-support');
const logRedactor = v3.createLogRedactor();
logRedactor.install(console); // Wrap before configuration or file logging can emit values.

// 좀비 스트리머 감지용
const offerWaitTimers = new Map();
const OFFER_WAIT_TIMEOUT_MS = 20 * 1000;  // 20초 (여러 플레이어 동시 처리 시 지연 허용)
let zombieRestartInProgress = false;  // 상단에 추가

function startOfferWaitTimer(playerId, streamerId) {
	clearOfferWaitTimer(playerId);
	const expectedPlayer = players.get(playerId);
	const expectedStreamer = streamers.get(streamerId);
	const timer = setTimeout(() => {
		if (offerWaitTimers.get(playerId) !== timer) return;
		offerWaitTimers.delete(playerId);
		const player = players.get(playerId);
		if (!player || player !== expectedPlayer || player.ws.readyState !== WebSocket.OPEN ||
			player.streamerId !== streamerId || streamers.get(streamerId) !== expectedStreamer ||
			!expectedStreamer || expectedStreamer.ws.readyState !== WebSocket.OPEN) return;
		if (!allowAppAutoStart('offer-timeout')) {
			player.ws.close(); // External supervision: isolate this waiter, never restart UE.
			return;
		}
		if (zombieRestartInProgress || appCommandInProgress || appCommandRunner.isBlocked()) {
			startOfferWaitTimer(playerId, streamerId); // Defer this same check; never overlap a command.
			return;
		}
		if (hasNegotiatedViewer(expectedStreamer, playerId)) {
			console.warn(`[ZOMBIE] Offer timeout for player ${playerId}; negotiated viewers retained`);
			player.ws.close(); // Same close code/reason as disconnectAllPlayers.
			return;
		}
		// Check before removing UE/player sockets: an exhausted budget is
		// observation-only, and closing browsers would trigger reconnect loops.
		if (!canStartApp()) return;
		
		zombieRestartInProgress = true;
		console.logColor(logging.Red,
			`[ZOMBIE] Player ${playerId} → Streamer ${streamerId} offer 없음 (${OFFER_WAIT_TIMEOUT_MS/1000}초) → 좀비 감지! 3D 앱 재시작`
		);
		
		// 같은 스트리머에 대기 중인 다른 플레이어의 offer 타이머도 모두 취소 (중복 트리거 방지)
		for (let [pid] of new Map(offerWaitTimers)) {
			const p = players.get(pid);
			if (p && p.streamerId === streamerId) {
				clearOfferWaitTimer(pid);
			}
		}
		
		// 스트리머를 Map에서 먼저 선제 제거 → ws.close() 이후 onStreamerDisconnected 중복 호출 차단
		const zombieStreamer = streamers.get(streamerId);
		if (zombieStreamer) {
			streamers.delete(streamerId);
			console.logColor(logging.Orange, `[ZOMBIE] 스트리머 ${streamerId} Map에서 선제 제거`);
		}
		
		// 모든 플레이어 강제 해제
		disconnectAllPlayers(streamerId);
		
		// 좀비 스트리머 WebSocket 강제 종료 (Map 제거 후 실행 → 중복 onStreamerDisconnected 방지)
		if (zombieStreamer) {
			try { zombieStreamer.ws.close(1011, 'zombie restart'); } catch (e) {}
		}
		
		// 3D 앱 재시작
		appRunning = false;
		runAppCommand(START_CMD, (err) => {
			// 스트리머 없음 타이머가 남아있으면 취소 (appRunning=false 덮어쓰기 방지)
			if (streamerGoneTimerId) {
				clearTimeout(streamerGoneTimerId);
				streamerGoneTimerId = null;
			}
			zombieRestartInProgress = false;  // 재시작 완료 후 해제
			if (err) {
				appRunning = appStreamerCount(true) > 0;
				console.error(`[ZOMBIE] 재시작 실패: ${err.message}`);
				// Use the existing 90-second startup watchdog rather than an immediate retry loop.
			} else {
				appRunning = true;
				console.logColor(logging.Green, `[ZOMBIE] 3D 앱 재시작 완료`);
				// 재시작 완료 후 아직 연결 중인 대기 플레이어에게 streamerList push는
				// 스트리머가 실제로 등록되는 시점(registerStreamer)에서 자동으로 처리됨
			}
		});
	}, OFFER_WAIT_TIMEOUT_MS);
	offerWaitTimers.set(playerId, timer);
}
	
function clearOfferWaitTimer(playerId) {
	if (offerWaitTimers.has(playerId)) {
		clearTimeout(offerWaitTimers.get(playerId));
		offerWaitTimers.delete(playerId);
	}
}

function hasNegotiatedViewer(streamer, exceptId) {
	return [...players.values()].some(player => player.id !== exceptId && !player.isSFU() &&
		player.ws.readyState === WebSocket.OPEN && player.streamerId === streamer.id &&
		player.negotiatedStreamer === streamer && streamers.get(streamer.id) === streamer);
}

// 상단 변수 선언부에 추가
let lastStreamerPingTime = null;
let lastStreamerRegistrationTime = null;
let streamerWatchdogTimer = null;
const STREAMER_PING_TIMEOUT_MS = 1 * 60 * 1000;  // 진단용 경과 시간; 재시작 조건이 아님

function startStreamerWatchdog() {
	if (streamerWatchdogTimer) clearInterval(streamerWatchdogTimer);
	streamerWatchdogTimer = setInterval(() => {
		if (zombieRestartInProgress || appCommandInProgress || appCommandRunner.isBlocked()) return;
		// Idle grace is observation-only. A UE/SFU socket is not browser demand.
		// The independent ten-minute timer remains responsible for shutdown.
		if (!hasBrowserDemand()) return;
		if (!allowAppAutoStart('registration-watchdog')) return;
		if (startRetryStatus.state === 'exhausted') return;
		
		// [신규] 앱 시작 후 APP_START_TIMEOUT_MS 내 스트리머 미연결 감지
		// Watch_Streamers 등이 프로세스를 죽였거나 앱 내부 오류로 연결 못 한 경우 재시작
		if (appStreamerCount() === 0 && appStartTime) {
			const elapsed = Date.now() - appStartTime;
			if (elapsed > APP_START_TIMEOUT_MS) {
				console.logColor(logging.Red,
					`[WATCHDOG] 앱 시작 후 ${Math.floor(elapsed/1000)}초 경과 but 스트리머 미연결 → appRunning 리셋 후 재시작 시도`
				);
				appRunning = false;
				appStartTime = null;
				console.logColor(logging.Yellow, `[WATCHDOG] 대기 브라우저 → startApp 재호출`);
				startApp();
				return;
			}
		}
		
		// UE 5.3's JSON keepalive itself defaults to a 60-second game-world
		// timer. Delay/absence is diagnostic telemetry, not proof of a dead UE
		// process or failed WebRTC media. Never restart from ping age alone.
	}, 30 * 1000);  // 30초마다 체크
}

function stopStreamerWatchdog() {
	if (streamerWatchdogTimer) {
		clearInterval(streamerWatchdogTimer);
		streamerWatchdogTimer = null;
	}
}
	
// Command line argument --configFile needs to be checked before loading the config, all other command line arguments are dealt with through the config object

// Compatibility default only. Runtime timing always uses config.AppIdleTimeoutMs.
const APP_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const defaultConfig = {
	UseFrontend: false,
	UseMatchmaker: false,
	UseHTTPS: false,
	HTTPSCertFile: './certificates/client-cert.pem',
	HTTPSKeyFile: './certificates/client-key.pem',
	HTTPSCAFile: '',  // 중간 CA 체인 파일 (공인 인증서 사용시: './certificates/DigiCertCA.pem')
	UseAuthentication: false,
	LogToFile: true,
	LogVerbose: true,
	HomepageFile: 'player.html',
	AdditionalRoutes: new Map(),
	EnableWebserver: true,
	MatchmakerAddress: "",
	MatchmakerPort: 9999,
	PublicIp: "localhost",
	HttpPort: 80,
	HttpsPort: 443,
	StreamerPort: 8888,
	SFUPort: 8889,
	MaxPlayerCount: -1,
	DisableSSLCert: true,
	HttpMode: 'certificate-only',
	AppCommandTimeoutMs: 60000,
	AppCommandKillGraceMs: 5000,
	AppCommandMaxTimeouts: 3,
	MaxWebSocketPayloadBytes: 4 * 1024 * 1024,
	AppStartMaxAttempts: 3,
	PlayerKeepaliveTimeoutMs: 30000,
	AppStartCooldownMs: 600000,
	AppIdleTimeoutMs: APP_IDLE_TIMEOUT_MS,
	AppAutoStart: true
};

const argv = require('yargs').argv;
var configFile = (typeof argv.configFile != 'undefined') ? argv.configFile.toString() : path.join(__dirname, 'config.json');
console.log(`configFile ${configFile}`);
const config = v3.loadConfig(configFile, defaultConfig, argv, fs);
logRedactor.remember(config);

if (config.LogToFile) {
	logging.RegisterFileLogger('./logs/');
	v3.installErrorFileLogger(console, { fileSystem: fs, redact: logRedactor.redact });
}

console.log("Config: " + JSON.stringify(logRedactor.redact(config), null, '\t'));
console.log(`[APP] Lifecycle | AppAutoStart=${config.AppAutoStart} | AppIdleTimeoutMs=${config.AppIdleTimeoutMs} | 모드: ${lifecycleModeLabel()}`);
if (!config.AppAutoStart && config.AppIdleTimeoutMs > 0) {
	console.warn('[APP] 자동 기동은 꺼져 있으나 유휴 종료는 켜져 있음: 외부가 기동한 3D도 설정된 무접속 시간 후 종료됨');
}

var http = require('http').Server(app);

if (config.UseHTTPS) {
	//HTTPS certificate details
	const options = {
		key: fs.readFileSync(v3.certificatePath(__dirname, config.HTTPSKeyFile)),
		cert: fs.readFileSync(v3.certificatePath(__dirname, config.HTTPSCertFile))
	};

	// 공인 인증서 사용 시: 중간 CA 체인 파일을 ca 옵션에 추가
	// (DigiCertCA.pem 등 중간 CA가 있을 경우 브라우저 체인 검증에 필요)
	if (config.HTTPSCAFile && config.HTTPSCAFile !== '') {
		options.ca = fs.readFileSync(v3.certificatePath(__dirname, config.HTTPSCAFile));
	}
	
	var https = require('https').Server(options, app);
}

//If not using authetication then just move on to the next function/middleware
var isAuthenticated = redirectUrl => function (req, res, next) { return next(); }

if (config.UseAuthentication && config.UseHTTPS) {
	var passport = require('passport');
	require('./modules/authentication').init(app);
	// Replace the isAuthenticated with the one setup on passport module
	isAuthenticated = passport.authenticationMiddleware ? passport.authenticationMiddleware : isAuthenticated
} else if (config.UseAuthentication && !config.UseHTTPS) {
	console.error('Trying to use authentication without using HTTPS, this is not allowed and so authentication will NOT be turned on, please turn on HTTPS to turn on authentication');
}

const helmet = require('helmet');
var hsts = require('hsts');
var net = require('net');

var FRONTEND_WEBSERVER = 'https://localhost';
if (config.UseFrontend) {
	var httpPort = 3000;
	var httpsPort = 8000;

	if (config.UseHTTPS && config.DisableSSLCert) {
		//Required for self signed certs otherwise just get an error back when sending request to frontend see https://stackoverflow.com/a/35633993
		console.logColor(logging.Orange, 'WARNING: config.DisableSSLCert is true. Unauthorized SSL certificates will be allowed! This is convenient for local testing but please DO NOT SHIP THIS IN PRODUCTION. To remove this warning please set DisableSSLCert to false in your config.json.');
		process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"
	}

	const httpsClient = require('./modules/httpsClient.js');
	var webRequest = new httpsClient();
} else {
	var httpPort = config.HttpPort;
	var httpsPort = config.HttpsPort;
}

var streamerPort = config.StreamerPort; // port to listen to Streamer connections
var sfuPort = config.SFUPort;

var matchmakerAddress = '127.0.0.1';
var matchmakerPort = 9999;
var matchmakerRetryInterval = 5;
var matchmakerKeepAliveInterval = 30;
var maxPlayerCount = -1;

var gameSessionId;
var userSessionId;
var serverPublicIp;

// `clientConfig` is send to Streamer and Players
// Example of STUN server setting
// let clientConfig = {peerConnectionOptions: { 'iceServers': [{'urls': ['stun:34.250.222.95:19302']}] }};
var clientConfig = { type: 'config', peerConnectionOptions: {} };

// Parse public server address from command line
// --publicIp <public address>
try {
	if (typeof config.PublicIp != 'undefined') {
		serverPublicIp = config.PublicIp.toString();
	}

	if (typeof config.HttpPort != 'undefined') {
		httpPort = config.HttpPort;
	}

	if (typeof config.HttpsPort != 'undefined') {
		httpsPort = config.HttpsPort;
	}

	if (typeof config.StreamerPort != 'undefined') {
		streamerPort = config.StreamerPort;
	}

	if (typeof config.SFUPort != 'undefined') {
		sfuPort = config.SFUPort;
	}

	if (typeof config.FrontendUrl != 'undefined') {
		FRONTEND_WEBSERVER = config.FrontendUrl;
	}

	if (typeof config.peerConnectionOptions != 'undefined') {
		clientConfig.peerConnectionOptions = JSON.parse(config.peerConnectionOptions);
		console.log(`peerConnectionOptions = ${JSON.stringify(logRedactor.redact(clientConfig.peerConnectionOptions))}`);
	} else {
		console.log("No peerConnectionConfig")
	}

	if (typeof config.MatchmakerAddress != 'undefined') {
		matchmakerAddress = config.MatchmakerAddress;
	}

	if (typeof config.MatchmakerPort != 'undefined') {
		matchmakerPort = config.MatchmakerPort;
	}

	if (typeof config.MatchmakerRetryInterval != 'undefined') {
		matchmakerRetryInterval = config.MatchmakerRetryInterval;
	}

	if (typeof config.MaxPlayerCount != 'undefined') {
		maxPlayerCount = config.MaxPlayerCount;
	}
} catch (e) {
	console.error(e);
	process.exit(2);
}

if (config.UseHTTPS) {
	app.use(helmet());

	app.use(hsts({
		maxAge: 15552000  // 180 days in seconds
	}));

	//Setup http -> https redirect
	console.log('Redirecting http->https');
	app.use(function (req, res, next) {
		if (!req.secure) {
			if (req.get('Host')) {
				var hostAddressParts = req.get('Host').split(':');
				var hostAddress = hostAddressParts[0];
				if (httpsPort != 443) {
					hostAddress = `${hostAddress}:${httpsPort}`;
				}
				return res.redirect(['https://', hostAddress, req.originalUrl].join(''));
			} else {
				console.error(`unable to get host name from header. Requestor ${req.ip}, url path: '${req.originalUrl}', available headers ${JSON.stringify(req.headers)}`);
				return res.status(400).send('Bad Request');
			}
		}
		next();
	});
}

sendGameSessionData();

// 
// 3D 앱 자동 관리 (플레이어 접속/해제 연동)
//
const { spawn } = require('child_process');

// The idle deadline is configured per server; the default remains ten minutes.
//
// OS 자동 감지 - Linux / Windows 모두 대응
//
const isWindows = process.platform === 'win32';

// 이 시그널링 서버가 사용하는 StreamerPort로 인스턴스 구분
const myStreamerPort = config.StreamerPort;  // config에서 이미 읽은 값 (8881 or 8861)
const RUN_DIR = (config.RunDir || 'E:\\Streaming\\Run');

// PID 파일 경로 (포트 번호로 구분) - watch_streamers.sh / Start_*.bat 에서 관리
// const PID_FILE = isWindows
// ? path.join(RUN_DIR, `pid_${myStreamerPort}.txt`)
// : `/tmp/pid_${myStreamerPort}.txt`;
// ※ cirrus.js는 PID 파일을 직접 읽지 않으므로 현재 미사용 (참고용)

const START_CMD = isWindows
	? `cmd /c "${RUN_DIR}\\Start_${myStreamerPort}.bat"`
	: `/dt/run.sh restart`;

const STOP_CMD = isWindows
	? `cmd /c "${RUN_DIR}\\Stop_${myStreamerPort}.bat"`
	: `/dt/run.sh stop`;

console.logColor(logging.Green, `[APP] OS: ${process.platform} | Port: ${myStreamerPort} | START: ${START_CMD}`);

let idleTimer = null;
let idleTimerStartTime = null;  // 추가 - 유휴 타이머 시작 시각
let appRunning = false;
// Signalling loss does not prove the launched OS process exited. Retain cleanup
// responsibility until STOP is requested, even if appRunning is resynchronized.
let appStopPending = false;
let appStartTime = null;  // 추가 - startApp() 호출 시각 (스트리머 미연결 타임아웃 감지용)

// 앱 시작 후 이 시간 내 스트리머가 연결 안 되면 재시작 시도
const APP_START_TIMEOUT_MS = 90 * 1000;  // 90초

// 스트리머 없음 5초 타이머 전역 관리 (취소 가능하도록)
let streamerGoneTimerId = null;

let stopRetryTimer = null;
const STOP_RETRY_INTERVAL_MS = 15 * 1000;  // 15초마다 재시도
const STOP_RETRY_MAX = 4;  // 최대 4회 재시도 (명령 실행 중인 회차는 건너뜀)
let stopRetryStatus = { state: 'idle', attempts: 0, at: null };

function resetStopRetryStatus() {
	stopRetryStatus = { state: 'idle', attempts: 0, at: null };
}

let startRetryTimer = null;
let startRetryStatus = { state: 'idle', attempts: 0, at: null, nextRetryAt: null, slowRetries: 0 };
const autoStartSuppressionCauses = new Set();

function lifecycleModeLabel() {
	if (config.AppAutoStart) return '접속 시 기동';
	return config.AppIdleTimeoutMs === 0 ? '상시(자동기동 끔)' : '외부 기동·유휴 종료(자동기동 끔)';
}

function allowAppAutoStart(cause) {
	if (config.AppAutoStart) return true;
	if (!autoStartSuppressionCauses.has(cause)) {
		autoStartSuppressionCauses.add(cause);
		console.warn(`[APP] AppAutoStart=false (${cause}): 외부 감시가 3D 기동을 관리함`);
	}
	return false;
}

function resetStartRetryStatus() {
	if (startRetryTimer) { clearTimeout(startRetryTimer); startRetryTimer = null; }
	startRetryStatus = { state: 'idle', attempts: 0, at: null, nextRetryAt: null, slowRetries: 0 };
}

function canStartApp() {
	return config.AppAutoStart && startRetryStatus.attempts < config.AppStartMaxAttempts;
}

function scheduleSlowStartRetry() {
	if (!allowAppAutoStart('slow-retry')) { resetStartRetryStatus(); return; }
	if (startRetryTimer || startRetryStatus.state !== 'exhausted' || config.AppStartCooldownMs === 0) return;
	startRetryStatus.nextRetryAt = new Date(Date.now() + config.AppStartCooldownMs).toISOString();
	startRetryTimer = setTimeout(() => {
		startRetryTimer = null;
		startRetryStatus.nextRetryAt = null;
		if (!allowAppAutoStart('slow-retry')) { resetStartRetryStatus(); return; }
		if (startRetryStatus.state !== 'exhausted') return;
		// A busy/blocked/no-demand round is skipped, never queued for an early retry.
		scheduleSlowStartRetry();
		if (!hasBrowserDemand() || appCommandInProgress || appCommandRunner.isBlocked() || zombieRestartInProgress) return;
		console.warn('[APP] START cooldown elapsed; one slow retry');
		appRunning = true;
		runAppCommand(START_CMD, error => {
			if (error) { appRunning = appStreamerCount(true) > 0; console.error(`[APP] Slow START failed: ${error.message}`); }
		}, true);
	}, config.AppStartCooldownMs);
	startRetryTimer.unref?.();
}

function countStartAttempt(slowRetry = false) {
	if (!config.AppAutoStart) return;
	startRetryStatus.attempts++;
	if (slowRetry) startRetryStatus.slowRetries++;
	if (canStartApp()) {
		startRetryStatus.state = 'attempting';
	} else if (startRetryStatus.state !== 'exhausted') {
		startRetryStatus.state = 'exhausted';
		startRetryStatus.at = new Date().toISOString();
		console.warn(`[APP] START budget exhausted (${startRetryStatus.attempts}/${config.AppStartMaxAttempts}); further automatic START disabled until negotiation succeeds or idle expires`);
		scheduleSlowStartRetry();
	}
}

// Keep the v1 booleans and scripts. This gate tracks only the current shell command.
let appCommandInProgress = null;
let startAfterStop = false;
let stopAfterStart = false;
const appCommandRunner = v3.createCommandRunner({
	spawn, platform: process.platform,
	kill: (pid, signal) => process.kill(pid, signal),
	setTimeout, clearTimeout, now: () => Date.now(),
	timeoutMs: config.AppCommandTimeoutMs,
	graceMs: config.AppCommandKillGraceMs,
	maxTimeouts: config.AppCommandMaxTimeouts,
	hasLiveApp: () => appStreamerCount(true) > 0
});

function browserPlayerCount() {
	return [...players.values()].filter(player => !player.isSFU()).length;
}

function hasBrowserDemand() {
	return [...players.values()].some(player => !player.isSFU() && player.ws.readyState === WebSocket.OPEN);
}

function appStreamerCount(openOnly = false) {
	return [...streamers.values()].filter(streamer => !streamer.isSFU() &&
		(!openOnly || streamer.ws.readyState === WebSocket.OPEN)).length;
}

function getStreamerHealth() {
	if (appStreamerCount(true) === 0) return { state: 'disconnected', ageMs: null };
	const observedAt = lastStreamerPingTime ?? lastStreamerRegistrationTime;
	const ageMs = observedAt === null ? null : Math.max(0, Date.now() - observedAt);
	return { state: ageMs !== null && ageMs > STREAMER_PING_TIMEOUT_MS ? 'stale' :
		lastStreamerPingTime === null ? 'awaiting-ping' : 'healthy', ageMs };
}

function runAppCommand(command, callback, slowRetry = false) {
	if (command === START_CMD && !allowAppAutoStart('command-entry')) return false;
	if (appCommandInProgress || appCommandRunner.isBlocked()) return false;
	if (command === START_CMD && !canStartApp() && !slowRetry) return false;
	appCommandInProgress = command;
	if (command === START_CMD) {
		countStartAttempt(slowRetry);
		appStopPending = true;
		appStartTime = Date.now(); // All three START paths retain the same registration deadline.
		if (streamerGoneTimerId) { clearTimeout(streamerGoneTimerId); streamerGoneTimerId = null; }
		startStreamerWatchdog();
	}
	let finished = false;
	const complete = (err, stdout, stderr) => {
		if (finished) return;
		finished = true;
		appCommandInProgress = null;
		const resumeStart = command === STOP_CMD && startAfterStop;
		const resumeStop = command === START_CMD && stopAfterStart;
		if (command === STOP_CMD) startAfterStop = false;
		if (command === START_CMD) stopAfterStart = false;
		callback(err, stdout, stderr);
		if (appCommandRunner.isBlocked() && appStreamerCount(true) === 0) {
			for (const player of players.values()) {
				if (!player.isSFU() && player.ws.readyState === WebSocket.OPEN) {
					player.ws.close(1013, '3D launcher blocked; operator recovery required');
				}
			}
		}
		if (!appCommandInProgress) {
			if (resumeStart && hasBrowserDemand() && allowAppAutoStart('after-stop')) startApp(true);
			else if (resumeStop && browserPlayerCount() === 0) stopApp(true);
		}
	};
	return appCommandRunner.run(command, complete, command === START_CMD ? 'start' : 'stop');
}

function forceCloseAllStreamers(reason) {
	if (appStreamerCount() === 0) return;
	console.logColor(logging.Orange, `[APP] 스트리머 ${streamers.size}개 WebSocket 강제 종료 (${reason})`);
	for (let [id, streamer] of new Map(streamers)) {
		if (streamer.isSFU()) continue;
		try { streamer.ws.close(1011, reason); } catch (e) {}
	}
}

function startApp(forceStart = false) {
	if (!hasBrowserDemand() || appCommandRunner.isBlocked()) return;
	// 진행 중인 stop 재시도 타이머가 있으면 취소 (새로 시작하는 경우)
	if (stopRetryTimer) {
		clearInterval(stopRetryTimer);
		stopRetryTimer = null;
		console.logColor(logging.Yellow, `[APP] 진행 중이던 stop 재시도 취소 (재시작 우선)`);
	}

	stopAfterStart = false; // A new browser cancels a queued idle shutdown.
	if (!allowAppAutoStart('browser-demand')) return;
	if (appCommandInProgress) {
		if (appCommandInProgress === STOP_CMD) startAfterStop = true;
		return;
	}
	// [핵심 수정] 좀비 재시작 진행 중이면 startApp을 완전히 차단
	// → zombie exec(START_CMD)와 플레이어 재연결 시 startApp()이 동시에 호출되어
	// START_CMD가 이중 실행되고 스트리머 2개가 생성되는 근본 원인 차단
	if (zombieRestartInProgress) {
		console.logColor(logging.Yellow, `[APP] 좀비 재시작 진행 중 → startApp 스킵 (중복 기동 방지)`);
		return;
	}
	
	if (appRunning && !forceStart) {
		console.logColor(logging.Green, `[APP] 이미 실행 중 - 스킵`);
		return;
	}
	
	// 스트리머가 이미 연결되어 있으면 appRunning 상태가 잘못된 것 → 동기화 후 스킵
	// (AppRunning=false인데 스트리머가 있다 = 5초 타이머가 잘못 덮어쓴 경우)
	if (appStreamerCount() > 0 && !forceStart) {
		appRunning = true;
		startStreamerWatchdog();
		console.logColor(logging.Green, `[APP] 스트리머 ${streamers.size}개 연결 확인 → appRunning 동기화 (재시작 스킵)`);
		return;
	}
	if (!canStartApp()) return;
	
	appRunning = true;  // ← exec 호출 전에 즉시 true로 설정 (중복 방지)
	appStartTime = Date.now();
	console.logColor(logging.Green, `[APP] 3D 앱 시작 요청...`);
	
	runAppCommand(START_CMD, (err) => {
		if (err) {
			console.error(`[APP] 시작 실패: ${err.message}`);
			appRunning = appStreamerCount(true) > 0;  // A late launcher failure must not undo a live registration.
		} else {
			console.logColor(logging.Green, `[APP] 시작 완료`);
			// appRunning은 이미 true이므로 다시 설정 불필요
		}
	});
		
	// appRunning = true; ← 여기서 제거
	lastStreamerPingTime = null;
	startStreamerWatchdog();  // 추가
}

function stopApp(forceStop = false) {
	if (appCommandRunner.isBlocked()) return;
	if (browserPlayerCount() > 0) return;
	if (appCommandInProgress) {
		if (appCommandInProgress === START_CMD) stopAfterStart = true;
		return;
	}
	if (!appRunning && !appStopPending && !forceStop) return;
	console.logColor(logging.Orange, `[APP] 유휴 ${config.AppIdleTimeoutMs / 60000}분 경과 → 3D 앱 종료`);
	
	// STOP_CMD 실행 (BAT/sh)
	runAppCommand(STOP_CMD, (err) => {
		if (err) console.error(`[APP] 종료 명령 실패: ${err.message}`);
		else console.logColor(logging.Orange, `[APP] 종료 명령 전송 완료`);
	});
	
	// WebSocket도 강제로 끊어서 Windows BAT 실패 시에도 연결 정리
	forceCloseAllStreamers('idle shutdown');
	
	appRunning = false;
	appStopPending = false;
	appStartTime = null;  // 추가
	stopStreamerWatchdog();
	lastStreamerPingTime = null;

	// 재시도 로직: BAT 실패로 스트리머가 남아 있으면 재연결 차단
	let retryCount = 0;
	if (stopRetryTimer) { clearInterval(stopRetryTimer); stopRetryTimer = null; }
	
	stopRetryTimer = setInterval(() => {
		if (appCommandRunner.isBlocked()) {
			clearInterval(stopRetryTimer);
			stopRetryTimer = null;
			return;
		}
		if (browserPlayerCount() > 0) {
			clearInterval(stopRetryTimer);
			stopRetryTimer = null;
			return;
		}
		if (appCommandInProgress) return;
		retryCount++;
		if (appStreamerCount() === 0) {
			console.logColor(logging.Green, `[APP] 스트리머 완전 종료 확인 (재시도 ${retryCount}회)`);
			resetStopRetryStatus();
			clearInterval(stopRetryTimer);
			stopRetryTimer = null;
			return;
		}
		console.logColor(logging.Red,
			`[APP] 스트리머 아직 연결됨 (${retryCount}/${STOP_RETRY_MAX}) → 재종료 시도`);
		runAppCommand(STOP_CMD, (err) => {
			if (err) console.error(`[APP] 재종료 실패: ${err.message}`);
		});
		forceCloseAllStreamers('idle shutdown retry ' + retryCount);
		
		if (retryCount >= STOP_RETRY_MAX) {
			stopRetryStatus = { state: 'exhausted', attempts: retryCount, at: new Date().toISOString() };
			console.logColor(logging.Red, `[APP] 최대 재시도 초과 → 재시도 중단`);
			clearInterval(stopRetryTimer);
			stopRetryTimer = null;
		}
	}, STOP_RETRY_INTERVAL_MS);
}

function resetIdleTimer() {
	if (idleTimer) {
		clearTimeout(idleTimer);
		idleTimer = null;
	}
	idleTimerStartTime = null;  // 추가
}

function startIdleTimer() {
	resetIdleTimer();
	if (config.AppIdleTimeoutMs === 0) return;
	idleTimerStartTime = Date.now();  // 추가
	console.logColor(logging.Yellow, `[APP] 유휴 타이머 시작 (${config.AppIdleTimeoutMs / 60000}분 후 종료)`);
	idleTimer = setTimeout(() => {
		if (browserPlayerCount() === 0) {
			resetStartRetryStatus();
			stopApp();
		}
	}, config.AppIdleTimeoutMs);
}

// set up rate limiter: maximum of five requests per minute
var RateLimit = require('express-rate-limit');
var limiter = RateLimit({
  windowMs: 1*60*1000, // 1 minute
  max: 60
});

// apply rate limiter to all requests
app.use(limiter);

// Liveness is separate from UE registration/readiness and is not media validation.
function getServiceStatus() {
	const launcher = appCommandRunner.snapshot();
	const startExhausted = startRetryStatus.state === 'exhausted';
	const ready = appStreamerCount(true) > 0 && !appCommandInProgress && launcher.state !== 'blocked' && !startExhausted;
	return { status: launcher.state === 'blocked' || startExhausted || stopRetryStatus.state === 'exhausted' ? 'degraded' : ready ? 'ready' : 'waiting', ready,
		browsers: browserPlayerCount(), ueStreamers: appStreamerCount(true), launcher,
		stopRetry: { ...stopRetryStatus },
		startRetry: { ...startRetryStatus },
		lifecycle: { autoStart: config.AppAutoStart, idleTimeoutMs: config.AppIdleTimeoutMs },
		streamerHealth: getStreamerHealth(),
		mediaValidated: false };
}
app.get('/healthz', (req, res) => res.set('Cache-Control', 'no-store').status(200).json(getServiceStatus()));
app.get('/readyz', (req, res) => {
	const status = getServiceStatus();
	res.set('Cache-Control', 'no-store').status(status.ready ? 200 : 503).json(status);
});

// The old certificate-only access policy remains the default. Web serving is opt-in.
app.use((req, res, next) => {
	if (req.headers.upgrade && req.headers.upgrade.toLowerCase() === 'websocket') {
		return next();
	}
	if (config.HttpMode === 'web' && req.path !== '/cert-check') return next();
	res.set('Cache-Control', 'no-store').status(200).send(`<!DOCTYPE html>
<html lang="ko">
<head>
	<meta charset="utf-8">
	<title>${req.secure ? 'HTTPS' : 'HTTP'} 연결 확인</title>
	<style>
		body {
			font-family: Arial, sans-serif;
			display: flex; flex-direction: column;
			align-items: center; justify-content: center;
			height: 100vh; margin: 0;
			background: #1a1a2e; color: #eee;
		}
		.box {
			text-align: center;
			background: #16213e;
			border: 1px solid #0f3460;
			border-radius: 12px;
			padding: 40px 60px;
			box-shadow: 0 4px 24px rgba(0,0,0,0.4);
		}
		h2 { color: #4ecca3; margin-bottom: 12px; }
		p { color: #aaa; margin: 6px 0; }
		.counter { font-size: 2em; color: #4ecca3; margin: 16px 0; }
	</style>
</head>
<body>
	<div class="box">
		<h2>${req.secure ? 'HTTPS' : 'HTTP'} 연결 확인</h2>
		<p>픽셀 스트리밍 시그널링 서버에 연결되었습니다.</p>
		<p>${req.secure ? 'HTTPS 연결이 성립했습니다.' : '현재 연결은 HTTP이며 TLS 인증서 검증을 의미하지 않습니다.'}</p>
		<div class="counter" id="cnt">3</div>
		<p>초 후 자동으로 창이 닫힙니다.</p>
	</div>
	<script>
		var sec = 3;
		var el = document.getElementById('cnt');
		var t = setInterval(function() {
			sec--;
			el.textContent = sec;
			if (sec <= 0) {
				clearInterval(t);
				// 창 닫기 시도 (팝업/탭 공통 대응)
				window.close();
				// 창 닫기가 안되는 경우 이전 페이지로 이동
				setTimeout(function() {
				   if (!window.closed) {
					   if (window.history.length > 1) {
						   window.history.back();
					   } else {
						   document.querySelector('.box').innerHTML = 
							'<h2>연결 확인</h2><p>이 창을 직접 닫아 주세요.</p>';
					   }
				   }
				}, 500);
			}
		}, 1000);
	</script>
</body>
</html>`);
});

//Setup the login page if we are using authentication
if(config.UseAuthentication){
	if(config.EnableWebserver) {
		app.get('/login', function(req, res){
			res.sendFile(path.join(__dirname, '/Public', '/login.html'));
		});
	}

	// create application/x-www-form-urlencoded parser
	var urlencodedParser = bodyParser.urlencoded({ extended: false })

	//login page form data is posted here
	app.post('/login', 
		urlencodedParser, 
		passport.authenticate('local', { failureRedirect: '/login' }), 
		function(req, res){
			//On success try to redirect to the page that they originally tired to get to, default to '/' if no redirect was found
			var redirectTo = req.session.redirectTo ? req.session.redirectTo : '/';
			delete req.session.redirectTo;
			console.log(`Redirecting to: '${redirectTo}'`);
			res.redirect(redirectTo);
		}
	);
}

if(config.EnableWebserver) {
	//Setup folders
	app.use(express.static(path.join(__dirname, '/Public')))
	app.use('/images', express.static(path.join(__dirname, './images')))
	app.use('/scripts', [isAuthenticated('/login'),express.static(path.join(__dirname, '/scripts'))]);
	app.use('/', [isAuthenticated('/login'), express.static(path.join(__dirname, '/custom_html'))])
}

try {
	for (var property in config.AdditionalRoutes) {
		if (config.AdditionalRoutes.hasOwnProperty(property)) {
			console.log(`Adding additional routes "${property}" -> "${config.AdditionalRoutes[property]}"`)
			app.use(property, [isAuthenticated('/login'), express.static(path.join(__dirname, config.AdditionalRoutes[property]))]);
		}
	}
} catch (err) {
	console.error(`reading config.AdditionalRoutes: ${err}`)
}

if(config.EnableWebserver) {

	// Request has been sent to site root, send the homepage file
	app.get('/', isAuthenticated('/login'), function (req, res) {
		homepageFile = (typeof config.HomepageFile != 'undefined' && config.HomepageFile != '') ? config.HomepageFile.toString() : defaultConfig.HomepageFile;
		
		let pathsToTry = [ path.join(__dirname, homepageFile), path.join(__dirname, '/Public', homepageFile), path.join(__dirname, '/custom_html', homepageFile), homepageFile ];

		// Try a few paths, see if any resolve to a homepage file the user has set
		for(let pathToTry of pathsToTry){
			if(fs.existsSync(pathToTry)){
				// Send the file for browser to display it
				res.sendFile(pathToTry);
				return;
			}
		}

		// Catch file doesn't exist, and send back 404 if not
		console.error('Unable to locate file ' + homepageFile)
		res.status(404).send('Unable to locate file ' + homepageFile);
		return;
	});
}

if (config.HttpMode === 'web') {
	app.use((req, res) => res.status(404).json({ error: 'not_found' }));
}

//Setup http and https servers
http.listen(httpPort, function () {
	console.logColor(logging.Green, 'Http listening on *: ' + httpPort);
});

if (config.UseHTTPS) {
	https.listen(httpsPort, function () {
		console.logColor(logging.Green, 'Https listening on *: ' + httpsPort);
	});
}

console.logColor(logging.Cyan, `Running Cirrus - The Pixel Streaming reference implementation signalling server for Unreal Engine 5.3.`);

let nextPlayerId = 1;

const StreamerType = { Regular: 0, SFU: 1 };

class Streamer {
	constructor(initialId, ws, type) {
		this.id = initialId;
		this.ws = ws;
		this.type = type;
		this.idCommitted = false;
	}

	// registers this streamers id
	commitId(id) {
		this.id = id;
		this.idCommitted = true;
	}

	// returns true if we have a valid id
	isIdCommitted() {
		return this.idCommitted;
	}

	// links this streamer to a subscribed SFU player (player component of an SFU)
	addSFUPlayer(sfuPlayerId) {
		if (!!this.SFUPlayerId && this.SFUPlayerId != sfuPlayerId) {
			console.error(`Streamer ${this.id} already has an SFU ${this.SFUPlayerId}. Trying to add ${sfuPlayerId} as SFU.`);
			return;
		}
		this.SFUPlayerId = sfuPlayerId;
	}

	// removes the previously subscribed SFU player
	removeSFUPlayer() {
		delete this.SFUPlayerId;
	}

	// gets the player id of the subscribed SFU if any
	getSFUPlayerId() {
		return this.SFUPlayerId;
	}

	// returns true if this streamer is forwarding another streamer
	isSFU() {
		return this.type == StreamerType.SFU;
	}

	// links this streamer to a player, used for SFU connections since they have both components
	setSFUPlayerComponent(playerComponent) {
		if (!this.isSFU()) {
			console.error(`Trying to add an SFU player component ${playerComponent.id} to streamer ${this.id} but it is not an SFU type.`);
			return;
		}
		this.sfuPlayerComponent = playerComponent;
	}

	// gets the player component for this sfu
	getSFUPlayerComponent() {
		if (!this.isSFU()) {
			console.error(`Trying to get an SFU player component from streamer ${this.id} but it is not an SFU type.`);
			return null;
		}
		return this.sfuPlayerComponent;
	}
}

const PlayerType = { Regular: 0, SFU: 1 };
const WhoSendsOffer = { Streamer: 0, Browser: 1 };

class Player {
	constructor(id, ws, type, whoSendsOffer) {
		this.id = id;
		this.ws = ws;
		this.type = type;
		this.whoSendsOffer = whoSendsOffer;
	}

	isSFU() {
		return this.type == PlayerType.SFU;
	}

	subscribe(streamerId) {
		if (!streamers.has(streamerId)) {
			console.error(`subscribe: Player ${this.id} tried to subscribe to a non-existent streamer ${streamerId}`);
			return;
		}
		if (this.streamerId === streamerId) return;
		if (this.streamerId) this.unsubscribe();
		this.streamerId = streamerId;
		if (this.type == PlayerType.SFU) {
			let streamer = streamers.get(this.streamerId);
			streamer.addSFUPlayer(this.id);
		}
		const msg = { type: 'playerConnected', playerId: this.id, dataChannel: true, sfu: this.type == PlayerType.SFU, sendOffer: this.whoSendsOffer == WhoSendsOffer.Streamer };
		logOutgoing(this.streamerId, msg);
		this.sendFrom(msg);
		
		// 이 줄 추가 (SFU 제외)
		if (this.type !== PlayerType.SFU && this.whoSendsOffer === WhoSendsOffer.Streamer) {
			startOfferWaitTimer(this.id, this.streamerId);
		}
	}

	unsubscribe() {
		delete this.negotiatedStreamer;
		clearOfferWaitTimer(this.id);
		if (this.streamerId && streamers.has(this.streamerId)) {
			if (this.type == PlayerType.SFU) {
				let streamer = streamers.get(this.streamerId);
				if (streamer.getSFUPlayerId() != this.id) {
					console.error(`Trying to unsibscribe SFU player ${this.id} from streamer ${streamer.id} but the current SFUId does not match (${streamer.getSFUPlayerId()}).`)
				} else {
					streamer.removeSFUPlayer();
				}
			}
			const msg = { type: 'playerDisconnected', playerId: this.id };
			logOutgoing(this.streamerId, msg);
			this.sendFrom(msg);
		}
		this.streamerId = null;
	}

	sendFrom(message) {
		if (!this.streamerId) {
			if(streamers.size > 0) {
				this.streamerId = streamers.entries().next().value[0];
				console.logColor(logging.Orange, `Player ${this.id} attempted to send an outgoing message without having subscribed first. Defaulting to ${this.streamerId}`);
			} else {
				console.logColor(logging.Orange, `Player ${this.id} attempted to send an outgoing message without having subscribed first. No streamer connected so this message isn't going anywhere!`)
				return;
			}
		}

		// normally we want to indicate what player this message came from
		// but in some instances we might already have set this (streamerDataChannels) due to poor choices
		if (!message.playerId) {
			message.playerId = this.id;
		}
		const msgString = JSON.stringify(message);

		let streamer = streamers.get(this.streamerId);
		if (!streamer) {
			console.error(`sendFrom: Player ${this.id} subscribed to non-existent streamer: ${this.streamerId}`);
		} else {
			streamer.ws.send(msgString);
		}
	}

	sendTo(message, callback) {
		const msgString = JSON.stringify(message);
		this.ws.send(msgString, callback);
	}

	setSFUStreamerComponent(streamerComponent) {
		if (!this.isSFU()) {
			console.error(`Trying to add an SFU streamer component ${streamerComponent.id} to player ${this.id} but it is not an SFU type.`);
			return;
		}
		this.sfuStreamerComponent = streamerComponent;
	}

	getSFUStreamerComponent() {
		if (!this.isSFU()) {
			console.error(`Trying to get an SFU streamer component from player ${this.id} but it is not an SFU type.`);
			return null;
		}
		return this.sfuStreamerComponent;
	}
};

let streamers = new Map();		// streamerId <-> streamer
let players = new Map(); 		// playerId <-> player/peer/viewer
const LegacyStreamerPrefix = "__LEGACY_STREAMER__"; // old streamers that dont know how to ID will be assigned this id prefix.
const LegacySFUPrefix = "__LEGACY_SFU__"; 					// same as streamer version but for SFUs
const streamerIdTimeoutSecs = 5;

// gets the SFU subscribed to this streamer if any.
function getSFUForStreamer(streamerId) {
	if (!streamers.has(streamerId)) {
		return null;
	}
	const streamer = streamers.get(streamerId);
	const sfuPlayerId = streamer.getSFUPlayerId();
	if (!sfuPlayerId) {
		return null;
	}
	return players.get(sfuPlayerId);
}

function logIncoming(sourceName, msg) {
	if (config.LogVerbose)
		console.logColor(logging.Blue, "\x1b[37m%s ->\x1b[34m %s", sourceName, JSON.stringify(logRedactor.redact(msg)));
	else
		console.logColor(logging.Blue, "\x1b[37m%s ->\x1b[34m %s", sourceName, msg.type);
}

function logOutgoing(destName, msg) {
	if (config.LogVerbose)
		console.logColor(logging.Green, "\x1b[37m%s <-\x1b[32m %s", destName, JSON.stringify(logRedactor.redact(msg)));
	else
		console.logColor(logging.Green, "\x1b[37m%s <-\x1b[32m %s", destName, msg.type);
}

function logForward(srcName, destName, msg) {
	if (config.LogVerbose)
		console.logColor(logging.Cyan, "\x1b[37m%s -> %s\x1b[36m %s", srcName, destName, JSON.stringify(logRedactor.redact(msg)));
	else
		console.logColor(logging.Cyan, "\x1b[37m%s -> %s\x1b[36m %s", srcName, destName, msg.type);
}

let WebSocket = require('ws');

let sfuMessageHandlers = new Map();
let playerMessageHandlers = new Map();

function invokeMessageHandler(handler, peer, message, ws, preserveStreamer = false) {
	const failed = err => {
		console.error('[SIGNALLING] Message handler failed: ' + (err?.stack || err));
		if (!preserveStreamer && ws.readyState === WebSocket.OPEN) ws.close(1011, 'Message handler failed');
	};
	try {
		const result = handler(peer, message);
		if (result && typeof result.catch === 'function') result.catch(failed);
	} catch (err) { failed(err); }
}

function sanitizePlayerId(playerId) {
	if (playerId && typeof playerId === 'number') {
		playerId = playerId.toString();
	}
	return playerId;
}

function getPlayerIdFromMessage(msg) {
	return sanitizePlayerId(msg.playerId);
}

let uniqueLegacyStreamerPostfix = 0;
function getUniqueLegacyStreamerId() {
	const finalId = LegacyStreamerPrefix + uniqueLegacyStreamerPostfix;
	++uniqueLegacyStreamerPostfix;
	return finalId;
}

let uniqueLegacySFUPostfix = 0;
function getUniqueLegacySFUId() {
	const finalId = LegacySFUPrefix + uniqueLegacySFUPostfix;
	++uniqueLegacySFUPostfix;
	return finalId;
}

function requestStreamerId(streamer) {
	// first we ask the streamer to id itself.
	// if it doesnt reply within a time limit we assume it's an older streamer
	// and assign it an id.

	// request id
	const msg = { type: "identify" };
	logOutgoing(streamer.id, msg);
	streamer.ws.send(JSON.stringify(msg));

	streamer.idTimer = setTimeout(function() {
		// streamer did not respond in time. give it a legacy id.
		const newLegacyId = streamer.isSFU() ? getUniqueLegacySFUId() : getUniqueLegacyStreamerId();
		if (newLegacyId.length == 0) {
			const error = `Ran out of legacy ids.`;
			console.error(error);
			streamer.ws.close(1008, error);
		} else {
			registerStreamer(newLegacyId, streamer);
		}

	}, streamerIdTimeoutSecs * 1000);
}

function sanitizeStreamerId(id) {
	// 직접 중복 확인 - 없으면 바로 사용
	if (!streamers.has(id)) {
		return id;
	}
	// 중복이 있으면 _2, _3 ... 순으로 유일한 ID 생성
	let counter = 2;
	while(streamers.has(id + '_' + counter)) {
		counter++;
	}
	const newId = id + '_' + counter;
	console.logColor(logging.Orange, `[STREAMER] ID 중복 감지: "${id}" → "${newId}" (이전 연결이 아직 정리 중)`);
	return newId;
}

function registerStreamer(id, streamer) {
	if (streamer.ws.readyState !== 1) {  // 1 = OPEN
		console.error(`[${new Date().toISOString()}] registerStreamer: WebSocket is not OPEN (state=${streamer.ws.readyState}), skipping registration for ${id}`);
		return;
	}
	
	if (streamers.get(id) === streamer) return; // Duplicate endpointId on the same socket.

	// 동일 ID 스트리머가 이미 있으면 기존 것을 종료하고 새 연결로 교체
	// (재시작 시 238-1_2 같은 중복 스트리머 생성 방지)
	if (streamers.has(id)) {
		const oldStreamer = streamers.get(id);
		console.logColor(logging.Orange, `[STREAMER] "${id}" 재연결 감지 → 기존 스트리머 종료 후 새 연결로 교체`);
		// 기존 스트리머에 연결된 플레이어들 해제 (재연결 유도)
		disconnectAllPlayers(id);
		streamers.delete(id);
		try { oldStreamer.ws.close(1000, 'replaced by new connection'); } catch (e) {}
	}
	
	streamer.commitId(id);
	if (!!streamer.idTimer) {
		clearTimeout(streamer.idTimer);
		delete streamer.idTimer;
	}
	streamers.set(id, streamer);
	if (!streamer.isSFU()) {
		if (appCommandInProgress !== STOP_CMD) appRunning = true;
		appStopPending = true;
		lastStreamerRegistrationTime = Date.now();
		lastStreamerPingTime = null; // Do not inherit the replaced connection's ping timestamp.
		startStreamerWatchdog();
		if (browserPlayerCount() === 0 && config.AppIdleTimeoutMs > 0 &&
			!stopRetryTimer && stopRetryStatus.state !== 'exhausted' &&
			appCommandInProgress !== STOP_CMD && !appCommandRunner.isBlocked() && !zombieRestartInProgress) {
			console.log('[APP] 브라우저 없이 3D 연결 → 유휴 타이머 시작');
			startIdleTimer(); // A standalone UE gets its full configured grace from registration.
		}
	}
	if (!streamer.isSFU()) appStartTime = null;  // Only the UE registration completes app startup.
	if (!streamer.isSFU()) appCommandRunner.noteRegistered();
	// 스트리머 등록 시 "스트리머 없음" 타이머 취소 (appRunning=false로 잘못 변경 방지)
	if (!streamer.isSFU() && streamerGoneTimerId) {
		clearTimeout(streamerGoneTimerId);
		streamerGoneTimerId = null;
		console.logColor(logging.Green, `[APP] 스트리머 등록 → 스트리머 없음 타이머 취소`);
	}
	console.logColor(logging.Green, `[${new Date().toISOString()}] Registered new streamer: ${streamer.id} | Total streamers: ${streamers.size}`);
	
	// 스트리머 등록 시 구독 안 된 대기 플레이어에게 streamerList 자동 push
	// (스트리머 없음으로 대기 중이던 플레이어가 자동으로 연결 시도할 수 있도록)
	const waitingPlayers = [...players.values()].filter(p => !p.streamerId && !p.isSFU());
	if (waitingPlayers.length > 0) {
		const ids = [...streamers.keys()];
		const listMsg = { type: 'streamerList', ids };
		waitingPlayers.forEach(p => {
			console.logColor(logging.Green, `[STREAMER] 대기 플레이어 ${p.id}에게 streamerList 자동 push: ${JSON.stringify(ids)}`);
			try { p.sendTo(listMsg); } catch (e) {}
		});
		
		// 단일 UE 재등록 뒤 클라이언트가 subscribe를 생략해도 모든 대기자를 복구한다.
		if (!streamer.isSFU() && streamers.size === 1) {
			const waitingStreamerId = streamer.id;
			waitingPlayers.forEach(waitingPlayer => {
				setTimeout(() => {
					const currentPlayer = players.get(waitingPlayer.id);
					if (currentPlayer === waitingPlayer && currentPlayer.ws.readyState === WebSocket.OPEN &&
						!currentPlayer.streamerId && streamers.size === 1 && streamers.get(waitingStreamerId) === streamer) {
						console.logColor(logging.Green,
							`[STREAMER] 대기 플레이어 ${waitingPlayer.id} 자동 subscribe → ${waitingStreamerId}`
						);
						currentPlayer.subscribe(waitingStreamerId);
					}
				}, 1000);
			});
		}
	}
}

function onStreamerDisconnected(streamer) {
	if (streamer.idTimer) { clearTimeout(streamer.idTimer); streamer.idTimer = null; }
	if (!streamer.id || !streamers.has(streamer.id)) {
		// 추가 이미 제거된 streamer 재호출 감지
		console.logColor(logging.Orange, `[${new Date().toISOString()}] onStreamerDisconnected called but streamer not found: ${streamer.id}]`);
		return;
	}
	
	// [핵심 수정] registerStreamer에서 기존 스트리머를 교체(ws.close)할 때
	// 비동기 close 이벤트가 발생하여 새로 등록된 스트리머를 잘못 삭제하는 race condition 방지
	// → Map에 등록된 스트리머와 close 이벤트를 발생시킨 streamer의 ws 인스턴스가 다르면 무시
	const currentRegistered = streamers.get(streamer.id);
	if (currentRegistered !== streamer) {
		console.logColor(logging.Orange, `[${new Date().toISOString()}] onStreamerDisconnected: ${streamer.id} - 이미 새 스트리머로 교체됨 → 무시 (race condition 방지)`);
		return;
	}

	// 추가
	console.logColor(logging.Red, `[${new Date().toISOString()}] Streamer DISCONNECTED: ${streamer.id} | Remaining Streamers: ${streamers.size - 1} | Connected players: ${players.size}`);
	
	sendStreamerDisconnectedToMatchmaker();
	let sfuPlayer = getSFUForStreamer(streamer.id);
	if (sfuPlayer) {
		const msg = { type: "streamerDisconnected" };
		logOutgoing(sfuPlayer.id, msg);
		sfuPlayer.sendTo(msg);
		disconnectAllPlayers(sfuPlayer.id);
	}
	disconnectAllPlayers(streamer.id);
	streamers.delete(streamer.id);
	
	// 스트리머가 끊기면 appRunning 상태 재동기화
	if (appStreamerCount() === 0) {
		if (streamerGoneTimerId) clearTimeout(streamerGoneTimerId);  // 기존 타이머 중복 방지
		streamerGoneTimerId = setTimeout(() => {
			streamerGoneTimerId = null;
			// A short UE reconnect must not release STOP exhaustion and re-arm idle shutdown.
			if (appStreamerCount() === 0) resetStopRetryStatus();
			if (appStreamerCount() === 0 && !zombieRestartInProgress && !appCommandInProgress) {  // 좀비 재시작 중이면 덮어쓰지 않음
				appRunning = false;
				appStartTime = null;  // 추가
				console.logColor(logging.Orange, `[APP] 스트리머 없음 → appRunning=false`);
				
				// [핵심 버그 수정] 스트리머 종료 5초 타이머 완료 시점에 대기 플레이어가 있으면 즉시 재시작
				// 시나리오: Watch_Streamers가 프로세스 종료 → 5초 내 플레이어 재접속 →
				// startApp()이 appRunning=true 로 스킵됨 → 5초 후 appRunning=false 전환 →
				// 하지만 아무도 startApp() 재호출 안 함 → 앱 영구 미기동 버그 수정
				if (hasBrowserDemand() && allowAppAutoStart('streamer-disconnect')) {
					console.logColor(logging.Yellow,
						`[APP] 스트리머 종료 후 대기 플레이어 ${players.size}명 감지 → 자동 재시작`
					);
					startApp();
				}
			}
		}, 5000);  // 5초 후 재확인
	}
}

function onStreamerMessageId(streamer, msg) {
	logIncoming(streamer.id, msg);

	let streamerId = msg.id;
	registerStreamer(streamerId, streamer);
}

function onStreamerMessagePing(streamer, msg) {
	logIncoming(streamer.id, msg);
	if (streamers.get(streamer.id) === streamer && !streamer.isSFU()) lastStreamerPingTime = Date.now();
	const pongMsg = JSON.stringify({ type: "pong", time: msg.time});
	streamer.ws.send(pongMsg);
}

function onStreamerMessageDisconnectPlayer(streamer, msg) {
	logIncoming(streamer.id, msg);

	const playerId = getPlayerIdFromMessage(msg);
	const player = players.get(playerId);
	if (player && canRouteToPlayer(streamer, player)) {
		player.ws.close(1011 /* internal error */, v3.closeReason(msg.reason));
	}
}

function canRouteToPlayer(streamer, player) {
	if (player.streamerId === streamer.id && streamers.get(streamer.id) === streamer) return true;
	console.warn('[SIGNALLING] Dropped streamer message outside current player subscription');
	return false;
}

function onStreamerMessageLayerPreference(streamer, msg) {
	let sfuPlayer = getSFUForStreamer(streamer.id);
	if (sfuPlayer) {
		logOutgoing(sfuPlayer.id, msg);
		sfuPlayer.sendTo(msg);
	}
}

function forwardStreamerMessageToPlayer(streamer, msg) {
	const playerId = getPlayerIdFromMessage(msg);
	const player = players.get(playerId);
	if (player && !canRouteToPlayer(streamer, player)) return;
	if (player) {
		const negotiation = !streamer.isSFU() && player.streamerId === streamer.id && streamers.get(streamer.id) === streamer &&
			((msg.type === 'offer' && player.whoSendsOffer === WhoSendsOffer.Streamer) ||
			 (msg.type === 'answer' && player.whoSendsOffer === WhoSendsOffer.Browser));
		delete msg.playerId;
		logForward(streamer.id, playerId, msg);
		player.sendTo(msg, negotiation ? error => {
			if (!error && players.get(playerId) === player && player.ws.readyState === WebSocket.OPEN &&
				player.streamerId === streamer.id && streamers.get(streamer.id) === streamer && streamer.ws.readyState === WebSocket.OPEN) {
				clearOfferWaitTimer(playerId);
				if (!player.isSFU()) player.negotiatedStreamer = streamer;
				resetStartRetryStatus();
			}
		} : undefined);
	} else {
		console.warn("No playerId specified, cannot forward message: %s", msg);
	}
}

let streamerMessageHandlers = new Map();
streamerMessageHandlers.set('endpointId', onStreamerMessageId);
streamerMessageHandlers.set('ping', onStreamerMessagePing);
streamerMessageHandlers.set('offer', forwardStreamerMessageToPlayer);
streamerMessageHandlers.set('answer', forwardStreamerMessageToPlayer);
streamerMessageHandlers.set('iceCandidate', forwardStreamerMessageToPlayer);
streamerMessageHandlers.set('disconnectPlayer', onStreamerMessageDisconnectPlayer);
streamerMessageHandlers.set('layerPreference', onStreamerMessageLayerPreference);

console.logColor(logging.Green, `WebSocket listening for Streamer connections on :${streamerPort}`)
// let streamerServer = new WebSocket.Server({ port: streamerPort, backlog: 1 });
let streamerServer = new WebSocket.Server({ port: streamerPort, maxPayload: config.MaxWebSocketPayloadBytes });
streamerServer.on('connection', function (ws, req) {
	console.logColor(logging.Green, `Streamer connected: ${req.connection.remoteAddress}`);
	sendStreamerConnectedToMatchmaker();

	const temporaryId = req.connection.remoteAddress;
	let streamer = new Streamer(temporaryId, ws, StreamerType.Regular);

	ws.on('message', (msgRaw) => {
		var msg;
		try {
			msg = JSON.parse(msgRaw);
			if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string' || !msg.type) throw new Error('Invalid message object');
		} catch(err) {
			console.error('Cannot parse Streamer message (payload omitted).');
			ws.close(1008, 'Cannot parse');
			return;
		}

		let handler = streamerMessageHandlers.get(msg.type);
		if (!handler || (typeof handler != 'function')) {
			if (config.LogVerbose) {
				console.logColor(logging.White, "\x1b[37m-> %s\x1b[34m: %s", streamer.id, msgRaw);
			}
			console.error('Unsupported Streamer message type (value omitted).');
			ws.close(1008, 'Unsupported message type');
			return;
		}
		invokeMessageHandler(handler, streamer, msg, ws, true);
	});
	
	ws.on('close', function(code, reason) {
		// 추가 - 종료 코드별 원인 해석
		const closeReasons = {
			1000: 'Normal closure',
			1001: 'Going away',
			1006: 'Abnormal closure (no close frame)',
			1008: 'Policy violation',
			1011: 'Internal server error',
			1013: 'Try again later'
		};
		const reasonStr = closeReasons[code] || 'Unknown';
		console.error(`[${new Date().toISOString()}] Streamer ${streamer.id} CLOSED | Code: ${code} (${reasonStr}) | Reason: ${reason} | uptime: ${process.uptime().toFixed(1)}s`);
		onStreamerDisconnected(streamer);
	});

	ws.on('error', function(error) {
		// 추가 - 에러 타입 상세 출력
		console.error(`[${new Date().toISOString()}] Streamer ${streamer.id} ERROR | Type: ${error.code || 'unknown'} | Message: ${error.message}`);
		// onStreamerDisconnected(streamer);
		// try {
		// 	ws.close(1006 /* abnormal closure */, error);
		// } catch(err) {
		// 	console.error(`ERROR: ws.on error: ${err.message}`);
		// }
	});

	ws.send(JSON.stringify(clientConfig));
	requestStreamerId(streamer);
});

function forwardSFUMessageToPlayer(sfuPlayer, msg) {
	const playerId = getPlayerIdFromMessage(msg);
	const player = players.get(playerId);
	if (player && canRouteToPlayer(sfuPlayer.getSFUStreamerComponent(), player)) {
		logForward(sfuPlayer.getSFUStreamerComponent().id, playerId, msg);
		const source = sfuPlayer.getSFUStreamerComponent();
		player.sendTo(msg, error => {
			if (!error && msg.type === 'offer' && !player.isSFU() && player.whoSendsOffer === WhoSendsOffer.Streamer &&
				players.get(playerId) === player && player.ws.readyState === WebSocket.OPEN &&
				player.streamerId === source.id && streamers.get(source.id) === source && source.ws.readyState === WebSocket.OPEN) {
				player.negotiatedStreamer = source;
				clearOfferWaitTimer(playerId);
			}
		});
	}
}

function forwardSFUMessageToStreamer(sfuPlayer, msg) {
	logForward(sfuPlayer.getSFUStreamerComponent().id, sfuPlayer.streamerId, msg);
	msg.sfuId = sfuPlayer.id;
	sfuPlayer.sendFrom(msg);
}

function onPeerDataChannelsSFUMessage(sfuPlayer, msg) {
	// sfu is telling a peer what stream id to use for a data channel
	const playerId = getPlayerIdFromMessage(msg);
	const player = players.get(playerId);
	if (player) {
		logForward(sfuPlayer.getSFUStreamerComponent().id, playerId, msg);
		player.sendTo(msg);
		player.datachannel = true;
	}
}

// basically a duplicate of the streamer id request but this one does not register the streamer
function requestSFUStreamerId(sfuPlayer) {
	// request id
	const msg = { type: "identify" };
	const sfuStreamerComponent = sfuPlayer.getSFUStreamerComponent();
	logOutgoing(sfuStreamerComponent.id, msg);
	sfuStreamerComponent.ws.send(JSON.stringify(msg));

	sfuStreamerComponent.idTimer = setTimeout(function() {
		// streamer did not respond in time. give it a legacy id.
		const newLegacyId = getUniqueLegacySFUId();
		if (newLegacyId.length == 0) {
			const error = `Ran out of legacy ids.`;
			console.error(error);
			sfuPlayer.ws.close(1008, error);
		} else {
			sfuStreamerComponent.id = newLegacyId;
		}
	}, streamerIdTimeoutSecs * 1000);
}

function onSFUMessageId(sfuPlayer, msg) {
	const sfuStreamerComponent = sfuPlayer.getSFUStreamerComponent();
	logIncoming(sfuStreamerComponent.id, msg);
	sfuStreamerComponent.id = msg.id;

	if (!!sfuStreamerComponent.idTimer) {
		clearTimeout(sfuStreamerComponent.idTimer);
		delete sfuStreamerComponent.idTimer;
	}
}

function onSFUMessageStartStreaming(sfuPlayer, msg) {
	const sfuStreamerComponent = sfuPlayer.getSFUStreamerComponent();
	logIncoming(sfuStreamerComponent.id, msg);
	if (streamers.has(sfuStreamerComponent.id)) {
		console.error(`SFU ${sfuStreamerComponent.id} is already registered as a streamer and streaming.`)
		return;
	}

	registerStreamer(sfuStreamerComponent.id, sfuStreamerComponent);
	// SFU can publish media without a UE offer addressed to a browser. Use the
	// work-order fallback only while its subscribed, registered UE is open.
	const ue = streamers.get(sfuPlayer.streamerId);
	if (ue && !ue.isSFU() && ue.ws.readyState === WebSocket.OPEN) resetStartRetryStatus();
}

function onSFUMessageStopStreaming(sfuPlayer, msg) {
	const sfuStreamerComponent = sfuPlayer.getSFUStreamerComponent();
	logIncoming(sfuStreamerComponent.id, msg);
if (!streamers.has(sfuStreamerComponent.id)) {
		console.error(`SFU ${sfuStreamerComponent.id} is not registered as a streamer or streaming.`)
		return;
	}

	onStreamerDisconnected(sfuStreamerComponent);
}

function onSFUDisconnected(sfuPlayer) {
	console.log("disconnecting SFU from streamer");
	disconnectAllPlayers(sfuPlayer.id);
	onStreamerDisconnected(sfuPlayer.getSFUStreamerComponent());
	sfuPlayer.unsubscribe();
	sfuPlayer.ws.close(4000, "SFU Disconnected");
	players.delete(sfuPlayer.id);
	streamers.delete(sfuPlayer.id);
}

sfuMessageHandlers.set('listStreamers', onPlayerMessageListStreamers);
sfuMessageHandlers.set('subscribe', onPlayerMessageSubscribe);
sfuMessageHandlers.set('unsubscribe', onPlayerMessageUnsubscribe);
sfuMessageHandlers.set('offer', forwardSFUMessageToPlayer);
sfuMessageHandlers.set('answer', forwardSFUMessageToStreamer);
sfuMessageHandlers.set('streamerDataChannels', forwardSFUMessageToStreamer);
sfuMessageHandlers.set('peerDataChannels', onPeerDataChannelsSFUMessage);
sfuMessageHandlers.set('endpointId', onSFUMessageId);
sfuMessageHandlers.set('startStreaming', onSFUMessageStartStreaming);
sfuMessageHandlers.set('stopStreaming', onSFUMessageStopStreaming);

console.logColor(logging.Green, `WebSocket listening for SFU connections on :${sfuPort}`);
let sfuServer = new WebSocket.Server({ port: sfuPort, maxPayload: config.MaxWebSocketPayloadBytes });
sfuServer.on('connection', function (ws, req) {

	let playerId = sanitizePlayerId(nextPlayerId++);
	console.logColor(logging.Green, `SFU (${req.connection.remoteAddress}) connected `);

	let streamerComponent = new Streamer(req.connection.remoteAddress, ws, StreamerType.SFU);
	let playerComponent = new Player(playerId, ws, PlayerType.SFU, WhoSendsOffer.Streamer);

	streamerComponent.setSFUPlayerComponent(playerComponent);
	playerComponent.setSFUStreamerComponent(streamerComponent);

	players.set(playerId, playerComponent);

	ws.on('message', (msgRaw) => {
		var msg;
		try {
			msg = JSON.parse(msgRaw);
			if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string' || !msg.type) throw new Error('Invalid message object');
		} catch (err) {
			console.error('Cannot parse SFU message (payload omitted).');
			ws.close(1008, 'Cannot parse');
			return;
		}

		let sfuPlayer = players.get(playerId);
		if (!sfuPlayer) {
			console.error(`Received a message from an SFU not in the player list ${playerId}`);
			ws.close(1001, 'Broken');
			return;
		}

		let handler = sfuMessageHandlers.get(msg.type);
		if (!handler || (typeof handler != 'function')) {
			if (config.LogVerbose) {
				console.logColor(logging.White, "\x1b[37m-> %s\x1b[34m: %s", sfuPlayer.id, msgRaw);
			}
			console.error('Unsupported SFU message type (value omitted).');
			ws.close(1008, 'Unsupported message type');
			return;
		}
		invokeMessageHandler(handler, sfuPlayer, msg, ws);
	});

	ws.on('close', function(code, reason) {
		console.error(`SFU disconnected: ${code} - ${reason}`);
		onSFUDisconnected(playerComponent);
	});

	ws.on('error', function(error) {
		console.error(`SFU connection error: ${error}`);
		// onSFUDisconnected(playerComponent);
		// try {
		// 	ws.close(1006 /* abnormal closure */, error);
		// } catch(err) {
		// 	console.error(`ERROR: ws.on error: ${err.message}`);
		// }
	});

	requestStreamerId(playerComponent.getSFUStreamerComponent());
});

let playerCount = 0;

function sendPlayersCount() {
	const msg = { type: 'playerCount', count: players.size };
	logOutgoing("[players]", msg);
	for (let player of players.values()) {
		player.sendTo(msg);
	}
}

function onPlayerMessageSubscribe(player, msg) {
	logIncoming(player.id, msg);
	player.subscribe(msg.streamerId);
}

function onPlayerMessageUnsubscribe(player, msg) {
	logIncoming(player.id, msg);
	player.unsubscribe();
}

function onPlayerMessageStats(player, msg) {
	console.log(`player ${player.id}: stats\n${msg.data}`);
}

function onPlayerMessageListStreamers(player, msg) {
	logIncoming(player.id, msg);

	let reply = { type: 'streamerList', ids: [] };
	for (let [streamerId, streamer] of streamers) {
		reply.ids.push(streamerId);
	}

	// 스트리머가 없지만 앱 시작 중이면 로그로 상태 기록
	// (registerStreamer에서 스트리머 등록 시 대기 플레이어에게 자동 push 처리됨)
	if (reply.ids.length === 0 && appRunning) {
		console.logColor(logging.Yellow,
			`[WAIT] Player ${player.id} listStreamers 요청 but 스트리머 없음 (앱 시작 중...) → 등록 시 자동 push 예정`	
		);
	}
	
	logOutgoing(player.id, reply);
	player.sendTo(reply);
}

// Preserve the production v1 forwarding body; reject unsafe mDNS assumptions
// at the ICE dispatcher while retaining the original wire payload unchanged.
function forwardPlayerIceMessage(player, msg) {
	const candidate = msg.candidate?.candidate;
	const address = player.ws?._socket?.remoteAddress;
	if (typeof candidate !== 'string' || typeof address !== 'string' || !address) {
		logForward(player.id, player.streamerId, msg);
		player.sendFrom(msg);
		return;
	}
	forwardPlayerMessage(player, msg);
}

function forwardPlayerMessage(player, msg) {
	// mDNS(.local) ICE candidate 필터링
	// Chrome 등 최신 브라우저가 프라이버시 보호로 .local 주소를 보내는데
	// 리눅스 서버는 mDNS 해석 불가 → ICE 실패 → 검은 화면 원인
	if (msg.type === 'iceCandidate' && msg.candidate && msg.candidate.candidate) {
		if (msg.candidate.candidate.includes('.local')) {
			// 차단하지 말고 서버(브라우저 접속 IP)로 대체
			const clientIp = player.ws._socket.remoteAddress.replace('::ffff:', '');
			const replaced = msg.candidate.candidate.replace(/[\w-]+\.local/, clientIp);
			console.logColor(logging.Orange, `[mDNS 변환] player ${player.id} → ${replaced}`);
			msg.candidate.candidate = replaced;
			// 차단 없이 그대로 전달
		}
	}
	logForward(player.id, player.streamerId, msg);
	player.sendFrom(msg);
}

function onPlayerDisconnected(playerId) {
	clearOfferWaitTimer(playerId);  // 이 줄 추가
	const player = players.get(playerId);
	if (!player) return;  // 이 줄 추가
	player.unsubscribe();
	players.delete(playerId);
	--playerCount;
	sendPlayersCount();
	sendPlayerDisconnectedToFrontend();
	sendPlayerDisconnectedToMatchmaker();
	
	// 추가 - 아무도 없으면 유휴 타이머 시작
	if (browserPlayerCount() === 0) {
		startIdleTimer();
	}
}

playerMessageHandlers.set('subscribe', onPlayerMessageSubscribe);
playerMessageHandlers.set('unsubscribe', onPlayerMessageUnsubscribe);
playerMessageHandlers.set('stats', onPlayerMessageStats);
playerMessageHandlers.set('offer', forwardPlayerMessage);
playerMessageHandlers.set('answer', forwardPlayerMessage);
playerMessageHandlers.set('iceCandidate', forwardPlayerIceMessage);
playerMessageHandlers.set('listStreamers', onPlayerMessageListStreamers);
// sfu related messages
playerMessageHandlers.set('dataChannelRequest', forwardPlayerMessage);
playerMessageHandlers.set('peerDataChannelsReady', forwardPlayerMessage);

console.logColor(logging.Green, `WebSocket listening for Players connections on :${httpPort}`);
let playerServer = new WebSocket.Server({ server: config.UseHTTPS ? https : http, maxPayload: config.MaxWebSocketPayloadBytes });
playerServer.on('connection', function (ws, req) {
	let parsedUrl;
	try { parsedUrl = new URL(req.url, 'http://localhost'); }
	catch {
		console.warn('Invalid player request URL (value omitted).');
		ws.close(1008, 'Invalid request URL');
		return;
	}
	const urlParams = new URLSearchParams(parsedUrl.search);
	const whoSendsOffer = urlParams.has('OfferToReceive') && urlParams.get('OfferToReceive') !== 'false' ? WhoSendsOffer.Browser : WhoSendsOffer.Streamer;
	if (appCommandRunner.isBlocked()) {
		ws.close(1013, '3D launcher blocked; operator recovery required');
		return;
	}

	if (playerCount + 1 > maxPlayerCount && maxPlayerCount !== -1)
	{
		console.logColor(logging.Red, `new connection would exceed number of allowed concurrent connections. Max: ${maxPlayerCount}, Current ${playerCount}`);
		ws.close(1013, `too many connections. max: ${maxPlayerCount}, current: ${playerCount}`);
		return;
	}

	++playerCount;
	let playerId = sanitizePlayerId(nextPlayerId++);
	console.logColor(logging.Green, `player ${playerId} (${req.connection.remoteAddress}) connected`);
	let player = new Player(playerId, ws, PlayerType.Regular, whoSendsOffer);
	players.set(playerId, player);
	v3.monitorPlayerSocket(ws, config.PlayerKeepaliveTimeoutMs, { setInterval, clearInterval,
		onTimeout: () => console.warn(`[PLAYER] keepalive timeout: ${playerId}`) });

	// 추가 - 플레이어 접속 시 3D 앱 실행
	resetStopRetryStatus();
	resetIdleTimer();
	startApp();
	
	ws.on('message', (msgRaw) =>{
		var msg;
		try {
			msg = JSON.parse(msgRaw);
			if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.type !== 'string' || !msg.type) throw new Error('Invalid message object');
		} catch (err) {
			console.error(`Cannot parse player ${playerId} message (payload omitted).`);
			ws.close(1008, 'Cannot parse');
			return;
		}

		let player = players.get(playerId);
		if (!player) {
			console.error(`Received a message from a player not in the player list ${playerId}`);
			ws.close(1001, 'Broken');
			return;
		}

		let handler = playerMessageHandlers.get(msg.type);
		if (!handler || (typeof handler != 'function')) {
			if (config.LogVerbose) {
				console.logColor(logging.White, "\x1b[37m-> %s\x1b[34m: %s", playerId, msgRaw);
			}
			console.error('Unsupported player message type (value omitted).');
			ws.close(1008, 'Unsupported message type');
			return;
		}
		invokeMessageHandler(handler, player, msg, ws);
	});

	ws.on('close', function(code, reason) {
		console.logColor(logging.Yellow, `player ${playerId} connection closed: ${code} - ${reason}`);
		onPlayerDisconnected(playerId);
	});

	ws.on('error', function(error) {
		console.error(`player ${playerId} connection error: ${error}`);
		// ws.close(1006 /* abnormal closure */, error);
		// onPlayerDisconnected(playerId);

		// console.logColor(logging.Red, `Trying to reconnect...`);
		// reconnect();
	});

	sendPlayerConnectedToFrontend();
	sendPlayerConnectedToMatchmaker();
	player.ws.send(JSON.stringify(clientConfig));
	sendPlayersCount();
});

function disconnectAllPlayers(streamerId) {
	console.log(`unsubscribing all players on ${streamerId}`);
	let clone = new Map(players);
	for (let player of clone.values()) {
		 if (player.streamerId == streamerId) {
			clearOfferWaitTimer(player.id);
		 	// disconnect players but just unsubscribe the SFU
		 	const sfuPlayer = getSFUForStreamer(streamerId);
		 	if (sfuPlayer && player.id == sfuPlayer.id) {
				sfuPlayer.unsubscribe();
			} else {
				player.ws.close();
			}
		}
	}
}

/**
 * Function that handles the connection to the matchmaker.
 */

if (config.UseMatchmaker) {
	var matchmaker = new net.Socket();

	matchmaker.on('connect', function() {
		console.log(`Cirrus connected to Matchmaker ${matchmakerAddress}:${matchmakerPort}`);

		// message.playerConnected is a new variable sent from the SS to help track whether or not a player 
		// is already connected when a 'connect' message is sent (i.e., reconnect). This happens when the MM
		// and the SS get disconnected unexpectedly (was happening often at scale for some reason).
		var playerConnected = false;

		// Set the playerConnected flag to tell the MM if there is already a player active (i.e., don't send a new one here)
		if( players && players.size > 0) {
			playerConnected = true;
		}

		// Add the new playerConnected flag to the message body to the MM
		message = {
			type: 'connect',
			address: typeof serverPublicIp === 'undefined' ? '127.0.0.1' : serverPublicIp,
			port: config.UseHTTPS ? httpsPort : httpPort,
			ready: streamers.size > 0,
			playerConnected: playerConnected
		};

		matchmaker.write(JSON.stringify(message));
	});

	matchmaker.on('error', (err) => {
		console.log(`Matchmaker connection error ${JSON.stringify(err)}`);
	});

	matchmaker.on('end', () => {
		console.log('Matchmaker connection ended');
	});

	matchmaker.on('close', (hadError) => {
		console.logColor(logging.Blue, 'Setting Keep Alive to true');
        matchmaker.setKeepAlive(true, 60000); // Keeps it alive for 60 seconds
		
		console.log(`Matchmaker connection closed (hadError=${hadError})`);

		reconnect();
	});

	// Attempt to connect to the Matchmaker
	function connect() {
		matchmaker.connect(matchmakerPort, matchmakerAddress);
	}

	// Try to reconnect to the Matchmaker after a given period of time
	function reconnect() {
		console.log(`Try reconnect to Matchmaker in ${matchmakerRetryInterval} seconds`)
		setTimeout(function() {
			connect();
		}, matchmakerRetryInterval * 1000);
	}

	function registerMMKeepAlive() {
		setInterval(function() {
			message = {
				type: 'ping'
			};
			matchmaker.write(JSON.stringify(message));
		}, matchmakerKeepAliveInterval * 1000);
	}

	connect();
	registerMMKeepAlive();
}

//Keep trying to send gameSessionId in case the server isn't ready yet
function sendGameSessionData() {
	//If we are not using the frontend web server don't try and make requests to it
	if (!config.UseFrontend)
		return;
	webRequest.get(`${FRONTEND_WEBSERVER}/server/requestSessionId`,
		function (response, body) {
			if (response.statusCode === 200) {
				gameSessionId = body;
				console.log('SessionId: ' + gameSessionId);
			}
			else {
				console.error('Status code: ' + response.statusCode);
				console.error(body);
			}
		},
		function (err) {
			//Repeatedly try in cases where the connection timed out or never connected
			if (err.code === "ECONNRESET") {
				//timeout
				sendGameSessionData();
			} else if (err.code === 'ECONNREFUSED') {
				console.error('Frontend server not running, unable to setup game session');
			} else {
				console.error(err);
			}
		});
}

function sendUserSessionData(serverPort) {
	//If we are not using the frontend web server don't try and make requests to it
	if (!config.UseFrontend)
		return;
	webRequest.get(`${FRONTEND_WEBSERVER}/server/requestUserSessionId?gameSessionId=${encodeURIComponent(gameSessionId || '')}&serverPort=${encodeURIComponent(serverPort || '')}&appName=${encodeURIComponent(clientConfig.AppName || '')}&appDescription=${encodeURIComponent(clientConfig.AppDescription || '')}${(typeof serverPublicIp === 'undefined' ? '' : '&serverHost=' + encodeURIComponent(serverPublicIp))}`,
		function (response, body) {
			if (response.statusCode === 410) {
				sendUserSessionData(serverPort);
			} else if (response.statusCode === 200) {
				userSessionId = body;
				console.log('UserSessionId: ' + userSessionId);
			} else {
				console.error('Status code: ' + response.statusCode);
				console.error(body);
			}
		},
		function (err) {
			//Repeatedly try in cases where the connection timed out or never connected
			if (err.code === "ECONNRESET") {
				//timeout
				sendUserSessionData(serverPort);
			} else if (err.code === 'ECONNREFUSED') {
				console.error('Frontend server not running, unable to setup user session');
			} else {
				console.error(err);
			}
		});
}

function sendServerDisconnect() {
	//If we are not using the frontend web server don't try and make requests to it
	if (!config.UseFrontend)
		return;
	try {
		webRequest.get(`${FRONTEND_WEBSERVER}/server/serverDisconnected?gameSessionId=${encodeURIComponent(gameSessionId || '')}&appName=${encodeURIComponent(clientConfig.AppName || '')}`,
			function (response, body) {
				if (response.statusCode === 200) {
					console.log('serverDisconnected acknowledged by Frontend');
				} else {
					console.error('Status code: ' + response.statusCode);
					console.error(body);
				}
			},
			function (err) {
				//Repeatedly try in cases where the connection timed out or never connected
				if (err.code === "ECONNRESET") {
					//timeout
					sendServerDisconnect();
				} else if (err.code === 'ECONNREFUSED') {
					console.error('Frontend server not running, unable to setup user session');
				} else {
					console.error(err);
				}
			});
	} catch(err) {
		console.logColor(logging.Red, `ERROR::: sendServerDisconnect error: ${err.message}`);
	}
}

function sendPlayerConnectedToFrontend() {
	//If we are not using the frontend web server don't try and make requests to it
	if (!config.UseFrontend)
		return;
	try {
		webRequest.get(`${FRONTEND_WEBSERVER}/server/clientConnected?gameSessionId=${encodeURIComponent(gameSessionId || '')}&appName=${encodeURIComponent(clientConfig.AppName || '')}`,
			function (response, body) {
				if (response.statusCode === 200) {
					console.log('clientConnected acknowledged by Frontend');
				} else {
					console.error('Status code: ' + response.statusCode);
					console.error(body);
				}
			},
			function (err) {
				//Repeatedly try in cases where the connection timed out or never connected
				if (err.code === "ECONNRESET") {
					//timeout
					sendPlayerConnectedToFrontend();
				} else if (err.code === 'ECONNREFUSED') {
					console.error('Frontend server not running, unable to setup game session');
				} else {
					console.error(err);
				}
			});
	} catch(err) {
		console.logColor(logging.Red, `ERROR::: sendPlayerConnectedToFrontend error: ${err.message}`);
	}
}

function sendPlayerDisconnectedToFrontend() {
	//If we are not using the frontend web server don't try and make requests to it
	if (!config.UseFrontend)
		return;
	try {
		webRequest.get(`${FRONTEND_WEBSERVER}/server/clientDisconnected?gameSessionId=${encodeURIComponent(gameSessionId || '')}&appName=${encodeURIComponent(clientConfig.AppName || '')}`,
			function (response, body) {
				if (response.statusCode === 200) {
					console.log('clientDisconnected acknowledged by Frontend');
				}
				else {
					console.error('Status code: ' + response.statusCode);
					console.error(body);
				}
			},
			function (err) {
				//Repeatedly try in cases where the connection timed out or never connected
				if (err.code === "ECONNRESET") {
					//timeout
					sendPlayerDisconnectedToFrontend();
				} else if (err.code === 'ECONNREFUSED') {
					console.error('Frontend server not running, unable to setup game session');
				} else {
					console.error(err);
				}
			});
	} catch(err) {
		console.logColor(logging.Red, `ERROR::: sendPlayerDisconnectedToFrontend error: ${err.message}`);
	}
}

function sendStreamerConnectedToMatchmaker() {
	if (!config.UseMatchmaker)
		return;
	try {
		message = {
			type: 'streamerConnected'
		};
		matchmaker.write(JSON.stringify(message));
	} catch (err) {
		console.logColor(logging.Red, `ERROR sending streamerConnected: ${err.message}`);
	}
}

function sendStreamerDisconnectedToMatchmaker() {
	if (!config.UseMatchmaker)
		return;
	try {
		message = {
			type: 'streamerDisconnected'
		};
		matchmaker.write(JSON.stringify(message));	
	} catch (err) {
		console.logColor(logging.Red, `ERROR sending streamerDisconnected: ${err.message}`);
	}
}

// The Matchmaker will not re-direct clients to this Cirrus server if any client
// is connected.
function sendPlayerConnectedToMatchmaker() {
	if (!config.UseMatchmaker)
		return;
	try {
		message = {
			type: 'clientConnected'
		};
		matchmaker.write(JSON.stringify(message));
	} catch (err) {
		console.logColor(logging.Red, `ERROR sending clientConnected: ${err.message}`);
	}
}

// The Matchmaker is interested when nobody is connected to a Cirrus server
// because then it can re-direct clients to this re-cycled Cirrus server.
function sendPlayerDisconnectedToMatchmaker() {
	if (!config.UseMatchmaker)
		return;
	try {
		message = {
			type: 'clientDisconnected'
		};
		matchmaker.write(JSON.stringify(message));
	} catch (err) {
		console.logColor(logging.Red, `ERROR sending clientDisconnected: ${err.message}`);
	}
}

setInterval(() => {
	const uptimeSec = Math.floor(process.uptime());
	const h = Math.floor(uptimeSec / 3600);
	const m = Math.floor((uptimeSec % 3600) / 60);
	const s = uptimeSec % 60;
	const uptimeStr = `${h}h ${m}m ${s}s`;
	
	// 유휴 타이머 경과 시간 계산
	let idleStr = '-';
	if (config.AppIdleTimeoutMs === 0) {
		idleStr = '자동 종료 꺼짐';
	} else if (browserPlayerCount() > 0) {
		idleStr = '접속 중 (타이머 없음)';
	} else if (stopRetryTimer) {
		idleStr = `종료 재시도 중 (스트리머 ${streamers.size}개 남음)`;		
	} else if (idleTimerStartTime) {
		const idleElapsedSec = Math.floor((Date.now() - idleTimerStartTime) / 1000);
		const idleLimitSec = Math.floor(config.AppIdleTimeoutMs / 1000);
		const remainSec = Math.max(0, idleLimitSec - idleElapsedSec);
		const em = Math.floor(idleElapsedSec / 60);
		const es = idleElapsedSec % 60;
		const rm = Math.floor(remainSec / 60);
		const rs = remainSec % 60;
		idleStr = `${em}m ${es}s 경과 / 남은 시간 ${rm}m ${rs}s`;
	} else if (!appRunning) {
		idleStr = '앱 꺼짐';
	}
	
	console.logColor(logging.Cyan,
		`[${new Date().toISOString()}] HEARTBEAT | Streamers: ${streamers.size} | Players: ${players.size} | Browsers: ${browserPlayerCount()} | UE ping: ${getStreamerHealth().state} | Uptime: ${uptimeStr} | 모드: ${lifecycleModeLabel()} | 유휴: ${idleStr}`
	);
	if (stopRetryStatus.state === 'exhausted') {
		console.warn(`[HEARTBEAT] STOP retries exhausted (${stopRetryStatus.attempts}); operator inspection required`);
	}
	if (startRetryStatus.state === 'exhausted') {
		console.warn(`[HEARTBEAT] START budget exhausted (${startRetryStatus.attempts}); next slow retry: ${startRetryStatus.nextRetryAt || 'disabled'}`);
	}
	if (streamers.size > 0) {
		for (let [id, streamer] of streamers) {
			console.logColor(logging.Cyan, `- Streamer: ${id} | wsState: ${streamer.ws.readyState} (1=OPEN, 3=CLOSED)`);
		}
	} else {
		console.logColor(logging.Orange, `No streamers connected!`);	
	}
}, 30000);

startIdleTimer();

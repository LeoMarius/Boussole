/* ===========================
   CONFIG / CONSTANTS
   =========================== */
const CONFIG = {
	alignmentToleranceDeg: 5,   // tolérance d'alignement en degrés (+/-)
	groupSpacingDeg: 3,        // espacement min entre lignes dans un groupe (deg)
	maxDisplayDistanceKm: 200, // distance max affichée (pour échelle)
	lineMaxLengthPx: 260,      // longueur max pour une ligne (px)
	canvasSize: 720,           // taille de canvas (css responsive will scale)
	updateIntervalMs: 60,      // fréquence de redraw
	audioFadeMs: 150,          // fondu audio à l'arrêt (ms)
	debug: false               // true pour logs
};

/* ===========================
   APPLICATION STATE
   =========================== */
const state = {
	userPos: null,        // {lat, lon}
	heading: null,        // cap actuel en degrés (0 = Nord)
	beffrois: [],         // liste provenant du JSON (avec calculs)
	activeGroup: null,    // groupe alignée
	audioPlaying: null,   // référence de lecture active
	permissionDenied: false,
	lastRender: 0
};

/* ===========================
   UTILITAIRES GÉO + MATH
   =========================== */

/**
 * Convertir degrés -> radians
 */
function deg2rad(d){ return d * Math.PI / 180; }
function rad2deg(r){ return r * 180 / Math.PI; }

/**
 * Haversine distance en km
 */
function distanceKm(lat1, lon1, lat2, lon2){
	const R = 6371;
	const dLat = deg2rad(lat2 - lat1);
	const dLon = deg2rad(lon2 - lon1);
	const a = Math.sin(dLat/2)**2 + Math.cos(deg2rad(lat1))*Math.cos(deg2rad(lat2))*Math.sin(dLon/2)**2;
	const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
	return R * c;
}

/**
 * Bearing (azimut) de point A vers B en degrés (0 = Nord, 90 = Est)
 * Formule standard.
 */
function bearingDeg(lat1, lon1, lat2, lon2){
	const φ1 = deg2rad(lat1);
	const φ2 = deg2rad(lat2);
	const λ1 = deg2rad(lon1);
	const λ2 = deg2rad(lon2);
	const y = Math.sin(λ2-λ1) * Math.cos(φ2);
	const x = Math.cos(φ1)*Math.sin(φ2) - Math.sin(φ1)*Math.cos(φ2)*Math.cos(λ2-λ1);
	let θ = Math.atan2(y, x);
	θ = rad2deg(θ);
	// Convertir en bearing depuis le Nord
	return (θ + 360) % 360;
}

/**
 * Normaliser angle pour être dans -180 .. +180
 */
function normalizeAngleDiff(a){
	let x = ((a + 180) % 360) - 180;
	if (x < -180) x += 360;
	return x;
}

/* ===========================
   PERMISSIONS / CAPTEURS
   =========================== */

const overlay = document.getElementById('overlay');
const deniedEl = document.getElementById('denied');
const appEl = document.getElementById('app');

document.getElementById('btn-request').addEventListener('click', requestPermissions);
document.getElementById('btn-retry').addEventListener('click', requestPermissions);

/**
 * Demande permissions : géoloc + orientation (iOS nécessite requestPermission)
 * Si OK on cache l'overlay et on démarre la logique.
 */
async function requestPermissions() {
	try {
		// 1. Demande GPS
		const geoResult = await new Promise((resolve, reject) => {
			if (!('geolocation' in navigator))
				return reject(new Error('Geolocation non supportée'));
			navigator.geolocation.getCurrentPosition(
				pos => resolve(pos),
				err => reject(err),
				{ enableHighAccuracy: true, maximumAge: 10000, timeout: 10000 }
			);
		});
		state.userPos = { lat: geoResult.coords.latitude, lon: geoResult.coords.longitude };

		// 2. Gestion orientation : iOS ou Android
		if (
			typeof DeviceOrientationEvent !== 'undefined' &&
			typeof DeviceOrientationEvent.requestPermission === 'function'
		) {
			// --- iOS ---
			const response = await DeviceOrientationEvent.requestPermission();
			if (response !== 'granted')
				throw new Error('Permission orientation refusée sur iOS');
			startOrientationListener(); // OK, on peut écouter maintenant
		} else {
			// --- Android ou desktop ---
			// Chrome, Firefox, etc. n’ont pas besoin de permission explicite
			startOrientationListener();
		}

		// 3. Watch position csontinue
		startGeolocationWatch();

		// 4. UI
		overlay.classList.add('hidden');
		deniedEl.classList.add('hidden');
		appEl.classList.remove('hidden');

		loadBeffroiData();

	} catch (err) {
		console.error('Permission error:', err);
		state.permissionDenied = true;
		overlay.classList.add('hidden');
		deniedEl.classList.remove('hidden');
	}
}

/* ===========================
   GEOLOCATION WATCH
   =========================== */

let geoWatchId = null;
function startGeolocationWatch(){
	if (!('geolocation' in navigator)) return;
	if (geoWatchId !== null) navigator.geolocation.clearWatch(geoWatchId);
	geoWatchId = navigator.geolocation.watchPosition(pos => {
		state.userPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
		updateBeffroisComputed();
        if (state.lastRender === 0) drawRadar();
	}, err => {
		console.warn('watchPosition error', err);
	}, {enableHighAccuracy:true, maximumAge:5000, timeout:10000});
}

/* ===========================
   ORIENTATION LISTENER
   =========================== */

function startOrientationListener(){
	if ('ondeviceorientationabsolute' in window) {
		window.addEventListener('deviceorientationabsolute', onDeviceOrientation, true);
	} else {
		window.addEventListener('deviceorientation', onDeviceOrientation, true);
	}
}

function onDeviceOrientation(e){
	// Some devices (iOS) provide webkitCompassHeading
	let heading = null;
	if (e.webkitCompassHeading !== undefined && e.webkitCompassHeading !== null) {
		// iOS: webkitCompassHeading (0..360) where 0 = North
		heading = e.webkitCompassHeading;
	} else if (e.absolute === true && e.alpha !== null) {
		// Many Android browsers: alpha gives compass heading but might need conversion
		// Many implementations use: heading = 360 - alpha
		heading = (360 - e.alpha) % 360;
	} else if (e.alpha !== null) {
		// Fallback: try alpha
		heading = (360 - e.alpha) % 360;
	}
	if (heading !== null) {
		state.heading = (heading + 360) % 360;
		document.getElementById('heading').textContent = Math.round(state.heading) + '°';
	}
}

/* ===========================
   CHARGEMENT DES BEFFROIS
   =========================== */

function loadBeffroiData(){
	// Exemple: on lit le script JSON embarqué
	const dataEl = document.getElementById('beffroi-data');
	let data = {};
	try {
		data = JSON.parse(dataEl.textContent);
	} catch (err) {
		console.error('Erreur parse JSON beffrois', err);
	}
	// Normaliser structure et calculer distances/bearings
	state.beffrois = (data.beffroi || []).map((b, idx) => ({
		id: idx,
		titre: b.titre || `Beffroi ${idx+1}`,
		path: b.path || null,
		source: b.source || null,
		lat: Number(b.localisation.latitude || b.localisation.lat || 0),
		lon: Number(b.localisation.longiture || b.localisation.lon || b.localisation.long || 0),
		_distanceKm: null,
		_bearing: null
	}));
	updateBeffroisComputed();
}

/**
 * Mettre à jour distances et bearings depuis la position utilisateur
 */
function updateBeffroisComputed() {
	if (!state.userPos) return;
	for (const b of state.beffrois) {
		b.distance = haversine(state.userPos.lat, state.userPos.lon, b.localisation.latitude, b.localisation.longiture);
		b.bearing = bearing(state.userPos.lat, state.userPos.lon, b.localisation.latitude, b.localisation.longiture);
	}
}

/* ===========================
   GROUPEMENT D'ANGLES / LAYOUT
   =========================== */

/**
 * Regroupe les beffrois proches en angle (groupSpacingDeg)
 * Puis, pour chaque groupe contenant plusieurs éléments,
 * répartit les lignes autour de l'angle central avec un écart minimal.
 *
 * Retourne une liste d'objets :
 * { groupAngle, members: [{beffroi, displayAngle}] }
 */
function groupBeffroisByAngle(relAngles){
	// relAngles: array of {beffroi, relAngle} where relAngle is -180..180 (0 = front)
	const groups = [];
	const spacing = CONFIG.groupSpacingDeg;

	// Simple greedy clustering: sort by angle, then cluster if distance <= spacing
	const sorted = relAngles.slice().sort((a,b)=>a.relAngle - b.relAngle);

	for (let item of sorted){
		let placed = false;
		for (let g of groups){
			// compute circular difference to group's center
			const diff = normalizeAngleDiff(item.relAngle - g.center);
			if (Math.abs(diff) <= spacing){
				g.items.push(item);
				// recompute center (mean angle handling wrap)
				const angles = g.items.map(x => x.relAngle);
				g.center = meanAngleDeg(angles);
				placed = true;
				break;
			}
		}
		if (!placed){
			groups.push({ center: item.relAngle, items: [item] });
		}
	}

	// For each group with multiple items, compute display offsets to avoid overlap
	const result = groups.map(g => {
		const count = g.items.length;
		if (count === 1){
			return {
				groupAngle: g.center,
				members: [{ beffroi: g.items[0].beffroi, displayAngle: g.items[0].relAngle }]
			};
		} else {
			// spread around group's center with minimum spacing
			const totalSpan = (count - 1) * spacing;
			const base = g.center - totalSpan/2;
			const members = g.items.map((it, i) => {
				const displayAngle = base + i*spacing;
				return { beffroi: it.beffroi, displayAngle };
			});
			return { groupAngle: g.center, members };
		}
	});

	return result;
}

/**
 * Moyenne d'un ensemble d'angles (en degrés) en traitant le wrap-around
 */
function meanAngleDeg(angles){
	// convertir en vecteurs unitaires
	let x=0,y=0;
	for (let a of angles){
		const r = deg2rad(a);
		x += Math.cos(r);
		y += Math.sin(r);
	}
	const ang = Math.atan2(y,x); // -PI..PI
	return (rad2deg(ang) + 360) % 360;
}

/* ===========================
   RENDU CANVAS / UI
   =========================== */

const canvas = document.getElementById('radar');
const ctx = canvas.getContext('2d');
resizeCanvas();
window.addEventListener('resize', resizeCanvas);

let lastDraw = 0;

// Main render loop
function renderLoop(timestamp){
	if (!state.userPos || state.heading === null) {
		// still waiting for sensors
		requestAnimationFrame(renderLoop);
		return;
	}
	if (timestamp - state.lastRender >= CONFIG.updateIntervalMs) {
		drawRadar();
		state.lastRender = timestamp;
	}
	requestAnimationFrame(renderLoop);
}

requestAnimationFrame(renderLoop);

function resizeCanvas(){
	const rect = canvas.getBoundingClientRect();
	canvas.width = Math.min(CONFIG.canvasSize, Math.round(rect.width * devicePixelRatio));
	canvas.height = Math.min(CONFIG.canvasSize, Math.round(rect.height * devicePixelRatio));
	// scale for crispness
	ctx.setTransform(1,0,0,1,0,0);
	ctx.scale(devicePixelRatio, devicePixelRatio);
}

/**
 * Dessine le radar, les lignes, distances, etc.
 */
function drawRadar(){
	const w = canvas.clientWidth;
	const h = canvas.clientHeight;
	const cx = w/2;
	const cy = h/2;
	const maxLen = Math.min(CONFIG.lineMaxLengthPx, Math.min(w,h)/2 - 20);

	// clear
	ctx.clearRect(0,0,w,h);
	ctx.save();

	// background
	ctx.fillStyle = '#fff';
	ctx.fillRect(0,0,w,h);

	// draw N/S/E/W faint lines
	ctx.strokeStyle = '#eee';
	ctx.lineWidth = 1;
	ctx.beginPath();
	// vertical center
	ctx.moveTo(cx, 0); ctx.lineTo(cx, h);
	// horizontal center
	ctx.moveTo(0, cy); ctx.lineTo(w, cy);
	ctx.stroke();

	// draw green reference line (device "forward" = up direction)
	ctx.save();
	ctx.strokeStyle = '#19a75b';
	ctx.lineWidth = 3;
	ctx.beginPath();
	ctx.moveTo(cx, cy);
	ctx.lineTo(cx, 10); // up from center
	ctx.stroke();
	ctx.restore();

	// prepare relative angles for each beffroi => relative to device heading
	const relAngles = [];
	for (let b of state.beffrois){
		if (b._distanceKm === null || b._bearing === null) continue;
		// relativeAngle = bearing - heading; then convert to -180..180
		let rel = normalizeAngleDiff(b._bearing - state.heading);
		relAngles.push({ beffroi: b, relAngle: rel });
	}

	// Group and compute display angles (in degrees where 0 = forward/up, positive = clockwise to right)
	const groups = groupBeffroisByAngle(relAngles);

	// Draw each group's members
	let activeGroup = null;
	for (let g of groups){
		for (let m of g.members){
			const b = m.beffroi;
			const angleDeg = m.displayAngle; // -180..180
			const rad = deg2rad(angleDeg);
			// compute length scaled by distance (closer = longer)
			let distKm = b._distanceKm;
			let len = maxLen;
			// optionally scale by inverse of distance (caps)
			if (distKm > 0){
				const ratio = Math.max(0.05, 1 - Math.min(distKm, CONFIG.maxDisplayDistanceKm) / CONFIG.maxDisplayDistanceKm);
				len = Math.max(40, maxLen * ratio);
			}

			// compute end point
			// Canvas coords: angle 0 = up; positive clockwise: x = sin, y = -cos
			const ex = cx + Math.sin(rad) * len;
			const ey = cy - Math.cos(rad) * len;

			// check active (aligned) within tolerance
			const isActive = Math.abs(angleDeg) <= CONFIG.alignmentToleranceDeg;

			// draw line
			ctx.beginPath();
			ctx.strokeStyle = isActive ? '#000' : '#666';
			ctx.lineWidth = isActive ? 5 : 2;
			ctx.moveTo(cx, cy);
			ctx.lineTo(ex, ey);
			ctx.stroke();

			// draw distance text at midpoint
			const mx = cx + Math.sin(rad) * (len*0.6);
			const my = cy - Math.cos(rad) * (len*0.6);
			ctx.fillStyle = '#222';
			ctx.font = '12px system-ui';
			const distText = (b._distanceKm !== null) ? (b._distanceKm.toFixed(1) + ' km') : '';
			ctx.fillText(distText, mx + 4, my + 4);

			// small dot at end
			ctx.beginPath();
			ctx.arc(ex, ey, isActive ? 6 : 4, 0, Math.PI*2);
			ctx.fillStyle = isActive ? '#000' : '#444';
			ctx.fill();

			// if active, remember the group (show title + play button)
			if (isActive) {
				activeGroup = g;
				// we'll show the first member's title (if multiple, you can adapt)
				showActiveTarget(g);
			}
		}
	}

	if (!activeGroup) hideActiveTarget();

	ctx.restore();
}

/* ===========================
   UI: Affichage du titre / bouton de lecture
   =========================== */

const targetTitleEl = document.getElementById('target-title');
const playBtn = document.getElementById('play-btn');

function showActiveTarget(group){
	// if group has multiple, join titles
	const titles = group.members.map(m => m.beffroi.titre);
	targetTitleEl.textContent = titles.join(' — ')+" à "+m.beffroi.distance.toFixed(1)+" km";
	targetTitleEl.classList.remove('hidden');
	playBtn.classList.remove('hidden');

	// set click handler to play the first beffroi's audio in the group (or implement list)
	playBtn.onclick = () => {
		// stop others and play the first in the group's members
		const first = group.members[0].beffroi;
		playAudioFor(first);
	};
}

function hideActiveTarget(){
	targetTitleEl.classList.add('hidden');
	playBtn.classList.add('hidden');
}

/* ===========================
   AUDIO MANAGEMENT
   =========================== */

const audioPool = new Map(); // id -> HTMLAudioElement

function playAudioFor(beffroi){
	if (!beffroi || !beffroi.path) return;
	// Stop currently playing (option gentle fade)
	stopAllAudio();

	let audio = audioPool.get(beffroi.id);
	if (!audio){
		audio = new Audio(beffroi.path);
		audio.loop = true;
		audioPool.set(beffroi.id, audio);
	}
	audio.volume = 1.0;
	audio.play().catch(err => console.warn('audio play error', err));
	state.audioPlaying = audio;
}

function stopAllAudio(){
	for (let [,a] of audioPool){
		try {
			// fade then pause
			a.pause();
			// reset time
			a.currentTime = 0;
		} catch(e){}
	}
	state.audioPlaying = null;
}

/* ===========================
   UTIL: DEBUG / LOG
   =========================== */
function log(...args){
	if (CONFIG.debug) console.log(...args);
}

/* ===========================
   INITIALIZATION
   =========================== */

// Show initial coords if known
document.getElementById('coords').textContent = '--';

function updateUiCoords(){
	if (state.userPos){
		document.getElementById('coords').textContent = state.userPos.lat.toFixed(5) + ', ' + state.userPos.lon.toFixed(5);
	}
}
setInterval(updateUiCoords, 5000);

/* on unload stop audio */
window.addEventListener('pagehide', () => stopAllAudio());

/* Fin du fichier */

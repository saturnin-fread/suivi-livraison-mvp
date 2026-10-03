// Faux service Traccar pour les tests locaux : appareils = livreurs de la
// base, trajets synthétiques dans Cotonou (déterministes selon l'heure), avec
// un arrêt de 6 min et un trou de signal de 8 min chaque heure. Certains
// appareils ont un signal ancien (20 min) ou n'existent pas, pour couvrir
// tous les états de la carte. Ne sert qu'aux tests.
const http = require('http');
const { Pool } = require('pg');

const port = Number(process.env.FAKE_TRACCAR_PORT || 8097);
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const WAYPOINTS = [
  [6.3712, 2.4194], [6.3655, 2.4250], [6.3600, 2.4310], [6.3668, 2.4362], [6.3730, 2.4380],
  [6.3690, 2.4490], [6.3640, 2.4600], [6.3560, 2.4440], [6.3586, 2.3897], [6.3530, 2.3640],
  [6.3650, 2.3800], [6.3870, 2.4050], [6.3800, 2.4150],
];
const LOOP_MS = 60 * 60 * 1000;
const lerp = (a, b, f) => a + (b - a) * f;

function pointAt(deviceId, t) {
  const offset = (deviceId * 7919) % LOOP_MS;
  const phase = ((t + offset) % LOOP_MS) / LOOP_MS;
  const minute = phase * 60;
  // Arrêt entre la 20e et la 26e minute : position figée.
  const effective = minute >= 20 && minute < 26 ? 20 / 60 : minute >= 26 ? (minute - 6) / 60 : phase;
  const segs = WAYPOINTS.length;
  const pos = effective * segs;
  const i = Math.floor(pos) % segs;
  const f = pos - Math.floor(pos);
  const a = WAYPOINTS[i];
  const b = WAYPOINTS[(i + 1) % segs];
  const shift = ((deviceId % 5) - 2) * 0.0012;
  return { latitude: lerp(a[0], b[0], f) + shift, longitude: lerp(a[1], b[1], f) - shift, stopped: minute >= 20 && minute < 26, minute };
}
const inGap = (deviceId, t) => { const m = pointAt(deviceId, t).minute; return m >= 40 && m < 48; };

async function devices() {
  const r = await pool.query("SELECT id, traccar_unique_id FROM drivers WHERE traccar_unique_id IS NOT NULL AND traccar_unique_id <> '' ORDER BY id");
  return r.rows.filter((d) => Number(d.id) % 7 !== 0).map((d) => ({
    id: Number(d.id), uniqueId: d.traccar_unique_id, name: `Appareil ${d.id}`,
    status: Number(d.id) % 6 === 0 ? 'offline' : 'online',
    lastUpdate: new Date(Date.now() - (Number(d.id) % 5 === 0 ? 20 * 60000 : 15000)).toISOString(),
  }));
}
function position(device, t) {
  const p = pointAt(device.id, t);
  return {
    id: Math.floor(t / 1000), deviceId: device.id, latitude: p.latitude, longitude: p.longitude,
    speed: p.stopped ? 0 : 14, course: 90, accuracy: 8, fixTime: new Date(t).toISOString(),
  };
}

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const list = await devices();
    let body;
    if (url.pathname === '/api/devices') body = list;
    else if (url.pathname === '/api/positions' && url.searchParams.get('deviceId')) {
      const device = list.find((d) => String(d.id) === url.searchParams.get('deviceId'));
      const from = Date.parse(url.searchParams.get('from'));
      const to = Math.min(Date.parse(url.searchParams.get('to')), Date.now());
      body = [];
      if (device && Number.isFinite(from) && Number.isFinite(to)) {
        const step = 20000;
        for (let t = Math.ceil(from / step) * step; t <= to && body.length < 20000; t += step) {
          if (!inGap(device.id, t)) body.push(position(device, t));
        }
      }
    } else if (url.pathname === '/api/positions') {
      body = list.map((d) => position(d, new Date(d.lastUpdate).getTime()));
    } else { res.writeHead(404); res.end('{}'); return; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  } catch (error) {
    res.writeHead(500); res.end(JSON.stringify({ error: error.message }));
  }
}).listen(port, () => console.log(`fake-traccar on ${port}`));

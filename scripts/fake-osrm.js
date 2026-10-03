// Faux OSRM pour les tests locaux : route = ligne brisée passant par les points
// demandés (distance à vol d'oiseau × 1,3, 8 m/s). Seul le service route est servi.
const http = require('http');
const port = Number(process.env.PORT || 8096);
const hav = (a, b) => {
  const r = Math.PI / 180; const dLat = (b[1] - a[1]) * r; const dLng = (b[0] - a[0]) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * r) * Math.cos(b[1] * r) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};
http.createServer((req, res) => {
  const m = /^\/route\/v1\/[^/]+\/([^?]+)/.exec(req.url);
  if (!m) { res.writeHead(404, { 'Content-Type': 'application/json' }); return res.end('{"code":"InvalidUrl"}'); }
  const pts = decodeURIComponent(m[1]).split(';').map((p) => p.split(',').map(Number));
  const legs = pts.slice(1).map((p, i) => { const d = hav(pts[i], p) * 1.3; return { distance: d, duration: d / 8, steps: [], summary: '', weight: d / 8 }; });
  const distance = legs.reduce((t, l) => t + l.distance, 0);
  const duration = legs.reduce((t, l) => t + l.duration, 0);
  const coords = [];
  pts.forEach((p, i) => { if (i) { const q = pts[i - 1]; coords.push([(q[0] + p[0]) / 2 + 0.002, (q[1] + p[1]) / 2]); } coords.push(p); });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ code: 'Ok', routes: [{ distance, duration, weight: duration, weight_name: 'routability', legs, geometry: { type: 'LineString', coordinates: coords } }], waypoints: pts.map((p) => ({ location: p, distance: 0, name: '' })) }));
}).listen(port, '127.0.0.1', () => console.log(`fake-osrm on ${port}`));

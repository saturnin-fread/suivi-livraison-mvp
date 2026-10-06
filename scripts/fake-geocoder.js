// Faux service de géocodage (format Nominatim /search) pour les tests locaux.
const http = require('http');
const port = Number(process.env.PORT || 8095);
const PLACES = [
  { name: 'Marché Dantokpa', lat: 6.3726, lon: 2.4335, suburb: 'Missèbo', city: 'Cotonou', type: 'marketplace' },
  { name: 'Pharmacie Camp Guézo', lat: 6.3619, lon: 2.4182, suburb: 'Camp Guézo', city: 'Cotonou', type: 'pharmacy' },
  { name: 'Carrefour Saint-Michel', lat: 6.3667, lon: 2.4261, suburb: 'Saint-Michel', city: 'Cotonou', type: 'crossing' },
  { name: 'École primaire publique de Fidjrossè', lat: 6.3561, lon: 2.3622, suburb: 'Fidjrossè', city: 'Cotonou', type: 'school' },
  { name: 'Stade de l’Amitié', lat: 6.3893, lon: 2.3794, suburb: 'Kouhounou', city: 'Cotonou', type: 'stadium' },
];
const fold = (v) => String(v).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/search') { res.writeHead(404); return res.end('[]'); }
  const q = fold(url.searchParams.get('q') || '');
  const hits = PLACES.filter((p) => fold(`${p.name} ${p.suburb}`).includes(q)).map((p, i) => ({
    place_id: i + 1, lat: String(p.lat), lon: String(p.lon), name: p.name, type: p.type, category: 'amenity',
    display_name: `${p.name}, ${p.suburb}, ${p.city}, Littoral, Bénin`, address: { suburb: p.suburb, city: p.city, state: 'Littoral', country_code: 'bj' },
  }));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(hits));
}).listen(port, '127.0.0.1', () => console.log(`fake-geocoder on ${port}`));

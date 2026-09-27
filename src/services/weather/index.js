// Weather service — OpenWeatherMap adapter (PRD §9.8) with a deterministic mock
// fallback so the admin Weather screen works without an API key.
// Computes Rain / Heat / Frost / Spray-window alerts from the data.

import { env } from '../../config/env.js';
import { createAsyncCache } from '../../utils/asyncCache.js';

const KEY = env.weather?.apiKey || process.env.OPENWEATHER_API_KEY || '';
export const weatherConfigured = Boolean(KEY);

const OWM = 'https://api.openweathermap.org';
const CACHE_TTL_MS = 10 * 60 * 1000;
const weatherCache = createAsyncCache({ maxEntries: 256 });
const geoCache = createAsyncCache({ maxEntries: 256 });

async function getJson(url, ms = 4500) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`OpenWeatherMap ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

// ── Deterministic mock (seeded by location string) ───────────
function seedFrom(s) {
  let h = 0;
  for (let i = 0; i < (s || 'x').length; i += 1) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
const DESCS = ['Clear sky', 'Few clouds', 'Scattered clouds', 'Light rain', 'Haze', 'Partly cloudy'];

function mockWeather(label) {
  const seed = seedFrom(label);
  const baseTemp = 24 + (seed % 12); // 24–35
  const humidity = 50 + (seed % 40);
  const wind = 4 + (seed % 14);
  const current = {
    temp: baseTemp + 2,
    feelsLike: baseTemp + 3,
    humidity,
    windSpeed: wind,
    description: DESCS[seed % DESCS.length],
    rain1h: seed % 5 === 0 ? 6.2 : 0,
  };
  const forecast = Array.from({ length: 7 }, (_, i) => {
    const s = seedFrom(label + i);
    const max = baseTemp + (s % 7);
    return {
      date: null, // filled by caller offset
      min: max - 6 - (s % 3),
      max,
      rainProb: (s % 100),
      rainMm: s % 7 === 0 ? 8 + (s % 10) : s % 3 === 0 ? 2 : 0,
      wind: 4 + (s % 12),
      description: DESCS[s % DESCS.length],
    };
  });
  return { current, forecast, source: 'mock' };
}

// ── Alert computation ────────────────────────────────────────
export function computeAlerts(current, forecast) {
  const alerts = [];
  const next = forecast[0] ?? {};

  // Decide spray guidance ONCE so we never emit contradictory advice
  // (e.g. "postpone spraying" alongside "ideal for spraying").
  const rainSoon = (current.rain1h ?? 0) > 0 || (next.rainMm ?? 0) > 0 || (next.rainProb ?? 0) >= 40;
  const heat     = current.temp > 40;
  const frost    = Math.min(current.temp, next.min ?? current.temp) < 5;
  const noRainSoon = forecast.length > 0 && !rainSoon;
  const calmWind = current.windSpeed >= 1 && current.windSpeed < 4;

  if (rainSoon) {
    alerts.push({ type: 'RAIN', severity: 'MEDIUM', title: 'Rain in the forecast', detail: 'Check rainfall timing and the product label’s rain-free interval before planning a spray.' });
  }
  if (heat) {
    alerts.push({ type: 'HEAT', severity: 'HIGH', title: 'Heat stress', detail: 'Temperature above 40°C — irrigate and spray only in the early morning or evening, never at mid-day.' });
  }
  if (frost) {
    alerts.push({ type: 'FROST', severity: 'MEDIUM', title: 'Frost risk', detail: 'Temperature below 5°C — protect vegetable crops.' });
  }
  // Only suggest a good spray window when nothing else advises against spraying.
  if (!rainSoon && !heat && !frost && noRainSoon && calmWind) {
    alerts.push({ type: 'SPRAY_WINDOW', severity: 'LOW', title: 'Review spray conditions', detail: 'No rain is forecast in the next daily period. Check wind at your field and follow the product label before spraying.' });
  }
  return alerts;
}

function addDates(forecast) {
  const out = [];
  for (let i = 0; i < forecast.length; i += 1) {
    const d = new Date();
    d.setDate(d.getDate() + i + 1);
    out.push({ ...forecast[i], date: d.toISOString().slice(0, 10) });
  }
  return out;
}

/** Fetch weather for a place (city/village string or lat/lon). `lang` localizes descriptions (e.g. 'hi'). */
async function fetchWeather({ city, lat, lon, lang }) {
  const label = city || (lat != null ? `${lat},${lon}` : 'Unknown');
  const langQ = lang ? `&lang=${lang}` : '';

  if (!weatherConfigured) {
    const m = mockWeather(label);
    const forecast = addDates(m.forecast);
    return { location: label, source: 'mock', current: m.current, forecast, alerts: [] };
  }

  try {
    let plat = lat;
    let plon = lon;
    let name = label;
    if (plat == null && city) {
      const geo = await geoCache.get(`city:${city.toLowerCase()}`, () => getJson(`${OWM}/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${KEY}`, 2500), 86_400_000);
      if (!geo.length) throw new Error('Location not found');
      plat = geo[0].lat; plon = geo[0].lon; name = `${geo[0].name}, ${geo[0].country}`;
    }
    // Current conditions, forecast and reverse geocoding are independent. Run
    // them together instead of paying for three sequential network round-trips.
    const reverse = plat != null
      ? geoCache.get(`gps:${Number(plat).toFixed(2)},${Number(plon).toFixed(2)}`, () => getJson(`${OWM}/geo/1.0/reverse?lat=${plat}&lon=${plon}&limit=1&appid=${KEY}`, 800), 86_400_000).catch(() => [])
      : Promise.resolve([]);
    const [rev, cur, fc] = await Promise.all([
      reverse,
      getJson(`${OWM}/data/2.5/weather?lat=${plat}&lon=${plon}&units=metric${langQ}&appid=${KEY}`),
      getJson(`${OWM}/data/2.5/forecast?lat=${plat}&lon=${plon}&units=metric${langQ}&appid=${KEY}`),
    ]);
    if (rev.length) name = [rev[0].name, rev[0].state].filter(Boolean).join(', ');

    const current = {
      temp: cur.main.temp, feelsLike: cur.main.feels_like, humidity: cur.main.humidity,
      windSpeed: cur.wind.speed, description: cur.weather?.[0]?.description ?? '', rain1h: cur.rain?.['1h'] ?? 0,
    };
    // Aggregate 3-hour steps into daily buckets.
    const byDay = new Map();
    for (const step of fc.list ?? []) {
      const day = step.dt_txt.slice(0, 10);
      const e = byDay.get(day) ?? { min: Infinity, max: -Infinity, rainMm: 0, wind: 0, n: 0, rainProb: 0, description: step.weather?.[0]?.description ?? '' };
      e.min = Math.min(e.min, step.main.temp_min);
      e.max = Math.max(e.max, step.main.temp_max);
      e.rainMm += step.rain?.['3h'] ?? 0;
      e.wind = Math.max(e.wind, step.wind.speed);
      e.rainProb = Math.max(e.rainProb, Math.round((step.pop ?? 0) * 100));
      e.n += 1;
      byDay.set(day, e);
    }
    const forecast = [...byDay.entries()].slice(0, 7).map(([date, e]) => ({ date, min: Math.round(e.min), max: Math.round(e.max), rainMm: Math.round(e.rainMm * 10) / 10, wind: Math.round(e.wind), rainProb: e.rainProb, description: e.description }));
    return { location: name, source: 'openweathermap', current, forecast, alerts: computeAlerts(current, forecast) };
  } catch {
    // Fall back to mock on any API failure so the screen still renders.
    const m = mockWeather(label);
    const forecast = addDates(m.forecast);
    return { location: label, source: 'mock', current: m.current, forecast, alerts: [] };
  }
}

function weatherKey({ city, lat, lon, lang }) {
  if (lat != null && lon != null) return `gps:${Number(lat).toFixed(2)},${Number(lon).toFixed(2)}:${lang || 'en'}`;
  return `city:${String(city || 'India').trim().toLowerCase()}:${lang || 'en'}`;
}

/** Cached + request-deduplicated public adapter. Weather changes slowly enough
 * that a ten-minute cache gives a much faster home screen without stale advice. */
export function getWeather(args) {
  if ((args.lat == null) !== (args.lon == null) || (args.lat != null &&
      (!Number.isFinite(args.lat) || !Number.isFinite(args.lon) || Math.abs(args.lat) > 90 || Math.abs(args.lon) > 180))) {
    return Promise.reject(new Error('Invalid weather coordinates'));
  }
  return weatherCache.get(weatherKey(args), () => fetchWeather(args),
    (value) => value.source === 'mock' && weatherConfigured ? 30_000 : CACHE_TTL_MS);
}

// Weather service — OpenWeatherMap adapter (PRD §9.8) with a deterministic mock
// fallback so the admin Weather screen works without an API key.
// Computes Rain / Heat / Frost / Spray-window alerts from the data.

import { env } from '../../config/env.js';

const KEY = env.weather?.apiKey || process.env.OPENWEATHER_API_KEY || '';
export const weatherConfigured = Boolean(KEY);

const OWM = 'https://api.openweathermap.org';

async function getJson(url, ms = 8000) {
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
function computeAlerts(current, forecast) {
  const alerts = [];
  const next = forecast[0] ?? {};

  // Decide spray guidance ONCE so we never emit contradictory advice
  // (e.g. "postpone spraying" alongside "ideal for spraying").
  const rainSoon = (current.rain1h ?? 0) > 5 || (next.rainMm ?? 0) > 5;
  const heat     = current.temp > 40;
  const frost    = Math.min(current.temp, next.min ?? current.temp) < 5;
  const noRainSoon = (current.rain1h ?? 0) === 0 && (next.rainMm ?? 0) <= 1;
  const calmWind   = current.windSpeed < 10;

  if (rainSoon) {
    alerts.push({ type: 'RAIN', severity: 'HIGH', title: 'Rain expected', detail: 'Rainfall > 5mm — postpone spraying until the rain clears.' });
  }
  if (heat) {
    alerts.push({ type: 'HEAT', severity: 'HIGH', title: 'Heat stress', detail: 'Temperature above 40°C — irrigate and spray only in the early morning or evening, never at mid-day.' });
  }
  if (frost) {
    alerts.push({ type: 'FROST', severity: 'MEDIUM', title: 'Frost risk', detail: 'Temperature below 5°C — protect vegetable crops.' });
  }
  // Only suggest a good spray window when nothing else advises against spraying.
  if (!rainSoon && !heat && noRainSoon && calmWind) {
    alerts.push({ type: 'SPRAY_WINDOW', severity: 'LOW', title: 'Good spray window', detail: 'Low wind and no rain expected soon — ideal for spraying in the next few hours.' });
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
export async function getWeather({ city, lat, lon, lang }) {
  const label = city || (lat != null ? `${lat},${lon}` : 'Unknown');
  const langQ = lang ? `&lang=${lang}` : '';

  if (!weatherConfigured) {
    const m = mockWeather(label);
    const forecast = addDates(m.forecast);
    return { location: label, source: 'mock', current: m.current, forecast, alerts: computeAlerts(m.current, forecast) };
  }

  try {
    let plat = lat;
    let plon = lon;
    let name = label;
    if (plat == null && city) {
      const geo = await getJson(`${OWM}/geo/1.0/direct?q=${encodeURIComponent(city)}&limit=1&appid=${KEY}`);
      if (!geo.length) throw new Error('Location not found');
      plat = geo[0].lat; plon = geo[0].lon; name = `${geo[0].name}, ${geo[0].country}`;
    } else if (plat != null) {
      // Reverse-geocode coordinates → nearest village/town name (instead of showing lat,lon).
      try {
        const rev = await getJson(`${OWM}/geo/1.0/reverse?lat=${plat}&lon=${plon}&limit=1&appid=${KEY}`);
        if (rev.length) name = [rev[0].name, rev[0].state].filter(Boolean).join(', ');
      } catch { /* keep coord label */ }
    }
    const cur = await getJson(`${OWM}/data/2.5/weather?lat=${plat}&lon=${plon}&units=metric${langQ}&appid=${KEY}`);
    const fc = await getJson(`${OWM}/data/2.5/forecast?lat=${plat}&lon=${plon}&units=metric${langQ}&appid=${KEY}`);

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
    return { location: label, source: 'mock', current: m.current, forecast, alerts: computeAlerts(m.current, forecast) };
  }
}

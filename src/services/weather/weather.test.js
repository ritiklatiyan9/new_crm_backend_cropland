import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ||= 'postgresql://test@127.0.0.1:1/test';
process.env.JWT_SECRET ||= 'test-only';
process.env.OPENWEATHER_API_KEY = 'weather-test-key';
const { getWeather, computeAlerts } = await import('./index.js');

test('high rain probability and light rain never produce a spray-window alert', () => {
  const current = { temp: 26, windSpeed: 2.2, rain1h: 0 };
  for (const next of [{ rainProb: 95, rainMm: 0.7 }, { rainProb: 90, rainMm: 0 }]) {
    const alerts = computeAlerts(current, [next]);
    assert.equal(alerts.some(a => a.type === 'RAIN'), true);
    assert.equal(alerts.some(a => a.type === 'SPRAY_WINDOW'), false);
  }
  assert.equal(computeAlerts(current, []).some(a => a.type === 'SPRAY_WINDOW'), false);
  assert.equal(computeAlerts({ ...current, windSpeed: 8 }, [{ rainProb: 0, rainMm: 0 }]).some(a => a.type === 'SPRAY_WINDOW'), false);
});

test('weather deduplicates concurrent readers and isolates language', async () => {
  const saved = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    const body = url.includes('/geo/') ? [{ name: 'Test farm', state: 'Test' }]
      : url.includes('/forecast') ? { list: [{ dt_txt: '2026-09-28 09:00:00', main: { temp_min: 23, temp_max: 28 }, wind: { speed: 3 }, pop: 0, weather: [{ description: 'clear sky' }] }] }
      : { main: { temp: 26, feels_like: 27, humidity: 50 }, wind: { speed: 3 }, weather: [{ description: 'clear sky' }] };
    return { ok: true, json: async () => body };
  };
  try {
    const args = { lat: 20, lon: 70, lang: 'en' };
    const [first, second] = await Promise.all([getWeather(args), getWeather(args)]);
    assert.equal(first.source, 'openweathermap');
    assert.equal(first.current.windSpeed, 3); // Provider metric units are m/s.
    assert.deepEqual(first, second);
    assert.equal(calls, 3);
    await getWeather(args);
    assert.equal(calls, 3);
    await getWeather({ ...args, lang: 'hi' });
    assert.equal(calls, 5); // Reverse-geocoding is reused across languages.
  } finally { globalThis.fetch = saved; }
});

test('provider failure is labelled demo and never supplies mock farming advice', async () => {
  const saved = globalThis.fetch;
  globalThis.fetch = async () => { throw Error('provider down'); };
  try {
    const result = await getWeather({ lat: 22, lon: 72 });
    assert.equal(result.source, 'mock');
    assert.deepEqual(result.alerts, []);
    await assert.rejects(getWeather({ lat: 91, lon: 0 }), /Invalid weather coordinates/);
    await assert.rejects(getWeather({ lat: 20 }), /Invalid weather coordinates/);
  } finally { globalThis.fetch = saved; }
});

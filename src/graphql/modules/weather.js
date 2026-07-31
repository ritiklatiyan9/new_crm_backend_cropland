// GraphQL module: Weather Engine (PRD §9.8). OpenWeatherMap-backed (mock fallback).

import { query } from '../../db/index.js';
import { assertAuth } from '../context.js';
import { httpError, num } from '../helpers.js';
import { getWeather, weatherConfigured } from '../../services/weather/index.js';

export const weatherTypeDefs = /* GraphQL */ `
  type CurrentWeather {
    temp: Float!
    feelsLike: Float!
    humidity: Float!
    windSpeed: Float!
    description: String
    rain1h: Float!
  }
  type ForecastDay {
    date: String!
    min: Float!
    max: Float!
    rainMm: Float!
    rainProb: Float!
    wind: Float!
    description: String
  }
  type WeatherAlert { type: String!, severity: String!, title: String!, detail: String }
  type Weather {
    location: String!
    source: String!
    configured: Boolean!
    current: CurrentWeather!
    forecast: [ForecastDay!]!
    alerts: [WeatherAlert!]!
  }

  extend type Query {
    weather(city: String, lat: Float, lon: Float): Weather!
    weatherForFarmer(farmerId: ID!): Weather!
  }
`;

function shape(w) {
  return { ...w, configured: weatherConfigured };
}

export function weatherResolvers() {
  return {
    Query: {
      weather: async (_p, { city, lat, lon }, ctx) => {
        assertAuth(ctx);
        if (!city && lat == null) throw httpError('Provide a city/village or coordinates', 400);
        return shape(await getWeather({ city, lat, lon }));
      },
      weatherForFarmer: async (_p, { farmerId }, ctx) => {
        assertAuth(ctx);
        const { rows } = await query('SELECT village, district, state, gps_lat, gps_lng FROM farmers WHERE id = $1', [farmerId]);
        const f = rows[0];
        if (!f) throw httpError('Farmer not found', 404);
        if (f.gps_lat != null && f.gps_lng != null) {
          return shape(await getWeather({ lat: num(f.gps_lat), lon: num(f.gps_lng) }));
        }
        const city = [f.village, f.district, f.state].filter(Boolean).join(', ');
        return shape(await getWeather({ city: city || 'India' }));
      },
    },
  };
}

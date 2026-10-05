/**
 * Free, keyless data sources with structured answers — so common questions never depend on a
 * general web search. Each call throws a short honest error on failure.
 */
import { DataPort, Logger } from '../types';


const WMO: Record<number, string> = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers', 82: 'violent showers',
  85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorm', 96: 'thunderstorm with hail', 99: 'thunderstorm with heavy hail',
};

export function createDataPort(opts: { fetchImpl?: typeof fetch; timeoutMs?: number; log?: Logger } = {}): DataPort {
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const getJson = async <T>(url: string): Promise<T> => {
    const res = await doFetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'i-journal/1.0' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).hostname}`);
    return (await res.json()) as T;
  };

  return {
    async rate(from, to) {
      const base = from.trim().toUpperCase();
      if (!/^[A-Z]{3}$/.test(base)) throw new Error(`"${from}" is not a 3-letter currency code`);
      const want = to.map((c) => c.trim().toUpperCase()).filter((c) => /^[A-Z]{3}$/.test(c));
      const data = await getJson<{ result?: string; rates?: Record<string, number>; time_last_update_utc?: string; 'error-type'?: string }>(`https://open.er-api.com/v6/latest/${base}`);
      if (data.result !== 'success' || !data.rates) throw new Error(`rate lookup failed${data['error-type'] ? ': ' + data['error-type'] : ''}`);
      const rates: Record<string, number> = {};
      if (!want.length) throw new Error('say which currencies to convert to');
      for (const c of want) if (typeof data.rates[c] === 'number') rates[c] = data.rates[c];
      if (!Object.keys(rates).length) throw new Error(`no rate for ${want.join(', ')}`);
      return { base, rates, updated: data.time_last_update_utc || '', source: 'open.er-api.com (ExchangeRate-API)' };
    },

    async weather(place) {
      const geo = await getJson<{ results?: Array<{ name: string; country?: string; latitude: number; longitude: number; timezone?: string; admin1?: string }> }>(
        `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(place.trim())}&count=1&language=en&format=json`
      );
      const g = geo.results?.[0];
      if (!g) throw new Error(`could not find a place called "${place}"`);
      const f = await getJson<{
        timezone?: string;
        current?: { temperature_2m: number; apparent_temperature?: number; wind_speed_10m: number; relative_humidity_2m?: number; weather_code: number };
        daily?: { time: string[]; temperature_2m_min: number[]; temperature_2m_max: number[]; precipitation_sum: number[]; precipitation_probability_max?: number[]; weather_code: number[] };
      }>(
        `https://api.open-meteo.com/v1/forecast?latitude=${g.latitude}&longitude=${g.longitude}&current=temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max&timezone=auto&forecast_days=3`
      );
      if (!f.current || !f.daily) throw new Error('forecast unavailable');
      return {
        place: [g.name, g.admin1].filter(Boolean).join(', '),
        country: g.country,
        timezone: f.timezone || g.timezone || '',
        current: {
          tempC: f.current.temperature_2m,
          feelsC: f.current.apparent_temperature,
          windKph: f.current.wind_speed_10m,
          humidity: f.current.relative_humidity_2m,
          description: WMO[f.current.weather_code] || `code ${f.current.weather_code}`,
        },
        days: f.daily.time.map((date, i) => ({
          date,
          minC: f.daily!.temperature_2m_min[i],
          maxC: f.daily!.temperature_2m_max[i],
          rainMm: f.daily!.precipitation_sum[i],
          rainChance: f.daily!.precipitation_probability_max?.[i],
          description: WMO[f.daily!.weather_code[i]] || `code ${f.daily!.weather_code[i]}`,
        })),
        source: 'Open-Meteo',
      };
    },

    async verse(reference, translation = 'web') {
      const tr = /^[a-z]{2,6}$/i.test(translation) ? translation.toLowerCase() : 'web';
      const data = await getJson<{ reference?: string; text?: string; translation_name?: string; error?: string }>(
        `https://bible-api.com/${encodeURIComponent(reference.trim())}?translation=${tr}`
      );
      if (!data.text) throw new Error(data.error || `could not find "${reference}"`);
      return { reference: data.reference || reference, text: data.text.replace(/\s+/g, ' ').trim(), translation: data.translation_name || tr.toUpperCase(), source: 'bible-api.com' };
    },

    async wiki(topic) {
      const search = await getJson<{ pages?: Array<{ key: string; title: string }> }>(`https://en.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(topic.trim())}&limit=1`);
      const page = search.pages?.[0];
      if (!page) throw new Error(`no Wikipedia article for "${topic}"`);
      const s = await getJson<{ title?: string; extract?: string; content_urls?: { desktop?: { page?: string } } }>(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(page.key)}`);
      if (!s.extract) throw new Error('no summary available');
      return { title: s.title || page.title, summary: s.extract, url: s.content_urls?.desktop?.page || `https://en.wikipedia.org/wiki/${encodeURIComponent(page.key)}`, source: 'Wikipedia' };
    },
  };
}

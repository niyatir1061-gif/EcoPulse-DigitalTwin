/**
 * api.js  —  EcoPulse Live Data Layer
 *
 * Sources
 * -------
 * 1. Open-Meteo  (https://api.open-meteo.com)
 *    Free, no API key, CORS-open.
 *    Fetches real current ambient temperature, humidity, wind speed,
 *    apparent temperature and cloud cover for the configured location.
 *    Refreshed every 5 minutes.
 *
 * 2. EIA API v2  (https://api.eia.gov/v2)
 *    Free, requires a user-supplied API key.
 *    Fetches the latest hourly US grid electricity demand (MW) for a
 *    configurable balancing authority (default: CISO = California ISO).
 *    Used to show real grid-level energy context on the Fleet tab.
 *    Refreshed every 15 minutes (EIA updates hourly at best).
 *
 * Both sources are cached so rapid UI refreshes never hammer the APIs.
 * The ambient temperature is pushed into the simulator via setAmbientTemp().
 */

/* ------------------------------------------------------------------ */
/*  Configuration (user-editable at runtime via the Settings panel)   */
/* ------------------------------------------------------------------ */
const ApiConfig = {
  // Open-Meteo: Mumbai, Maharashtra, India
  latitude:  19.0760,
  longitude: 72.8777,
  location:  'Mumbai, IN',

  // EIA v2 — balancing authority facet value
  // Common options: CISO (California), ERCO (Texas), MISO, PJM, NYIS
  eiaRegion:  'CISO',
  eiaApiKey:  '',           // set by user in the Settings panel

  // Refresh intervals (ms)
  weatherInterval: 5  * 60 * 1000,   //  5 min
  eiaInterval:     15 * 60 * 1000,   // 15 min
};

/* ------------------------------------------------------------------ */
/*  In-memory cache                                                    */
/* ------------------------------------------------------------------ */
const _cache = {
  weather: { data: null, fetchedAt: 0, status: 'idle' },
  eia:     { data: null, fetchedAt: 0, status: 'idle' },
};

/* ------------------------------------------------------------------ */
/*  Status callback — UI subscribes to know when data arrives         */
/* ------------------------------------------------------------------ */
let _onStatusChange = () => {};
function onApiStatus(cb) { _onStatusChange = cb; }

function _notify() { _onStatusChange({ weather: _cache.weather, eia: _cache.eia }); }

/* ------------------------------------------------------------------ */
/*  Open-Meteo  —  current weather                                    */
/* ------------------------------------------------------------------ */
async function fetchWeather(force = false) {
  const now  = Date.now();
  const stale = now - _cache.weather.fetchedAt > ApiConfig.weatherInterval;
  if (!force && !stale && _cache.weather.data) return _cache.weather.data;

  _cache.weather.status = 'loading';
  _notify();

  const url = `https://api.open-meteo.com/v1/forecast`
    + `?latitude=${ApiConfig.latitude}`
    + `&longitude=${ApiConfig.longitude}`
    + `&current=temperature_2m,apparent_temperature,relative_humidity_2m`
    + `,wind_speed_10m,cloud_cover,weather_code`
    + `&wind_speed_unit=kmh`
    + `&timezone=auto`;

  try {
    const res  = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const c    = json.current;

    const parsed = {
      temperature:        c.temperature_2m,
      apparentTemp:       c.apparent_temperature,
      humidity:           c.relative_humidity_2m,
      windSpeed:          c.wind_speed_10m,
      cloudCover:         c.cloud_cover,
      weatherCode:        c.weather_code,
      time:               c.time,
      location:           ApiConfig.location,
      fetchedAt:          new Date().toLocaleTimeString(),
    };

    _cache.weather = { data: parsed, fetchedAt: now, status: 'ok' };
    // Push ambient temperature and weather into the motor simulator
    setAmbientTemp(parsed.temperature, parsed.humidity, parsed.windSpeed);
    _notify();
    return parsed;
  } catch (err) {
    _cache.weather.status = `error: ${err.message}`;
    _notify();
    return _cache.weather.data;   // return last good data if available
  }
}

/* ------------------------------------------------------------------ */
/*  EIA v2  —  hourly electricity demand                              */
/* ------------------------------------------------------------------ */
async function fetchEIA(force = false) {
  if (!ApiConfig.eiaApiKey) {
    _cache.eia.status = 'no-key';
    _notify();
    return null;
  }

  const now   = Date.now();
  const stale = now - _cache.eia.fetchedAt > ApiConfig.eiaInterval;
  if (!force && !stale && _cache.eia.data) return _cache.eia.data;

  _cache.eia.status = 'loading';
  _notify();

  // EIA v2 endpoint — hourly demand by balancing authority
  // Returns the last 24 hourly demand values
  const url = `https://api.eia.gov/v2/electricity/rto/region-data/data/`
    + `?api_key=${ApiConfig.eiaApiKey}`
    + `&frequency=hourly`
    + `&data[]=value`
    + `&facets[type][]=D`                              // D = Demand
    + `&facets[respondent][]=${ApiConfig.eiaRegion}`
    + `&sort[0][column]=period&sort[0][direction]=desc`
    + `&length=24`
    + `&offset=0`;

  try {
    const res  = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();

    if (!json.response || !json.response.data) {
      throw new Error('Unexpected EIA response shape');
    }

    // Most-recent first — reverse so chronological for charting
    const rows = json.response.data.slice().reverse();

    const parsed = {
      region:    ApiConfig.eiaRegion,
      labels:    rows.map(r => r.period.slice(11, 16)),   // "HH:MM"
      demandMW:  rows.map(r => Number(r.value)),
      latestMW:  Number(rows[rows.length - 1]?.value || 0),
      latestTime:rows[rows.length - 1]?.period || '',
      fetchedAt: new Date().toLocaleTimeString(),
    };

    _cache.eia = { data: parsed, fetchedAt: now, status: 'ok' };
    _notify();
    return parsed;
  } catch (err) {
    _cache.eia.status = `error: ${err.message}`;
    _notify();
    return _cache.eia.data;
  }
}

/* ------------------------------------------------------------------ */
/*  Bootstrap + periodic refresh                                       */
/* ------------------------------------------------------------------ */
async function initApis() {
  await fetchWeather(true);
  await fetchEIA();

  setInterval(() => fetchWeather(), ApiConfig.weatherInterval);
  setInterval(() => fetchEIA(),     ApiConfig.eiaInterval);
}

/* ------------------------------------------------------------------ */
/*  Getters used by dashboard.js                                       */
/* ------------------------------------------------------------------ */
function getWeatherData() { return _cache.weather.data; }
function getWeatherStatus() { return _cache.weather.status; }
function getEIAData()     { return _cache.eia.data; }
function getEIAStatus()   { return _cache.eia.status; }

/* ------------------------------------------------------------------ */
/*  Config mutators (called from Settings panel)                      */
/* ------------------------------------------------------------------ */
function setApiLocation(lat, lon, label) {
  ApiConfig.latitude  = lat;
  ApiConfig.longitude = lon;
  ApiConfig.location  = label;
}

function setEiaKey(key) {
  ApiConfig.eiaApiKey = key.trim();
}

function setEiaRegion(region) {
  ApiConfig.eiaRegion = region.toUpperCase();
}

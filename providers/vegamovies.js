const cheerio = require('cheerio-without-node-native');

const PROVIDER_NAME = 'Vegamovies';
let baseUrl = 'https://vegamovies.pages.dev'; // Fallback base URL
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const DOMAINS_JSON_URL = 'https://raw.githubusercontent.com/swagkaran/nvega/main/domains.json';
const REQUEST_TIMEOUT = 12000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

const MOBILE_UAS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Mobile Safari/537.36'
];

let cachedDomains = null;
let domainCacheTime = 0;
const DOMAIN_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 Hours

let cachedHubDomain = 'https://hubcloud.one';
let cachedVcDomain = 'https://vcloud.zip';

function getMobileHeaders() {
  const ua = MOBILE_UAS[Math.floor(Math.random() * MOBILE_UAS.length)];
  return {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Referer': baseUrl + '/'
  };
}

async function fetchSafe(url, options = {}, timeoutMs = REQUEST_TIMEOUT) {
  try {
    const fetchOptions = {
      ...options,
      headers: {
        ...HEADERS,
        ...(options.headers || {}),
        'Accept-Encoding': 'identity'
      }
    };
    const fetchPromise = fetch(url, fetchOptions);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('timeout')), timeoutMs)
    );
    return await Promise.race([fetchPromise, timeoutPromise]);
  } catch (err) {
    console.error(`[${PROVIDER_NAME}] fetchSafe error: ${url.substring(0, 60)} -> ${err.message}`);
    return null;
  }
}

async function refreshDomains() {
  const now = Date.now();
  if (cachedDomains && (now - domainCacheTime < DOMAIN_CACHE_TTL)) {
    return cachedDomains;
  }
  try {
    const res = await fetchSafe(DOMAINS_JSON_URL, {}, 8000);
    if (res && res.ok) {
      const data = JSON.parse(await res.text());
      if (data) {
        cachedDomains = data;
        domainCacheTime = now;
        if (data.vegamovies) baseUrl = data.vegamovies;
        if (data.hubcloud) cachedHubDomain = data.hubcloud;
        if (data.vcloud) cachedVcDomain = data.vcloud;
        console.log(`[${PROVIDER_NAME}] Refreshed domains: Base=${baseUrl}`);
      }
    }
  } catch (e) {
    console.error(`[${PROVIDER_NAME}] Domain refresh failed, using defaults`);
  }
  return cachedDomains || {};
}

function parseQuality(str) {
  const s = String(str || '');
  const match = s.match(/(2160|1080|720|480)\s*P/i);
  if (match) return match[1].toLowerCase() + 'p';
  if (/4K|UHD/i.test(s)) return '2160p';
  if (/1440|2K/i.test(s)) return '1440p';
  return 'HD';
}

function makeStream(titleStr, quality, url, headers) {
  return {
    name: `${PROVIDER_NAME} | ${quality}`,
    title: titleStr,
    url: url || '',
    behaviorHints: {
      notWebReady: true,
      proxyHeaders: {
        request: headers || { 'Referer': baseUrl + '/' }
      }
    }
  };
}

async function getStreams(tmdbId, mediaType, season, episode) {
  try {
    console.log(`[${PROVIDER_NAME}] Request: TMDB=${tmdbId}, Type=${mediaType}, S=${season}, E=${episode}`);
    await refreshDomains();

    // 1. Search for title on VegaMovies backend
    const searchUrl = `${baseUrl}/wp-json/wp/v2/posts?search=${encodeURIComponent(tmdbId)}&per_page=5`;
    const res = await fetchSafe(searchUrl, { headers: getMobileHeaders() });
    
    if (!res || !res.ok) {
      console.log(`[${PROVIDER_NAME}] No search results or invalid API response.`);
      return [];
    }

    const posts = JSON.parse(await res.text());
    if (!Array.isArray(posts) || posts.length === 0) return [];

    const streams = [];
    for (const post of posts) {
      const content = post.content?.rendered || '';
      const $ = cheerio.load(content);

      $('a[href*="vcloud"], a[href*="hubcloud"], a[href*="nexdrive"]').each((_, el) => {
        const link = $(el).attr('href');
        const label = $(el).text().trim() || 'Download Link';
        const quality = parseQuality(label);

        if (link) {
          streams.push(makeStream(`VegaMovies - ${label}`, quality, link));
        }
      });
    }

    return streams;
  } catch (err) {
    console.error(`[${PROVIDER_NAME}] Fatal Error: ${err.message}`);
    return [];
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}

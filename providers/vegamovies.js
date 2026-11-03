const cheerio = require('cheerio-without-node-native');

const PROVIDER_NAME = 'Vegamovies';
const BASE_URL = 'https://veqamovies.cc';
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';

// Points directly to your repository's raw domains.json
const DOMAINS_JSON_URL = 'https://raw.githubusercontent.com/anime239/All-in-One-Nuvio/main/domains.json';
const REQUEST_TIMEOUT = 12000;

let baseUrl = BASE_URL;
let cachedHubDomain = 'https://hubcloud.one';
let cachedVcDomain = 'https://vcloud.zip';
let cachedDomains = null;
let domainCacheTime = 0;
const DOMAIN_CACHE_TTL = 4 * 60 * 60 * 1000; // 4 Hours cache

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

const FALLBACK_VEGAMOVIES_DOMAINS = [
  'https://veqamovies.cc',
  'https://1vegamovies.asia',
  'https://vegamovies.domains'
];

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
    if (err.message === 'timeout') {
      console.warn(`[${PROVIDER_NAME}] Timeout requesting: ${url.substring(0, 60)}`);
    } else {
      console.error(`[${PROVIDER_NAME}] fetchSafe error: ${url.substring(0, 60)} -> ${err.message}`);
    }
    return null;
  }
}

async function fetchJson(url, options = {}) {
  try {
    const res = await fetchSafe(url, options);
    if (!res || !res.ok) return null;
    const text = await res.text();
    return JSON.parse(text);
  } catch (e) {
    return null;
  }
}

async function fetchHtml(url, options = {}) {
  try {
    const res = await fetchSafe(url, options);
    if (!res || !res.ok) return null;
    const text = await res.text();
    return cheerio.load(text);
  } catch (e) {
    return null;
  }
}

function fixUrl(url) {
  if (!url) return '';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  if (url.startsWith('//')) return 'https:' + url;
  if (url.startsWith('/')) return baseUrl + url;
  return baseUrl + '/' + url;
}

function parseQuality(str) {
  const s = String(str || '');
  const match = s.match(/(2160|1080|720|480)\s*P/i);
  if (match) return match[1].toLowerCase() + 'p';
  if (/4K|UHD/i.test(s)) return '2160p';
  if (/1440|2K/i.test(s)) return '1440p';
  return 'HD';
}

function decodeEntities(str) {
  if (!str) return '';
  return str
    .replace(/&#8211;/g, '-')
    .replace(/&#8212;/g, '-')
    .replace(/&#038;/g, '&')
    .replace(/&#8217;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&ndash;/g, '-')
    .replace(/&mdash;/g, '-')
    .replace(/&quot;/g, '"');
}

function makeStream(serverName, titleInfo, streamUrl, quality, reqHeaders) {
  const cleanTitle = decodeEntities(titleInfo || '').replace(/[\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  const resWeight = quality.includes('2160') || quality.includes('4k') ? 3 : quality.includes('1080') ? 2 : 1;

  return {
    name: `${PROVIDER_NAME} | ${quality} | ${serverName}`,
    title: `${cleanTitle}\n${serverName} - Stream`,
    url: streamUrl || '',
    _resWeight: resWeight,
    behaviorHints: {
      notWebReady: true,
      proxyHeaders: {
        request: reqHeaders || { 'Referer': baseUrl + '/' }
      }
    }
  };
}

function dedupe(streams) {
  const seen = new Set();
  return (streams || []).filter(item => {
    if (!item || !item.url || seen.has(item.url)) return false;
    seen.add(item.url);
    return true;
  });
}

async function refreshDomains() {
  const now = Date.now();
  if (cachedDomains && (now - domainCacheTime < DOMAIN_CACHE_TTL)) {
    return cachedDomains;
  }
  try {
    const res = await fetchSafe(DOMAINS_JSON_URL, {}, 5000);
    if (res && res.ok) {
      const text = await res.text();
      if (text && !text.includes('404')) {
        const data = JSON.parse(text);
        if (data) {
          cachedDomains = data;
          domainCacheTime = now;
          if (data.vegamovies) baseUrl = data.vegamovies;
          if (data.hubcloud) cachedHubDomain = data.hubcloud;
          if (data.vcloud) cachedVcDomain = data.vcloud;
          console.log(`[${PROVIDER_NAME}] Refreshed domains from Github: Base=${baseUrl}`);
          return cachedDomains;
        }
      }
    }
  } catch (e) {
    console.warn(`[${PROVIDER_NAME}] Failed to fetch Github JSON. Falling back to internal list.`);
  }

  baseUrl = FALLBACK_VEGAMOVIES_DOMAINS[0];
  return { vegamovies: baseUrl, hubcloud: cachedHubDomain, vcloud: cachedVcDomain };
}

async function getTMDBInfo(id, type) {
  const cleanId = String(id || '').trim();
  const isImdb = cleanId.startsWith('tt');
  const mediaType = type === 'tv' || type === 'series' ? 'tv' : 'movie';

  try {
    if (isImdb) {
      const res = await fetchJson(`https://api.themoviedb.org/3/find/${cleanId}?api_key=${TMDB_API_KEY}&external_source=imdb_id`);
      const results = res ? (mediaType === 'tv' ? res.tv_results : res.movie_results) : null;
      if (results && results.length > 0) {
        const item = results[0];
        return {
          title: mediaType === 'tv' ? item.name : item.title,
          year: (item.first_air_date || item.release_date || '').split('-')[0],
          imdbId: cleanId,
          tmdbId: item.id
        };
      }
      return { title: cleanId, year: null, imdbId: cleanId, tmdbId: null };
    } else {
      const res = await fetchJson(`https://api.themoviedb.org/3/${mediaType}/${cleanId}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`);
      if (res) {
        return {
          title: mediaType === 'tv' ? res.name : res.title,
          year: (res.first_air_date || res.release_date || '').split('-')[0],
          imdbId: res.imdb_id || (res.external_ids ? res.external_ids.imdb_id : null),
          tmdbId: res.id
        };
      }
    }
  } catch (e) {
    console.error(`[${PROVIDER_NAME}] TMDB Lookup Error: ${e.message}`);
  }
  return { title: cleanId, year: null, imdbId: null, tmdbId: null };
}

async function searchByTitle(query, year) {
  if (!query) return [];
  const searchSlug = encodeURIComponent(query + (year ? ' ' + year : ''));
  const searchUrl = `${baseUrl}/index.php?do=search&subaction=search&story=${searchSlug}`;

  const $ = await fetchHtml(searchUrl, { headers: getMobileHeaders() });
  if (!$) return [];

  const posts = [];
  $('h2 a, h3 a, .title a, .post-title a, article a').each((_, el) => {
    const href = $(el).attr('href');
    const title = $(el).text().trim() || $(el).attr('title') || '';
    
    if (href && href.startsWith('http') && title.length > 5) {
      const cleanTitle = title.replace(/Download\s*/gi, '').trim();
      posts.push({
        postId: href,
        title: cleanTitle,
        permalink: href,
        year: (cleanTitle.match(/\b(19|20)\d{2}\b/) || [null])[0]
      });
    }
  });

  return posts.filter((item, index, self) => 
    index === self.findIndex((t) => t.permalink === item.permalink)
  );
}

async function extractSingleVc(url, referer, season, episode, title, qualityHint) {
  const streams = [];
  try {
    const $ = await fetchHtml(url, { headers: { ...getMobileHeaders(), Referer: referer || baseUrl + '/' } });
    if (!$) return streams;

    $('a.btn, a').each((_, el) => {
      const href = $(el).attr('href') || '';
      const text = ($(el).text() || '').trim();

      if (!href || href === '#' || href.toLowerCase().includes('javascript')) return;

      if (href.includes('workers.dev') || href.includes('fsl') || href.includes('vcloud') || href.includes('hubcloud')) {
        const detectedQuality = parseQuality(text) || qualityHint || 'HD';
        streams.push(makeStream(text || 'Cloud Server', title, href, detectedQuality, { Referer: url }));
      }
    });
  } catch (e) {
    console.error(`[${PROVIDER_NAME}] extractSingleVc Error: ${e.message}`);
  }
  return streams;
}

async function extractFromPost(postData, season, episode) {
  const streams = [];
  if (!postData || !postData.content) return streams;

  const $ = cheerio.load(postData.content);
  const linksToProcess = [];

  $('a[href*="nexdrive"], a[href*="vcloud"], a[href*="hubcloud"], a[href*="genxfm"]').each((_, el) => {
    const href = $(el).attr('href');
    const label = $(el).text().trim();
    if (href) {
      linksToProcess.push({ href: fixUrl(href), label, quality: parseQuality(label) });
    }
  });

  for (const item of linksToProcess) {
    const foundStreams = await extractSingleVc(item.href, baseUrl + '/', season, episode, item.label, item.quality);
    streams.push(...foundStreams);
  }

  return streams;
}

async function getStreams(id, type, season, episode) {
  try {
    console.log(`[${PROVIDER_NAME}] Processing Request: ID=${id}, Type=${type}, S=${season}, E=${episode}`);
    await refreshDomains();

    const tmdbInfo = await getTMDBInfo(id, type);
    let searchResults = [];

    if (tmdbInfo.imdbId) {
      searchResults = await searchByTitle(tmdbInfo.imdbId, null);
    }

    if (searchResults.length === 0 && tmdbInfo.title) {
      searchResults = await searchByTitle(tmdbInfo.title, null);

      if (searchResults.length === 0 && tmdbInfo.title.includes(':')) {
        const shortTitle = tmdbInfo.title.split(':')[0].trim();
        searchResults = await searchByTitle(shortTitle, null);
      }
    }

    if (searchResults.length === 0) {
      console.log(`[${PROVIDER_NAME}] No post matching media title found.`);
      return [];
    }

    let matchedPost = searchResults[0];
    if (type === 'tv' && season) {
      const seasonRegex = new RegExp(`(?:s|season)\\s*0*${season}\\b`, 'i');
      const foundSeasonPost = searchResults.find(post => seasonRegex.test(post.title));
      if (foundSeasonPost) {
        matchedPost = foundSeasonPost;
      }
    }

    const $post = await fetchHtml(matchedPost.permalink, { headers: getMobileHeaders() });

    if (!$post) return [];

    const extractedStreams = await extractFromPost(
      { content: $post.html(), title: matchedPost.title },
      season ? Number(season) : null,
      episode ? Number(episode) : null
    );

    return dedupe(extractedStreams);
  } catch (err) {
    console.error(`[${PROVIDER_NAME}] Fatal getStreams error: ${err.message}`);
    return [];
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}

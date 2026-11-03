
const cheerio = require('cheerio-without-node-native');

const PROVIDER_NAME = 'HdMovieHub';
const BASE_URL = 'https://hdmoviehub.institute';
const TMDB_API_KEY = '439c478a771f35c05022f9feabcca01c';
const REQUEST_TIMEOUT = 15000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9'
};

const LINK_HOSTS = /hubcloud|vcloud|nexdrive|workers\.dev|drive\.google|gdflix|gofile|dood|streamwish|vidhide|filepress|pixeldrain|lithub\.pro/i;

function cleanText(value) {
  return String(value || '')
    .replace(/&nbsp;|\u00a0/g, ' ')
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, '-')
    .replace(/&#8217;|&rsquo;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function absoluteUrl(value, base = BASE_URL) {
  if (!value) return '';
  try {
    return new URL(value, base).href;
  } catch (_) {
    return '';
  }
}

function unwrapUrl(value) {
  const url = absoluteUrl(value);
  if (!url) return '';

  try {
    const parsed = new URL(url);

    if (parsed.hostname.endsWith('href.li')) {
      const raw = url.split('?')[1];
      return raw ? decodeURIComponent(raw) : url;
    }
  } catch (_) {}

  return url;
}

function qualityFrom(value) {
  const text = String(value || '');
  const match = text.match(/(2160|1440|1080|720|480|360)\s*p?/i);

  if (match) return `${match[1]}p`;
  if (/4k|uhd/i.test(text)) return '2160p';
  if (/web.?dl|bluray|webrip|hdrip|hd/i.test(text)) return 'HD';

  return 'HD';
}

function resolutionWeight(quality) {
  const number = parseInt(String(quality).replace(/\D/g, ''), 10) || 720;

  if (number >= 2160) return 4;
  if (number >= 1080) return 3;
  if (number >= 720) return 2;

  return 1;
}

async function fetchResponse(url, options = {}, timeout = REQUEST_TIMEOUT) {
  if (!url) return null;

  const controller = typeof AbortController !== 'undefined'
    ? new AbortController()
    : null;

  let timer;

  try {
    const response = await Promise.race([
      fetch(url, {
        ...options,
        redirect: 'follow',
        signal: controller ? controller.signal : undefined,
        headers: {
          ...HEADERS,
          ...(options.headers || {})
        }
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeout);
      })
    ]);

    return response && response.ok ? response : null;
  } catch (_) {
    if (controller) controller.abort();
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function fetchHtml(url, options = {}) {
  const response = await fetchResponse(url, options);
  if (!response) return null;

  try {
    return cheerio.load(await response.text());
  } catch (_) {
    return null;
  }
}

async function fetchJson(url) {
  const response = await fetchResponse(url, {
    headers: { Accept: 'application/json' }
  });

  if (!response) return null;

  try {
    return await response.json();
  } catch (_) {
    return null;
  }
}

function isTv(type) {
  return ['tv', 'series', 'show'].includes(
    String(type || '').toLowerCase()
  );
}

async function getTMDBInfo(id, type) {
  const value = String(id || '').trim();
  const media = isTv(type) ? 'tv' : 'movie';

  if (!value) return null;

  if (value.startsWith('tt')) {
    const found = await fetchJson(
      `https://api.themoviedb.org/3/find/${encodeURIComponent(value)}?api_key=${TMDB_API_KEY}&external_source=imdb_id`
    );

    const result = found && (
      media === 'tv' ? found.tv_results : found.movie_results
    );

    const item = result && result[0];

    if (item) {
      return {
        title: media === 'tv' ? item.name : item.title,
        year: String(
          (item.first_air_date || item.release_date || '').slice(0, 4)
        ),
        imdbId: value,
        tmdbId: item.id
      };
    }

    return {
      title: '',
      year: '',
      imdbId: value,
      tmdbId: null
    };
  }

  const data = await fetchJson(
    `https://api.themoviedb.org/3/${media}/${encodeURIComponent(value)}?api_key=${TMDB_API_KEY}&append_to_response=external_ids`
  );

  if (!data) return null;

  return {
    title: media === 'tv' ? data.name : data.title,
    year: String(
      (data.first_air_date || data.release_date || '').slice(0, 4)
    ),
    imdbId: data.imdb_id ||
      (data.external_ids && data.external_ids.imdb_id) || '',
    tmdbId: data.id
  };
}

function normalizeTitle(value) {
  return cleanText(value)
    .replace(/^download\s+/i, '')
    .replace(/\b(480|720|1080|1440|2160)p?\b/gi, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function titleScore(candidate, expected, year) {
  const a = normalizeTitle(candidate);
  const b = normalizeTitle(expected);

  if (!a || !b) return 0;

  let score = 0;

  if (a === b) {
    score += 100;
  } else if (a.includes(b) || b.includes(a)) {
    score += 65;
  } else {
    const aw = new Set(a.split(' '));
    const bw = b.split(' ');
    const overlap = bw.filter(
      word => word.length > 1 && aw.has(word)
    ).length;

    score += Math.round(
      (overlap / Math.max(1, bw.length)) * 55
    );
  }

  if (year && String(candidate).includes(String(year))) {
    score += 25;
  }

  return score;
}

async function searchByTitle(title, year) {
  if (!title) return [];

  const query = cleanText(`${title} ${year || ''}`);
  const url = `${BASE_URL}/?s=${encodeURIComponent(query)}`;

  const $ = await fetchHtml(url, {
    headers: { Referer: `${BASE_URL}/` }
  });

  if (!$) return [];

  const results = [];

  $('article.generate-columns-container article.generate-columns, .generate-columns-container article.generate-columns, article.generate-columns')
    .each((_, element) => {
      const card = $(element);
      const titleLink = card.find('.entry-title a').first();
      const link = titleLink.attr('href');
      const titleText = cleanText(
        titleLink.text() || titleLink.attr('title')
      );

      const image = card.find(
        '.post-image img, img.wp-post-image'
      ).first();

      const poster =
        image.attr('data-src') ||
        image.attr('data-lazy-src') ||
        image.attr('data-original') ||
        image.attr('src') ||
        image.attr('data-srcset') ||
        image.attr('srcset') ||
        '';

      if (!link || !titleText) return;

      results.push({
        title: titleText,
        permalink: absoluteUrl(link),
        poster: absoluteUrl(
          String(poster).split(',')[0].trim().split(' ')[0]
        ),
        year: (
          titleText.match(/\b(?:19|20)\d{2}\b/) || []
        )[0] || ''
      });
    });

  const seen = new Set();

  return results.filter(item => {
    if (!item.permalink || seen.has(item.permalink)) return false;

    seen.add(item.permalink);
    return true;
  });
}

function choosePost(posts, info, type, season) {
  if (!posts.length) return null;

  const expected = info.title || '';

  const ranked = posts.map(post => {
    let score = titleScore(post.title, expected, info.year);

    if (isTv(type) && season) {
      const pattern = new RegExp(
        `(?:season|s)\\s*0*${Number(season)}\\b`,
        'i'
      );

      if (pattern.test(post.title)) {
        score += 50;
      } else if (/season|s\d{1,2}/i.test(post.title)) {
        score -= 25;
      }
    }

    return { post, score };
  }).sort((a, b) => b.score - a.score);

  return ranked[0].score >= 20 ? ranked[0].post : null;
}

function getQualityLinks($, postUrl) {
  const links = [];

  const selectors = [
    'a.maxbutton-1',
    'a.maxbutton-2',
    'a.maxbutton-3',
    'a.maxbutton-480p',
    'a.maxbutton-720p',
    'a.maxbutton-1080p',
    'a.maxbutton'
  ].join(', ');

  $(selectors).each((_, element) => {
    const anchor = $(element);
    const href = unwrapUrl(anchor.attr('href'));

    const label = cleanText(
      anchor.find('.mb-text').text() ||
      anchor.text() ||
      anchor.attr('aria-label')
    );

    if (!href || !/^https?:\/\//i.test(href)) return;

    links.push({
      url: href,
      label: label || 'Download',
      quality: qualityFrom(label)
    });
  });

  if (!links.length) {
    $('.entry-content a[href]').each((_, element) => {
      const anchor = $(element);
      const href = unwrapUrl(anchor.attr('href'));
      const label = cleanText(
        anchor.text() || anchor.attr('title')
      );

      if (
        !href ||
        !/^https?:\/\//i.test(href) ||
        !LINK_HOSTS.test(href)
      ) return;

      links.push({
        url: href,
        label: label || 'Download',
        quality: qualityFrom(label)
      });
    });
  }

  const seen = new Set();

  return links.filter(link => {
    if (seen.has(link.url)) return false;

    seen.add(link.url);
    return true;
  });
}

function collectOutboundLinks($, pageUrl) {
  const links = [];

  $('a[href], iframe[src], source[src]').each((_, element) => {
    const node = $(element);
    const raw = node.attr('href') || node.attr('src');
    const url = unwrapUrl(absoluteUrl(raw, pageUrl));

    if (url && LINK_HOSTS.test(url)) {
      links.push(url);
    }
  });

  const html = $.html();

  const matches = html.match(
    /https?:\\?\/\\?\/[a-z0-9.-]+(?:\\?\/\\?\/|\/)[^\s"'<>\\]+/gi
  ) || [];

  for (const match of matches) {
    const url = match
      .replace(/\\\//g, '/')
      .replace(/\\u0026/g, '&');

    if (LINK_HOSTS.test(url)) {
      links.push(url);
    }
  }

  return [...new Set(links)];
}

function makeStream(url, title, quality, referer) {
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch (_) {
      return 'Server';
    }
  })();

  return {
    name: `${PROVIDER_NAME} | ${quality} | ${host}`,
    title: `${cleanText(title)}\n${quality} - ${host}`,
    url,
    _resWeight: resolutionWeight(quality),
    behaviorHints: {
      notWebReady: true,
      proxyHeaders: {
        request: {
          Referer: referer || `${BASE_URL}/`
        }
      }
    }
  };
}

async function resolveDownloadPage(
  url,
  title,
  quality,
  sourceReferer,
  depth = 0
) {
  const streams = [];

  if (!url || depth > 2) return streams;

  const $ = await fetchHtml(url, {
    headers: {
      Referer: sourceReferer || `${BASE_URL}/`
    }
  });

  if (!$) {
    if (/\.(mp4|mkv|m3u8)(?:$|\?)/i.test(url)) {
      streams.push(
        makeStream(url, title, quality, sourceReferer)
      );
    }

    return streams;
  }

  const links = collectOutboundLinks($, url);

  for (const link of links) {
    if (/\.(mp4|mkv|m3u8)(?:$|\?)/i.test(link)) {
      streams.push(makeStream(link, title, quality, url));
      continue;
    }

    if (depth < 2) {
      const nested = await resolveDownloadPage(
        link,
        title,
        quality,
        url,
        depth + 1
      );

      streams.push(...nested);
    } else if (/hubcloud|vcloud|workers\.dev|nexdrive/i.test(link)) {
      streams.push(makeStream(link, title, quality, url));
    }
  }

  return streams;
}

function dedupe(streams) {
  const seen = new Set();

  return streams
    .filter(stream => {
      if (!stream || !stream.url || seen.has(stream.url)) {
        return false;
      }

      seen.add(stream.url);
      return true;
    })
    .sort((a, b) => (b._resWeight || 0) - (a._resWeight || 0));
}

async function getStreams(
  id,
  type = 'movie',
  season = null,
  episode = null
) {
  try {
    const info = await getTMDBInfo(id, type);

    if (!info || !info.title) return [];

    const queries = [info.title];

    if (info.title.includes(':')) {
      queries.push(info.title.split(':')[0].trim());
    }

    let posts = [];

    for (const query of queries) {
      posts = await searchByTitle(query, info.year);

      if (posts.length) break;
    }

    if (!posts.length) return [];

    const matched = choosePost(posts, info, type, season);

    if (!matched) return [];

    const $ = await fetchHtml(matched.permalink, {
      headers: { Referer: `${BASE_URL}/` }
    });

    if (!$) return [];

    let qualityLinks = getQualityLinks($, matched.permalink);

    if (!qualityLinks.length) return [];

    if (isTv(type) && season && episode) {
      const episodePattern = new RegExp(
        `(?:s\\s*0*${Number(season)}\\s*e\\s*0*${Number(episode)}|season\\s*0*${Number(season)}[^\\d]{0,12}episode\\s*0*${Number(episode)})`,
        'i'
      );

      const episodeLinks = qualityLinks.filter(link =>
        episodePattern.test(link.label)
      );

      if (episodeLinks.length) {
        qualityLinks = episodeLinks;
      }
    }

    const streams = [];

    for (const link of qualityLinks) {
      const resolved = await resolveDownloadPage(
        link.url,
        `${info.title}${info.year ? ` (${info.year})` : ''}`,
        link.quality,
        matched.permalink
      );

      streams.push(...resolved);
    }

    return dedupe(streams);
  } catch (_) {
    return [];
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getStreams };
} else {
  global.getStreams = getStreams;
}

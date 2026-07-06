/**
 * LinkPreviewService - Open Graph Fetching with Caching
 */

const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const LinkPreviewCache = require('../models/LinkPreviewCache');
const ChatLogger = require('./ChatLogger');

const { EVENTS } = ChatLogger;

// Simple HTML parser for OG tags
function parseOgTags(html) {
  const result = {};

  // Title
  const titleMatch =
    html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i) ||
    html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) result.title = titleMatch[1].trim().substring(0, 500);

  // Description
  const descMatch =
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i) ||
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
  if (descMatch) result.description = descMatch[1].trim().substring(0, 1000);

  // Image
  const imgMatch =
    html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  if (imgMatch) result.imageUrl = imgMatch[1];

  // Site name
  const siteMatch =
    html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i);
  if (siteMatch) result.siteName = siteMatch[1].trim().substring(0, 200);

  return result;
}

/**
 * Fetch URL content with timeout
 */
function fetchUrl(url, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const protocol = parsedUrl.protocol === 'https:' ? https : http;

    const req = protocol.get(
      url,
      {
        timeout,
        headers: {
          'User-Agent': 'DocWellnessBot/1.0 (+https://docwellness.app)',
          Accept: 'text/html',
        },
      },
      (res) => {
        // Handle redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchUrl(res.headers.location, timeout).then(resolve).catch(reject);
          return;
        }

        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }

        let data = '';
        res.setEncoding('utf8');

        res.on('data', (chunk) => {
          data += chunk;
          // Limit to first 50KB
          if (data.length > 50000) {
            res.destroy();
          }
        });

        res.on('end', () => resolve(data));
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

/**
 * Generate URL hash for caching
 */
function hashUrl(url) {
  return crypto.createHash('sha256').update(url).digest('hex').substring(0, 32);
}

class LinkPreviewService {
  /**
   * Get link preview (from cache or fetch)
   * @param {string} url - URL to preview
   * @param {object} logContext - Logging context
   * @returns {Promise<object>} Preview data
   */
  static async getPreview(url, logContext = {}) {
    const startTime = Date.now();
    const urlHash = hashUrl(url);

    try {
      // Check cache first
      const cached = await LinkPreviewCache.findOne({
        urlHash,
        fetchStatus: 'success',
        expiresAt: { $gt: new Date() },
      });

      if (cached) {
        ChatLogger.timed(EVENTS.LINK_PREVIEW_CACHE_HIT, startTime, {
          ...logContext,
          url,
        });

        return {
          url,
          title: cached.title,
          description: cached.description,
          imageUrl: cached.imageUrl,
          siteName: cached.siteName,
          cached: true,
        };
      }

      // Fetch and parse
      ChatLogger.info(EVENTS.LINK_PREVIEW_FETCH, {
        ...logContext,
        url,
      });

      const html = await fetchUrl(url);
      const ogData = parseOgTags(html);

      // Store in cache
      await LinkPreviewCache.findOneAndUpdate(
        { urlHash },
        {
          url,
          urlHash,
          ...ogData,
          fetchStatus: 'success',
          fetchedAt: new Date(),
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
        { upsert: true, new: true }
      );

      ChatLogger.timed(EVENTS.LINK_PREVIEW_OK, startTime, {
        ...logContext,
        url,
        hasImage: !!ogData.imageUrl,
      });

      return {
        url,
        ...ogData,
        cached: false,
      };
    } catch (error) {
      // Store failed fetch in cache to avoid retrying too soon
      await LinkPreviewCache.findOneAndUpdate(
        { urlHash },
        {
          url,
          urlHash,
          fetchStatus: 'failed',
          fetchError: error.message,
          fetchedAt: new Date(),
          expiresAt: new Date(Date.now() + 1 * 60 * 60 * 1000), // Retry after 1 hour
        },
        { upsert: true, new: true }
      ).catch(() => {}); // Ignore cache write errors

      ChatLogger.error(EVENTS.LINK_PREVIEW_FAIL, {
        ...logContext,
        url,
        error,
        latency_ms: Date.now() - startTime,
      });

      return {
        url,
        error: error.message,
      };
    }
  }

  /**
   * Extract URLs from text
   * @param {string} text - Text to search
   * @returns {string[]} Array of URLs
   */
  static extractUrls(text) {
    if (!text) return [];

    const urlRegex = /(https?:\/\/[^\s<>"{}|\\^`\[\]]+)/gi;
    const matches = text.match(urlRegex);
    return matches || [];
  }
}

module.exports = LinkPreviewService;

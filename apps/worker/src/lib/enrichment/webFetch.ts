// Best-effort fetcher for a company's homepage. Used in structured mode
// (mode B) to inline website text into the prompt; agentic mode (A) skips
// this and lets Claude's web_fetch server tool handle navigation.
//
// SSRF: Company.website is user-controlled. Without a guard, a workspace
// member could set it to e.g. `http://169.254.169.254/...` (cloud
// metadata) or `http://postgres:5432/` (the docker service) and the
// fetched body would land in the LLM prompt. We block private/loopback/
// link-local hosts via `isPrivateHost`, controlled by the env flag
// `ENRICHMENT_ALLOW_PRIVATE_TARGETS` so homelab dev setups still work.
//
// We do redirects manually (rather than `redirect: 'follow'`) so the SSRF
// check runs on every hop — otherwise `https://example.com → http://10/`
// would slip through. Capped at 3 hops; most well-behaved sites resolve
// inside 2 (apex→canonical, http→https).
//
// HTML→text strip is regex-based to keep deps light; cheerio would be
// more accurate but pulls a meaningful weight into the worker for what's
// only "rough cut signal for the LLM." JS-only sites are flagged so the
// prompt can warn Claude.

import { logger } from '../../logger.js';
import { env } from '../../env.js';
import { isPrivateHost } from './ssrf.js';

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_TEXT_CHARS = 30_000;
const MAX_REDIRECTS = 3;
const USER_AGENT = 'PipelineFlow-Enrichment/1.0 (+https://pipelineflow.app)';

export interface FetchedSite {
  url: string;
  text: string;
  /** True when the body looks like a JS-only shell (e.g. <div id="root">
   *  with no meaningful body text). Lets the prompt warn Claude. */
  jsOnly: boolean;
}

export async function fetchCompanySite(rawUrl: string): Promise<FetchedSite | null> {
  const allowPrivate = env.ENRICHMENT_ALLOW_PRIVATE_TARGETS;
  const initial = normalizeUrl(rawUrl);
  if (!initial) return null;
  if (!allowPrivate && isPrivateHost(new URL(initial).hostname)) {
    logger.debug({ url: initial }, 'enrichment site fetch blocked: private host');
    return null;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let currentUrl = initial;
    let res: Response | null = null;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      res = await fetch(currentUrl, {
        headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,*/*' },
        redirect: 'manual',
        signal: controller.signal,
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get('location');
        if (!loc) break;
        let next: URL;
        try {
          next = new URL(loc, currentUrl);
        } catch {
          return null;
        }
        if (next.protocol !== 'https:' && next.protocol !== 'http:') {
          return null;
        }
        if (!allowPrivate && isPrivateHost(next.hostname)) {
          logger.debug(
            { from: currentUrl, to: next.toString() },
            'enrichment site fetch blocked: redirect into private host',
          );
          return null;
        }
        currentUrl = next.toString();
        continue;
      }
      break;
    }
    if (!res) return null;
    if (!res.ok) {
      logger.debug({ url: currentUrl, status: res.status }, 'enrichment site fetch non-2xx');
      return null;
    }
    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('text/html') && !ct.includes('text/plain')) {
      return null;
    }
    const buf = await readCapped(res, MAX_BYTES);
    const html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
    const text = htmlToText(html);
    const jsOnly = text.length < 200 && /<script/i.test(html);
    return {
      url: res.url || currentUrl,
      text: text.slice(0, MAX_TEXT_CHARS),
      jsOnly,
    };
  } catch (err) {
    logger.debug({ url: rawUrl, err }, 'enrichment site fetch failed');
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) {
    const buf = await res.arrayBuffer();
    return new Uint8Array(buf.slice(0, max));
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    total += value.length;
    if (total >= max) break;
  }
  const out = new Uint8Array(Math.min(total, max));
  let off = 0;
  for (const c of chunks) {
    if (off >= out.length) break;
    const room = out.length - off;
    out.set(c.subarray(0, Math.min(c.length, room)), off);
    off += Math.min(c.length, room);
  }
  return out;
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

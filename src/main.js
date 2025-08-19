import { Actor, log } from 'apify';
import { PlaywrightCrawler, RequestQueue } from 'crawlee';
import { gotScraping } from 'got-scraping';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/ig;
const PHONE_RE = /\+?1?\s*\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function cleanText(t) { return (t || '').replace(/\s+/g, ' ').trim(); }

function extractEmails(text) {
  if (!text) return [];
  const matches = text.match(EMAIL_RE) || [];
  return [...new Set(matches.map(e => e.toLowerCase()))];
}

function pickCompanyFromText(text) {
  if (/coldwell\s*banker/i.test(text)) return 'Coldwell Banker';
  return 'Coldwell Banker';
}

function splitName(full) {
  const parts = cleanText(full).split(' ').filter(Boolean);
  if (parts.length >= 2) return { first: parts[0], last: parts.slice(1).join(' ') };
  if (parts.length === 1) return { first: parts[0], last: '' };
  return { first: '', last: '' };
}

function preferEmail(emails, preferDomain) {
  if (!emails || emails.length === 0) return '';
  const ranked = emails.slice().sort((a, b) => {
    const aLocal = a.split('@')[0];
    const bLocal = b.split('@')[0];
    const aPref = preferDomain && a.endsWith(preferDomain) ? 0 : 1;
    const bPref = preferDomain && b.endsWith(preferDomain) ? 0 : 1;
    const aGen = ['info','contact','sales','hello','support'].includes(aLocal) ? 1 : 0;
    const bGen = ['info','contact','sales','hello','support'].includes(bLocal) ? 1 : 0;
    return aPref - bPref || aGen - bGen || a.length - b.length;
  });
  return ranked[0];
}

async function fetchOffsite(link, delayMs) {
  try {
    if (delayMs) await sleep(delayMs);
    const res = await gotScraping({ url: link, timeout: { request: 15000 } });
    return res.body || '';
  } catch {
    return '';
  }
}

async function getProfileLinks(page) {
  const links = await page.$$eval('a[href]', as => as.map(a => a.getAttribute('href')).filter(Boolean));
  const profs = [];
  for (const href of links) {
    if (href.includes('/agents/') && href.includes('aid-')) {
      try {
        const abs = new URL(href, page.url()).href;
        profs.push(abs);
      } catch {}
    }
  }
  return [...new Set(profs)];
}

async function getNextPageUrl(page) {
  const nextHandle = await page.$('a:has-text("Next")');
  if (nextHandle) {
    const href = await nextHandle.getAttribute('href');
    if (href) return new URL(href, page.url()).href;
  }
  const hrefs = await page.$$eval('a[href*="page="]', as => as.map(a => a.getAttribute('href')));
  for (const h of hrefs) {
    if (h) {
      try { return new URL(h, page.url()).href; } catch {}
    }
  }
  return null;
}

Actor.main(async () => {
  const input = await Actor.getInput() || {};
  const {
    startUrl = 'https://www.coldwellbanker.com/city/fl/jacksonville/agents',
    maxPages = 50,
    maxProfiles = 2000,
    concurrency = 5,
    perDomainDelayMs = 1000,
    followOffsiteMax = 5,
    preferDomain = '@cbvfl.com',
    listTag = 'Coldwell Banker JAX Agents',
  } = input;

  log.info('Starting with input', { startUrl, maxPages, maxProfiles, concurrency, followOffsiteMax });

  const auditDataset = await Actor.openDataset('AUDIT');
  const brevoDataset = await Actor.openDataset('BREVO');
  const seenEmails = new Set();
  const seenProfiles = new Set();

  const queue = await RequestQueue.open();
  await queue.addRequest({ url: startUrl, label: 'LIST', userData: { pageNo: 1 } });

  let profilesCount = 0;
  const crawler = new PlaywrightCrawler({
    requestQueue: queue,
    maxConcurrency: concurrency,
    requestHandlerTimeoutSecs: 60,
    navigationTimeoutSecs: 30,
    async requestHandler({ request, page }) {
      const { label } = request;
      if (label === 'LIST') {
        const { pageNo = 1 } = request.userData || {};
        await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
        const links = await getProfileLinks(page);
        for (const link of links) {
          if (seenProfiles.has(link)) continue;
          seenProfiles.add(link);
          if (profilesCount < maxProfiles) {
            await queue.addRequest({ url: link, label: 'PROFILE' });
          }
        }
        if (pageNo < maxPages) {
          const nextUrl = await getNextPageUrl(page);
          if (nextUrl) {
            await queue.addRequest({ url: nextUrl, label: 'LIST', userData: { pageNo: pageNo + 1 } });
          }
        }
        return;
      }

      if (label === 'PROFILE') {
        profilesCount++;
        await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
        const html = await page.content();
        const text = await page.textContent('body').catch(() => '') || '';

        let name = await page.locator('h1, .agent-name, [data-testid="agent-name"]').first().textContent().catch(() => '');
        name = cleanText(name);
        if (!name) {
          const og = await page.locator('meta[property="og:title"]').getAttribute('content').catch(() => '');
          if (og) name = cleanText(og.replace(/\| Coldwell Banker.*/i, ''));
        }

        let phone = '';
        const phoneMatch = (text || html).match(PHONE_RE);
        if (phoneMatch) phone = cleanText(phoneMatch[0]);

        const company = pickCompanyFromText(text || html);

        const emailsProfile = extractEmails(html);

        const anchors = await page.$$eval('a[href]', as => as.map(a => ({ href: a.href, text: a.innerText })));
        const candidates = [];
        for (const a of anchors) {
          const t = (a.text || '').toLowerCase();
          const href = a.href;
          if (!href) continue;
          if (href.includes('coldwellbanker.com') && href.includes('/agents/')) continue;
          if (t.includes('website') || t.includes('visit site') || t.includes('agent site')
            || /facebook\.com|instagram\.com|linkedin\.com|twitter\.com|x\.com|youtube\.com/i.test(href)
            || /^https?:\/\//i.test(href)) {
            candidates.push(href);
          }
        }
        const offsite = [...new Set(candidates)].slice(0, followOffsiteMax);

        let emailsOffsite = [];
        for (const link of offsite) {
          const body = await fetchOffsite(link, perDomainDelayMs);
          const found = extractEmails(body);
          if (found.length) emailsOffsite.push(...found);
        }
        emailsOffsite = [...new Set(emailsOffsite)];

        const allEmails = [...new Set([...(emailsProfile||[]), ...emailsOffsite])];
        const chosenEmail = preferEmail(allEmails, preferDomain);

        const website = offsite.length ? offsite[0] : '';

        await auditDataset.pushData({
          profile_url: request.url,
          name, phone, company,
          website,
          emails_found: allEmails,
          chosen_email: chosenEmail,
        });

        if (chosenEmail && !seenEmails.has(chosenEmail)) {
          seenEmails.add(chosenEmail);
          const { first, last } = splitName(name);
          await brevoDataset.pushData({
            EMAIL: chosenEmail,
            FIRSTNAME: first,
            LASTNAME: last,
            COMPANY: company,
            PHONE: phone,
            LISTS: listTag,
          });
        }
      }
    },
  });

  await crawler.run();

  log.info('Done. Download your CSV:');
  log.info(' - BREVO dataset → Export as CSV (EMAIL, FIRSTNAME, LASTNAME, COMPANY, PHONE, LISTS)');
  log.info(' - AUDIT dataset → Export for QA (profile_url, website, emails_found, chosen_email)');
});

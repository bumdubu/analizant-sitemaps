// Analizant — hreflang sitemap generatoru v1.1
// Blogger feed-ini oxuyur, tg-* etiketinə görə tərcümə qruplarını yığır,
// docs/sitemap-hreflang.xml faylını qurur. Node 20+ (daxili fetch).
// v1.1: ana səhifə üçün yüngül indeks — docs/home-index.json (hər yazının örtük şəkli və təsviri).
//       Ana səhifə kartları bu indeksi oxuyur və hər kart üçün yazının tam mətnini endirmir.

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { parseHTML } from 'linkedom';

const SITE = (process.env.SITE || 'https://www.analizant.com').replace(/\/$/, '');
const LANGS = ['az', 'en', 'ru'];
const DEFAULT_LANG = 'az';           // x-default bu dilə yönəlir
const LANG_PREFIX = 'lang-';
const GROUP_PREFIX = 'tg-';
const PAGE_SIZE = 150;               // Blogger feed limiti

const warnings = [];
const warn = (m) => { warnings.push(m); console.warn('⚠ ' + m); };

const clean = (u) => u.split('#')[0].split('?')[0].replace(/^http:/, 'https:');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

async function fetchAllPosts() {
  const out = [];
  for (let start = 1; ; start += PAGE_SIZE) {
    const url = `${SITE}/feeds/posts/default?alt=json&max-results=${PAGE_SIZE}&start-index=${start}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'analizant-sitemap-bot/1.0' } });
    if (!r.ok) throw new Error(`Feed alınmadı (${r.status}): ${url}`);
    const j = await r.json();
    const entries = (j.feed && j.feed.entry) || [];
    out.push(...entries);
    if (entries.length < PAGE_SIZE) break;
  }
  return out;
}

// Ana səhifə indeksi: temadakı məntiqin eynisi (təsvir + örtük şəkli).
// d — .homepage-description, yoxsa 80 simvoldan uzun ilk <p> (sənəd sırası ilə — brauzerdəki kimi)
// i — #hero img, yoxsa ilk <img>;  u — yazının son yenilənmə vaxtı (köhnəlmiş qeydi tanımaq üçün)
const DESC_SEL = '.homepage-description, #homepage-description, [data-homepage-description]';
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
function indexEntry(e) {
  const m = String((e.id && e.id.$t) || '').match(/post-(\d+)/);
  if (!m) return null;
  const html = (e.content && e.content.$t) || '';
  const { document } = parseHTML('<!doctype html><html><body>' + html + '</body></html>');
  const dn = document.querySelector(DESC_SEL);
  let d = dn ? norm(dn.getAttribute('data-homepage-description') || dn.textContent) : '';
  if (!d) for (const n of document.querySelectorAll('p')) { const x = norm(n.textContent); if (x.length > 80) { d = x; break; } }
  const im = document.querySelector('#hero img') || document.querySelector('img');
  let i = im ? (im.getAttribute('src') || '') : '';
  if (!/^https?:|^\/\//.test(i)) i = '';
  return [m[1], { i, d: d.slice(0, 600), u: (e.updated && e.updated.$t) || '' }];
}

function parseEntry(e) {
  const labels = (e.category || []).map((c) => c.term);
  const langLabels = labels.filter((t) => t.startsWith(LANG_PREFIX));
  const groupLabels = labels.filter((t) => t.startsWith(GROUP_PREFIX));
  const alt = (e.link || []).find((l) => l.rel === 'alternate');
  const title = e.title && e.title.$t;
  // Əsas mənbə: yazı içindəki <script id="az-post-lang">{lang, family, alt}</script>
  let fam = null;
  const m = ((e.content && e.content.$t) || '').match(/id=["']az-post-lang["'][^>]*>([\s\S]*?)<\/script>/);
  if (m) { try { fam = JSON.parse(m[1]); } catch (err) { warn(`"${title}" — az-post-lang JSON pozulub`); } }
  if (langLabels.length > 1) warn(`"${title}" — birdən çox dil etiketi var: ${langLabels.join(', ')}`);
  if (groupLabels.length > 1) warn(`"${title}" — birdən çox qrup etiketi var: ${groupLabels.join(', ')}`);
  let lang = fam && fam.lang ? fam.lang : (langLabels.length ? langLabels[0].slice(LANG_PREFIX.length) : DEFAULT_LANG);
  if (fam && langLabels.length && langLabels[0].slice(LANG_PREFIX.length) !== fam.lang) warn(`"${title}" — etiket (${langLabels[0]}) ilə az-post-lang (${fam.lang}) uyğun gəlmir`);
  if (!LANGS.includes(lang)) { warn(`"${title}" — naməlum dil etiketi: ${langLabels[0]}`); lang = null; }
  return {
    title,
    lang,
    group: (fam && fam.family) ? 'family:' + fam.family : (groupLabels[0] || null),
    hasLangLabel: langLabels.length > 0 || !!fam,
    url: alt ? clean(alt.href) : null,
    updated: e.updated && e.updated.$t,
  };
}

async function loadPageGroups() {
  try {
    const raw = JSON.parse(await readFile(new URL('./pages.json', import.meta.url), 'utf8'));
    return (raw.groups || []).map((g) => {
      const versions = {};
      for (const l of LANGS) if (g[l]) versions[l] = { url: clean(g[l]), updated: null };
      return { name: g.name || '(adsız səhifə)', versions };
    });
  } catch (err) {
    warn('pages.json oxunmadı: ' + err.message);
    return [];
  }
}

function urlBlock(selfUrl, updated, versions) {
  const links = LANGS.filter((l) => versions[l])
    .map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${esc(versions[l].url)}"/>`);
  const xdef = (versions[DEFAULT_LANG] || versions[Object.keys(versions)[0]]).url;
  links.push(`    <xhtml:link rel="alternate" hreflang="x-default" href="${esc(xdef)}"/>`);
  const lastmod = updated ? `\n    <lastmod>${esc(updated.slice(0, 10))}</lastmod>` : '';
  return `  <url>\n    <loc>${esc(selfUrl)}</loc>${lastmod}\n${links.join('\n')}\n  </url>`;
}

async function main() {
  const raw = await fetchAllPosts();
  const posts = raw.map(parseEntry);
  const groups = new Map();

  for (const p of posts) {
    if (!p.url || !p.lang) continue;
    if (!p.group) {
      if (p.hasLangLabel && p.lang !== DEFAULT_LANG) warn(`"${p.title}" (${p.lang}) — nə az-post-lang family, nə tg-* etiketi var; orijinala bağlanmayıb`);
      continue;
    }
    if (!groups.has(p.group)) groups.set(p.group, {});
    const g = groups.get(p.group);
    if (g[p.lang]) { warn(`${p.group} — "${p.lang}" dilində iki yazı var; biri nəzərə alınmadı: ${p.url}`); continue; }
    g[p.lang] = { url: p.url, updated: p.updated };
  }

  const blocks = [];
  let postGroups = 0;
  for (const [name, versions] of groups) {
    const n = Object.keys(versions).length;
    if (n < 2) { warn(`${name} — qrupda tək versiya var (${Object.keys(versions)[0]}); tərcümə hələ yayımlanmayıb?`); continue; }
    if (!versions[DEFAULT_LANG]) warn(`${name} — orijinal (az) versiyada tg etiketi yoxdur; x-default başqa dilə yönəldi`);
    postGroups++;
    for (const l of Object.keys(versions)) blocks.push(urlBlock(versions[l].url, versions[l].updated, versions));
  }

  const pageGroups = await loadPageGroups();
  for (const g of pageGroups) {
    if (Object.keys(g.versions).length < 2) continue;
    for (const l of Object.keys(g.versions)) blocks.push(urlBlock(g.versions[l].url, null, g.versions));
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${blocks.join('\n')}
</urlset>
`;

  await mkdir(new URL('./docs/', import.meta.url), { recursive: true });
  await writeFile(new URL('./docs/sitemap-hreflang.xml', import.meta.url), xml);
  // Səhifə qrupları JS modulu üçün də dərc olunur (GitHub Pages CORS-a icazə verir)
  await writeFile(new URL('./docs/pages.json', import.meta.url),
    JSON.stringify({ groups: pageGroups.map((g) => Object.fromEntries(Object.entries(g.versions).map(([l, v]) => [l, v.url]))) }, null, 2));
  await writeFile(new URL('./docs/.nojekyll', import.meta.url), '');
  // Ana səhifə indeksi
  const index = { v: 1, built: new Date().toISOString(), posts: {} };
  for (const e of raw) { try { const r = indexEntry(e); if (r) index.posts[r[0]] = r[1]; } catch (err) { warn('indeks: ' + (e.title && e.title.$t) + ' — ' + err.message); } }
  await writeFile(new URL('./docs/home-index.json', import.meta.url), JSON.stringify(index));

  const report = [
    `Son qurulma: ${new Date().toISOString()}`,
    `Sayt: ${SITE}`,
    `Yoxlanan yazı: ${posts.length}`,
    `Tərcümə qrupu (yazı): ${postGroups}`,
    `Tərcümə qrupu (səhifə): ${pageGroups.filter((g) => Object.keys(g.versions).length > 1).length}`,
    `Sitemap-dəki URL: ${blocks.length}`,
    `Ana səhifə indeksi: ${Object.keys(index.posts).length} yazı`,
    '',
    warnings.length ? 'XƏBƏRDARLIQLAR:\n- ' + warnings.join('\n- ') : 'Xəbərdarlıq yoxdur.',
  ].join('\n');
  await writeFile(new URL('./docs/report.txt', import.meta.url), report + '\n');
  console.log('\n' + report);
}

main().catch((e) => { console.error(e); process.exit(1); });

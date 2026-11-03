/**
 * MealPrep AI — backend proxy
 * ---------------------------------------------------------------
 * The OpenAI key must NEVER sit in the browser. This tiny Node
 * server (no dependencies) holds the key server-side and exposes
 * two endpoints the front-end calls:
 *
 *   POST /api/recipes  { cuisine, servings }        -> recipe list
 *   POST /api/summary  { url, name }                -> ingredients + steps
 *
 * Run:
 *   npm start                      (after `export OPENAI_API_KEY=sk-...`)
 *   OPENAI_API_KEY=sk-... node server.js
 *
 * Then open http://localhost:8787
 * ---------------------------------------------------------------
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = process.env.PORT || 8787;
const API_KEY = process.env.OPENAI_API_KEY;
const MODEL = process.env.OPENAI_MODEL || 'gpt-4o';
const MIN_RATING = 4.5;

if (!API_KEY) {
  console.error('\n  Missing OPENAI_API_KEY.\n  Run it like:  OPENAI_API_KEY=sk-... node server.js\n');
  process.exit(1);
}

/* ------------------------------------------------------------------ */
/* OpenAI helper                                                       */
/* ------------------------------------------------------------------ */

async function askOpenAI(system, user, { json = true, temperature = 0.7 } = {}) {
  const body = {
    model: MODEL,
    temperature,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
  if (json) body.response_format = { type: 'json_object' };

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const detail = await res.text();
    const err = new Error(`OpenAI ${res.status}: ${detail.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '';
  if (!json) return text;

  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('Model did not return JSON.');
    return JSON.parse(match[0]);
  }
}

/* ------------------------------------------------------------------ */
/* Prompt 1 — find recipes                                             */
/* ------------------------------------------------------------------ */

const FIND_SYSTEM = `You are a recipe research assistant for a meal-prep website.

You recommend real, well-reviewed recipe articles from the open web for home cooks who
batch-cook for the week.

HARD RULES
- Every recipe you return MUST have an average rating of ${MIN_RATING} or higher out of 5.
  If you are not confident a recipe clears ${MIN_RATING}, do not return it. Never invent a
  rating to fill a slot — a shorter list is better than a dishonest one.
- Prefer recipe sites, food blogs and major outlets that publish star ratings
  (Serious Eats, NYT Cooking, Bon Appetit, Allrecipes, BBC Good Food, RecipeTin Eats,
  Budget Bytes, Simply Recipes, Smitten Kitchen, Food52 and similar).
- Give a real, working source_url where the recipe lives. If you cannot recall a dependable
  URL for a dish, leave it out.
- Scale every ingredient quantity so it genuinely feeds the requested number of people,
  and say the number you scaled to inside "why_it_fits".
- Keep "summary" to 25 words or fewer. Keep "why_it_fits" to 20 words or fewer.

You reply with JSON only, no prose and no markdown fences, shaped exactly like:
{
  "recipes": [
    {
      "name": "Chicken Tinga Tacos",
      "cuisine": "Mexican",
      "rating": 4.8,
      "rating_count": 412,
      "source_name": "Serious Eats",
      "source_url": "https://...",
      "prep_minutes": 20,
      "cook_minutes": 35,
      "summary": "Smoky chipotle-braised chicken shredded into tortillas; reheats beautifully.",
      "image_query": "chicken tinga tacos close up plate",
      "why_it_fits": "Scales cleanly to 6 servings; holds 4 days refrigerated."
    }
  ]
}`;

function findUserPrompt(cuisine, servings, count) {
  const today = new Date().toISOString().slice(0, 10);
  return `Find ${count} dinner recipes.

Cuisine the household wants: ${cuisine}
Number of people to meal prep for: ${servings}
Today's date: ${today}

Aim for variety: different proteins, different cooking methods, and a mix of
weeknight-fast and weekend-longer dishes. Every one must be rated ${MIN_RATING}+ out of 5
by real reviewers. Scale the quantities mentally for ${servings} people and note the
scaling in why_it_fits. Return JSON only.`;
}

/* ------------------------------------------------------------------ */
/* Prompt 2 — summarise a recipe article                               */
/* ------------------------------------------------------------------ */

const SUMMARY_SYSTEM = `You reduce a recipe article to a clean, cooked-from shopping list and method.

Read the article text you are given. Ignore everything that is not the recipe: ads,
life stories, SEO filler, comment threads, newsletter prompts, related-post links.

Return JSON only, no prose and no markdown fences, shaped exactly like:
{
  "title": "Recipe name",
  "servings": "6 servings",
  "prep_minutes": 20,
  "cook_minutes": 35,
  "rating": 4.8,
  "rating_count": 412,
  "rating_source": "Serious Eats",
  "verdict": "One line on what makes this recipe worth cooking.",
  "storage": "How to store and reheat it across the week.",
  "groups": [
    {
      "heading": "For the chicken",
      "items": [ { "quantity": "2 lb", "item": "boneless chicken thighs" } ]
    },
    {
      "heading": null,
      "items": [ { "quantity": "1 tsp", "item": "kosher salt" } ]
    }
  ],
  "steps": [
    {
      "n": 1,
      "text": "Short imperative instruction.",
      "minutes": 8
    }
  ]
}

RULES
- "groups" holds the ingredient list. Use headings ONLY where the recipe has them
  (e.g. "For the sauce"); otherwise set heading to null and keep one flat group.
- Split every ingredient into a compact "quantity" and the "item" itself. Front-load the
  quantity so the list scans like a shopping list.
- "steps": one action per step, written in the imperative, 30 words or fewer each.
  Never merge two actions into one step. "minutes" is your best estimate of the active
  time for that step, or null.
- If the article gives no rating, set rating to null rather than guessing.
- If the given text is not actually a recipe, return {"error": "not a recipe"}.
- Obey the SCALE INSTRUCTION that follows the article — it overrides the original yield.`;

/* ------------------------------------------------------------------ */
/* Optional suggested photo, via the free Openverse API (no key)       */
/* ------------------------------------------------------------------ */

async function findPhoto(imageQuery) {
  try {
    const url =
      'https://api.openverse.org/v1/images/?' +
      new URLSearchParams({
        q: imageQuery,
        license_type: 'commercial',
        page_size: '3',
        mature: 'false',
      }).toString();

    const res = await fetch(url, {
      headers: { 'User-Agent': 'MealPrepAI/1.0 (demo project)' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;

    const data = await res.json();
    const hit = (data.results || []).find((r) => r.thumbnail || r.url);
    if (!hit) return null;

    return {
      url: hit.thumbnail || hit.url,
      title: hit.title || '',
      creator: hit.creator || '',
      license: (hit.license || '').toUpperCase(),
      license_url: hit.license_url || '',
      foreign_landing_url: hit.foreign_landing_url || hit.url,
    };
  } catch {
    return null; // a missing photo must never break the recipe list
  }
}

/* ------------------------------------------------------------------ */
/* Static file serving                                                 */
/* ------------------------------------------------------------------ */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.join(__dirname, 'public', path.normalize(rel));

  if (!file.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1_000_000) reject(new Error('Payload too large'));
    });
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* Routes                                                              */
/* ------------------------------------------------------------------ */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const { pathname } = url;

  // ---- health
  if (pathname === '/api/health') {
    return sendJSON(res, 200, { ok: true, model: MODEL, minRating: MIN_RATING });
  }

  // ---- 1. find recipes
  if (pathname === '/api/recipes' && req.method === 'POST') {
    try {
      const { cuisine = '', servings = 4, count = 6, exclude = [] } = await readBody(req);
      if (!cuisine.trim()) return sendJSON(res, 400, { error: 'A cuisine is required.' });

      const n = Math.max(3, Math.min(9, Number(count) || 6));
      let user = findUserPrompt(cuisine, servings, n);
      if (Array.isArray(exclude) && exclude.length) {
        user += `\n\nDo NOT repeat any of these dishes, which the user has already seen: ${exclude
          .slice(0, 25)
          .join('; ')}. Offer fresh dishes instead, still ${MIN_RATING}+ rated.`;
      }

      const out = await askOpenAI(FIND_SYSTEM, user, { temperature: 0.85 });
      // Filter in code too — never trust the model's own claim blindly.
      const recipes = (out.recipes || [])
        .filter((r) => r && r.name && Number(r.rating) >= MIN_RATING)
        .slice(0, n);

      const withPhotos = await Promise.all(
        recipes.map(async (r) => ({
          ...r,
          photo: await findPhoto(r.image_query || `${r.name} plated dish`),
        }))
      );

      console.log(`[recipes] "${cuisine}" x${servings} -> ${withPhotos.length} returned`);
      return sendJSON(res, 200, { recipes: withPhotos, minRating: MIN_RATING });
    } catch (err) {
      console.error('[recipes]', err.message);
      return sendJSON(res, err.status || 500, { error: humanError(err) });
    }
  }

  // ---- 2. summarise one recipe article
  if (pathname === '/api/summary' && req.method === 'POST') {
    try {
      const { url: srcUrl, name, servings = 4 } = await readBody(req);
      if (!srcUrl) return sendJSON(res, 400, { error: 'A recipe URL is required.' });

      // Fetch the article ourselves so the summary rests on the real page.
      let article = '';
      let fetched = false;
      try {
        const page = await fetch(srcUrl, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
          },
          redirect: 'follow',
          signal: AbortSignal.timeout(15000),
        });
        if (page.ok) {
          const html = await page.text();
          article = html
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
            .replace(/<!--[\s\S]*?-->/g, ' ')
            .replace(/<\/(p|div|li|h[1-6]|br|tr)>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&amp;/g, '&')
            .replace(/&#39;|&rsquo;|&apos;/g, "'")
            .replace(/&quot;|&ldquo;|&rdquo;/g, '"')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
          fetched = true;
        }
      } catch {
        fetched = false;
      }

      let user;
      if (fetched && article.length > 400) {
        user = `ARTICLE URL: ${srcUrl}
ARTICLE TITLE (from source): ${name || '(unknown)'}

SCALE INSTRUCTION: Rescale all ingredient quantities so this feeds exactly ${servings} people.
Set "servings" in the JSON to "${servings} servings".

--- BEGIN ARTICLE TEXT ---
${article.slice(0, 60000)}
--- END ARTICLE TEXT ---`;
      } else {
        // Paywall, JS-only page or no network: fall back to the model's own knowledge of
        // the dish, and mark the result so the reader knows it was not read off the page.
        user = `ARTICLE URL: ${srcUrl}
ARTICLE TITLE: ${name || '(unknown)'}

SCALE INSTRUCTION: Write this for exactly ${servings} people. Set "servings" to "${servings} servings".

The page text could not be retrieved (paywall or JavaScript-only page). Reconstruct the
canonical ingredients and method for this dish from your own knowledge, and set
"fetched_from_article" to false in the JSON. Be accurate and conservative: do not invent
awards, ratings or specific claims.`;
      }

      const out = await askOpenAI(SUMMARY_SYSTEM, user, { json: true, temperature: 0.3 });
      if (out.error) return sendJSON(res, 422, { error: out.error });

      out.fetched_from_article = !!(fetched && article.length > 400);
      out.source_url = srcUrl;
      console.log(`[summary] ${name} — fetched=${out.fetched_from_article}`);
      return sendJSON(res, 200, out);
    } catch (err) {
      console.error('[summary]', err.message);
      return sendJSON(res, err.status || 500, { error: humanError(err) });
    }
  }

  if (pathname.startsWith('/api/')) return sendJSON(res, 404, { error: 'Unknown endpoint.' });
  return serveStatic(req, res, pathname);
});

function humanError(err) {
  if (err.status === 401) return 'The OpenAI API key was rejected. Check OPENAI_API_KEY.';
  if (err.status === 429) return 'OpenAI rate limit or out of credit. Try again shortly.';
  if (err.status >= 500) return 'OpenAI had a server error. Try again.';
  return err.message || 'Something went wrong.';
}

server.listen(PORT, () => {
  console.log(`\n  MealPrep AI running →  http://localhost:${PORT}`);
  console.log(`  model: ${MODEL} · minimum rating: ${MIN_RATING}\n`);
});

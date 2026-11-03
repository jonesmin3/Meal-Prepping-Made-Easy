/* =====================================================================
   MealPrep AI — front-end
   Flow: cuisine → servings → AI search → pick a card → summarised recipe
   All OpenAI calls go through /api/* on this same origin. No key here.
   ===================================================================== */

const $ = (id) => document.getElementById(id);

const CUISINES = [
  { label: 'Italian', emoji: '🍝' },
  { label: 'Mexican', emoji: '🌮' },
  { label: 'Japanese', emoji: '🍱' },
  { label: 'Indian', emoji: '🍛' },
  { label: 'Thai', emoji: '🍜' },
  { label: 'Chinese', emoji: '🥟' },
  { label: 'Korean', emoji: '🍲' },
  { label: 'Mediterranean', emoji: '🫒' },
  { label: 'American comfort', emoji: '🥘' },
  { label: 'French', emoji: '🥖' },
  { label: 'Greek', emoji: '🧆' },
  { label: 'Vietnamese', emoji: '🍲' },
];

const SERVING_PRESETS = [
  { n: 1, hint: 'just me' },
  { n: 2, hint: 'couple' },
  { n: 4, hint: 'family of 4' },
  { n: 6, hint: 'big batch' },
  { n: 8, hint: 'freezer stash' },
];

const state = {
  cuisine: '',
  servings: 4,
  recipes: [],
  seen: [],          // dish names already shown, so Refresh never repeats
  active: null,      // the currently selected recipe
  lastView: 'results',
};

const STEPS = ['step-cuisine', 'step-servings', 'step-loading', 'step-results', 'step-detail', 'step-error'];
function show(id) {
  STEPS.forEach((s) => { $(s).hidden = s !== id; });
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function showError(msg, retry) {
  $('error-text').textContent = msg;
  $('error-retry').onclick = retry;
  show('step-error');
}
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ── Step 1 — cuisine ─────────────────────────────────────────────── */

function buildCuisineChips() {
  const wrap = $('cuisine-chips');
  wrap.innerHTML = '';
  CUISINES.forEach(({ label, emoji }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = `${emoji} ${label}`;
    b.setAttribute('aria-pressed', 'false');
    b.onclick = () => selectCuisine(label);
    wrap.appendChild(b);
  });
}

function selectCuisine(label) {
  state.cuisine = label;
  [...$('cuisine-chips').children].forEach((chip) => {
    const match = chip.textContent.includes(label);
    chip.setAttribute('aria-pressed', String(match));
  });
  $('cuisine-custom').value = label;
  $('to-servings').disabled = false;
}

$('cuisine-use-custom').onclick = () => {
  const v = $('cuisine-custom').value.trim();
  if (!v) return;
  state.cuisine = v;
  [...$('cuisine-chips').children].forEach((c) => c.setAttribute('aria-pressed', 'false'));
  $('to-servings').disabled = false;
};
$('cuisine-custom').addEventListener('input', () => {
  $('to-servings').disabled = !$('cuisine-custom').value.trim();
});
$('cuisine-custom').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('cuisine-use-custom').click();
});
$('to-servings').onclick = () => {
  state.cuisine = $('cuisine-custom').value.trim() || state.cuisine;
  if (!state.cuisine) return;
  $('servings-context').textContent = `${state.cuisine} for dinner. Now, how many mouths?`;
  buildServingPresets();
  show('step-servings');
};

/* ── Step 2 — servings ────────────────────────────────────────────── */

function buildServingPresets() {
  const wrap = $('serving-presets');
  wrap.innerHTML = '';
  SERVING_PRESETS.forEach(({ n, hint }) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chip';
    b.textContent = `${n} — ${hint}`;
    b.onclick = () => setServings(n);
    wrap.appendChild(b);
  });
}

function setServings(n) {
  state.servings = Math.max(1, Math.min(20, Number(n) || 1));
  $('servings').value = state.servings;
  $('servings-unit').textContent = state.servings === 1 ? 'person' : 'people';
  [...$('serving-presets').children].forEach((c) =>
    c.setAttribute('aria-pressed', String(c.textContent.startsWith(`${state.servings} —`))));
  const perMeal = state.servings;
  $('servings-hint').textContent =
    `Every ingredient list gets rescaled to feed ${perMeal}. Leftovers store fine for a few days.`;
}

$('minus').onclick = () => setServings(state.servings - 1);
$('plus').onclick = () => setServings(state.servings + 1);
$('servings').addEventListener('change', (e) => setServings(e.target.value));
$('back-cuisine').onclick = () => show('step-cuisine');
$('find-recipes').onclick = () => findRecipes({ refresh: false });

/* ── Loading theatre ──────────────────────────────────────────────── */

const LOADING_LINES = [
  'Reading the cuisine and portioning for your household…',
  'Scanning rated recipe articles across the web…',
  'Discarding everything under 4.5 stars…',
  'Pulling main photos for each dish…',
  'Scaling quantities to your serving size…',
];

let loadingTimer = null;
function startLoading(title, sub) {
  $('loading-title').textContent = title;
  $('loading-sub').textContent = sub;
  const list = $('loading-list');
  list.innerHTML = LOADING_LINES.map((t) => `<li>${esc(t)}</li>`).join('');
  let i = 0;
  const tick = () => {
    const items = [...list.children];
    items.forEach((li, idx) => {
      li.classList.toggle('done', idx < i);
      li.classList.toggle('active', idx === i);
    });
    i = Math.min(i + 1, items.length);
  };
  tick();
  loadingTimer = setInterval(tick, 1400);
  show('step-loading');
}
function stopLoading() {
  clearInterval(loadingTimer);
  loadingTimer = null;
}

/* ── API ──────────────────────────────────────────────────────────── */

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function findRecipes({ refresh }) {
  startLoading(
    refresh ? 'Finding a fresh set of ideas…' : 'Searching for the best-rated recipes…',
    `Only 4.5★ and above · scaled for ${state.servings} ${state.servings === 1 ? 'person' : 'people'}.`
  );
  try {
    const data = await api('/api/recipes', {
      cuisine: state.cuisine,
      servings: state.servings,
      count: 6,
      exclude: state.seen,
    });
    stopLoading();

    const fresh = (data.recipes || []).filter((r) => r && r.name);
    if (!fresh.length) {
      return showError(
        `No recipe cleared the 4.5★ bar for “${state.cuisine}”. Try a broader cuisine such as “Mediterranean” or “Asian”.`,
        () => findRecipes({ refresh })
      );
    }
    if (refresh) {
      state.recipes = fresh;                       // a refresh replaces the board
    } else {
      state.recipes = fresh;
      state.seen = [];
    }
    state.seen = [...new Set([...state.seen, ...state.recipes.map((r) => r.name)])].slice(-24);
    renderResults(refresh);
  } catch (err) {
    stopLoading();
    showError(err.message, () => findRecipes({ refresh }));
  }
}

/* ── Step 3 — results grid ────────────────────────────────────────── */

function renderResults(refreshed) {
  $('results-context').textContent =
    `${state.cuisine} · feeding ${state.servings} ${state.servings === 1 ? 'person' : 'people'} · ${state.recipes.length} options`;
  $('results-note').textContent =
    'Tap a card to get the ingredients and method, stripped of everything else.';

  const grid = $('recipe-grid');
  grid.innerHTML = '';

  state.recipes.forEach((r, idx) => {
    const card = document.createElement('article');
    card.className = 'card';

    const ratingCount = r.rating_count ? `<small>(${esc(r.rating_count)})</small>` : '';
    const photo = r.photo && r.photo.url
      ? `<img src="${esc(r.photo.url)}" alt="${esc(r.name)}"
              loading="lazy" referrerpolicy="no-referrer"
              onerror="this.closest('.card-photo').classList.add('no-photo');this.remove();">`
      : '';
    const glyph = r.photo && r.photo.url ? '' : `<span class="glyph">🍽️</span>`;
    const minutes = (r.prep_minutes || 0) + (r.cook_minutes || 0);

    card.innerHTML = `
      <div class="card-photo ${photo ? '' : 'no-photo'}">
        ${photo}${glyph}
        <span class="rating">★ ${esc(Number(r.rating).toFixed(1))} ${ratingCount}</span>
      </div>
      <div class="card-body">
        <p class="card-tag">${esc(r.cuisine || state.cuisine)}</p>
        <h2 class="card-title">${esc(r.name)}</h2>
        <p class="card-sum">${esc(r.summary || '')}</p>
        <div class="card-foot">
          <span class="card-src">${esc(r.source_name || 'Source')}${minutes ? ` · ${minutes} min` : ''}</span>
          <button class="btn btn-primary" type="button" style="padding:.5rem 1rem;font-size:.85rem">Open</button>
        </div>
      </div>`;

    const open = () => openRecipe(r, idx);
    card.querySelector('button').onclick = open;
    card.querySelector('.card-title').style.cursor = 'pointer';
    card.querySelector('.card-title').onclick = open;
    grid.appendChild(card);
  });

  $('results-h').textContent = refreshed ? 'Fresh picks' : "Pick tonight's plan";
  show('step-results');
}

$('refresh').onclick = () => findRecipes({ refresh: true });
$('back-servings').onclick = () => show('step-servings');
$('detail-refresh').onclick = () => findRecipes({ refresh: true });
$('detail-back').onclick = () => show('step-results');
$('back-results').onclick = () => show('step-results');

/* ── Step 4 — the summarised recipe ───────────────────────────────── */

async function openRecipe(recipe, idx) {
  state.active = recipe;
  state.lastView = 'results';

  // Paint instantly with whatever the card already knows, then refine.
  $('detail-h').textContent = recipe.name;
  $('detail-summary').textContent = recipe.summary || '';
  $('detail-verdict').textContent = '';
  $('detail-img').src = (recipe.photo && recipe.photo.url) || '';
  $('detail-img').alt = recipe.name;
  $('detail-credit').textContent = recipe.photo
    ? [recipe.photo.creator, recipe.photo.license && `${recipe.photo.license} licensed`,
       recipe.photo.foreign_landing_url ? 'via Openverse' : ''].filter(Boolean).join(' · ')
    : 'No photo suggestion available for this one.';
  $('detail-badges').innerHTML = badgeHTML(recipe);
  $('ingredients').innerHTML = `<p class="micro">Summarising the ingredients…</p>`;
  $('steps').innerHTML = `<li style="border:none">Reading the article and stripping it to the method…</li>`;
  $('storage').innerHTML = '';
  show('step-detail');

  try {
    const s = await api('/api/summary', {
      url: recipe.source_url,
      name: recipe.name,
      servings: state.servings,
    });

    $('detail-h').textContent = s.title || recipe.name;
    $('detail-verdict').textContent = s.verdict || '';
    $('detail-badges').innerHTML = badgeHTML(s, recipe);
    $('ingredients-sub').textContent =
      `Scaled for ${esc(s.servings || state.servings)} — tap through it at the shop.`;

    renderIngredients(s.groups);
    renderSteps(s.steps);
    $('method-sub').textContent = (s.prep_minutes || s.cook_minutes)
      ? `${s.prep_minutes || '—'} min prep · ${s.cook_minutes || '—'} min cook`
      : '';
    $('storage').innerHTML = s.storage ? `<strong>Storage:</strong> ${esc(s.storage)}` : '';
    $('ingredients-sub').textContent += s.fetched_from_article === false
      ? ' ⚠︎ Source page could not be read; reconstructed from the dish name.'
      : '';
  } catch (err) {
    $('ingredients').innerHTML = `<p class="micro">⚠︎ ${esc(err.message)}</p>`;
    $('steps').innerHTML = '';
  }
}

function badgeHTML(s, fallback) {
  const rating = s.rating ?? fallback?.rating;
  const count = s.rating_count ?? fallback?.rating_count;
  const source = s.rating_source || fallback?.source_name;
  const out = [];
  if (rating != null) {
    out.push(`<span class="badge badge-star">★ ${esc(Number(rating).toFixed(1))}${
      count ? ` <span style="opacity:.75">(${esc(count)})</span>` : ''}</span>`);
  }
  if (source) out.push(`<span class="badge badge-plain">${esc(source)}</span>`);
  if (fallback?.source_url) {
    out.push(`<a class="badge badge-plain" style="text-decoration:none" href="${esc(fallback.source_url)}"
                 target="_blank" rel="noopener noreferrer">Open full article ↗</a>`);
  }
  return out.join('');
}

function renderIngredients(groups) {
  const host = $('ingredients');
  host.innerHTML = '';
  (groups || []).forEach((g) => {
    const box = document.createElement('div');
    box.className = 'ing-group';
    const items = (g.items || [])
      .map((it) => `<li><span class="ing-qty">${esc(typeof it === 'string' ? '' : it.quantity || '')}</span>
                    <span class="ing-item">${esc(typeof it === 'string' ? it : it.item || '')}</span></li>`)
      .join('');
    box.innerHTML = `
      ${g.heading ? `<p class="ing-group-head">${esc(g.heading)}</p>` : ''}
      <ul class="ing-list">${items}</ul>`;
    host.appendChild(box);
  });
  if (!host.children.length) host.innerHTML = `<p class="micro">No ingredient list came back.</p>`;
}

function renderSteps(steps) {
  const host = $('steps');
  host.innerHTML = '';
  (steps || []).forEach((s, i) => {
    const li = document.createElement('li');
    li.innerHTML = `${esc(s.text || '')}${
      s.minutes ? `<span class="step-time">⏱ ~${esc(s.minutes)} min</span>` : ''}`;
    li.dataset.n = i + 1;
    host.appendChild(li);
  });
  if (!host.children.length) host.innerHTML = `<li style="border:none">No steps came back.</li>`;
}

/* ── boot ─────────────────────────────────────────────────────────── */

buildCuisineChips();
setServings(4);
show('step-cuisine');

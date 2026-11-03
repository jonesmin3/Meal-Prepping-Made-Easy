# MealPrep AI

A cuisine-first meal-prep site. Two questions in, a board of 4.5★+ dinner options out,
then a stripped-down ingredient list and method for whichever one you pick.

## The flow

1. **What cuisine?** — 12 chips plus a free-text box ("Korean", "Ethiopian", anything).
2. **How many people?** — counter plus presets (1 · 2 · 4 · 6 · 8). Everything downstream is
   scaled to this number.
3. **AI search** — one OpenAI call asks for real, well-reviewed recipe articles, variety-first.
   Everything under **4.5★ is dropped in code**, not just asked for in the prompt. Each
   surviving dish gets a suggested main photo from the free Openverse API.
4. **The board** — cards showing rating, review count, source, total time and one-line summary.
   **↻ Refresh — find new ones** runs a fresh search, passing the dish names already shown so
   the model never serves you the same six twice.
5. **The recipe** — picking a card fetches the source article, hands the page text to the model,
   and gets back *only* ingredients (grouped, quantity split out for shopping) and numbered
   instructions, plus a storage line. No life story, no ads, no SEO filler.

## Run it

```bash
cd mealprep
OPENAI_API_KEY=sk-your-key-here node server.js
# → http://localhost:8787
```

Optional environment variables:

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `8787` | Port to serve on |
| `OPENAI_MODEL` | `gpt-4o` | Any chat-completions model that supports JSON mode |

No `npm install` needed — the server has zero dependencies.

## Why there's a server at all

The key has to stay out of the browser. A pure front-end site would ship `sk-...` in the page
source to every visitor, and anyone could spend your credit within minutes. So:

- `server.js` holds the key and makes both OpenAI calls.
- `public/app.js` only ever calls `/api/recipes` and `/api/summary` on the same origin.

**Deploying:** any Node host (Render, Railway, Fly, a VPS) works. Set `OPENAI_API_KEY` in the
host's environment settings, never in the repo. Commit nothing containing the key — the server
reads it from `process.env` only.

## Where it's honest about its limits

- **Ratings come from the model's research, so they can be wrong.** The site labels them as such
  in the footer, and the detail panel links straight to the source article so you can verify.
- **Paywalled or JavaScript-only pages** (NYT Cooking, some Allrecipes layouts) can't be read
  server-side. The summary falls back to the model's own knowledge of the dish and flags it in
  the UI — "Source page could not be read; reconstructed from the dish name."
- **Photos are placeholders, not the recipe's own images.** Openverse is a Creative Commons
  search; each photo shows its creator and licence under it, and falls back to a neutral glyph
  when nothing matches. Swapping this for the real photo means a scraper plus a hotlink policy
  decision, which most publishers disallow — the free API keeps it clean.
- **No quantity unit conversion, no shopping-list export, no user accounts.** Straightforward
  next additions if you want them.

## Files

```
mealprep/
├── server.js          # key-holding proxy, both prompts, Openverse lookup
├── package.json
└── public/
    ├── index.html     # the four-step shell
    ├── style.css
    └── app.js         # flow state, grid rendering, summary rendering
```

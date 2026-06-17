// ============================================================
//  Ninja Roast — "Roast my GitHub" (#23)
//  Zero-dependency Node server. Type a GitHub handle → pulls the
//  PUBLIC profile + repos from api.github.com and writes a witty,
//  accurate, DATA-DRIVEN roast + stats. Shareable at /u/<handle>.
//  Rule-based roast (no LLM in the request path) · 10-min cache.
// ============================================================
"use strict";
const http = require("http");
const https = require("https");
const PORT = process.env.PORT || 3000;
const TOKEN = process.env.GITHUB_TOKEN || "";
const CACHE_TTL = 10 * 60 * 1000; // 10 min

// Cerebras GLM-4.7 — AI-powered roast (streamed). Key lives in Railway env on the
// ninja-roast service as `cerebras-api-key` (hyphenated → bracket access).
// If unset/unreachable, the app silently falls back to the rule-based roast.
const CEREBRAS_KEY = process.env["cerebras-api-key"] || process.env.CEREBRAS_API_KEY || "";
const CEREBRAS_MODEL = process.env.CEREBRAS_MODEL || "zai-glm-4.7";

// Top GitHub contributors leaderboard (#28) — baked at build time from the
// gayanvoice/top-github-users dataset. {countries:[...], byCountry:{label:[...]}}.
const COMMITTERS = require("./committers-data.js");
const COMMITTERS_JSON = JSON.stringify(COMMITTERS);

/** @type {Map<string,{at:number,data:any}>} */
const cache = new Map();
const wall = []; // recently roasted {login, name, avatar, headline, at}

// ---------- helpers ------------------------------------------------------
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function validHandle(h) { return /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,38})$/.test(h || ""); }
function nfmt(n) { return Number(n || 0).toLocaleString("en-US"); }
function ago(iso) {
  if (!iso) return "a while";
  const d = (Date.now() - new Date(iso).getTime()) / 86400000;
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  if (d < 30) return `${Math.round(d)} days ago`;
  if (d < 365) return `${Math.round(d / 30)} months ago`;
  return `${(d / 365).toFixed(1)} years ago`;
}
function years(iso) { return iso ? (Date.now() - new Date(iso).getTime()) / (365.25 * 86400000) : 0; }

function ghGet(path) {
  return new Promise((resolve) => {
    const headers = {
      "User-Agent": "ninja-roast",
      "Accept": "application/vnd.github+json",
    };
    if (TOKEN) headers["Authorization"] = "Bearer " + TOKEN;
    const req = https.request(
      { hostname: "api.github.com", path, method: "GET", headers, timeout: 8000 },
      (res) => {
        let buf = "";
        res.on("data", (c) => (buf += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(buf); } catch { json = null; }
          resolve({ status: res.statusCode, headers: res.headers, json });
        });
      }
    );
    req.on("error", () => resolve({ status: 0, headers: {}, json: null }));
    req.on("timeout", () => { req.destroy(); resolve({ status: 0, headers: {}, json: null }); });
    req.end();
  });
}

// ---------- data + stats -------------------------------------------------
async function fetchProfile(handle) {
  const key = handle.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.data;

  const u = await ghGet(`/users/${encodeURIComponent(handle)}`);
  if (u.status === 404) return { error: "notfound" };
  if (u.status === 403 || u.status === 429) return { error: "ratelimit" };
  if (u.status !== 200 || !u.json) return { error: "unavailable" };

  const r = await ghGet(`/users/${encodeURIComponent(handle)}/repos?per_page=100&sort=pushed`);
  const repos = Array.isArray(r.json) ? r.json : [];
  const data = { user: u.json, stats: computeStats(u.json, repos) };
  cache.set(key, { at: Date.now(), data });
  return data;
}

function computeStats(user, repos) {
  const owned = repos.filter((x) => !x.fork);
  const forks = repos.filter((x) => x.fork);
  const totalStars = repos.reduce((s, x) => s + (x.stargazers_count || 0), 0);
  const langCount = {};
  for (const x of repos) if (x.language) langCount[x.language] = (langCount[x.language] || 0) + 1;
  const topLangs = Object.entries(langCount).sort((a, b) => b[1] - a[1]).slice(0, 5);
  let topRepo = null;
  for (const x of repos) if (!topRepo || (x.stargazers_count || 0) > (topRepo.stargazers_count || 0)) topRepo = x;
  const lastPush = repos.reduce((m, x) => (x.pushed_at && (!m || x.pushed_at > m) ? x.pushed_at : m), null);
  const emptyish = owned.filter((x) => (x.size || 0) === 0).length;
  const lazyNames = owned
    .map((x) => x.name)
    .filter((n) => /^(test|untitled|new-?repo|project|temp|demo|hello-?world|my-?project|repo|app)\d*$/i.test(n));
  return {
    followers: user.followers || 0,
    following: user.following || 0,
    publicRepos: user.public_repos || 0,
    publicGists: user.public_gists || 0,
    owned: owned.length,
    forks: forks.length,
    totalStars,
    topLangs,
    topRepo: topRepo && topRepo.stargazers_count ? { name: topRepo.name, stars: topRepo.stargazers_count } : (topRepo ? { name: topRepo.name, stars: 0 } : null),
    lastPush,
    accountYears: years(user.created_at),
    emptyish,
    lazyNames,
    hasBio: !!(user.bio && user.bio.trim()),
    bio: user.bio || "",
  };
}

// ---------- the roast engine (rule-based, kind-but-witty) ---------------
const LANG_BURNS = {
  JavaScript: "Top language: JavaScript — so you enjoy debugging `undefined is not a function` at 2am. Respect the grind.",
  TypeScript: "Top language: TypeScript — JavaScript for people with trust issues. Healthy, honestly.",
  Python: "Top language: Python — where indentation is a lifestyle and a single space ruins your night.",
  Java: "Top language: Java. We're so sorry. `public static void pleaseEnd()`.",
  Go: "Top language: Go — `if err != nil` is basically your love language.",
  Rust: "Top language: Rust. You've absolutely mentioned the borrow checker on a first date.",
  "C++": "Top language: C++. You either love pain or the segfaults love you.",
  C: "Top language: C. Manual memory management as a personality. Bold.",
  Ruby: "Top language: Ruby — still riding that 2012 high, and we adore the loyalty.",
  PHP: "Top language: PHP. Someone has to, and it's heroically you.",
  "C#": "Top language: C#. Visual Studio has seen things, and so have you.",
  HTML: "Top 'language': HTML — a programming language, allegedly.",
  CSS: "Top 'language': CSS — centering a div remains your Vietnam.",
  Shell: "Top language: Shell — your repos are held together by `&&` and prayer.",
  "Jupyter Notebook": "Top language: Jupyter Notebook — running cells out of order and calling it science.",
  Swift: "Top language: Swift — you suffer for Apple and you'll do it again.",
  Kotlin: "Top language: Kotlin — Java that went to therapy. Growth.",
};

function buildRoast(login, s) {
  const lines = [];
  // followers / following
  if (s.following > 30 && s.followers / Math.max(1, s.following) < 0.5)
    lines.push(`You follow ${nfmt(s.following)} people but only ${nfmt(s.followers)} follow back — the GitHub social ladder is *brutal*, huh?`);
  else if (s.followers > 1000)
    lines.push(`${nfmt(s.followers)} followers — basically a GitHub influencer. Do you sign autographs in commit messages?`);
  // repo count
  if (s.publicRepos === 0)
    lines.push(`Zero public repos. A person of mystery — or a heavy private-repo enjoyer. We see you (we don't).`);
  else if (s.publicRepos > 100)
    lines.push(`${nfmt(s.publicRepos)} public repos. Quantity over README, I see.`);
  else if (s.publicRepos < 5)
    lines.push(`${nfmt(s.publicRepos)} repos total. "Quality over quantity" — that's the story we're going with.`);
  // forks vs originals
  if (s.forks > s.owned && s.forks > 3)
    lines.push(`More forks (${s.forks}) than original repos (${s.owned}). Your specialty is the **Fork** button — bold strategy.`);
  // stars
  if (s.totalStars === 0 && s.publicRepos > 0)
    lines.push(`0 stars across everything. Don't worry — your mom would star them if she made an account.`);
  else if (s.totalStars > 1000)
    lines.push(`${nfmt(s.totalStars)} total stars — okay, okay, the flex is real. Put it on the resume.`);
  if (s.topRepo && s.topRepo.stars >= 10)
    lines.push(`"${s.topRepo.name}" carries your whole profile on its back with ${nfmt(s.topRepo.stars)} stars. Hope you thanked it.`);
  // language
  if (s.topLangs.length) {
    const lang = s.topLangs[0][0];
    lines.push(LANG_BURNS[lang] || `Top language: ${lang} — a choice, and you made it.`);
  } else if (s.publicRepos > 0) {
    lines.push(`No detectable primary language — a polyglot, or just allergic to commitment.`);
  }
  // account age
  if (s.accountYears > 10)
    lines.push(`${s.accountYears.toFixed(0)} years on GitHub — you remember when the octocat was new. A certified veteran.`);
  else if (s.accountYears > 0 && s.accountYears < 1)
    lines.push(`Account's barely ${Math.max(1, Math.round(s.accountYears * 12))} months old — fresh meat. Welcome; the README never sleeps.`);
  // push recency
  if (s.lastPush && years(s.lastPush) > 1)
    lines.push(`Last push was ${ago(s.lastPush)}. The green squares are on a long sabbatical.`);
  else if (s.lastPush && ((Date.now() - new Date(s.lastPush).getTime()) / 86400000) < 2)
    lines.push(`Pushed code ${ago(s.lastPush)} — touch grass occasionally, champion.`);
  // bio buzzwords (strip md-control chars so mdInline can't mangle it)
  if (s.hasBio && /\b(ai|ml|blockchain|web3|10x|ninja|guru|rockstar|wizard|evangelist|thought leader)\b/i.test(s.bio))
    lines.push(`Your bio really says "${s.bio.slice(0, 60).replace(/[*`]/g, "")}". Of course it does.`);
  else if (!s.hasBio && s.publicRepos > 0)
    lines.push(`No bio at all — letting the code speak for itself. Risky. Iconic.`);
  // gists
  if (s.publicGists > 20)
    lines.push(`${nfmt(s.publicGists)} public gists — a hoarder, but make it code snippets.`);
  // lazy names
  if (s.lazyNames.length)
    lines.push(`You have a repo literally called "${s.lazyNames[0]}". Naming things: still the hardest problem in computer science.`);
  // empty repos
  if (s.emptyish >= 3)
    lines.push(`${s.emptyish} repos with basically nothing in them — Schrödinger's side projects: simultaneously started and abandoned.`);

  // pick the sharpest handful (already in priority order), keep it tight
  const picked = lines.slice(0, 6);
  const opener = `Alright **@${login}**, let's crack open this GitHub and see what we're working with… 🔥`;
  const closer = `But real talk — ${nfmt(s.publicRepos)} repos, ${nfmt(s.totalStars)} stars, and still shipping. Genuinely, keep going. 🥷💙`;
  return { opener, lines: picked, closer };
}

// Plain-text fallback paragraph from the rule-based roast (strip md markers).
function fallbackText(login, s) {
  const r = buildRoast(login, s);
  return [r.opener, ...r.lines, r.closer].join(" ").replace(/\*\*/g, "").replace(/[*`]/g, "");
}

// Build the Cerebras chat messages from the REAL GitHub stats so the roast is
// specific + accurate to this person (not generic).
function buildPromptMessages(login, name, s) {
  const langs = s.topLangs.map((l) => `${l[0]} (${l[1]})`).join(", ") || "none detected";
  const facts = [
    `handle: @${login}${name && name !== login ? ` (real name: ${name})` : ""}`,
    `public repos: ${s.publicRepos} (${s.owned} original, ${s.forks} forked)`,
    `total stars across all repos: ${s.totalStars}`,
    `followers: ${s.followers}, following: ${s.following}`,
    `top languages: ${langs}`,
    s.topRepo ? `most-starred repo: "${s.topRepo.name}" (${s.topRepo.stars} stars)` : `no standout repo`,
    `account age: ${s.accountYears.toFixed(1)} years`,
    s.lastPush ? `last pushed: ${ago(s.lastPush)}` : `never pushed any code`,
    `public gists: ${s.publicGists}`,
    s.hasBio ? `bio: "${s.bio.slice(0, 140)}"` : `no bio set`,
    s.lazyNames.length ? `lazily-named repos: ${s.lazyNames.slice(0, 3).join(", ")}` : null,
    s.emptyish ? `empty/near-empty repos: ${s.emptyish}` : null,
  ].filter(Boolean).map((x) => "- " + x).join("\n");
  const system =
    "You are a razor-sharp, good-natured stand-up comedian who roasts software developers based ONLY on " +
    "their real GitHub stats. Write ONE paragraph, 60-90 words. Be specific to THIS person's actual numbers, " +
    "clever, and genuinely funny. Punch at coding habits and choices — never at the person, their identity, " +
    "gender, race, or looks. Keep it playful and land on a slightly warm final beat. Output ONLY the roast " +
    "paragraph: no preamble, no title, no quotes, no markdown, and never reveal your reasoning or thinking.";
  const user = "Roast this developer using their real GitHub data:\n" + facts;
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

// Stream a GLM-4.7 roast to an open SSE response. Emits `data:{"v":"..."}` per
// chunk, `data:{"fallback":true}` if AI is unavailable/empty, then
// `data:{"done":true}`. Strips <think> reasoning; never throws.
function cerebrasRoastStream(res, messages) {
  const sse = (o) => { try { res.write("data: " + JSON.stringify(o) + "\n\n"); } catch (e) {} };
  if (!CEREBRAS_KEY) { sse({ fallback: true }); sse({ done: true }); return res.end(); }

  const payload = JSON.stringify({
    model: CEREBRAS_MODEL, messages, stream: true, temperature: 0.9, max_tokens: 400,
    // GLM-4.7 is a reasoning model; "none" disables thinking so the roast streams instantly.
    reasoning_effort: "none",
  });
  let anyEmit = false, finished = false, rawBuf = "", emitted = 0, buf = "";
  const finish = (fb) => {
    if (finished) return; finished = true; clearTimeout(firstTO);
    if (fb && !anyEmit) sse({ fallback: true });
    sse({ done: true }); try { res.end(); } catch (e) {}
  };

  const req = https.request({
    hostname: "api.cerebras.ai", path: "/v1/chat/completions", method: "POST",
    headers: {
      "Authorization": "Bearer " + CEREBRAS_KEY, "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(payload),
    }, timeout: 20000,
  }, (r) => {
    if (r.statusCode !== 200) {
      let e = ""; r.on("data", (c) => (e += c));
      r.on("end", () => { console.log("cerebras non-200:", r.statusCode, String(e).slice(0, 160)); finish(true); });
      return;
    }
    r.setEncoding("utf8");
    r.on("data", (chunk) => {
      buf += chunk; let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const d = line.slice(5).trim();
        if (d === "[DONE]") continue;
        let j; try { j = JSON.parse(d); } catch (e) { continue; }
        const c = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
        if (typeof c !== "string" || !c) continue;
        rawBuf += c;
        // strip complete + in-progress <think>…</think> so reasoning never streams
        const clean = rawBuf.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/<think>[\s\S]*$/, "");
        if (clean.length > emitted) {
          const out = clean.slice(emitted); emitted = clean.length;
          if (out) { anyEmit = true; clearTimeout(firstTO); sse({ v: out }); }
        }
      }
    });
    r.on("end", () => finish(true));
    r.on("error", () => finish(true));
  });
  // If no displayable token within 9s, give up and fall back.
  const firstTO = setTimeout(() => { if (!anyEmit) { try { req.destroy(); } catch (e) {} finish(true); } }, 9000);
  req.on("error", () => finish(true));
  req.on("timeout", () => { try { req.destroy(); } catch (e) {} finish(true); });
  req.write(payload); req.end();
}

// crude inline markdown → safe HTML (**bold**, `code`, *em*) on ALREADY-ESCAPED text
function mdInline(safe) {
  return safe
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

// ---------- pages --------------------------------------------------------
const HEAD = (title, desc) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}"/>
<meta property="og:title" content="${esc(title)}"/>
<meta property="og:description" content="${esc(desc)}"/>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Overpass:wght@700;800;900&family=Roboto+Mono:wght@500&family=Roboto:wght@400;500;700&display=swap" rel="stylesheet"/>
<style>
 :root{--blue:#2f6bff;--blue-b:#5b8cff;--cyan:#22d3ee;--violet:#7c5cff;--win:#36f08a;--fire:#ff8a3d;--ink:#eaf0ff;--muted:#9fb2d6;--line:rgba(120,160,255,.18)}
 *{margin:0;box-sizing:border-box}
 body{font-family:Roboto,system-ui,sans-serif;color:var(--ink);min-height:100vh;
   background:radial-gradient(1100px 700px at 78% 4%,#10204d,#0a1228 50%,#04060f 100%)}
 a{color:var(--cyan)}
 .wrap{max-width:880px;margin:0 auto;padding:6vh 6vw 8vh}
 .mark{font-family:Overpass;font-weight:900;letter-spacing:.2em;font-size:.95rem;color:#fff}
 .eyebrow{font-family:Overpass;font-weight:800;letter-spacing:.24em;text-transform:uppercase;font-size:.72rem;color:var(--cyan);margin:1.4rem 0 .5rem}
 h1{font-family:Overpass;font-weight:900;line-height:1;letter-spacing:-.02em;font-size:clamp(2.2rem,7vw,3.6rem);color:#fff}
 h1 .fire{background:linear-gradient(100deg,var(--fire),#ffd24d);-webkit-background-clip:text;background-clip:text;color:transparent}
 .sub{color:var(--muted);font-size:1.05rem;margin:1rem 0 1.6rem;max-width:48ch}
 form{display:flex;gap:.6rem;max-width:520px}
 .at{display:flex;align-items:center;flex:1;background:#070d20;border:1px solid #2a3a66;border-radius:12px;padding:0 .2rem 0 .8rem}
 .at span{color:var(--muted);font-family:Roboto Mono,monospace}
 input{flex:1;background:transparent;border:none;color:var(--ink);font-size:1.05rem;padding:.85rem .5rem;outline:none}
 button{font-family:Overpass;font-weight:800;font-size:1rem;color:#05070f;border:none;border-radius:12px;
   padding:.85rem 1.3rem;background:linear-gradient(100deg,var(--fire),#ffd24d);cursor:pointer;white-space:nowrap}
 button:disabled{opacity:.6}
 .examples{margin-top:1.1rem;font-size:.86rem;color:var(--muted)}
 .examples a{color:var(--blue-b);text-decoration:none;margin-right:.7rem}
 .links{margin-top:2rem;font-size:.85rem;color:#6f86a3}.links a{color:var(--blue-b);text-decoration:none}
</style></head><body>`;

function renderHome(msg) {
  return `${HEAD("Roast my GitHub · NinjaTech", "Type a GitHub handle and get a witty, real-data roast.")}
<div class="wrap">
  <div class="mark">NINJA 🥷</div>
  <p class="eyebrow">Foundry Live · GitHub SF</p>
  <h1>Roast my <span class="fire">GitHub</span> 🔥</h1>
  <p class="sub">Type any GitHub handle. We pull the real public profile + repos and write a roast it probably deserves. Built live by an AI employee.</p>
  ${msg ? `<p class="sub" style="color:var(--fire)">${esc(msg)}</p>` : ""}
  <form id="f" onsubmit="return go(event)">
    <label class="at"><span>@</span><input id="h" value="torvalds" placeholder="octocat" autocomplete="off" autocapitalize="off" spellcheck="false" maxlength="39"/></label>
    <button type="submit">Roast 🔥</button>
  </form>
  <p class="examples">Try: <a href="/u/torvalds">@torvalds</a><a href="/u/gaearon">@gaearon</a><a href="/u/octocat">@octocat</a></p>
  <p class="links">🧱 <a href="/wall">the wall of roasts →</a> · real GitHub data · no logins stored</p>

  <section class="board">
    <div class="bhead">
      <h2>🌍 Top GitHub contributors <span class="bhint">— click anyone to roast them live</span></h2>
      <div class="bctrl">
        <label for="country">Country</label>
        <select id="country" aria-label="Filter by country"></select>
        <input id="bsearch" placeholder="filter names…" autocomplete="off"/>
      </div>
    </div>
    <div class="btable-wrap">
      <table class="btable">
        <thead><tr><th>#</th><th>Developer</th><th class="ct">Country</th><th class="num">Contributions</th></tr></thead>
        <tbody id="brows"><tr><td colspan="4" class="bloading">loading the global leaderboard…</td></tr></tbody>
      </table>
    </div>
    <p class="bsrc">Data: <a href="https://github.com/gayanvoice/top-github-users" target="_blank" rel="noopener">top-github-users</a> (by public contributions) · like <a href="https://committers.top" target="_blank" rel="noopener">committers.top</a>. Tap a name → live Cerebras roast.</p>
  </section>
</div>
<style>
 .board{margin-top:2.4rem;max-width:920px}
 .bhead{display:flex;justify-content:space-between;align-items:flex-end;gap:1rem;flex-wrap:wrap;margin-bottom:1rem}
 .bhead h2{font-family:Overpass;font-weight:900;font-size:clamp(1.3rem,3.5vw,1.9rem);color:#fff;line-height:1.1}
 .bhint{font-family:Roboto,sans-serif;font-weight:400;font-size:.82rem;color:var(--muted)}
 .bctrl{display:flex;gap:.5rem;align-items:center}
 .bctrl label{font-size:.78rem;color:var(--muted)}
 #country,#bsearch{background:#070d20;border:1px solid #2a3a66;border-radius:9px;color:var(--ink);font-size:.9rem;padding:.5rem .6rem;outline:none}
 #country:focus,#bsearch:focus{border-color:var(--blue-b)}
 #bsearch{width:8.5rem}
 .btable-wrap{border:1px solid var(--line);border-radius:14px;overflow:hidden;background:rgba(255,255,255,.02)}
 .btable{width:100%;border-collapse:collapse;font-size:.92rem}
 .btable thead th{text-align:left;font-family:Overpass;font-weight:800;font-size:.7rem;letter-spacing:.06em;text-transform:uppercase;
   color:var(--muted);padding:.7rem .9rem;border-bottom:1px solid var(--line);background:rgba(47,107,255,.06)}
 .btable th.num,.btable td.num{text-align:right;font-variant-numeric:tabular-nums}
 .btable tbody tr{border-bottom:1px solid rgba(120,160,255,.07);cursor:pointer;transition:background .12s}
 .btable tbody tr:last-child{border-bottom:none}
 .btable tbody tr:hover{background:rgba(47,107,255,.12)}
 .btable td{padding:.5rem .9rem;vertical-align:middle}
 .btable td.rank{color:var(--muted);font-family:Overpass;font-weight:800;width:2.5rem}
 .dev{display:flex;align-items:center;gap:.65rem;text-decoration:none;color:#fff}
 .dev img{width:30px;height:30px;border-radius:50%;background:#0a1228;border:1px solid var(--line);flex:none}
 .dev .nm{font-weight:600;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:13rem}
 .dev .hd{color:var(--blue-b);font-family:Roboto Mono,monospace;font-size:.78rem}
 .btable td.ct{color:var(--muted);font-size:.84rem;white-space:nowrap}
 .btable td.num{color:var(--cyan);font-weight:700}
 .btable .go{color:var(--fire);font-size:.78rem;opacity:0;white-space:nowrap}
 .btable tr:hover .go{opacity:1}
 .bloading{padding:1.4rem;text-align:center;color:var(--muted)}
 .bsrc{margin-top:.8rem;font-size:.76rem;color:#6f86a3}.bsrc a{color:var(--blue-b);text-decoration:none}
 @media(max-width:600px){.dev .nm{max-width:8rem}.btable td.ct{display:none}.btable th.ct{display:none}}
</style>
<script>
 function go(e){e.preventDefault();var h=document.getElementById('h').value.trim().replace(/^@/,'');
   if(h)location.href='/u/'+encodeURIComponent(h);return false;}
 (function(){
   var sel=document.getElementById('country'), q=document.getElementById('bsearch'), body=document.getElementById('brows');
   var DATA=null, current='Global';
   function fmt(n){return (n||0).toLocaleString('en-US');}
   function render(){
     var rows=(DATA.byCountry[current]||[]); var term=(q.value||'').trim().toLowerCase();
     if(term) rows=rows.filter(function(u){return (u.login+' '+(u.name||'')).toLowerCase().indexOf(term)>=0;});
     body.textContent='';
     if(!rows.length){var tr=document.createElement('tr');var td=document.createElement('td');td.colSpan=4;td.className='bloading';td.textContent='no matches';tr.appendChild(td);body.appendChild(tr);return;}
     rows.forEach(function(u,i){
       var tr=document.createElement('tr');
       tr.addEventListener('click',function(){location.href='/u/'+encodeURIComponent(u.login);});
       var rk=document.createElement('td');rk.className='rank';rk.textContent=(i+1);tr.appendChild(rk);
       var dt=document.createElement('td');
       var a=document.createElement('a');a.className='dev';a.href='/u/'+encodeURIComponent(u.login);
       var img=document.createElement('img');img.loading='lazy';img.alt='';img.referrerPolicy='no-referrer';if(u.avatar)img.src=u.avatar;a.appendChild(img);
       var box=document.createElement('div');
       var nm=document.createElement('div');nm.className='nm';nm.textContent=u.name||u.login;box.appendChild(nm);
       var hd=document.createElement('div');hd.className='hd';hd.textContent='@'+u.login;box.appendChild(hd);
       a.appendChild(box);dt.appendChild(a);tr.appendChild(dt);
       var ct=document.createElement('td');ct.className='ct';ct.textContent=u.country||current;tr.appendChild(ct);
       var nu=document.createElement('td');nu.className='num';nu.textContent=fmt(u.c);
       var go=document.createElement('span');go.className='go';go.textContent='  roast →';
       tr.appendChild(nu);
       body.appendChild(tr);
     });
   }
   fetch('/api/committers').then(function(r){return r.json();}).then(function(d){
     DATA=d;
     d.countries.forEach(function(c){var o=document.createElement('option');o.value=c;o.textContent=c;sel.appendChild(o);});
     sel.value='Global'; render();
     sel.addEventListener('change',function(){current=sel.value;q.value='';render();});
     q.addEventListener('input',render);
   }).catch(function(){body.innerHTML='<tr><td colspan=4 class=bloading>leaderboard unavailable</td></tr>';});
 })();
</script></body></html>`;
}

function langBars(topLangs) {
  if (!topLangs.length) return "";
  const max = topLangs[0][1];
  return `<div class="langs">` + topLangs.map(([l, c]) =>
    `<div class="lang"><span class="ln">${esc(l)}</span><span class="lt"><i style="width:${Math.round(c / max * 100)}%"></i></span><b>${c}</b></div>`
  ).join("") + `</div>`;
}

function renderRoast(handle, data, origin) {
  const u = data.user, s = data.stats;
  const name = esc(u.name || u.login);
  const roast = buildRoast(u.login, s);
  const body = [roast.opener, ...roast.lines, roast.closer]
    .map((ln) => `<p class="rl">${mdInline(esc(ln))}</p>`)
    .join("");
  const fbText = fallbackText(u.login, s); // plain-text safety net (rule-based)
  const shareUrl = `${origin}/u/${encodeURIComponent(u.login)}`;
  return `${HEAD(`Roasting @${u.login} · Roast my GitHub`, `A data-driven roast of @${u.login} — ${nfmt(s.publicRepos)} repos, ${nfmt(s.totalStars)} stars.`)}
<style>
 .card{background:linear-gradient(180deg,rgba(15,26,58,.92),rgba(8,14,33,.92));border:1px solid var(--line);
   border-radius:20px;padding:clamp(1.3rem,4vw,2.2rem);box-shadow:0 30px 80px rgba(0,0,0,.5);margin-top:1.4rem}
 .id{display:flex;align-items:center;gap:1rem;flex-wrap:wrap}
 .id img{width:78px;height:78px;border-radius:50%;border:2px solid var(--blue-b);background:#0a1228}
 .id .nm{font-family:Overpass;font-weight:900;font-size:1.5rem;color:#fff;line-height:1.1}
 .id .hd{color:var(--muted);font-family:Roboto Mono,monospace;font-size:.9rem}
 .id .hd a{color:var(--blue-b);text-decoration:none}
 .stats{display:grid;grid-template-columns:repeat(4,1fr);gap:.7rem;margin:1.3rem 0}
 .st{background:rgba(255,255,255,.03);border:1px solid var(--line);border-radius:12px;padding:.7rem .5rem;text-align:center}
 .st b{display:block;font-family:Overpass;font-weight:900;font-size:clamp(1.1rem,3.5vw,1.6rem);color:var(--cyan)}
 .st span{font-size:.68rem;color:var(--muted);text-transform:uppercase;letter-spacing:.06em}
 .langs{margin:.4rem 0 .2rem;display:flex;flex-direction:column;gap:.35rem}
 .lang{display:grid;grid-template-columns:7rem 1fr 1.6rem;align-items:center;gap:.5rem;font-size:.82rem}
 .lang .ln{color:#dbe6ff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
 .lang .lt{height:8px;background:rgba(255,255,255,.06);border-radius:5px;overflow:hidden}
 .lang .lt i{display:block;height:100%;background:linear-gradient(90deg,var(--blue),var(--cyan))}
 .lang b{color:var(--muted);font-size:.74rem;text-align:right}
 .roast{margin-top:1.5rem;border-top:1px solid var(--line);padding-top:1.3rem}
 .roast h3{font-family:Overpass;font-weight:800;letter-spacing:.04em;color:var(--fire);font-size:1rem;text-transform:uppercase;margin-bottom:.8rem}
 .rl{font-size:clamp(1rem,2.2vw,1.18rem);line-height:1.55;margin-bottom:.85rem;color:#e7eeff}
 .rl b{color:#fff}.rl code{font-family:Roboto Mono,monospace;background:rgba(47,107,255,.16);padding:.05em .4em;border-radius:5px;font-size:.9em;color:#cfe0ff}
 .rl:first-child{color:#fff;font-weight:500}.rl:last-child{color:var(--win)}
 .roast h3{display:flex;align-items:center;gap:.5em;flex-wrap:wrap}
 .aibadge{font-family:Roboto Mono,monospace;font-size:.6rem;font-weight:500;color:var(--fire);border:1px solid var(--fire);
   border-radius:6px;padding:.15em .5em;letter-spacing:.04em;text-transform:none}
 .aibadge.fb{color:var(--muted);border-color:var(--line)}
 .aibadge .cere{height:1.2em;width:1.2em;vertical-align:-.25em;margin-right:.3em}
 .aibadge{display:inline-flex;align-items:center}
 .rstream{font-size:clamp(1.02rem,2.3vw,1.22rem);line-height:1.62;color:#e7eeff;min-height:5.2em}
 .rstream .w{display:inline-block;opacity:0;transform:translateY(3px);animation:fin .28s ease forwards}
 @keyframes fin{to{opacity:1;transform:none}}
 .rstream .cursor{display:inline-block;width:.55ch;color:var(--fire);animation:bl .8s steps(1) infinite}
 @keyframes bl{50%{opacity:0}}
 .actions{display:flex;gap:.7rem;flex-wrap:wrap;margin-top:1.6rem}
 .btn{font-family:Overpass;font-weight:800;font-size:.92rem;border-radius:11px;padding:.7rem 1.1rem;cursor:pointer;border:1px solid var(--line);text-decoration:none;color:#fff;background:rgba(47,107,255,.14)}
 .btn.fire{color:#05070f;background:linear-gradient(100deg,var(--fire),#ffd24d);border-color:transparent}
 .foot{margin-top:1.4rem;font-size:.78rem;color:#6f86a3}
 @media(max-width:560px){.stats{grid-template-columns:repeat(2,1fr)}.lang{grid-template-columns:5.5rem 1fr 1.6rem}}
</style>
<div class="wrap">
  <div class="mark">NINJA 🥷 · <a href="/" style="text-decoration:none;color:var(--muted)">roast my github</a></div>
  <div class="card">
    <div class="id">
      <img src="${esc(u.avatar_url || "")}" alt="" referrerpolicy="no-referrer"/>
      <div>
        <div class="nm">${name}</div>
        <div class="hd"><a href="https://github.com/${esc(u.login)}" target="_blank" rel="noopener">@${esc(u.login)}</a>${u.location ? " · " + esc(u.location) : ""}</div>
      </div>
    </div>
    <div class="stats">
      <div class="st"><b>${nfmt(s.publicRepos)}</b><span>repos</span></div>
      <div class="st"><b>${nfmt(s.totalStars)}</b><span>stars</span></div>
      <div class="st"><b>${nfmt(s.followers)}</b><span>followers</span></div>
      <div class="st"><b>${s.accountYears >= 1 ? s.accountYears.toFixed(0) + "y" : "<1y"}</b><span>on github</span></div>
    </div>
    ${langBars(s.topLangs)}
    <div class="roast">
      <h3>🔥 The roast <span class="aibadge" id="aibadge"><svg class="cere" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path clip-rule="evenodd" d="M14.121 2.701a9.299 9.299 0 000 18.598V22.7c-5.91 0-10.7-4.791-10.7-10.701S8.21 1.299 14.12 1.299V2.7zm4.752 3.677A7.353 7.353 0 109.42 17.643l-.901 1.074a8.754 8.754 0 01-1.08-12.334 8.755 8.755 0 0112.335-1.08l-.901 1.075zm-2.255.844a5.407 5.407 0 00-5.048 9.563l-.656 1.24a6.81 6.81 0 016.358-12.043l-.654 1.24zM14.12 8.539a3.46 3.46 0 100 6.922v1.402a4.863 4.863 0 010-9.726v1.402z" fill="#F15A29" fill-rule="evenodd"></path><path d="M15.407 10.836a2.24 2.24 0 00-.51-.409 1.084 1.084 0 00-.544-.152c-.255 0-.483.047-.684.14a1.58 1.58 0 00-.84.912c-.074.203-.11.416-.11.631 0 .218.036.43.11.631a1.594 1.594 0 00.84.913c.2.093.43.14.684.14.216 0 .417-.046.602-.135.188-.09.35-.225.475-.392l.928 1.006c-.14.14-.3.261-.482.363a3.367 3.367 0 01-1.083.38c-.17.026-.317.04-.44.04a3.315 3.315 0 01-1.182-.21 2.825 2.825 0 01-.961-.597 2.816 2.816 0 01-.644-.929 2.987 2.987 0 01-.238-1.21c0-.444.08-.847.238-1.21.15-.35.368-.666.643-.929.278-.261.605-.464.962-.596a3.315 3.315 0 011.182-.21c.355 0 .712.068 1.072.204.361.138.685.36.944.649l-.962.97z" fill="currentColor"></path></svg>Real-time AI · powered by Cerebras AI</span></h3>
      <div class="rstream" id="roast"></div>
      <noscript>${body}</noscript>
    </div>
    <div class="actions">
      <a class="btn fire" href="/">Roast another 🔥</a>
      <button class="btn" onclick="copy()">🔗 Copy share link</button>
      <a class="btn" href="https://github.com/${esc(u.login)}" target="_blank" rel="noopener">View on GitHub ↗</a>
    </div>
    <p class="foot">Real public data via the GitHub API · roast generated by a NinjaTech AI employee · all in good fun 🥷</p>
  </div>
</div>
<script>
 function copy(){navigator.clipboard.writeText(${JSON.stringify(shareUrl)}).then(function(){
   event.target.textContent='✓ copied!';});}
</script>
<script>
(function(){
 var HANDLE=${JSON.stringify(u.login)};
 var FALLBACK=${JSON.stringify(fbText).replace(/</g, "\\u003c")};
 var box=document.getElementById('roast'), badge=document.getElementById('aibadge');
 var done=false, started=false, gotAI=false, fellBack=false, fbTimer=null;
 var cursor=document.createElement('span'); cursor.className='cursor'; cursor.textContent='▌';
 box.appendChild(cursor);
 // Append text the INSTANT it arrives — display speed == Cerebras stream speed.
 // No queue, no per-word timer. The fade-in is a pure CSS per-span effect (concurrent).
 function appendText(t){
   var p=t.split(/(\\s+)/);
   for(var i=0;i<p.length;i++){
     var w=p[i]; if(w==='') continue;
     if(/^\\s+$/.test(w)){ box.insertBefore(document.createTextNode(w), cursor); }
     else { var s=document.createElement('span'); s.className='w'; s.textContent=w; box.insertBefore(s, cursor); }
   }
 }
 function finish(){ if(done) return; done=true; if(cursor.parentNode) cursor.remove(); }
 // Fallback (rule-based, local text): reveal FAST in small chunks (~done in <0.5s).
 function useFallback(){
   if(gotAI || fellBack) return; fellBack=true; started=true;
   badge.textContent='✦ instant roast'; badge.className='aibadge fb';
   while(box.firstChild) box.removeChild(box.firstChild); box.appendChild(cursor);
   var words=FALLBACK.split(/(\\s+)/).filter(function(x){return x!=='';}), i=0;
   fbTimer=setInterval(function(){
     if(i>=words.length){ clearInterval(fbTimer); finish(); return; }
     for(var k=0;k<4 && i<words.length;k++,i++){ appendText(words[i]); }
   }, 16);
 }
 var es=null;
 try { es=new EventSource('/api/roast-stream?u='+encodeURIComponent(HANDLE)); } catch(e){ useFallback(); }
 if(es){
   es.onmessage=function(ev){ var d; try{ d=JSON.parse(ev.data); }catch(e){ return; }
     if(d.fallback){ es.close(); useFallback(); return; }
     if(d.done){ es.close(); finish(); return; }
     if(typeof d.v==='string'){ started=true; gotAI=true; appendText(d.v); }
   };
   es.onerror=function(){ try{es.close();}catch(e){} if(!gotAI){ useFallback(); } else { finish(); } };
 }
})();
</script></body></html>`;
}

function renderError(handle, kind) {
  const map = {
    notfound: [`No GitHub user <b>@${esc(handle)}</b> 🤷`, "Double-check the handle — or try someone who actually pushes code."],
    ratelimit: ["GitHub rate limit hit ⏳", "We've been roasting a lot. Give it a minute and try again (results cache for 10 min)."],
    unavailable: ["GitHub is being shy 🙈", "Couldn't reach the API just now. Try again in a moment."],
    badhandle: ["That's not a valid GitHub handle 🧐", "Handles are letters, numbers and dashes (max 39)."],
  };
  const [h, p] = map[kind] || map.unavailable;
  return `${HEAD("Roast my GitHub", "Roast my GitHub")}
<div class="wrap">
  <div class="mark">NINJA 🥷</div>
  <p class="eyebrow" style="margin-top:2rem">Hmm</p>
  <h1 style="font-size:clamp(1.8rem,6vw,2.8rem)">${h}</h1>
  <p class="sub">${p}</p>
  <form id="f" onsubmit="return go(event)">
    <label class="at"><span>@</span><input id="h" placeholder="octocat" autocomplete="off" maxlength="39"/></label>
    <button type="submit">Roast 🔥</button>
  </form>
  <p class="links" style="margin-top:1.4rem"><a href="/">← back to start</a></p>
</div>
<script>function go(e){e.preventDefault();var h=document.getElementById('h').value.trim().replace(/^@/,'');if(h)location.href='/u/'+encodeURIComponent(h);return false;}</script>
</body></html>`;
}

function renderWall() {
  const items = wall.slice(-60).reverse();
  const cards = items.map((w) =>
    `<a class="wc" href="/u/${encodeURIComponent(w.login)}"><img src="${esc(w.avatar)}" alt="" referrerpolicy="no-referrer"/><div><b>@${esc(w.login)}</b><span>${esc(w.headline)}</span></div></a>`
  ).join("");
  return `${HEAD("The wall of roasts · NinjaTech", "Recently roasted GitHub handles.")}
<style>
 .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:.8rem;margin-top:1.4rem}
 .wc{display:flex;gap:.7rem;align-items:center;background:rgba(255,255,255,.03);border:1px solid var(--line);
   border-radius:14px;padding:.7rem .8rem;text-decoration:none;color:#fff}
 .wc img{width:40px;height:40px;border-radius:50%;border:1px solid var(--blue-b)}
 .wc b{font-family:Overpass;display:block}.wc span{color:var(--muted);font-size:.78rem;display:block;max-width:24ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
 .empty{color:#6f86a3;margin-top:2rem}
</style>
<div class="wrap">
  <div class="mark">NINJA 🥷</div>
  <p class="eyebrow" style="margin-top:1.4rem">🧱 The wall</p>
  <h1 style="font-size:clamp(1.8rem,6vw,2.8rem)">Recently roasted</h1>
  ${items.length ? `<div class="grid">${cards}</div>` : `<p class="empty">Nobody roasted yet — <a href="/">go first →</a></p>`}
  <p class="links" style="margin-top:2rem"><a href="/">← roast someone →</a></p>
</div></body></html>`;
}

// ---------- server -------------------------------------------------------
function send(res, code, type, body) {
  res.writeHead(code, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
function originOf(req) {
  const proto = (req.headers["x-forwarded-proto"] || "https").split(",")[0];
  return `${proto}://${req.headers.host}`;
}

const server = http.createServer(async (req, res) => {
  try {
    const u = req.url || "/";
    const path = decodeURIComponent(u.split("?")[0]);
    const qs = u.indexOf("?") >= 0 ? new URLSearchParams(u.slice(u.indexOf("?") + 1)) : new URLSearchParams();

    if (path === "/healthz") return send(res, 200, "text/plain", "ok");
    if (path === "/api/committers") return send(res, 200, "application/json", COMMITTERS_JSON);
    if (path === "/") return send(res, 200, "text/html; charset=utf-8", renderHome(""));
    if (path === "/wall") return send(res, 200, "text/html; charset=utf-8", renderWall());

    if (path === "/api/roast") {
      const h = (qs.get("u") || "").replace(/^@/, "").trim();
      if (!validHandle(h)) return send(res, 400, "application/json", JSON.stringify({ ok: false, error: "badhandle" }));
      const data = await fetchProfile(h);
      if (data.error) return send(res, data.error === "notfound" ? 404 : 503, "application/json", JSON.stringify({ ok: false, error: data.error }));
      const roast = buildRoast(data.user.login, data.stats);
      return send(res, 200, "application/json", JSON.stringify({ ok: true, login: data.user.login, stats: data.stats, roast }));
    }

    // Live AI roast over SSE (GLM-4.7 on Cerebras) — falls back to rule-based.
    if (path === "/api/roast-stream") {
      const h = (qs.get("u") || "").replace(/^@/, "").trim();
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(":ok\n\n");
      if (!validHandle(h)) { res.write('data: {"fallback":true}\n\n'); res.write('data: {"done":true}\n\n'); return res.end(); }
      const data = await fetchProfile(h);
      if (data.error) { res.write('data: {"fallback":true}\n\n'); res.write('data: {"done":true}\n\n'); return res.end(); }
      return cerebrasRoastStream(res, buildPromptMessages(data.user.login, data.user.name, data.stats));
    }

    // Flexible Cerebras probe from THIS runtime (Railway). ?mode=stream tests SSE;
    // ?think=1 leaves reasoning on. No secret leaked.
    if (path === "/api/ai-selftest") {
      if (!CEREBRAS_KEY) return send(res, 200, "application/json", JSON.stringify({ ok: false, keyPresent: false, error: "no cerebras-api-key in env" }));
      const stream = qs.get("mode") === "stream";
      const think = qs.get("think") === "1";
      const t0 = Date.now();
      const reqBody = { model: CEREBRAS_MODEL, messages: [{ role: "user", content: "In ONE short sentence, playfully roast JavaScript developers." }], max_tokens: 200, stream };
      if (!think) reqBody.reasoning_effort = "none";
      const payload = JSON.stringify(reqBody);
      const r = await new Promise((resolve) => {
        let content = "", reasoning = "", ttfc = 0, status = 0, errBody = "";
        const rq = https.request({ hostname: "api.cerebras.ai", path: "/v1/chat/completions", method: "POST",
          headers: { "Authorization": "Bearer " + CEREBRAS_KEY, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }, timeout: 20000 },
          (rr) => {
            status = rr.statusCode; rr.setEncoding("utf8");
            if (!stream || status !== 200) { let b = ""; rr.on("data", (c) => (b += c)); rr.on("end", () => { errBody = b; try { const j = JSON.parse(b); content = j.choices[0].message.content || ""; reasoning = j.choices[0].message.reasoning_content || ""; } catch (e) {} resolve({ status, content, reasoning, ttfc, errBody: status !== 200 ? b.slice(0, 220) : undefined }); }); return; }
            let buf = ""; rr.on("data", (chunk) => { buf += chunk; let i; while ((i = buf.indexOf("\n")) >= 0) { const ln = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!ln.startsWith("data:")) continue; const d = ln.slice(5).trim(); if (d === "[DONE]") continue; let j; try { j = JSON.parse(d); } catch (e) { continue; } const dc = j.choices && j.choices[0] && j.choices[0].delta || {}; if (dc.content) { if (!ttfc) ttfc = Date.now() - t0; content += dc.content; } if (dc.reasoning_content) reasoning += dc.reasoning_content; } });
            rr.on("end", () => resolve({ status, content, reasoning, ttfc }));
          });
        rq.on("error", (e) => resolve({ status: 0, content: "", reasoning: "", errBody: String(e) }));
        rq.on("timeout", () => { rq.destroy(); resolve({ status: 0, content: "", reasoning: "", errBody: "timeout" }); });
        rq.write(payload); rq.end();
      });
      return send(res, 200, "application/json", JSON.stringify({
        ok: r.status === 200 && !!r.content, status: r.status, model: CEREBRAS_MODEL, mode: stream ? "stream" : "chat",
        thinkDisabled: !think, ttfcMs: r.ttfc || null, totalMs: Date.now() - t0,
        contentChars: (r.content || "").length, reasoningChars: (r.reasoning || "").length,
        sample: (r.content || "").slice(0, 180), errBody: r.errBody,
      }));
    }

    if (path.startsWith("/u/")) {
      const h = path.slice(3).replace(/^@/, "").trim();
      if (!validHandle(h)) return send(res, 400, "text/html; charset=utf-8", renderError(h, "badhandle"));
      const data = await fetchProfile(h);
      if (data.error) return send(res, data.error === "notfound" ? 404 : 503, "text/html; charset=utf-8", renderError(h, data.error));
      // record on the wall (dedup by login, newest wins)
      const headline = data.stats.topLangs.length ? `${data.stats.topLangs[0][0]} · ${nfmt(data.stats.totalStars)}★` : `${nfmt(data.stats.publicRepos)} repos`;
      const idx = wall.findIndex((w) => w.login.toLowerCase() === data.user.login.toLowerCase());
      if (idx >= 0) wall.splice(idx, 1);
      wall.push({ login: data.user.login, name: data.user.name || data.user.login, avatar: data.user.avatar_url, headline, at: Date.now() });
      if (wall.length > 200) wall.shift();
      return send(res, 200, "text/html; charset=utf-8", renderRoast(h, data, originOf(req)));
    }

    return send(res, 404, "text/html; charset=utf-8", renderError("", "notfound"));
  } catch (e) {
    send(res, 500, "text/html; charset=utf-8", renderError("", "unavailable"));
  }
});

server.listen(PORT, () => console.log("ninja-roast on " + PORT));

#!/usr/bin/env python3
"""Build-time helper for #28: download top-GitHub-contributors per country from
the gayanvoice/top-github-users dataset, trim, and bake into committers-data.js
(a CommonJS module the roast app requires). No runtime external call."""
import json, urllib.request

RAW = "https://raw.githubusercontent.com/gayanvoice/top-github-users/main/cache/{}.json"
COUNTRIES = [
    "united_states", "india", "china", "united_kingdom", "germany", "canada",
    "france", "brazil", "japan", "russia", "australia", "netherlands", "spain",
    "italy", "poland", "sweden", "switzerland", "israel", "south_korea",
    "singapore", "indonesia", "ukraine", "turkey", "mexico", "argentina",
    "nigeria", "pakistan", "bangladesh", "vietnam", "taiwan", "ireland",
    "finland", "norway", "austria", "south_africa", "philippines",
]
PER_COUNTRY = 50
GLOBAL_TOP = 100
ACR = {"Uk": "UK", "Usa": "USA", "Uae": "UAE", "Of": "of", "And": "and"}


def title(slug):
    words = [w.capitalize() for w in slug.split("_")]
    return " ".join(ACR.get(w, w) for w in words)


def fetch(slug):
    req = urllib.request.Request(RAW.format(slug), headers={"User-Agent": "ninja-roast"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())


def trim(u):
    return {
        "login": u.get("login"),
        "name": (u.get("name") or u.get("login") or "").strip(),
        "avatar": u.get("avatarUrl") or "",
        "c": int(u.get("publicContributions") or 0),
        "loc": (u.get("location") or "").strip()[:40],
    }


by_country, seen_global = {}, {}
for slug in COUNTRIES:
    try:
        arr = fetch(slug)
    except Exception as e:
        print("skip", slug, str(e)[:80]); continue
    if not isinstance(arr, list):
        print("skip", slug, "not a list"); continue
    users = [trim(u) for u in arr if u.get("login")]
    users = [u for u in users if u["c"] > 0]
    users.sort(key=lambda x: x["c"], reverse=True)
    top = users[:PER_COUNTRY]
    label = title(slug)
    by_country[label] = top
    for u in top:
        k = u["login"].lower()
        if k not in seen_global or u["c"] > seen_global[k]["c"]:
            seen_global[k] = {**u, "country": label}
    print(f"{label}: {len(top)} (top {top[0]['login']} {top[0]['c']})")

glob = sorted(seen_global.values(), key=lambda x: x["c"], reverse=True)[:GLOBAL_TOP]
ordered = {"Global": glob}
for label in sorted(by_country):
    ordered[label] = by_country[label]

out = {"countries": list(ordered.keys()), "byCountry": ordered}
js = ("// AUTO-GENERATED (build_committers.py) — top GitHub contributors per country\n"
      "// source: gayanvoice/top-github-users · DO NOT EDIT BY HAND.\n"
      "module.exports = " + json.dumps(out, ensure_ascii=False, separators=(",", ":")) + ";\n")
open("demo/roast-app/committers-data.js", "w", encoding="utf-8").write(js)
print(f"\nwrote committers-data.js — {len(ordered)} groups, Global top {len(glob)}, "
      f"~{len(js)//1024}KB")

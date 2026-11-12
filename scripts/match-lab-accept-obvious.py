"""Match lab: check the obviously right matches of a report, so a person only reviews the rest.

usage: python scripts/match-lab-accept-obvious.py [--report <report.json>] [--write] [--show-b N]
  Without --write it only counts. The report defaults to the newest in .match-lab\reports; checks go to
  .match-lab\truth.json (an open review page merges them in on its next save, or reload it).

Only folders that hold one anime and nothing unmatched are considered, and in them only files whose
episode is the number in the name, unchanged (no relation redirect, no range, no "04.5", no season 0),
within the anime's count.
Two independent ways to be sure about the anime:
  A. every file is matched by its own exact title (or a user alias), all with the same parsed title;
  B. the folder's own name is a title of that anime (romaji or English, compared loosely), whatever
     rule matched the files (fuzzy, folder link...).
Extras (opening / ending types, no episode) in such folders are accepted as extras.
Existing checks are never changed; accepted ones carry a note starting with "auto:".
"""
import collections, json, os, re, sys, time, unicodedata

sys.stdout.reconfigure(encoding="utf-8")
lab = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".match-lab")
truth_path = os.path.join(lab, "truth.json")
if "--report" in sys.argv:
    report_path = sys.argv[sys.argv.index("--report") + 1]
else:
    reports = sorted(n for n in os.listdir(os.path.join(lab, "reports")) if n.endswith(".json"))
    if not reports:
        sys.exit("no reports yet: scripts/match-lab.ps1 run \"baseline\"")
    report_path = os.path.join(lab, "reports", reports[-1])
print("report", os.path.basename(report_path))
write = "--write" in sys.argv
show_b = int(sys.argv[sys.argv.index("--show-b") + 1]) if "--show-b" in sys.argv else 0
report = json.load(open(report_path, encoding="utf-8"))
truth = json.load(open(truth_path, encoding="utf-8")) if os.path.exists(truth_path) else {"files": {}}
truth.setdefault("files", {})
entries = {e["anilist_id"]: e for e in report["entries"]}
EXTRA_TYPES = {"op", "opening", "ncop", "ed", "ending", "nced", "preview", "pv", "cm", "menu", "trailer"}
# "04.5", "S01E05.5": a special between episodes, which the parse reads as the episode before it
FRACTION = re.compile(r"\d[.,]5(?!\d)")


def loose(s, drop_parens=False):
    """Lowercase ASCII words. Brackets are tags ("[02]", "[Group]"); a parenthesis may be part of the
    title ("(2009)", "(Zoku-hen)"), so it is only dropped on request."""
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = re.sub(r"\[[^\]]*\]", " ", s)
    if drop_parens:
        s = re.sub(r"\([^)]*\)", " ", s)
    s = re.sub(r"^\s*\d{1,3}\s*[-.]\s+", " ", s)           # "06 - " ordering prefix
    s = re.sub(r"[^a-z0-9]+", " ", s)
    s = re.sub(r"\b(the|tv|season)\b", " ", s)
    s = re.sub(r"\b(ii|iii|iv)\b", lambda m: {"ii": "2", "iii": "3", "iv": "4"}[m.group(1)], s)
    return " ".join(s.split())


def folder_names_anime(folder_name, entry):
    titles = {loose(entry.get("title")), loose(entry.get("english"))} - {""}
    if loose(folder_name) in titles:
        return True
    # "Title (Other Title)": the parenthesis may go only when it holds the anime's other title
    parens = re.findall(r"\(([^)]*)\)", folder_name)
    return (loose(folder_name, drop_parens=True) in titles and bool(parens)
            and all(loose(p) in titles for p in parens))


groups = collections.defaultdict(list)
for f in report["files"]:
    groups[os.path.dirname(f["path"])].append(f)

why_not = collections.Counter(); folders_left = collections.Counter()
accepted = {}; b_examples = []
for folder, files in groups.items():
    outs = [f["out"] for f in files]
    ids = {o["anilist_id"] for o in outs}
    reason = None
    if None in ids: reason = "folder has unmatched files"
    elif len(ids) != 1: reason = "folder holds several anime"
    if reason:
        why_not[reason] += len(files); folders_left[reason] += 1; continue
    aid = ids.pop(); e = entries.get(aid, {})
    by_title = (all(o["kind"] in ("title", "alias") for o in outs)
                and not any(f["parse"]["own"] for f in files)
                and len({f["parse"]["title"] for f in files}) == 1)
    named = folder_names_anime(os.path.basename(folder), e)
    if not (by_title or named):
        why_not["no second proof (fuzzy / folder / relation, folder named otherwise)"] += len(files)
        folders_left["no second proof"] += 1
        continue
    rule = "exact title" if by_title else "folder named after the anime"
    if not by_title and len(b_examples) < show_b:
        b_examples.append(f"{folder}  ->  {e.get('title')}  [{', '.join(sorted({o['kind'] for o in outs}))}]")
    total = e.get("episodes")
    odd = 0
    for f in files:
        o, p = f["out"], f["parse"]
        if (p["type"] or "").lower() in EXTRA_TYPES and o["episode"] is None:
            accepted[f["path"]] = {"anilist_id": aid, "episode": None, "note": f"auto: extra, {rule}"}
        elif (o["episode"] is not None and p["episode"] == o["episode"] and p["episode_alt"] is None
              and not p["type"] and (total is None or 1 <= o["episode"] <= total)
              and p["season"] != 0 and not FRACTION.search(os.path.basename(f["path"]))):
            accepted[f["path"]] = {"anilist_id": aid, "episode": o["episode"], "note": f"auto: {rule}"}
        else:
            odd += 1
    if odd:
        why_not["file itself is odd (special, range, redirect, out of range)"] += odd
        folders_left["has odd files"] += 1

new = {p: v for p, v in accepted.items() if p not in truth["files"]}
rules = collections.Counter(v["note"] for v in accepted.values())
print(f"{len(report['files'])} files in {len(groups)} folders, {len(truth['files'])} already checked by you")
print(f"obvious: {len(accepted)} ({len(new)} not checked yet), left for you: {len(report['files']) - len(accepted)}")
for note, n in rules.most_common():
    print(f"  {n:>6}  {note}")
print("left:")
for reason, n in why_not.most_common():
    print(f"  {n:>6} files  {reason}")
print("folders needing a look:", dict(folders_left))
disagree = [p for p, v in accepted.items() if p in truth["files"] and
            (truth["files"][p].get("anilist_id"), truth["files"][p].get("episode")) != (v["anilist_id"], v["episode"])]
print("accepted files you checked differently:", len(disagree), disagree[:5])
for line in b_examples:
    print("  B:", line)
if write:
    now = int(time.time())
    for p, v in new.items():
        truth["files"][p] = {**v, "at": now}
    tmp = truth_path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(truth, fh, ensure_ascii=False)
    os.replace(tmp, truth_path)
    print(f"wrote {len(new)} checks; {len(truth['files'])} checked in total")

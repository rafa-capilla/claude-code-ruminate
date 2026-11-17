"""Appends to a ruminator's jsonl what happened in the main session since it last knew.

usage: merge.py <ruminator jsonl> <main jsonl> <ruminator short id>

What is new is the main session's live branch from the last point the ruminator already knows:
the last uuid they share (the fork base or an earlier merge) or the last answer the ruminator
gave back ("ruminated at <id>"), whichever comes later. Entries go in as they are, with the
ruminator's sessionId, and the first one hangs from the ruminator's last entry.
Prints how many it appended.
"""
import json
import sys

rum_path, main_path, short = sys.argv[1:4]


def rows(path):
    with open(path) as f:
        return [json.loads(l) for l in f if l.strip()]


def text_of(r):
    c = (r.get("message") or {}).get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        return "".join(b.get("text", "") for b in c if isinstance(b, dict))
    return ""


rum = rows(rum_path)
main = [r for r in rows(main_path) if r.get("uuid") and not r.get("isSidechain")]
known = {r["uuid"] for r in rum if r.get("uuid")}
rum_last = next(r for r in reversed(rum) if r.get("uuid"))
session = rum_last["sessionId"]

# the main session's live branch, in order
by_uuid = {r["uuid"]: r for r in main}
chain, u = [], main[-1]["uuid"]
while u in by_uuid:
    chain.append(by_uuid[u])
    u = by_uuid[u].get("parentUuid")
chain.reverse()

start = -1
for i, r in enumerate(chain):
    if r["uuid"] in known or (
        r.get("type") == "assistant" and text_of(r).startswith(f"ruminated at {short}")
    ):
        start = i
if start < 0:
    sys.exit("the ruminator shares nothing with the main session")

new = [r for r in chain[start + 1 :] if r["uuid"] not in known]
parent = rum_last["uuid"]
with open(rum_path, "a") as f:
    for r in new:
        f.write(json.dumps({**r, "parentUuid": parent, "sessionId": session}, ensure_ascii=False) + "\n")
        parent = r["uuid"]
print(len(new))

---
name: heckle
description: Process the Heckle QA inbox. Read .heckle/inbox.md and, for each open item, fix it using its repro steps and attached console/network context, run tests, and mark it done. Use when the user says "check Heckle", "go heckle", "process the inbox", or references .heckle/inbox.md.
---

# Heckle: process the QA inbox

Heckle is a local QA co-pilot. A person tested the app and flagged issues; each approved
item is written to `.heckle/inbox.md` as structured feedback with the receipts attached.

## When to use
The user says "check Heckle", "go heckle", "process the inbox", or points at
`.heckle/inbox.md`. Heckle's auto-dispatch also invokes this after an item is approved.

## Steps
1. Read `.heckle/inbox.md`. Each item has: an id, an intent (the instruction), a severity
   (blocker/bug/polish), repro steps, and attached console/network context (the receipts).
2. For each item still open (skip ones already marked done):
   - Reconstruct the problem from the repro steps plus the attached console errors and
     failed network calls. Those are the evidence; trust them over guessing.
   - Make the smallest correct fix. Do not add unrequested work.
   - Run the project's tests or build if present, and confirm the fix matches the intent.
   - Mark the item done in `.heckle/inbox.md`, preserving its id.
3. If an item is vague or you cannot reproduce it, do not guess. Note what you found under
   the item and leave it open for the person to clarify.

## Rules
- The attached console/network refs are ground truth for what broke. Start there.
- One item, one focused change. Keep edits minimal and match the surrounding code.
- Never delete other items or rewrite `.heckle/inbox.md` wholesale; only update the item
  you addressed.

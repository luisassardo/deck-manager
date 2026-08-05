# Authoring decks for CUE

**Read this before writing a single line of a presentation.** CUE displays,
edits, presents and exports HTML decks — but only decks that follow the
contract below. A deck that ignores it still "works" in a browser and then
turns out to be un-editable, un-exportable, or invisible in the library, which
is discovered at the worst possible moment.

If you are an AI assistant asked to "make slides" / "build a deck" / "add a
session" for this user: this file is the specification. Follow it exactly, then
run the validator (bottom of this file) before you say you are done.

---

## 1. The shape of a deck

One deck = **one folder** containing **one `.html` file** plus its assets:

```
My Workshop/
  My Workshop.html      ← the deck (same name as the folder)
  deck-stage.js         ← the slide engine (copy it in — see §2)
  assets/               ← images, fonts, anything the deck loads
```

Put that folder anywhere inside the decks root (the folder CUE is pointed at).
Group folders are fine and become sections in the library:
`Digital Security/My Workshop/My Workshop.html`.

**Never** put two decks in the same folder if they have their own assets — CUE
treats a folder with exactly one `.html` plus assets as "this deck owns this
folder" and will move/rename/delete the whole folder as a unit.

---

## 2. The required skeleton

Copy this. It is the minimum that CUE will display **and** edit.

```html
<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>My Workshop</title>          <!-- becomes the deck name in the library -->
<style>
  *,*::before,*::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: #000; }
  deck-stage:not(:defined) { visibility: hidden; }   /* no flash before upgrade */
  deck-stage > section {
    background: #0A0E1A; color: #fff;
    overflow: hidden; position: relative;            /* position:relative is required
                                                        for placed images/text boxes */
  }
</style>
<script src="deck-stage.js"></script>
</head>
<body>
<deck-stage width="1920" height="1080">

  <section data-label="Title" data-speaker-notes="What I say out loud here.">
    …slide 1…
  </section>

  <section data-label="Agenda">
    …slide 2…
  </section>

</deck-stage>
</body>
</html>
```

Non-negotiables:

| Rule | Why |
|---|---|
| A literal `<deck-stage` element in the file | This string is how CUE detects a deck at all. No match → the deck is listed read-only as "external", with no editing, no presenter, no slideshow. |
| `<script src="deck-stage.js">` pointing at a **local copy** | The engine. Copy it from `templates/new-deck/deck-stage.js` (or from any existing deck) into the deck's folder. Never link it from the internet. |
| Every slide is a **direct `<section>` child** of `<deck-stage>` | Slides are `deck-stage > section`. A wrapper `<div>` around them means zero slides are found. |
| Fixed design size `width="1920" height="1080"` | Everything (scaling, thumbnails, PDF page size) derives from it. Author at those exact pixel dimensions; CUE scales to fit any screen. |
| `<title>` set to the deck's name | It is the library card title and the PDF filename. |

Recommended on every slide:

- `data-label="Short name"` — the name shown in the thumbnail rail and
  presenter view. Without it CUE guesses from the first heading.
- `data-speaker-notes="…"` — presenter notes. Stored on the slide itself, so
  they survive reordering and duplication.

---

## 3. Write slides so they can actually be edited

CUE's editing works by reading and rewriting the DOM in the file. That gives
three hard rules.

**3.1 — The HTML must be the content.** Never generate slide content with
JavaScript (no React, no `innerHTML` loops, no templating at runtime). CUE
saves by serializing the live DOM back into the file; a JS-rendered deck either
loses its source or bakes in generated markup. Write the markup literally.

**3.2 — Text lives in its own element.** Double-click editing targets the
nearest element that *directly* contains text. Write:

```html
<div class="lead">Passwords are the front door.</div>          <!-- editable -->
```

not:

```html
<div><span><b>Passwords</b></span> are the <em>front door</em>.</div>
```

The second is still editable, but only piece by piece and it reflows oddly.
Keep one sentence or line per element; use a wrapper only for layout.

**3.3 — Style with inline `style=` or a `<style>` block in the same file.**
Both survive editing. External stylesheets work for display but CUE cannot
rewrite them, so a trainer editing text can't adjust its look. Self-contained
is the goal: the deck must render correctly opened directly from disk, offline,
with no server.

---

## 4. Things that silently break CUE

These are real failures we have already hit. Avoid all of them.

**Do not pin the host to the viewport.**
```css
deck-stage { position: fixed; inset: 0; }   /* ✗ breaks PDF export */
```
Author CSS on the host outranks the engine's print rules, and every slide
collapses onto **one PDF page**. CUE now injects a print-time override for it,
but don't rely on that — style `deck-stage > section`, not `deck-stage`.

**Do not rely on network assets.** Google Fonts, CDN scripts and hotlinked
images all fail in a hotel conference room with no wifi, and in PDF export.
Download fonts into `assets/` and use `@font-face`, or use system fonts.

**Do not use `<x-dc>` / `<x-import>` wrappers.** Decks exported in that format
are display-only in CUE. If you have one, run
`node unbundle.mjs "<file>.html" "<out folder>"` to convert it first.

**Do not overflow the canvas.** Content must fit 1920×1080. Anything past it is
cut off in the slideshow and in PDF. Keep `overflow: hidden` on sections so an
overflow is obvious while authoring rather than at showtime.

**Do not hand-write `data-deck-*` or `data-screen-label` attributes.** The
engine manages those at runtime and strips them on save.

**Do not put two decks' assets in one folder** (see §1).

---

## 5. Content conventions that make good workshops

Not enforced by the tool, but this is the house style:

- One idea per slide. If a slide needs a scrollbar, it's two slides.
- Body text ≥ 28px at the 1920×1080 design size — it will be read from the back
  of a room and through video compression.
- Enough contrast to survive a projector: light text on the dark plate, or the
  reverse, never mid-grey on mid-grey.
- Speaker notes on every content slide. They are the deck's memory six months
  later, and they show in presenter view.
- Start from the layout templates in `templates/slides/` — title, section
  divider, bullets, two-column, comparison, big-stat, quote, three-cards,
  blank. Matching them keeps a series visually consistent.

---

## 6. Validate before you finish

```bash
node cue-doctor.mjs "path/to/My Workshop/My Workshop.html"
```

It checks everything in §2–§4 and prints pass / warn / fail with the fix for
each problem. **Exit code 0 means CUE can display, edit, present and export the
deck.** Run it on every deck you create or modify; treat any ✗ as unfinished
work. Check the whole decks folder at once with:

```bash
node cue-doctor.mjs --all "path/to/decks/root"
```

---

## 7. Quick checklist

- [ ] Deck lives in its own folder, `.html` named after the folder
- [ ] `deck-stage.js` copied into that folder, referenced with a relative path
- [ ] `<deck-stage width="1920" height="1080">` present
- [ ] Every slide a direct `<section>` child, with `data-label`
- [ ] `data-speaker-notes` on content slides
- [ ] `<title>` = deck name
- [ ] All assets local; renders offline from `file://`
- [ ] No JS-generated content, no `position: fixed` on `deck-stage`
- [ ] Text in its own elements, one line/sentence each
- [ ] `cue-doctor.mjs` exits 0

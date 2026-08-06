CUE — The HTML Presentation Studio
===================================

A local studio for HTML presentations: a library of all your decks, inline
editing, presenter view, a clean window you can screen-share in Zoom/Meet, and
one-click PDF export. Everything runs on your own machine; nothing is uploaded.


START IT
--------

  macOS    double-click   "Start CUE (macOS).command"
  Windows  double-click   "Start CUE (Windows).bat"
  Linux    run            ./start-cue.sh      (chmod +x it once)

The first time, CUE asks which folder holds your presentations — point it at
your decks folder (it can be anywhere, on a synced drive too). It remembers the
choice in cue.conf. To change it later, start CUE with --pick, or just edit
cue.conf.

CUE opens in your browser. Closing the terminal/console window stops it.


FIRST TIME: NODE.JS
-------------------

CUE needs Node.js (a free, standard runtime). If it isn't installed, the
launcher tells you and offers the download page — get the LTS version from
https://nodejs.org, install it, then start CUE again. One time only.

  Debian / Ubuntu:  sudo apt install nodejs


WHAT YOU CAN DO
---------------

  Library     every deck as a card, grouped by folder. Drag a card onto another
              group to move it. Hide decks you're not using (files untouched).
  Open        edit a deck: double-click any text to change it; click any element
              to select, drag, resize, restyle or delete it; + Text and + Image
              add objects (or just drag an image file onto the slide).
  Slideshow   a clean full-screen window with no toolbars — this is the one you
              share in Zoom/Meet as a single window.
  Present     presenter view: current slide, next slide, your notes, a timer.
              It drives the Slideshow window automatically.
  PDF         one page per slide, fonts intact.

Every change saves straight into the deck's .html file, and the last 20 versions
of each deck are kept in a .cue-backups folder next to your decks.


MAKING NEW DECKS
----------------

Decks are plain HTML files — one <section> per slide. Start from "+ New deck"
in the library, or copy an existing deck's folder.

If you build decks with an AI assistant, give it AUTHORING.md first. It is the
spec that keeps decks editable and exportable in CUE. Check any deck with:

  node cue-doctor.mjs "path/to/My Deck/My Deck.html"


TROUBLESHOOTING
---------------

Nothing opens              Look at the console window for an error. Most often
                           Node.js isn't installed yet (see above).
Port already in use        CUE picks the next free port automatically.
A deck shows as EXTERNAL   It doesn't use the CUE slide engine, so it can be
                           opened and presented but not edited. See AUTHORING.md.
PDF is one page            The deck pins deck-stage with position:fixed — run
                           cue-doctor.mjs on it, it will tell you the fix.


CUE is open source: https://github.com/luisassardo/cue

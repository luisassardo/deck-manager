**CUE — The HTML Presentation Studio.** A local studio for HTML presentations:
a library of every deck, inline editing, presenter view, a clean window you can
screen-share in Zoom/Meet, and one-click PDF export. Nothing is uploaded
anywhere; every change saves straight into the deck's `.html` file.

### Download

**`CUE-portable.zip`** — works on macOS, Windows and Linux. Unzip it anywhere
and double-click the launcher for your system:

| | |
|---|---|
| macOS | `Start CUE (macOS).command` |
| Windows | `Start CUE (Windows).bat` |
| Linux | `./start-cue.sh` |

On first launch CUE asks which folder holds your presentations — point it at
your decks folder (a synced drive works fine) and it remembers.

**One prerequisite:** [Node.js](https://nodejs.org) (free, LTS version). The
launcher checks for it and offers the download link if it's missing. Installers
with the runtime already bundled — `.dmg`, `.exe`, `.deb` — are built by the
release workflow and land here too.

### Making decks

Decks are plain HTML, one `<section>` per slide. Read **AUTHORING.md** (included
in the zip) before building one — and give it to any AI assistant you ask for
slides, so what comes back is actually editable in CUE. Validate anything with:

```
node cue-doctor.mjs "path/to/My Deck/My Deck.html"
```

Full docs: <https://github.com/luisassardo/deck-manager>

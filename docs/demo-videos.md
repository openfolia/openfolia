# Demo videos

The landing page shows the product in five short videos, each in English and German (#440): one
in the hero, and one for each "See it at work" tab (Editor, Manual builder, Review, Releases).
This page has three parts: the demo content they are filmed on, the demo set-up that runs it, and
the shared look that makes them one series.

How a video is recorded and put together (Playwright, the frame, the cards, ffmpeg) is covered
by the `/demo-video` skill, a recording kit kept outside this repository. Its current version
wins over this page. The look below is written in the skill's format and carries every number a
video needs, so the page can be followed without the kit; the kit's helpers it names (the cursor
overlay, `assemble.mjs`, `LoopVideo`) are that kit's.

**Status: the look is approved** (owner, 2026-11-23, #441), with three changes this page now
holds: the hero's intro and end card, a caption under the window in the tab videos, and no
call-to-action ending. A later change (owner, 2026-11-23, #442) gives the hero a voice-over and
an intro music sting, like the skill's pitch film.

## The demo content

The content is the documentation of a fictional car: the Fenna of an invented maker, Orvik, as a
hatchback and an estate, with petrol or electric drive, for left- and right-hand-drive markets.
It lives in `scripts/demo/content/`, and everything in it is invented: the maker, the model,
its numbers, the people and the drawings. No real brand, model, part number or badge appears.

| What                 | In the demo                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Variants             | Three variant attributes: `body` (hatchback, estate), `drive` (petrol, electric) and `market` (EU with left-hand drive, UK with right-hand drive). Text attributes per variant: `model-name` and `tyre-size`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Modules              | 32 modules, as an owner's manual and a service booklet have them. Safety notices: airbags, child seats, the high-voltage system, jacking and hot parts. Procedures: changing a wheel, refuelling and charging, jump-starting, replacing a fuse or the wiper blades, setting the clock, fitting a child seat, towing. Technical data: tyre pressures, fluids and capacities, dimensions, fuses. Variant blocks: "Refuelling" against "Charging" in one module, UK-only notes, the estate's own values. Block references: the warning-light table, included in the instrument panel module and in two manuals; snippets for securing the vehicle and warning other road users. Glossary terms in the text, a FAQ, and images with numbered callouts. |
| Manuals              | `owners` (the owner's manual, three variants), `quick-start` (eight modules, three variants), `service` (the service booklet for workshops, two variants).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Glossary             | Seven terms. One of them is still `proposed`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Images               | Six simple drawings of our own: the car from the side, the instrument panel, the charging socket, a wheel change, a wiper blade and the fuse box. The sources are SVG files in `content/images/source/`, drawn to PNG by `node scripts/demo/render-images.mjs`; both are committed. The safety symbols are SVG files in `content/symbols/`.                                                                                                                                                                                                                                                                                                                                                                                                        |
| Languages            | English is the source. German and French are complete and up to date, so a release cut on the demo has no translation warning (the Releases video cuts one on camera). French came in two stages: 11 modules first, two of which went out of date with a revision of the English, then the rest and those two again.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| History              | Five commits on weekdays, dated back from the start day: the English source, the first French modules, a revision of two English modules, German, then the rest of the French.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Made through the API | Release 1.0. Then a change merged by the admin: the fully loaded estate's rear tyre pressure raised from 2.9 to 3.1 bar, in English, German and French, the translations marked current. Release 1.1 follows, so the estate PDFs of the owner's manual and the service booklet show the new value. Last, an open change set in review: the author's revision of "Changing a wheel", with the reviewer's comments on two of its steps and the author's reply to one of them.                                                                                                                                                                                                                                                                        |
| People               | Mira Sand (author), Jonas Feld (reviewer, who may also write), Ada Linde (admin). Each signs in as a demo user. Their names live only in `scripts/demo/people.mjs`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

The texts the demo writes through the API (the change set titles, the release notes and the
comments) are written in the take's language. A German take shows German throughout, apart from
the gaps listed below.

`scripts/__tests__/demo-content.test.ts` checks the content. Every file must parse and be valid.
English and German must have the same blocks, and French must be partial. The history must be
on weekdays and the translation states must be real. One module (changing a wheel) goes
through PDF output in English, German and French.

### What a German take still shows in English

- **Manual titles and the project's settings labels.** These are module types, audiences,
  variant labels, facet values and group names, and each holds one text only, not one per
  language. The German PDF title page reads "Owner's manual". This is a product gap, filed as
  #731. The videos avoid lingering on these labels until it is fixed.
- **Module titles in the content list.** The list shows each module's source title, which is
  how the product works.

## The demo set-up

```bash
pnpm demo:start                  # English editor, signed in as the author
pnpm demo:start --lang de        # German editor; what the demo writes is in German too
pnpm demo:reset                  # a clean state between takes: everything made again
pnpm demo:stop
pnpm demo:status
pnpm demo:stills                 # one still per language in the frame (below)
```

**Options:**

- `--user author|reviewer|admin` sets who the editor opens as. The account menu switches people
  during a take.
- `--theme light|dark`
- `--api-port` / `--editor-port`
- `--no-build` skips the build of the API and the editor. Without it, the start builds them
  first, using the Nx cache.
- `pnpm demo:reset` with no options keeps the running demo's options.

**No tips in a take.** The start and every reset mark the first-run tour as done and the tips as
off for the three demo people (`PATCH /me/preferences`: `tourDone`, as the editor stores a
skipped tour, and `showTips: false`), so neither the tour's card nor a tip covers a take or a
still.

The start prints one address, `http://127.0.0.1:4390/__start?lang=…&user=…&theme=…`. It sets
the editor's language, person and theme in the browser, then opens the editor. Open it once
before each take; the recording kit does the same.

**How it runs.** The demo uses the editor's end-to-end stack
(`frontend/editor-e2e/stack/stack.ts`). Its parts:

- an in-memory Postgres (PGlite);
- the built API in demo mode;
- the built editor behind a small server;
- a content repository built from `scripts/demo/content/`.

A start takes about 30 to 60 seconds. Most of that is spent rendering the 48 PDFs of the two
releases, which the start waits for.

**What it leaves alone.** The demo never touches the person's own set-up:

- its ports are 3290 (API) and 4390 (editor), never 3100, 4310 or 4320;
- its folder is `.demo/` (git-ignored), never `.local/`;
- it starts no database server.

A stop removes the content and the database. `.demo/demo.log` keeps the log of the last start.

**The files:**

| File                         | What it does                                                                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `scripts/demo/demo.mjs`      | The commands: start, reset, stop, status.                                                                                                                    |
| `scripts/demo/run.mjs`       | The process that runs in the background.                                                                                                                     |
| `scripts/demo/content.mjs`   | Reads the content and builds the repository with its history.                                                                                                |
| `scripts/demo/populate.mjs`  | Makes the releases, the merged change and the change set in review, through the API.                                                                         |
| `scripts/demo/people.mjs`    | The demo people and their roles.                                                                                                                             |
| `scripts/demo/brand.mjs`     | The product name as the videos show it. It is the one place to change when the name changes.                                                                 |
| `scripts/demo/stills.mjs`    | The still frames.                                                                                                                                            |
| `scripts/demo/look.mjs`      | The look as numbers: the frame and the caption. Read by the stills, the cards and the assembly.                                                              |
| `scripts/demo/cards/`        | The hero's intro and end card: the templates, their texts (`cards.mjs`) and `render.mjs`.                                                                    |
| `scripts/demo/captions.mjs`  | The tab videos' captions: the file format, its checks, and the ffmpeg overlay.                                                                               |
| `scripts/demo/assemble.mjs`  | One video from its take: the frame, the captions or the cards, the crossfades, the hero's sound.                                                             |
| `scripts/demo/record.mjs`    | A take: the browser at the recording size, the cursor and its click ring, shots; parts joined.                                                               |
| `scripts/demo/scenes/`       | One scene script per video (`review.mjs`, `releases.mjs`, `manual-builder.mjs`, `editor.mjs`, `hero.mjs`, with `hero.md`): what the take does, shot by shot. |
| `scripts/demo/outlets.mjs`   | The hero's reader portal (a real build, served) and AI assistant (a real MCP `search`), and the layers drawn from them.                                      |
| `scripts/demo/narration.mjs` | A tab video's voice-over script, and each shot's length from it.                                                                                             |
| `scripts/demo/voice.mjs`     | The voice-over through ElevenLabs, run by the owner with their own key.                                                                                      |
| `scripts/demo/web.mjs`       | The landing page's files of a video (MP4, WebM, poster) and their README lines.                                                                              |

## The shared look

This is the skill's approved pitch look: the app as a rounded window on a graphite background.
All five videos use it, in both languages. One number differs from the skill: the window sits
48 px from the top instead of 72 px, so 96 px stay free below it for the tab videos' caption
(see "Captions" below). The hero uses the same frame, so all five videos match.

| Element           | Spec                                                                                                                                                                                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Output (master)   | 1920×1080, 30 fps, H.264 `crf 18`, `yuv420p`, `+faststart`                                                                                                                                                                                                        |
| Recording         | Browser viewport **1728×972** at zoom 100 % (16:9, so no bars), production build (`pnpm demo:start` builds it)                                                                                                                                                    |
| Frame             | App scaled to **1664×936**, placed at **128,48**, **22 px rounded corners**, shadow `0 40px 90px rgba(0,0,0,.55), 0 8px 24px rgba(0,0,0,.35)` plus a 1 px `rgba(255,255,255,.06)` edge                                                                            |
| Background        | Radial gradient `120% 90% at 50% 0%`: `#2a2c31` → `#17181b` (48%) → `#0b0c0e`, fractal-noise grain at 5% opacity                                                                                                                                                  |
| Theme             | **Light** for all five. The hero also gets a **dark** cut (`--theme dark`), which the skill's frame supports as it is: the dark window sits on the same graphite, and only the 1 px edge sets it apart.                                                           |
| Transitions       | **0.3 s** `xfade=transition=fade` between clips, nothing fancier                                                                                                                                                                                                  |
| Cards             | Hero only: an intro card (7.4 s) and an end card (6.6 s), below. The four tab videos have no cards and start on the app.                                                                                                                                          |
| Cursor and clicks | Visible cursor dot with a click ring (the kit's overlay). No other highlight.                                                                                                                                                                                     |
| Typing            | Typed text appears at about 40 ms per character. Long text is pasted, not typed.                                                                                                                                                                                  |
| Pacing            | One action at a time, then about 1.2 s on its result before the next one. A screen the viewer must read holds for 2 s or more.                                                                                                                                    |
| Length            | Hero: about 92 s of app (#804), about 1:46 with its cards. Each tab video: 15–25 s (the Manual builder about 26 s: its v2 script, approved; the Editor video up to 28 s, owner, 2026-11-23). Every tab video ends where it can loop without a jump.               |
| Captions          | Short signposts on the graphite under the window, each held over several shots, in the take's language (below): three per tab video, six in the hero (#804).                                                                                                      |
| Voice and music   | Tab videos: a voice-over per shot ("Voice-over" below) and, optionally, a quiet music bed under it ("Music, tab videos" below); delivered with sound and silent (`-silent`). The hero: a voice-over and a music sting ("The hero" below), and its own silent cut. |
| Loop              | Tab videos: the last **0.5 s** blend into the opening, which starts 0.5 s in, so the end is the start.                                                                                                                                                            |
| Ending            | **No call to action.** The landing page has its own buttons beside the videos. A tab video ends where it can loop; the hero ends on the end card.                                                                                                                 |
| Language          | Each video is filmed once per language, with `--lang en` and `--lang de`. The German takes are filmed again, never dubbed.                                                                                                                                        |
| Demo data         | `pnpm demo:reset` before every take. Dates count back from the day of filming, on weekdays.                                                                                                                                                                       |

### The hero's cards

Built from the skill's card templates, rebranded: the frame's own graphite and grain (so the
intro flows into the first shot without a cut and the end card closes where the film began), a
slow push-in (scale 1 to 1.045 on the intro, to 1.04 on the end card), elements that come in from a blur, the theme's Geist and Geist
Mono, and the theme's lockup for dark backgrounds (`frontend/theme/src/brand`). Everything is
near-monochrome; the brand green is the only colour, for one moment: the mark's green leaf
landing.

- **Intro, 7.4 s.** One module, "Changing a wheel" (DE "Rad wechseln") with its ID, floats on the
  graphite. It splits into the demo's three manuals, each as a page in the take's language with
  the page in the other language behind it, the module inside each. The pages fold back into the
  mark: the spine builds, the back leaf fans out, the green leaf catches last. The name wipes in,
  then the line in two beats, the second brighter: EN "Write it once. **Publish every
  manual.**", DE "Ein Modul. **Jede Anleitung.**".
- **End card, 6.6 s.** The mark builds, its green leaf lands at about 1.6 s, then the name and
  the same line. No call to action.

```bash
node scripts/demo/cards/render.mjs                  # both cards, EN and DE
node scripts/demo/cards/render.mjs --card intro --lang de
node scripts/demo/cards/render.mjs --stills-only    # only the stills
```

`render.mjs` steps every CSS animation to the exact frame time and screenshots each frame (no
screen-recording judder), then encodes with `crf 14`. It writes `.demo/cards/<card>-<lang>.mp4`,
the filled page next to it (`<card>-<lang>.html`, to preview in a browser), and three stills per
card, at the start, the middle and the end where the card holds still:
`.demo/stills/cards/<card>-<lang>-<start|middle|end>.png`. The texts are in
`scripts/demo/cards/cards.mjs`; the product name in the page title comes from `brand.mjs`, the
mark from the theme, so a rebrand reaches the cards without editing them.

The greys are `CARD_COLORS` in `cards.mjs`, three steps of text and one of drawing. Every text is
at least **4.5:1** against the lightest background behind it, measured on the rendered frames
(the 99th percentile of the pixels in the text's box, with the text hidden): the bright beat and
the module's title `#eef0ec` (12.5:1 on the module's page, about 15:1 on the graphite), the first
beat and the manuals' titles `#a4a9b1` (7.3:1 under the line, 6.2:1 on a manual's page), the
module's ID and the language tags `#94989f` (4.8:1 on the module's page, 5.2:1 on a manual's).
The bullets of the placeholder lines keep the old `#5d626a`: drawing, not text. A test holds the
greys to those surfaces (`CARD_SURFACES`).

### Captions

The tab videos play muted, in a loop, so a caption tells the viewer what they are looking at:
three quiet signposts per video, each held over the shots of one step of the story, on the
graphite under the window, in the take's language.

| Element  | Spec                                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Type     | Geist (the theme's), weight 500, **32 px**, line height 40 px, letter spacing −0.01em                                                                    |
| Colour   | `#eef0ec` (the theme's dark-mode text), about 17:1 on the graphite below the window; no box, no shadow                                                   |
| Position | Centred on the frame's width, one line, its middle at **y 1032**: the middle of the 96 px band between the window (ending at y 984) and the frame's edge |
| Length   | One phrase, at most **60 characters** in either language (the assembly refuses more than 70), so it stays one line well inside the window's width        |
| Timing   | From its start shot's start until the next caption's start shot, or the take's end; at least 1.5 s                                                       |
| Fade     | Opacity only, 0.25 s, and only where one caption gives way to the next: none between the shots one caption spans. No movement                            |
| Words    | A signpost in plain words ("Questions settled on the step itself"), names, never a role. **No full stop at the end**, no capitals, no exclamations       |

**Why the window moved up.** Below a window at y 72 there are 72 px. The tab videos are encoded at
1280 px wide and shown at about 1000 px on the landing page, so a caption that fits 72 px
(about 24 px tall) would show at about 12 px: too small to read. At 32 px it shows at about
17 px, which needs about 96 px of band. Moving the window up by 24 px gives that band and keeps
the window's size, so the app on screen stays as readable as approved. The hero keeps the same
frame, with the band empty, so all five videos match.

**The captions file.** One per tab video, `scripts/demo/captions/<video>.json`, written with the
video's storyboard, keyed by the recording kit's shot ID **where each caption starts**, every entry
in both languages:

```json
{
  "01a": {
    "en": "Mira's revision, every edit marked",
    "de": "Miras Überarbeitung, jede Änderung markiert"
  },
  "02a": {
    "en": "Questions settled on the step itself",
    "de": "Fragen werden direkt am Schritt geklärt"
  },
  "03a": {
    "en": "Approved: the revision is ready to merge",
    "de": "Freigegeben: bereit zum Zusammenführen"
  }
}
```

A caption holds from its shot until the next caption's shot starts (the last one until the
take's end), so 01b and 02b above carry the caption before them. A file with an entry for every
shot (the first format) still works: each caption then holds for its own shot. The assembly
refuses a caption longer than 70 characters, one ending in a full stop, one with a line break or
markup, one missing a language, and one for a shot the take does not have.

### Voice-over

A tab video tells one small story, in English and German, besides its captions: a tension up
front, a payoff, a short last line that sticks. Its sentences run across the cuts; each shot has
its part of them, and a sentence that spans two shots sits on the shot where it starts. The
captions signpost, the voice tells. The same rule as the
captions: neutral, names (Mira, Jonas), never a role noun or "he"/"she" for a role.

**The script.** `scripts/demo/captions/<video>.narration.<lang>.md`, in the kit's narration
format: one block per scene, one line per shot, the scene's number and the line's letter being
the shot's ID.

```markdown
## 01-diff

- a: Before Mira's wheel change goes out, Jonas reads every edit…
- b: then side by side, old against new.
```

**Timing.** Each shot lasts as long as its line (`narration.mjs`): 0.25 s before it, the line,
0.45 s after it, and at least as long as its action needs; the first and the last shot get the
loop's 0.5 s on top, so no line sits under the blend. Before the voice exists, a line's length is
estimated at 2.6 words per second in English and 2.3 in German.

**A pause between sentences.** Where a line holds two sentences, the voice pauses at the full
stop instead of running on: `voice.mjs` sends a `<break time="0.45s" />` after each sentence end
inside a line (`.`, `?` or `!`, perhaps closed by a quote, followed by a capital; never after
"…", an abbreviation such as "z. B." or "e.g." or a number, as in "am 3. Mai"), and the estimate counts 0.45 s per break
(`SENTENCE_PAUSE_MS` in `narration.mjs`). `previous_text` and `next_text` go without the tags.
The script itself stays plain text.

**The voice** is made by the owner, with their own ElevenLabs key: agents write the narration and
time the shots, and never handle the key. One mp3 per shot, read knowing the lines around it:

```bash
node scripts/demo/voice.mjs review --lang en --dry-run           # the lines, no key
DEMO_VOICE_EN=<voice id> node scripts/demo/voice.mjs review --lang en
DEMO_VOICE_DE=<voice id> node scripts/demo/voice.mjs review --lang de
```

It asks for the key without echo (or reads `ELEVENLABS_API_KEY` from the environment) and writes
`.demo/voice/<video>-<lang>/<shot>.mp3`. Then the take is filmed again, now timed from the voice,
and assembled: the assembly refuses a line longer than its shot.

### The hero

The storyboard is `scripts/demo/scenes/hero.md`; the take is filmed by
`scripts/demo/scenes/hero.mjs`. Since #804 it tells one story, a circle ("The question"): a
reader asks the portal how tight the wheel bolts go, and neither the portal nor an AI assistant
has the number (release 1.1); the gap is in two manuals, every variant, three languages; in
OpenFolia the fix goes in once (Mira, in both languages; the French goes to its translators);
Jonas approves, Ada releases 1.2; and the same question finds its answer in every PDF, on the
portal and through the assistant, quoting release 1.2. The take has ten parts (`HERO_PARTS`,
`record.mjs` `joinParts`), joined with the look's crossfade; between them, through the API and
off camera, what only waits: the save points, the German marked current, the merge, the French
coming back (a translation job's XLIFF, translated, imported and merged), the release's files,
the portal built again.

**The portal and the assistant are real** (`scripts/demo/outlets.mjs`). The take makes a role
holding `content.read` alone, up to the owners' audience, a service account with it and a token
(`readerToken`). With that token the portal's own build (`frontend/portal/scripts/build.ts`)
makes the owners' site in the take's language at release 1.1, and again at 1.2, served as plain
files on 127.0.0.1 (a free port) while the take films it; and the MCP server (`backend/mcp/dist/main.js`,
over stdio, through the official SDK's client) answers `search` at each release's tag. The
assistant layer shows the reader's question, that tool call and the first module it returned,
word for word: no model writes an answer, and no vendor's chat window appears. To let Mira mark
the German current with the English, the take gives her a role with `translation.manage` for
German only (the demo is reset before the next take).

```bash
node scripts/demo/scenes/hero.mjs --lang en [--theme dark]    # resets the demo, films the take
node scripts/demo/assemble.mjs hero --lang en                  # hero-dark for the dark cut
```

**Captions.** Six, in `scripts/demo/captions/hero.json` (the dark cut uses the same file), in the
tab videos' format and look; each spans the shots up to the next.

**Voice-over.** The same as a tab video's: `scripts/demo/captions/hero.narration.<lang>.md`, the
owner's voice through `voice.mjs hero --lang <lang>`. A shot lasts as long as its actions need
(`HERO_SHOTS`) or as long as its line, whichever is longer. The dark cut uses the light cut's
voice, `.demo/voice/hero-<lang>/`.

**Music.** None is committed. `DEMO_MUSIC=<file>` names the track at assembly, with
`DEMO_MUSIC_STING_FROM` (seconds into the track where the sting starts, default 0) and
`DEMO_MUSIC_HIT` (the track's last hit, default half a second before its end). The sting plays
under the intro card at volume 0.5 and fades out over 3 s, gone about 2 s into the first shot;
the track's ending plays under the end card, its last hit on the logo's landing (1.6 s into the
card). With `DEMO_BED=<file>` (#804), the tab videos' bed plays under the app: at the same
**−29 LUFS**, dipping 3.5 dB under each line, in over 2 s from a second before the first shot
(under the sting's fade, so there is no gap) and out over the app's last 1.5 s, so the ending
lands clean (`HERO_BED`, `soundPlan`). Check the tracks' licences before the film goes public.

**Two cuts.** `.demo/films/hero-<lang>-silent.mp4` for the muted autoplay, and
`.demo/films/hero-<lang>.mp4` with the voice and the music, made only once there is a voice or
`DEMO_MUSIC`.

### The Releases video

`scripts/demo/scenes/releases.mjs` (#446): Ada cuts release 1.2 in the "New release" dialog
(the version, straight on to the notes, a pasted summary, "Create release"); the release's page
then shows what changed since 1.1, per manual and language, and its PDFs per variant and
language; one opens, a strip of the owner's manual for the estate in the take's language with
the new step marked (drawn from the release's own file, `pdfTile`, as the hero's are). Before the
take, off camera, Mira's revision in review is approved and merged and its translations follow,
so the dialog's checks are clean: no warning to confirm on camera (the scene refuses one). The
take has two parts; between them, off camera, the release's files are made, waited for on its
`meta.outputs.state`.

### The Manual builder video

`scripts/demo/scenes/manual-builder.mjs` (#444): Mira, in a new revision, adds the high-voltage
notice to the quick start guide from the add list, drags it into place after the airbags and keeps
it to the electric variants (the row's "Only for some variants…"); the preview for petrol names it
among what the variant hides, the one for the estate (electric) has it in its contents; and the
PDF, built from the revision, opens on two of its pages, the contents and the module's own page,
its title marked. The PDF opens in a new tab, which the take's browser cannot show: the take keeps
the file the click built, closes the tab and lays the pages (`pdftoppm`) over the preview. The
builder opens in the take's language (`&lang=`), so the preview and the PDF are in it too; the
builder's list shows the source titles (#731). The revision is started through the API before
the take, off camera.

### Recording a take

```bash
node scripts/demo/scenes/review.mjs --lang en          # resets the demo, then films the take
node scripts/demo/scenes/review.mjs --lang de --only 02a,02b   # only these shots: a preview
node scripts/demo/scenes/editor.mjs --lang en          # the Editor video, the same way
```

A scene script drives the editor through its shots with `record.mjs`: the browser at the
recording size, the kit's cursor dot and click ring, the cursor moved eased onto each target (and
kept off the words the viewer reads), each shot held for its length. A move is driven by the
clock, so it lasts the time it is given even when the page is busy (fewer steps, not a slower
dot). It writes the take and its shots to `.demo/takes/<video>-<lang>.webm` and `.json`.

**The Editor video** (`scenes/editor.mjs`) writes in "Checking the tyre pressure", in a revision
of Mira's made through the API before the take: a new step, a variant block through the slash
menu with its note, shown only for the estate (the dialog lists the builds that show it), a
warning through the slash menu, the snippet "Secure the vehicle" by reference from the toolbar's
Insert menu, then the live preview, which names the estate's block as hidden for its variant. With
`--only`, the shots before the chosen ones run off camera first.

### Putting a video together

```bash
node scripts/demo/assemble.mjs review --lang de
node scripts/demo/assemble.mjs hero --lang en
```

It reads the take and its shots from the recording kit (`.demo/takes/<video>-<lang>.webm` and
`.json`, or `--take` and `--shots`), frames the take, and then either lays the captions over it
(a tab video) or puts the cards around it with 0.3 s crossfades (`hero`, `hero-dark`). The
master goes to `.demo/films/<video>-<lang>.mp4`: 1920×1080, 30 fps, H.264 `crf 18`. Each caption
is drawn once as a transparent picture in the theme's font and laid over its shot with its fade
(ffmpeg here has no text filter, and the picture keeps the type exactly the theme's).

A tab video ends where its last shot ends (what the browser recorded while the take closed is
cut). It is then looped (from a lossless copy, so the loop costs no quality) and written
silent, `.demo/films/<video>-<lang>-silent.mp4`. Once every line has its voice
(`.demo/voice/<video>-<lang>/`, or `--voice <dir>`), the voiced cut follows,
`.demo/films/<video>-<lang>.mp4`: the silent picture with the lines laid in at their shots.

### Music, tab videos

A tab video can have a quiet music bed under its voice: `DEMO_BED=<file> node
scripts/demo/assemble.mjs releases --lang en`. The track is never committed (the owner keeps it
in `.demo/music/`); without `DEMO_BED` the cuts are as above. Only the cut with sound gets it,
the `-silent` cut stays silent, and `web.mjs` encodes it with the voice (its README line says
"voice, music bed and captions"). The set-up, in `assemble.mjs` (`BED`, `bedFilter`):

- **The voice's level:** a cut's voice lines are measured together (`loudnorm`, measuring
  only) and brought to **−23 LUFS** integrated by one fixed gain for the whole cut (`VOICE` in
  `assemble.mjs`, #805), so English and German sound equally loud though their voice files come
  out several LU apart. The lines keep their dynamics against each other: no line is normalised
  alone, no compressor. This holds with or without a bed.
- **Level:** the integrated loudness of the part of the track the film plays is measured
  (`loudnorm`, measuring only; a track's opening is often much quieter than its whole) and a fixed
  gain brings it to **−29 LUFS** integrated, steady and without a limiter colouring it.
- **Ducking:** while a line is spoken the bed dips a further **3.5 dB**, ramped over 0.25 s on
  each side: volume automation from the voice's own cues, not a compressor, so it is the same
  every time and cannot pump.
- **Loop:** a track shorter than the film is laid end to end with 1.5 s equal-power
  (`qsin`) crossfades until it covers the film, then cut to the film's length.
- **Fades:** in over **1 s**, out over **1.5 s**. Both are longer than the film's 0.5 s loop
  blend, so where the film runs from its end into its start the bed is silent on both sides: the
  loop has no bump.

### The files and where they go

The masters come from the kit (`assemble.mjs`). The web files are encoded from them, as the
skill's `reference/website.md` describes: `node scripts/demo/web.mjs review --lang en` writes a
video's files to `.demo/out/`, with their lines in `.demo/out/README.md`. A tab video has a silent
cut (`<video>-<lang>-silent.mp4/.webm`) and, once the voice exists, a voiced one
(`<video>-<lang>.mp4/.webm`, AAC 96 kb/s and Opus 64 kb/s instead of `-an`). The hero's are
the same, with its sound cut once there is a voice or music. `--out <dir>` writes elsewhere; the
README keeps the other videos' lines.

| File                              | How it is made                                                                                          | Target size                                       |
| --------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `<video>-<lang>.mp4`              | H.264, `scale=1600:-2` for the hero and `scale=1280:-2` for the tabs, `-crf 28`, `-an`, `+faststart`    | hero ≤ 8 MB (#804: about 1:46), each tab ≤ 1.5 MB |
| `<video>-<lang>.webm`             | VP9, the same scale, `-crf 38 -b:v 0` (then 42, 46, 50 until no larger than the MP4), `-an`             | at most the MP4's size                            |
| `<video>-<lang>.jpg`              | Poster: one frame at 1600×900 (`-q:v 3`): the frame a tab video opens on, the hero's intro line (6.3 s) | ≤ 150 KB                                          |
| `hero-dark-<lang>.mp4/.webm/.jpg` | The hero's dark cut, made the same way                                                                  | as the hero                                       |

**The videos and their names:**

- `hero`
- `editor`
- `manual-builder`
- `review`
- `releases`

The languages are `en` and `de`.

On the page, each video plays muted, in a loop, inline, with `preload="none"`, and only while it
is on screen. With reduced motion, the poster stays (the kit's `LoopVideo`).

**Delivery.** The files go to the landing page project's media folder, `public/media/`. Next to
them goes a `README.md` with one line per file: the video, the language, the length and the
commit of this repository it was filmed on.

### Still frames

`pnpm demo:stills` writes one still per language (`.demo/stills/review-<lang>.png`) from the
running demo. It shows the review screen as the reviewer sees it, in the frame above. Use
`--screen /content`, `--user` and `--theme dark` for other stills, and `--caption "<text>"` to
see a caption under the window (`…-caption.png`). The stills are for approving the look before
anything is filmed; the cards' stills come from `cards/render.mjs`.

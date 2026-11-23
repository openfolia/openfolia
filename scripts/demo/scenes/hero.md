# The hero: storyboard

"The question" (#804): one story, a circle. A reader asks how tight the wheel bolts go; the
portal and an AI assistant have no answer (release 1.1). The gap is in every manual, variant and
language; in OpenFolia the fix goes in once; the same question then finds its answer in every
PDF, on the portal and through the assistant (release 1.2). About 85 s of app between the intro
card (7.4 s) and the end card (6.6 s), in the frame at 128,48, light and a dark cut
(`hero-dark`), in English and German. Six captions under the window
(`scripts/demo/captions/hero.json`), the voice-over in
`scripts/demo/captions/hero.narration.<lang>.md`, the sting (`DEMO_MUSIC`) under the cards and
the quiet bed (`DEMO_BED`) under the app.

Filmed by `hero.mjs` next to this file, on a clean demo each take, in ten parts
(`HERO_PARTS`) joined with the look's crossfade. The people: Mira (writes), Jonas (reviews), Ada
(releases).

| Shot | On screen                                                                                                                                                                                 | Holds at least |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
|      | **Intro card**                                                                                                                                                                            | 7.4 s          |
| 01a  | The reader portal at release 1.1 (owners, the take's language): "wheel bolts" typed into its search, "Changing a wheel" opens on its steps.                                               | 5.0 s          |
| 01b  | The last step, "…tighten the wheel bolts crosswise.", and nothing more; the cursor rests beside it.                                                                                       | 2.5 s          |
| 01c  | The assistant layer: the reader's question, the `search` call through the MCP server at release 1.1, the passage it returned, without a value.                                            | 4.5 s          |
| 02a  | Release 1.1's page as Mira: "All 30 files ready", the files list scrolling through the manuals per variant and language.                                                                  | 5.0 s          |
| 02b  | The content list: the modules, each in English, German and French; the cursor down the languages to "Changing a wheel".                                                                   | 4.0 s          |
| 02c  | The owner's manual in the builder ("Drive: Electric" beside the high-voltage module), its preview switched to the electric estate: "High-voltage system" appears, in the take's language. | 6.6 s          |
| 03a  | "Changing a wheel" in Mira's draft revision; the cursor goes to the last step.                                                                                                            | 2.4 s          |
| 03b  | "to 120 Nm" typed (DE "mit 120 Nm"); the autosave says so.                                                                                                                                | 4.8 s          |
| 03c  | "Used in": the owner's manual and the quick start.                                                                                                                                        | 3.6 s          |
| 03d  | The language switch to the other language; the same words typed in its step.                                                                                                              | 5.5 s          |
|      | _Off camera: the save point; the German marked current (Mira holds `translation.manage` for German, given for the take)._                                                                 |                |
| 03e  | The content list in the revision: "Changing a wheel" with English and German current, French out of date.                                                                                 | 3.4 s          |
|      | _Off camera: submitted for review._                                                                                                                                                       |                |
| 04a  | Jonas's review: the inline diff, the new words marked; Approve; the approvals read ready to merge.                                                                                        | 6.5 s          |
|      | _Off camera: merged; the French step sent as a translation job, its XLIFF translated, imported, applied, reviewed and merged._                                                            |                |
| 05a  | Ada's "New release" dialog: "1.2", every check green, the notes pasted, Create release.                                                                                                   | 7.8 s          |
|      | _Off camera: the release's 30 files; the portal built again at 1.2; the assistant asked again._                                                                                           |                |
| 05b  | Release 1.2's page: what changed, per manual and language; "All 30 files ready".                                                                                                          | 4.4 s          |
| 06a  | Four strips of the release's PDFs (owner's manual estate, quick start hatchback, both languages), "120 Nm" marked in the brand green.                                                     | 6.2 s          |
| 06b  | The portal at release 1.2: the same search, the same step, "120 Nm" marked.                                                                                                               | 5.5 s          |
| 06c  | The assistant layer again: the same question and call at release 1.2, the passage now with "120 Nm", "Release 1.2" as its source.                                                         | 5.0 s          |
| 07a  | The three outlets side by side: the PDF strip, the portal's step, the assistant's passage, "120 Nm" in each.                                                                              | 3.5 s          |
|      | **End card**                                                                                                                                                                              | 6.6 s          |

A shot lasts as long as its actions need, or as long as its line of the voice-over with 0.25 s
before and 0.45 s after it, whichever is longer.

**What is real.** The portal is the portal's own build (`frontend/portal`, `scripts/build.ts`)
from the demo API at the release, for the owners' audience, served as static files on a free port of 127.0.0.1.
The assistant's passages are the MCP server's (`backend/mcp`, over stdio, through the official
SDK's client) answers to `search` at the release's tag, drawn word for word: no model writes an
answer, and no vendor's chat window appears. Both read with a service account whose role holds
`content.read` alone, up to the owners' audience (`outlets.mjs`, `readerToken`).

```bash
pnpm demo:start --api-port 3293 --editor-port 4393
node scripts/demo/cards/render.mjs                      # the cards, EN and DE
node scripts/demo/scenes/hero.mjs --lang en             # the take: .demo/takes/hero-en.webm
node scripts/demo/scenes/hero.mjs --lang en --theme dark
DEMO_BED=<bed> DEMO_MUSIC=<sting> node scripts/demo/assemble.mjs hero --lang en
DEMO_BED=<bed> DEMO_MUSIC=<sting> node scripts/demo/assemble.mjs hero-dark --lang en
```

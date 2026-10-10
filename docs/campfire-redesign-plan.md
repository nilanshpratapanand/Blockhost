# Blockhost — "Campfire" redesign plan (dashboard + Sync window)

Status: plan v1 · Phase 1 (dashboard theme) and Phase 2 (Sync window) follow this doc.

## 1. The idea, polished

**Blockhost is a campfire for your friends' Minecraft world.** Nobody has to keep a PC on all night: whoever shows up lights the fire (starts the server), the others sit around it (join), and when everyone leaves the fire is banked and the world is saved to the cloud. The owner can always look in on the camp from the dashboard, even when a friend is keeping the fire.

That metaphor is the whole product, so the interface should say it:

| Server reality | Campfire state | What the UI shows |
|---|---|---|
| Asleep, world saved in cloud | Embers | dim glowing coals, "Nobody is hosting. Light the fire." |
| Starting / pulling world | Kindling | small flame, progress ("gathering wood" = downloading world) |
| Online, players connected | Roaring | full animated fire, players seated around it |
| Saving / handing back | Banking the fire | flame lowers, sparks, "Saving to the cloud" |
| Error / lost baton | Smoke | grey smoke wisp + plain-language fix |
| Friend hosts, owner watching | "Aarav is keeping the fire" | fire + torch-passing badge, owner controls still live |

Product polish that falls out of this (all already built or small): one-click join for friends, owner-only dashboard, remote control relay, session-only ops, reachable-from-internet check, honest failure messages. Still to do: a "Camp roster" (who is online, who last hosted), a shareable join card for WhatsApp, and a first-run walkthrough.

## 2. Research (what the evidence says)

- **Value carries readability, hue carries mood.** Limited pixel palettes work best at ~8–32 colours; readability comes from lightness contrast; shadows shift cool and highlights shift warm ("the single biggest upgrade" from flat to vibrant); reuse 3–4-step ramps instead of inventing new shades. → one ramp per hue, warm lights over cool-ish dark. ([Wayline: Color and limited palettes](https://www.wayline.io/learn/pixel-art/2))
- **Fit the UI to the world's mood, and keep it unobtrusive.** A 1-bit UI limited feedback; big overlays broke atmosphere; show information contextually. → pixel flavour in accents (fire, borders, numerals) while body text stays a clean readable sans. ([Return devlog: effective pixel-art UI](https://jesseeisenbart.itch.io/return-alpha/devlog/384935/return-devlog-01-creating-effective-pixel-art-uigui))
- **Contrast is a hard floor.** Text needs ≥ 4.5:1; large text (≥ 24 px, or ≥ 18.5 px bold) ≥ 3:1; icons and graphic symbols fall under 1.4.11 (≥ 3:1). ([W3C WCAG 2.2, SC 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)) Every colour pair in this plan was computed against that (section 3).
- **Motion must be optional.** Keep animations, override under `prefers-reduced-motion: reduce` with subtler effects rather than nothing. ([MDN: prefers-reduced-motion](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion))
- **Status first, errors in plain words.** Visibility of system status (feedback quickly, no consequential action unannounced), error prevention before error messages, plain-language errors with a one-click fix. ([NN/g: 10 usability heuristics](https://www.nngroup.com/articles/ten-usability-heuristics/))
- **Notification-area rules (Microsoft).** One icon per component; left-click shows what users most likely want (a small window near the icon); double-click runs the default command; right-click menu has the default command in bold first, then state items with check marks, then Options / Exit; remove menu items that do not apply instead of disabling them; do not flash or rapidly change the icon; infotip = "Name - status summary"; no About; click fires on mouse-up. ([Microsoft: notification area guidelines](https://learn.microsoft.com/en-ie/Windows/Win32/uxguide/winenv-notification)) Note: the page is Windows 7-era and says newer guidance lives in UWP docs; the interaction rules above are still the baseline for WinForms `NotifyIcon`.

## 3. Design system: "Campfire"

**Source of the look:** the camp-at-night pixel scene you shared. I sampled its pixels: ~27 % pure black, then warm near-blacks (`#090700` `#120a04` `#1b1207` `#221605`), ember browns (`#371808` `#5a2612` `#78391d`), amber light (`#cc8447` `#d47a2d`), flame core `#fef5e7`, sleeping-bag red `#ad2c15`; cool accents come from the leaves/creatures. **We take the lighting, palette and mood only.** The characters in that picture belong to someone else, so every sprite in Blockhost will be original (a campfire, tents, logs, a small original "camper" avatar set).

**Palette (all contrast-checked against `#0c0905` and card `#17110a`)**

| Token | Hex | Role | Contrast on bg / card |
|---|---|---|---|
| `--bg` | `#0c0905` | night, warm black | - |
| `--surface` | `#17110a` | cards | - |
| `--surface-2` | `#201710` | raised | - |
| `--bark` | `#2d2014` | borders, inputs | - |
| `--text` | `#f4e6cc` | firelight cream | 16.1 / 15.2 |
| `--muted` | `#b9a487` | secondary text | 8.3 / 7.8 |
| `--dim` | `#8c7a62` | tertiary (min size 12 px) | 4.8 / 4.5 |
| `--flame` | `#ffd27a` | highlights, focus | 14.0 / 13.2 |
| `--amber` | `#ee9b3d` | primary action | 8.9 / 8.4 |
| `--ember` | `#e8552f` | danger, error | 5.5 / 5.2 |
| `--moss` | `#7fc15a` | online / success | 9.2 / 8.6 |
| `--dusk` | `#6d94f0` | info, "friend hosts" | 6.8 / 6.4 |
| `--rose` | `#e97f95` | accent (players) | 7.5 / 7.1 |

Rules: warm light on cool-ish dark (shadows lean `#0a090d`, not pure brown); state colour drives the page glow exactly as today (`--state`), now moss = roaring, amber = kindling, ember = smoke; buttons use a 3-step ramp (light edge, mid, deep) as the existing pixel-style buttons do.

**Type:** Pixelify Sans (already loaded) for the wordmark, big numerals and state labels only; Manrope for all reading text; JetBrains Mono for addresses and console. Body text ≥ 13 px.

**Texture and light (CSS only, no images to download):** radial warm vignette with the fire as the light source (the hero card glows amber, edges fall to black); 2 px pixel-stepped borders via `box-shadow` on cards; faint dithered ground pattern in the background; a small pixel campfire built from a CSS grid / inline SVG with `image-rendering: pixelated`, three flame frames stepped with `steps()` animation; ≤ 12 ember particles drawn on one low-frame-rate canvas (paused when the tab is hidden, off under reduced motion).

**Motion:** flame flicker (3 frames, ~0.5 s), embers rising on hosting, glow breathing 6 s, state change = flame resizes over 400 ms. Under `prefers-reduced-motion` the fire is a static frame and glows do not pulse.

## 4. Sync window (Windows tray app, WinForms) redesign

**Constraints:** WinForms has no CSS; keep it to flat owner-drawn panels, one font (Segoe UI / Segoe UI Semibold, with a pixel-style state label drawn as a bitmap), no transparent label backgrounds (caused the smeared text), double-buffering on, no UI-thread blocking (already fixed).

**Layout (460 × 520, fixed, dark):**
1. Header strip: small pixel campfire (bitmap that changes with state) + "Blockhost" + group/host name.
2. Big status line in plain words ("Server is asleep", "Starting - gathering the world 42 %", "Aarav is keeping the fire", "Saving to the cloud").
3. Address chip with Copy; the reach check as a three-step ribbon (Server up → Tunnel → Internet).
4. One primary button that changes meaning with state (Light the fire / Stop & save / Retry) in amber; everything else secondary.
5. "Wake the server when a friend asks" as a single switch row; a collapsible "Details" with the last log lines and a Copy log button (for support screenshots).

**Tray behaviour (per Microsoft rules):** one icon; icon variants for asleep/starting/online/problem (overlay badge bottom-right, never flashing); infotip `Blockhost - Server is online, 3 playing`; single left-click opens the window anchored near the tray; double-click = Open; right-click menu: **Open Blockhost** (bold), Start/Stop (only the one that applies - removed, not disabled), Copy server address, then check-mark items (Wake when a friend asks, Start with Windows), then Exit. No About. Toast only for: "Start the server for everyone?" (actionable), "Server is online", "Something needs attention".

## 5. Dashboard redesign (by page)

- **Shell:** warm black ground, vignette; sidebar with a tiny pixel flame beside the wordmark that mirrors server state; remote bar re-skinned as "Aarav is keeping the fire" (dusk accent).
- **Overview:** hero = the campfire scene (state-driven fire + tent/logs silhouette) with the big Start/Stop control below it; address as a "signpost"; four stat cards re-tinted; players shown as campers seated around the fire (avatar heads) with a count.
- **Console:** keep dense mono; colour map warm (chat = cream, joins = moss, warnings = amber, errors = ember, remote lines get a dusk gutter).
- **Players:** "Camp roster" cards, last seen, op/kick/ban kept, session-op badge ("op until they leave").
- **Cloud Host:** the hand-off told as a story strip: Asleep → Lit by X → Saved (v12).
- **Everything else** (Options, Packs, Backups, ...) inherits tokens; no layout change in phase 1.

## 6. Quality bar and tests

- Contrast: script computes every text/background token pair and fails the build under 4.5 (3.0 for large text and icons).
- Screenshots (Playwright) of Overview, Console, Players, Cloud Host at 1280 and 390 px wide; diff against previous run for unintended layout shifts.
- Reduced motion: emulate `prefers-reduced-motion: reduce`, assert no running animations on the fire.
- Perf: CPU of an idle tab with the ember canvas under 2 %; canvas stops when the tab is hidden.
- Sync window: PowerShell parse check, AST-extracted view-model tests for every phase string, and a real-Windows checklist (open, start, stop, DPI 100/150/200 %, Not Responding never appears).
- Existing 52 automated tests stay green.

## 7. Phases

1. **Dashboard theme foundation** (tokens, vignette, buttons, cards, pill, remote bar, pixel flame component) - screenshot-verified.
2. **Sync window** restyle + tray menu clean-up + state bitmaps.
3. **Overview campfire hero + camp roster** on Players.
4. **Join card for WhatsApp** (shareable image/text) and first-run walkthrough.
5. Polish pass: sounds off by default, empty states, copy edit.

## 8. Open questions for you

- Keep the purple "amethyst" brand mark, or move fully to amber/ember? (Plan assumes amber primary, amethyst only as a rare accent.)
- Is a light "day camp" theme wanted, or night only?
- Should friends see a version of the campfire in their Sync window with the roster of who is online?

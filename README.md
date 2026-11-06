# Afterglow

Browser tool for short video posts: a background video, a design from Figma on top, glow, chromatic aberration, grain and a vignette. Exports MP4 (H.264 + AAC) right in the browser. Made for 5 to 10 second clips.

Live: https://todels.github.io/afterglow/

## Run locally

```
python3 -m http.server 5220
```

Open http://localhost:5220. It loads a demo video and the GN text on start.

## Font

The text uses A-OTF Shin Go Pro M. It is a licensed font, so it is not in this repo. Click **Load font** in the Design panel (or drop an .otf / .ttf / .woff file on the page): it is stored in that browser only and used from then on. Any font works. Locally, a copy in `fonts/` (gitignored) is picked up automatically.

## Use

1. **Video**: drop a video (or a still image) anywhere, or click Replace.
2. **Design**, either:
   - **Text** (default): type in the Design panel. It uses the GN setup from the Figma post (A-OTF Shin Go Pro M, tracking -6%, white gradient fading in from the top of each line) and sizes itself: as big as GN in the Figma post, smaller when the text needs it to fit (84% of the width, 66% of the height). Enter makes a new line. Size 100 = auto size, so the Size slider scales relative to that. Without the font the text falls back to Helvetica (see Font).

     **Fill**: Fade in (GN: white fading in from the top) or Solid (6,316,573, LIVE ON OBOL).

     **Align**: Left, Center or Right. X / Y place the middle of the main text when centred, and its left (or right) edge and cap top when aligned left (right), so a top-left headline grows down and to the right as you type. Switching keeps the text where it is. **Line spacing** (shown for 2+ lines) is baseline to baseline in % of the font size; 99 is the Figma setting.

     **Subtitles**: the fields above and below the main text add a line over or under it (solid white, same font, tracking -6%, same glow). They stick to the main text and scale with it. Sub size is a % of the main text size; Above gap / Below gap move each one up or down (in % of the main text size, negative overlaps). Sub strength sets how bright they are next to the main text: 59 matches Figma, where the number has its glow group twice (100% + 70%) and the subtitle once. The whole group counts for the auto size, and X / Y point at the main text.

     **Posts**: GN, 6,316,573 or LIVE ON OBOL loads that Figma post in one click: text, fill, alignment, size and position, glow, aberration, grain, vignette, icon and logo settings. Then type your own text. Pictures and logos are not included: add them once (they stay in that browser).
   - **Image**: in Figma, select the layer or frame without its background, Copy as PNG, then press ⌘V here. Dropping a PNG works too. If the design has the same aspect as the output it fills the frame, otherwise it is placed at 60% width.

   Drag the design to move it (snaps to center), ⌘ + scroll to scale.
3. **Icon** (optional), the LIVE ON OBOL setup: Add picture takes any image (a token, a partner logo). It is cropped round with a feathered edge (Edge, in % of the diameter; Zoom crops into the picture) and blended Hard light like the Figma group. **Badge** adds a pill at its top left (e.g. "5x"): grey to white, black text, soft glow; long text shrinks to fit. Drag the circle on the canvas to move it, ⌘ + scroll to scale. Size is % of the frame height.

   **Icon 2** is a second picture with the same controls, for partner posts with two logos. The first picture you add goes right next to Icon 1 (same size and height, slightly overlapping); move it from there.
4. **Logo** (optional): Add logo takes an SVG or PNG (white on transparent). It sits at the bottom centre on top of everything, with no aberration or grain, like the logo layer in the Figma post. Size is % of the frame height. It is stored in that browser.
5. Tweak the panels. Double-click a slider to reset it.
6. **Trim** with the two handles on the timeline.
7. **Export MP4**. Renders every frame at full quality, then downloads.

## Presets

The Presets panel at the top saves everything on screen under a name: all settings, the trim, and the files (the video or still, the design image, both icon pictures and the logo). Click a preset to load it back exactly. Saving under an existing name updates it (the button says Update). The × deletes after a second click.

Presets live in that browser (IndexedDB), not on the site, so they do not move between computers or browsers, and clearing site data removes them. Each file is stored once, so ten presets on the same video take the space of one video. The panel shows how much storage the presets use.

Formats: 16:9 (1920×1080), 1:1, 4:5 (1080×1350), 9:16 (1080×1920). 30 or 60 fps.

## Share as a template

**Share** (top right) hands a client this post with the video, font, pictures, logo, trim and every setting. The client can only change the text (main text, the lines above / below if the template has them, badges), then Export MP4. Their text stays in their browser, so a reload keeps it.

**Template file** (works now, no account):

1. Share > **Download template file**. You get one `.afterglow` file with everything inside.
2. Send the client that file (WeTransfer, Slack, email) and the link https://todels.github.io/afterglow/?open (Copy link in the dialog).
3. They open the link, drop the file on the page (or Choose file), change the text and export.

Dropping a `.afterglow` file on the editor opens it the same way (text only). Go back to https://todels.github.io/afterglow/ for the full editor.

**Include the font file** puts the font in the template so the client sees it. The client can get the font file out of it, so only do this if the font license allows it. A font that is only installed on your computer cannot be included: use Load font with the file.

### Link only (optional, needs Supabase)

With a Supabase project connected, Share also makes a plain link (`?s=…`), no file to send. **Update** (click twice) replaces a link's template with what is on screen now (same link, the client reloads), **×** (click twice) deletes it and the files no other link uses. Each file is uploaded once.

Setup, once (free plan is enough; 50 MB per file):

1. Create a project at [supabase.com](https://supabase.com).
2. SQL Editor: paste `supabase-setup.sql`, replace `you@example.com` with your email, run it.
3. Authentication > Users > Add user: your email and a password (Auto Confirm on). Then Authentication > Sign In / Providers: turn off "Allow new users to sign up".
4. Project Settings > API Keys: put the project URL and the publishable (or anon) key in `share-config.js` and push. That key is meant to be public; uploads still need your login.

Then Share > sign in with that email and password (it stays signed in in that browser).

## Export quality

Export uses constant quality, not a target bitrate. Fine moving grain is close to random noise, and bitrate-targeted encoders smear it into flat blotches after a few frames. So file size depends on how much grain there is:

- **High quality** (default): visually close to the preview. Around 125 Mbps with default grain, so a 10 s clip at 30 fps is about 155 MB (double at 60 fps).
- **Smaller file**: about 40% of that, grain a bit softer.

X re-compresses every upload, so very fine grain gets softened there whatever you export. Grain Size 1.5 to 2 survives better than 1.

## Edit vs Preview

- **Edit** renders at half resolution, cheaper aberration, at most 30 fps, and only when something changes. Use it while tweaking.
- **Preview** renders at full screen resolution and full quality. Use it to judge the look.
- Export always renders at full output size and full quality, whatever the mode.

Keys: Space play/pause, P toggle Edit/Preview, ⌘V paste design.

## How the glow works

It follows the Figma setup the demo design came from: the design is blended over the video (Overlay), then a large blurred copy (Halo) and a small blurred copy (Bloom) are added on top. Amounts above 100% stack a second copy, like duplicating the group in Figma. Blur sizes are Figma blur values at 1080p, so a Figma layer blur of 86 on a 1350 px tall frame is about 69 here.

With text, the blur sizes are for GN-sized text and shrink or grow with the text actually drawn (GN and 6,316,573 both use halo blur = 14% of the font size, bloom = 2.2%), so long text or a smaller Size keeps the same look instead of drowning in glow. LIVE ON OBOL blurs a bit more (20% / 3.1%), which its post button sets as Halo size 97, Bloom size 15.

The blurs are cached and only rebuilt when the design, its position or a blur size changes, so playback is cheap (about 2 ms per 1080p frame on an M-series Mac).

## Notes

- Needs Chrome, Edge or Safari 17+ (WebCodecs). Firefox cannot export.
- Settings are saved in the browser (localStorage).
- `demo/` holds assets from the Obol Internal Figma file. Only `demo/demo.mp4` is published; the rest stays local.

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

     **Fill**: Fade in (GN: white fading in from the top) or Solid (the 6,316,573 post).

     **Subtitles**: the fields above and below the main text add a line over or under it (solid white, same font, tracking -6%, same glow). They stick to the main text and scale with it. Sub size is a % of the main text size; Above gap / Below gap move each one up or down (in % of the main text size, negative overlaps). Sub strength sets how bright they are next to the main text: 59 matches Figma, where the number has its glow group twice (100% + 70%) and the subtitle once. The whole group counts for the auto size, and X / Y point at the main text.

     **Example**: GN or 6,316,573 loads that Figma post in one click: text, fill, size and position, aberration, grain, vignette and logo. Then type your own text.
   - **Image**: in Figma, select the layer or frame without its background, Copy as PNG, then press ⌘V here. Dropping a PNG works too. If the design has the same aspect as the output it fills the frame, otherwise it is placed at 60% width.

   Drag the design to move it (snaps to center), ⌘ + scroll to scale.
3. **Logo** (optional): Add logo takes an SVG or PNG (white on transparent). It sits at the bottom centre on top of everything, with no aberration or grain, like the logo layer in the Figma post. Size is % of the frame height. It is stored in that browser.
4. Tweak the panels. Double-click a slider to reset it.
5. **Trim** with the two handles on the timeline.
6. **Export MP4**. Renders every frame at full quality, then downloads.

Formats: 16:9 (1920×1080), 1:1, 4:5 (1080×1350), 9:16 (1080×1920). 30 or 60 fps.

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

With text, the blur sizes are for GN-sized text and shrink or grow with the text actually drawn. Both Figma posts use the same ratio (halo blur = 14% of the font size, bloom = 2.2%), so long text or a smaller Size keeps the same look instead of drowning in glow.

The blurs are cached and only rebuilt when the design, its position or a blur size changes, so playback is cheap (about 2 ms per 1080p frame on an M-series Mac).

## Notes

- Needs Chrome, Edge or Safari 17+ (WebCodecs). Firefox cannot export.
- Settings are saved in the browser (localStorage).
- `demo/` holds assets from the Obol Internal Figma file. Only `demo/demo.mp4` is published; the rest stays local.

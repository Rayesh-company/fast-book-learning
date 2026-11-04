// The web face's own tokens (ui/mobile/app.css :root + body.dark),
// carried to the phone VERBATIM — color for color, no second palette:
// bg, surface, the app's raised takes the web's soft, rule takes line,
// ink and muted ride unchanged, clay is the web's accent (buttons,
// bubbles, phase titles), bad is the sheet-error red the web itself
// paints (#a03831, dark included — sameness wins over contrast here),
// gold's note text reads in the muted voice like the web's own notes,
// and ok stays the quiet green both worlds already agree on.
export const light = {
  bg: "#faf8f3",
  surface: "#fffefa",
  raised: "#f0eee8",
  rule: "#dfe2dc",
  ink: "#262c2b",
  mute: "#626965",
  clay: "#16786e",
  gold: "#626965",
  ok: "#3e6b4f",
  bad: "#a03831",
};

export const dark = {
  bg: "#202524",
  surface: "#272d2b",
  raised: "#333a37",
  rule: "#454d48",
  ink: "#f3f4ed",
  mute: "#b2bab5",
  clay: "#82cfc0",
  gold: "#b2bab5",
  ok: "#7fb091",
  bad: "#a03831",
};

export type Palette = typeof light;

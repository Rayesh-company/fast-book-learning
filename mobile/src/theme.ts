// The sheet's own paper world (ui/index.html's :root tokens), carried
// to the phone: one palette, both themes, the reader never decodes a
// second visual language.
export const light = {
  bg: "#d8cbae",
  surface: "#f3ead6",
  raised: "#faf4e6",
  rule: "#cdbf9f",
  ink: "#2e2417",
  mute: "#6d5e48",
  clay: "#1f4a78",
  gold: "#a67c2e",
  ok: "#3e6b4f",
  bad: "#9c3529",
};

export const dark = {
  bg: "#141821",
  surface: "#1e242e",
  raised: "#273040",
  rule: "#3e4757",
  ink: "#eae1c9",
  mute: "#a9997c",
  clay: "#7ea6d6",
  gold: "#c9a355",
  ok: "#7fb091",
  bad: "#d98a7c",
};

export type Palette = typeof light;

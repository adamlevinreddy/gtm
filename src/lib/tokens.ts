// Design tokens — THE palette. New and edited code imports from here
// instead of pasting hex values (the audit found 40+ pasted copies).
// Keep in sync with the CSS custom properties in globals.css.

export const PLUM = "#773D72";
export const PLUM_DEEP = "#5C2E58";
export const PLUM_SOFT = "#F5EDF4"; // active-nav / chip fill
export const PLUM_TINT = "#F0E8EF"; // icon-box / badge fill

export const BORDER = "#E4DCE3"; // card borders (plum-biased zinc)
export const BORDER_SOFT = "#EFE5EE"; // internal dividers

export const INK = "#241B23";
export const INK_2 = "#5E5060";
export const INK_3 = "#8F8291";

export const OK = "#3F7D5B";
export const WARN = "#B07D2E";
export const CRIT = "#A23B3B";
export const INFO = "#3A6B8C";

/** Sticky-header height. Anything sticky below the AppShell bar must offset
 * by at least this (CSS var --header-h is set in globals.css). */
export const HEADER_H = 56;

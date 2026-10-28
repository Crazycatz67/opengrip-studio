// ui/dom.js: tiny DOM helpers shared by the screens (no framework, no build step).

// Every string that goes into innerHTML passes through esc(): sketch output in the raw peek
// and file names are untrusted text.
export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// A "Why?" fold (simplify-spec §6): the plain sentence stays outside; the technical reason goes inside.
// Native <details>: keyboard-operable, announces expanded/collapsed, and closed content is not rendered.
export function whyHTML(text, label = 'Why?') {
  return text ? `<details class="why"><summary>${esc(label)}</summary><p>${esc(text)}</p></details>` : '';
}

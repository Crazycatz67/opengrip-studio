// ui/icons.js: inline SVG line icons (spec §4 rule 3: icons, never emoji). All are
// aria-hidden; the word next to them carries the meaning. stroke = currentColor so the
// status colour comes from CSS.

const svg = (size, body, extra = '') =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"${extra}>${body}</svg>`;

const STATUS_BODY = {
  ok: '<path d="M5 12.5l4.5 4.5L19 7.5"/>',
  check: '<path d="M12 4L21 19.5H3z"/><path d="M12 10v4.5"/><path d="M12 17.2v.1"/>',
  fix: '<path d="M6 6l12 12M18 6L6 18"/>',
  wait: '<circle cx="12" cy="12" r="7"/>',
  busy: '<circle cx="12" cy="12" r="7" stroke-dasharray="3 3.3"/>',
};

export function statusIcon(level, size = 16) {
  return svg(size, STATUS_BODY[level] || STATUS_BODY.wait, level === 'busy' ? ' class="spin"' : '');
}

// Brand: a diamond drawn as two trace strokes (spec §5), original, no logo.
export const brand = svg(20, '<path d="M12 2.5L21.5 12 12 21.5"/><path d="M12 21.5L2.5 12 7 7.5l2.5 3 2.5-5 2.5 6"/>');

export const tile = {
  connect: svg(32, '<path d="M9 3v5M15 3v5"/><rect x="6.5" y="8" width="11" height="6" rx="1.5"/><path d="M12 14v3.5a3.5 3.5 0 0 1-3.5 3.5H7"/>'),
  demo: svg(32, '<path d="M2 12c2.5 0 2.5-6 5-6s2.5 12 5 12 2.5-12 5-12 2.5 6 5 6"/>'),
  file: svg(32, '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4"/><path d="M9 12h6M9 15.5h6"/>'),
};

// Pose glyph for the prompt band (spec §8.2): a side-view arm in one of 4 positions with one of
// 4 hand states, built from 2 parts so it's 8 small paths, not 16 pictures. aria-hidden: the
// word and the position chip say the same thing in text.
const ARMS = {
  down: { d: 'M60 24 L60 88 L60 140', hand: [60, 152], dir: [0, 1] },
  elbow90: { d: 'M60 24 L60 88 L124 88', hand: [136, 88], dir: [1, 0] },
  raised: { d: 'M60 24 L108 24 L150 24', hand: [160, 24], dir: [1, 0] },
  table: { d: 'M60 24 L60 88 L128 100 M20 112 L170 112', hand: [140, 100], dir: [1, 0] },
};
function handPath(state, [x, y], [dx, dy]) {
  if (state === 'fist') return `<circle cx="${x}" cy="${y}" r="10"/>`;
  if (state === 'open') {
    // Three spread fingers, fanned around the arm's direction.
    const px = -dy; const py = dx;
    return [-1, 0, 1].map((k) => `<path d="M${x - dx * 8} ${y - dy * 8} L${x + dx * 12 + px * k * 10} ${y + dy * 12 + py * k * 10}"/>`).join('');
  }
  if (state === 'bend') return '<path d="M84 128 A40 40 0 0 0 120 64"/><path d="M110 62 L120 64 L118 74"/>';
  return `<path d="M${x - dx * 6} ${y - dy * 6} q ${dx * 10 - dy * 8} ${dy * 10 + dx * 8} ${dx * 14} ${dy * 14}"/>`;
}
export function pose(position, hand) {
  const a = ARMS[position] || ARMS.table;
  return `<svg viewBox="0 0 180 180" width="100%" height="100%" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="60" cy="14" r="8"/><path d="${a.d}"/>${handPath(hand, a.hand, a.dir)}</svg>`;
}

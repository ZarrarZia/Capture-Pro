// Scheduled recording rules (pure; unit-tested).
//
// schedule = {
//   id, name, active,
//   type: 'once' | 'daily' | 'weekly',
//   date: 'YYYY-MM-DD'            (once)
//   days: [0..6]                  (weekly; 0 = Sunday)
//   start: 'HH:MM:SS',
//   end: 'HH:MM:SS' | null, durationSec: number | null   (end may be on the next day)
//   target: 'last' | 'full' | 'rect', display, rect, after: 'nothing' | 'exit' | 'shutdown' | 'hibernate'
// }
const DAY = 86400000;

const parseHms = (s) => {
  const [h = 0, m = 0, sec = 0] = String(s || '0').split(':').map(Number);
  return ((h * 60 + m) * 60 + sec) * 1000;
};

function durationMs(s) {
  if (s.durationSec) return s.durationSec * 1000;
  let d = parseHms(s.end) - parseHms(s.start);
  if (d <= 0) d += DAY; // ends the day after
  return d;
}

function validate(s) {
  const d = durationMs(s);
  if (d < 1000 || d > DAY - 1000) return 'The duration must be between 00:00:01 and 23:59:59.';
  if (s.type === 'weekly' && !(s.days || []).length) return 'At least one day must be selected.';
  if (s.type === 'once' && !/^\d{4}-\d{2}-\d{2}$/.test(s.date || '')) return 'Please choose a date.';
  return null;
}

const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

// Occurrence windows (start/end Dates) that end after `from`, earliest first, scanning `days` days.
function occurrences(s, from, days = 8) {
  const out = [];
  const dur = durationMs(s);
  const startOfs = parseHms(s.start);
  for (let i = -1; i <= days; i++) {
    const base = midnight(new Date(from.getFullYear(), from.getMonth(), from.getDate() + i));
    let ok = false;
    if (s.type === 'daily') ok = true;
    else if (s.type === 'weekly') ok = (s.days || []).includes(base.getDay());
    else if (s.type === 'once') {
      const [y, m, d] = (s.date || '').split('-').map(Number);
      ok = base.getFullYear() === y && base.getMonth() === m - 1 && base.getDate() === d;
    }
    if (!ok) continue;
    const start = new Date(base.getTime() + startOfs);
    const end = new Date(start.getTime() + dur);
    if (end > from) out.push({ start, end });
  }
  return out;
}

const nextWindow = (s, now) => occurrences(s, now)[0] || null;

function status(s, now) {
  if (!s.active) return 'Inactive';
  const w = nextWindow(s, now);
  if (!w) return 'Passed';
  return w.start <= now ? 'Recording' : 'Waiting';
}

// The schedule (if any) whose window contains `now`.
function due(schedules, now) {
  for (const s of schedules) {
    if (!s.active) continue;
    const w = nextWindow(s, now);
    if (w && w.start <= now && now < w.end) return { schedule: s, window: w };
  }
  return null;
}

// Name of an existing active schedule whose windows overlap `s` within the next week, or null.
function overlapping(s, others, now = new Date()) {
  const mine = occurrences(s, now, 8);
  for (const o of others) {
    if (o.id === s.id || !o.active) continue;
    for (const a of mine) for (const b of occurrences(o, now, 8)) if (a.start < b.end && b.start < a.end) return o.name;
  }
  return null;
}

module.exports = { durationMs, validate, occurrences, nextWindow, status, due, overlapping, parseHms };

/**
 * A night shift runs ~23:00-07:00, so an event "belongs to" the morning it hands
 * over to. An event logged at/after 20:00 belongs to the NEXT calendar day's
 * morning; anything earlier (the post-midnight tail) belongs to the same date.
 */
export function morningForTimestamp(ts: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})/.exec(ts);
  if (!m) return null;
  const [, y, mo, d, h] = m;
  let date = `${y}-${mo}-${d}`;
  if (parseInt(h, 10) >= 20) date = addDay(date);
  return date;
}

export function addDay(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 1);
  return dt.toISOString().slice(0, 10);
}

const MONTHS: Record<string, string> = {
  jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06",
  jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12",
};

/**
 * Pull the "morning" date out of a free-text log header like
 * "Night of Wed 27 May -> morning Thu 28 May". Generalizes to any "morning <Day>
 * <DD> <Mon>" phrasing; returns null if no year is derivable from context.
 */
export function parseLogHeaderMorning(text: string, contextYear: string): string | null {
  const m = /morning[^\d]*(\d{1,2})\s+([A-Za-z]{3})/i.exec(text);
  if (!m) return null;
  const day = m[1].padStart(2, "0");
  const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
  if (!mon) return null;
  return `${contextYear}-${mon}-${day}`;
}
